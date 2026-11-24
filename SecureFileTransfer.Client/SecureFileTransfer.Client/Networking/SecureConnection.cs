using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Security.Cryptography.X509Certificates;

namespace SecureFileTransfer.Client.Networking;

public sealed record EchoReply(Guid RequestId, Guid ConnectionId, string Text);

// One instance represents one connection generation; reconnect creates a fresh instance.
public sealed partial class SecureConnection : IAsyncDisposable
{
    public const int MaxMessageBytes = 16 * 1024;
    public const int MaxTextLength = 1024;
    private readonly Uri address;
    private readonly ClientWebSocket socket = new();
    private readonly DevelopmentCertificateValidator certificates;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim sendGate = new(1, 1);
    private readonly SemaphoreSlim requestSlots = new(8, 8);
    private readonly ConcurrentDictionary<Guid, Pending> pending = new();
    private readonly TaskCompletionSource<Guid> hello = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object stopLock = new();
    private Task receiver = Task.CompletedTask;
    private Task? stopTask;
    private int started;
    private int disconnecting;
    private int queuedBytes;
    private sealed record Pending(string ExpectedType, long AuthGeneration, string? EchoText, TaskCompletionSource<JsonElement>? Result,
        TaskCompletionSource<DownloadBlock>? BinaryResult = null, Guid? DownloadId = null, long Offset = 0, int Length = 0)
    {
        public void Fail(Exception error) { Result?.TrySetException(error); BinaryResult?.TrySetException(error); }
    }
    private readonly object authLock = new();
    private long authGeneration;
    private int loginPending;
    private SessionIdentity? identity;
    private System.Threading.Timer? expiryTimer;

    public Guid? ConnectionId { get; private set; }
    public string? CertificateValidationError => certificates.LastError;
    public bool IsConnected => socket.State == WebSocketState.Open && Volatile.Read(ref disconnecting) == 0 && ConnectionId.HasValue;
    public Task Completion => receiver;
    public event Action<string>? Log;
    public SessionIdentity? Identity { get { lock (authLock) return identity; } }
    public event Action? IdentityChanged;
    public HashSet<string> Capabilities { get; } = [];
    public string AuthenticationMode { get; private set; } = "password";

    public SecureConnection(Uri address, string publicCaPath, X509Certificate2? clientCertificate = null)
    {
        if (address.Scheme != "wss" || address.AbsolutePath != "/ws" || address.Query.Length != 0 || address.Fragment.Length != 0 || address.UserInfo.Length != 0)
            throw new ArgumentException("地址必须为 wss://主机:端口/ws，且不含用户信息、查询参数或片段。");
        this.address = address;
        if (address.Host is "0.0.0.0" or "::" or "[::]") throw new ArgumentException("客户端必须填写服务器实际 IP 或域名，不能使用通配监听地址。");
        certificates = new DevelopmentCertificateValidator(publicCaPath, address.IdnHost);
        socket.Options.RemoteCertificateValidationCallback = certificates.Validate;
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        socket.Options.KeepAliveTimeout = TimeSpan.FromSeconds(10);
        socket.Options.Proxy = null;
        if (clientCertificate is not null) {
            if (!clientCertificate.HasPrivateKey) throw new ArgumentException("客户端证书没有可用私钥。");
            socket.Options.ClientCertificates.Add(clientCertificate);
        }
        // Compression is off: DangerousDeflateOptions is intentionally not configured.
    }

    public async Task ConnectAsync(CancellationToken cancellationToken = default)
    {
        if (Interlocked.Exchange(ref started, 1) != 0) throw new InvalidOperationException("此连接实例已经使用，请新建实例重连。");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            await socket.ConnectAsync(address, timeout.Token).ConfigureAwait(false);
            receiver = ReceiveLoopAsync();
            ConnectionId = await hello.Task.WaitAsync(timeout.Token).ConfigureAwait(false);
            Log?.Invoke($"已连接，connectionId={ConnectionId}");
        }
        catch
        {
            await DisconnectAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<EchoReply> EchoAsync(string text, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (text.Length > MaxTextLength) throw new ArgumentException("文本最多 1024 个 UTF-16 代码单元。");
        var requestId = Guid.NewGuid();
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new { version = 1, type = "ECHO", requestId, data = new { text } });
        var result = await RequestAsync(requestId, "ECHO_RESULT", body, 0, text, cancellationToken).ConfigureAwait(false);
        var reply = new EchoReply(requestId, result.GetProperty("connectionId").GetGuid(), result.GetProperty("data").GetProperty("text").GetString()!);
        Log?.Invoke($"ECHO_RESULT requestId={reply.RequestId}, connectionId={reply.ConnectionId}");
        return reply;
    }

