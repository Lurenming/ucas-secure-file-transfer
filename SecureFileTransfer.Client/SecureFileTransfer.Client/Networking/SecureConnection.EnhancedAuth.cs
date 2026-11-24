using System.Text.Json;
namespace SecureFileTransfer.Client.Networking;

public sealed partial class SecureConnection
{
    public void RequireCapability(string capability)
    {
        if (!Capabilities.Contains(capability)) throw new NotSupportedException("服务器未声明所需能力：" + capability + "。请使用匹配的新版本。");
    }
    public async Task<SessionIdentity> CertificateLoginAsync(CancellationToken token = default)
    {
        RequireCapability("window-auth-v1");
        long generation;
        lock (authLock) { if (identity is not null) throw new ServerRequestException("AUTH_ALREADY_LOGGED_IN"); generation = ++authGeneration; }
        var result = await ControlAsync("AUTH_CERT", new { }, generation, token).ConfigureAwait(false);
        return ParseIdentity(result.GetProperty("data"));
    }
    public async Task<string> WindowTicketAsync(CancellationToken token = default)
    {
        RequireCapability("window-auth-v1");
        var result = await ControlAsync("AUTH_WINDOW", new { }, RequireIdentity(), token).ConfigureAwait(false);
        return result.GetProperty("data").GetProperty("ticket").GetString()!;
    }
    public async Task<SessionIdentity> AttachWindowAsync(string ticket, CancellationToken token = default)
    {
        RequireCapability("window-auth-v1");
        long generation;
        lock (authLock) { if (identity is not null) throw new ServerRequestException("AUTH_ALREADY_LOGGED_IN"); generation = ++authGeneration; }
        var result = await ControlAsync("AUTH_ATTACH", new { ticket }, generation, token).ConfigureAwait(false);
        return ParseIdentity(result.GetProperty("data"));
    }
    public async Task ForgetUploadAsync(Guid uploadId, CancellationToken token = default)
    {
        await ControlAsync("UPLOAD_FORGET", new { uploadId }, RequireIdentity(), token).ConfigureAwait(false);
    }
}