    // This non-async method serializes credentials without retaining a password in an async state machine.
    public Task<SessionIdentity> LoginAsync(string username, string password, CancellationToken cancellationToken = default)
    {
        if (!Regex.IsMatch(username, "^[A-Za-z][A-Za-z0-9_]{2,31}$")) throw new ArgumentException("用户名须为 3–32 个 ASCII 字母、数字或下划线，以字母开头。");
        if (password.EnumerateRunes().Count() < 12 || new UTF8Encoding(false, true).GetByteCount(password) > 256)
            throw new ArgumentException("密码至少 12 个 Unicode 字符，最多 256 个 UTF-8 字节。");
        if (Interlocked.CompareExchange(ref loginPending, 1, 0) != 0) throw new ServerRequestException("AUTH_BUSY");
        try
        {
            var requestId = Guid.NewGuid();
            byte[] body = JsonSerializer.SerializeToUtf8Bytes(new { version = 1, type = "AUTH_LOGIN", requestId, data = new { username, password } });
            long generation;
            lock (authLock) generation = identity is null ? ++authGeneration : authGeneration;
            return LoginCoreAsync(requestId, body, generation, cancellationToken);
        }
        catch { Interlocked.Exchange(ref loginPending, 0); throw; }
    }

    private async Task<SessionIdentity> LoginCoreAsync(Guid requestId, byte[] body, long generation, CancellationToken token)
    {
        try
        {
            var result = await RequestAsync(requestId, "AUTH_LOGIN_RESULT", body, generation, null, token).ConfigureAwait(false);
            return ParseIdentity(result.GetProperty("data"));
        }
        catch (OperationCanceledException) { await DisconnectAsync().ConfigureAwait(false); throw; }
        finally { Interlocked.Exchange(ref loginPending, 0); }
    }

    public async Task<SessionIdentity> MeAsync(CancellationToken cancellationToken = default)
    {
        var requestId = Guid.NewGuid();
        long generation;
        lock (authLock) generation = authGeneration;
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new { version = 1, type = "AUTH_ME", requestId, data = new { } });
        var result = await RequestAsync(requestId, "AUTH_ME_RESULT", body, generation, null, cancellationToken).ConfigureAwait(false);
        return ParseIdentity(result.GetProperty("data"));
    }

    public async Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        long generation = ClearIdentity(); // Invalidate earlier async replies before sending logout.
        var requestId = Guid.NewGuid();
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new { version = 1, type = "AUTH_LOGOUT", requestId, data = new { } });
        try { await RequestAsync(requestId, "AUTH_LOGOUT_RESULT", body, generation, null, cancellationToken).ConfigureAwait(false); }
        catch { await DisconnectAsync().ConfigureAwait(false); throw; } // Uncertain logout must not leave a usable hidden session.
    }

    private async Task<JsonElement> RequestAsync(Guid requestId, string expectedType, byte[] body, long generation, string? echoText, CancellationToken cancellationToken, bool binary = false)
    {
        bool admitted = false;
        try
        {
            if (!IsConnected) throw new InvalidOperationException("连接尚未建立或已经断开。");
            if (!await requestSlots.WaitAsync(0, cancellationToken).ConfigureAwait(false)) throw new InvalidOperationException("最多允许 8 个待完成请求。");
            admitted = true;
            if (body.Length > MaxMessageBytes) throw new ArgumentException("消息超过 16 KiB。");
            var request = new Pending(expectedType, generation, echoText, new(TaskCreationOptions.RunContinuationsAsynchronously));
            pending[requestId] = request;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(binary || expectedType.StartsWith("UPLOAD_") || expectedType.StartsWith("DOWNLOAD_") ? 120 : 10));
            try { await SendFrameAsync(body, timeout.Token, binary).ConfigureAwait(false); }
            finally { CryptographicOperations.ZeroMemory(body); }
            return await request.Result!.Task.WaitAsync(timeout.Token).ConfigureAwait(false);
        }
        finally
        {
            pending.TryRemove(requestId, out _);
            CryptographicOperations.ZeroMemory(body);
            if (admitted) requestSlots.Release();
        }
    }

    private async Task SendFrameAsync(byte[] body, CancellationToken token, bool binary = false)
    {
        int total = Interlocked.Add(ref queuedBytes, body.Length);
        try
        {
            if (total > 64 * 1024) throw new InvalidOperationException("发送队列超过 64 KiB。");
            await sendGate.WaitAsync(token).ConfigureAwait(false);
            try
            {
                if (!IsConnected) throw new IOException("连接已关闭。");
                await socket.SendAsync(new ArraySegment<byte>(body), binary ? WebSocketMessageType.Binary : WebSocketMessageType.Text, true, token).ConfigureAwait(false);
            }
            finally { sendGate.Release(); }
        }
        finally { Interlocked.Add(ref queuedBytes, -body.Length); }
    }

    private async Task ReceiveLoopAsync()
    {
        Exception reason = new IOException("连接已关闭。");
        try
        {
            byte[] buffer = new byte[4096];
            while (!lifetime.IsCancellationRequested)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult part;
                WebSocketMessageType? messageType = null;
                do
                {
                    part = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), lifetime.Token).ConfigureAwait(false);
                    if (part.MessageType == WebSocketMessageType.Close)
                    {
                        Log?.Invoke($"服务器关闭连接：{part.CloseStatus}");
                        await CloseOutputAsync("Close acknowledged", CancellationToken.None).ConfigureAwait(false);
                        return;
                    }
                    messageType ??= part.MessageType;
                    if (part.MessageType != messageType) throw new InvalidDataException("消息分片类型不一致。");
                    if (message.Length + part.Count > MaxMessageBytes) throw new InvalidDataException("接收消息超过 16 KiB。");
                    message.Write(buffer, 0, part.Count);
                } while (!part.EndOfMessage);
                if (messageType == WebSocketMessageType.Binary) { HandleDownloadFrame(message.ToArray()); continue; }
                string json = new UTF8Encoding(false, true).GetString(message.ToArray());
                using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
                HandleMessage(document.RootElement);
            }
        }
        catch (Exception error) when (error is WebSocketException or IOException or InvalidDataException or OperationCanceledException or JsonException or InvalidOperationException or FormatException or DecoderFallbackException)
        {
            reason = error;
            Log?.Invoke("接收结束：" + error.Message);
        }
        finally
        {
            Interlocked.Exchange(ref disconnecting, 1);
            ClearIdentity();
            hello.TrySetException(reason);
            foreach (var item in pending.Values) item.Fail(reason);
            lifetime.Cancel();
            socket.Abort();
        }
    }

    private void HandleMessage(JsonElement message)
    {
        if (message.ValueKind != JsonValueKind.Object || !message.TryGetProperty("version", out var version)
            || !version.TryGetInt32(out int number) || number != 1
            || !message.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String
            || !message.TryGetProperty("connectionId", out var id) || id.ValueKind != JsonValueKind.String || !Guid.TryParseExact(id.GetString(), "D", out var connectionId))
            throw new InvalidDataException("服务器消息头无效。");
        if (type.GetString() == "HELLO")
        {
            if (hello.Task.IsCompleted) throw new InvalidDataException("重复 HELLO。");
            ConnectionId = connectionId;
            if (message.TryGetProperty("data", out var helloData)) {
                if (helloData.TryGetProperty("capabilities", out var caps)) foreach (var cap in caps.EnumerateArray()) Capabilities.Add(cap.GetString()!);
                if (helloData.TryGetProperty("authMode", out var mode)) AuthenticationMode = mode.GetString()!;
            }
            hello.TrySetResult(connectionId);
            return;
        }
        if (ConnectionId != connectionId) throw new InvalidDataException("connectionId 不匹配。");
        string messageType = type.GetString()!;
        if (messageType == "UPLOAD_ABORTED") { Log?.Invoke("未完成上传已失效。"); CancelUpload(); return; }
        if (messageType == "DOWNLOAD_ABORTED") { Log?.Invoke("未完成下载已失效。"); CancelDownload(); return; }
        if (messageType == "AUTH_EXPIRED") { ClearIdentity(); Log?.Invoke("会话已过期，请重新登录。"); return; }
        if (!message.TryGetProperty("requestId", out var request)
            || request.ValueKind != JsonValueKind.String || !Guid.TryParseExact(request.GetString(), "D", out var requestId))
            throw new InvalidDataException("服务器回复无效。");
        // A timed-out/cancelled request may have a late reply; never map it to another request.
        if (!pending.TryGetValue(requestId, out var waiting)) return;
        if (messageType == "ERROR")
        {
            if (!message.TryGetProperty("code", out var code) || code.ValueKind != JsonValueKind.String || !Regex.IsMatch(code.GetString()!, "^[A-Z_]{1,64}$"))
                throw new InvalidDataException("服务器错误格式无效。");
            if (code.GetString() == "AUTH_REQUIRED") ClearIdentity(waiting.AuthGeneration);
            waiting.Fail(new ServerRequestException(code.GetString()!));
            return;
        }
        if (waiting.BinaryResult is not null || messageType != waiting.ExpectedType || !message.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("服务器回复类型不匹配。");
        if (messageType == "ECHO_RESULT")
        {
            if (!data.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String || text.GetString()!.Length > MaxTextLength
                || waiting.EchoText != text.GetString()) throw new InvalidDataException("ECHO 返回文本不匹配。");
        }
        else if (messageType is "AUTH_LOGIN_RESULT" or "AUTH_ME_RESULT" or "AUTH_CERT_RESULT" or "AUTH_ATTACH_RESULT")
        {
            if (!ApplyIdentity(ParseIdentity(data), waiting.AuthGeneration))
            { waiting.Fail(new ServerRequestException("AUTH_CANCELLED")); return; }
        }
        waiting.Result!.TrySetResult(message.Clone());
    }

    private static SessionIdentity ParseIdentity(JsonElement data)
    {
        if (!data.TryGetProperty("userId", out var id) || id.ValueKind != JsonValueKind.String || !Guid.TryParseExact(id.GetString(), "D", out var userId)
            || !data.TryGetProperty("username", out var name) || name.ValueKind != JsonValueKind.String || !Regex.IsMatch(name.GetString()!, "^[a-z][a-z0-9_]{2,31}$")
            || !data.TryGetProperty("expiresAt", out var expiry) || expiry.ValueKind != JsonValueKind.String || !expiry.TryGetDateTimeOffset(out var expiresAt))
            throw new InvalidDataException("服务器身份字段无效。");
        return new(userId, name.GetString()!, expiresAt);
    }

    private bool ApplyIdentity(SessionIdentity value, long generation)
    {
        lock (authLock)
        {
            if (authGeneration != generation || value.ExpiresAt <= DateTimeOffset.UtcNow) return false;
            if (value.ExpiresAt > DateTimeOffset.UtcNow.AddDays(1)) throw new InvalidDataException("服务器会话有效期无效。");
            identity = value;
            expiryTimer?.Dispose();
            expiryTimer = new System.Threading.Timer(_ => ClearIdentity(generation), null,
                TimeSpan.FromMilliseconds(Math.Max(1, (value.ExpiresAt - DateTimeOffset.UtcNow).TotalMilliseconds)), Timeout.InfiniteTimeSpan);
        }
        IdentityChanged?.Invoke();
        return true;
    }

    private long ClearIdentity(long? expectedGeneration = null)
    {
        long generation;
        lock (authLock)
        {
            if (expectedGeneration.HasValue && authGeneration != expectedGeneration) return authGeneration;
            generation = ++authGeneration;
            identity = null;
            CancelTransfer();
            expiryTimer?.Dispose();
            expiryTimer = null;
        }
        IdentityChanged?.Invoke();
        return generation;
    }

    private async Task CloseOutputAsync(string reason, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(5));
        await sendGate.WaitAsync(deadline.Token).ConfigureAwait(false);
        try
        {
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, reason, deadline.Token).ConfigureAwait(false);
        }
        finally { sendGate.Release(); }
    }

    public Task DisconnectAsync()
    {
        lock (stopLock) return stopTask ??= DisconnectCoreAsync();
    }

    private async Task DisconnectCoreAsync()
    {
        Interlocked.Exchange(ref disconnecting, 1);
        ClearIdentity();
        try
        {
            await CloseOutputAsync("Client disconnect", CancellationToken.None).ConfigureAwait(false);
            await receiver.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException or TimeoutException or ObjectDisposedException) { }
        finally
        {
            lifetime.Cancel();
            socket.Abort();
            try { await receiver.ConfigureAwait(false); } catch (Exception) { }
            socket.Dispose();
            certificates.Dispose();
            lifetime.Dispose();
        }
    }

    public async ValueTask DisposeAsync() => await DisconnectAsync().ConfigureAwait(false);
}
