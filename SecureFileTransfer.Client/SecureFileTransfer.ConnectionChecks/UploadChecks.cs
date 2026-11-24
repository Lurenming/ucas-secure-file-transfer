using System.Security.Cryptography;
using System.Text.Json;
using SecureFileTransfer.Client.Networking;

internal static class UploadChecks
{
    private sealed record Settings(string Username, string SecondUsername, string Password, string SourceDirectory,
        string ExpiryAddress, string LostAckAddress, string StoppingAddress);
    private sealed class CallbackProgress(Action<UploadProgress> callback) : IProgress<UploadProgress>
    { public void Report(UploadProgress value) => callback(value); }
    private static void Check(bool value, string description)
    { if (!value) throw new InvalidOperationException("FAIL: " + description); Console.WriteLine("PASS: " + description); }

    public static async Task RunAsync(string caPath, Uri address, string input)
    {
        var settings = JsonSerializer.Deserialize<Settings>(input, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        string PathFor(string name) => Path.Combine(settings.SourceDirectory, name);
        async Task MakeFile(string name, int size)
        {
            await using var stream = new FileStream(PathFor(name), FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192, true);
            byte[] bytes = new byte[8192];
            while (size > 0) { RandomNumberGenerator.Fill(bytes); int count = Math.Min(size, bytes.Length); await stream.WriteAsync(bytes.AsMemory(0, count)); size -= count; }
        }
        void Record(UploadResult result, string source, string username) => Console.WriteLine("UPLOAD_RESULT:" + JsonSerializer.Serialize(new { fileId = result.FileId, source, username }));
        byte[] header = UploadProtocol.EncodeChunk(Guid.Parse("00112233-4455-4677-8899-aabbccddeeff"),
            Guid.Parse("ffeeddcc-bbaa-4988-8776-554433221100"), 0x01020304, new byte[] { 0xa5 });
        Console.WriteLine("UPLOAD_HEADER_HEX:" + Convert.ToHexString(header).ToLowerInvariant());
        await using var a = new SecureConnection(address, caPath);
        await using var b = new SecureConnection(address, caPath);
        await Task.WhenAll(a.ConnectAsync(), b.ConnectAsync());
        await MakeFile("未登录.bin", 1);
        try { await a.UploadFileAsync(PathFor("未登录.bin")); throw new InvalidOperationException("Unauthenticated upload accepted"); }
        catch (ServerRequestException error) { Check(error.Code == "AUTH_REQUIRED", "C# unauthenticated upload is refused"); }
        await Task.WhenAll(a.LoginAsync(settings.Username, settings.Password), b.LoginAsync(settings.SecondUsername, settings.Password));
        Guid connectionId = a.ConnectionId!.Value;
        foreach (int size in new[] { 0, 1, 8191, 8192, 8193, 48017 })
        {
            string name = "中文-" + size + ".bin"; await MakeFile(name, size);
            long last = 0; bool verifying = false;
            var result = await a.UploadFileAsync(PathFor(name), new CallbackProgress(value =>
            {
                Check(value.ConfirmedBytes >= last && value.ConfirmedBytes <= size, "C# progress uses monotonic acknowledged bytes");
                last = value.ConfirmedBytes; verifying |= value.Phase == "正在校验";
            }));
            await using var source = File.OpenRead(PathFor(name));
            Check(result.Size == size && result.Sha256 == Convert.ToHexString(await SHA256.HashDataAsync(source)).ToLowerInvariant() && verifying,
                "C# streamed upload and independent source hash: " + size);
            Record(result, name, settings.Username);
        }
        var duplicate = await a.UploadFileAsync(PathFor("中文-8193.bin")); Record(duplicate, "中文-8193.bin", settings.Username);
        await MakeFile("parallel-a.bin", 65536); await MakeFile("parallel-b.bin", 65536);
        var parallel = await Task.WhenAll(a.UploadFileAsync(PathFor("parallel-a.bin")), b.UploadFileAsync(PathFor("parallel-b.bin")));
        Record(parallel[0], "parallel-a.bin", settings.Username); Record(parallel[1], "parallel-b.bin", settings.SecondUsername);
        Check(a.ConnectionId == connectionId && (await a.MeAsync()).Username == settings.Username, "C# upload completion preserves connection and identity");
        using (var cancel = new CancellationTokenSource())
        {
            try {
                await a.UploadFileAsync(PathFor("parallel-a.bin"), new CallbackProgress(value => { if (value.ConfirmedBytes >= 8192) cancel.Cancel(); }), cancel.Token);
                throw new InvalidOperationException("Upload cancellation ignored");
            } catch (OperationCanceledException) { }
            Check(a.IsConnected && (await a.MeAsync()).Username == settings.Username, "C# normal cancel keeps WSS and authentication");
        }
        Task? logout = null;
        try {
            await a.UploadFileAsync(PathFor("parallel-a.bin"), new CallbackProgress(value => { if (value.ConfirmedBytes >= 8192 && logout is null) logout = a.LogoutAsync(); }));
            throw new InvalidOperationException("Logout did not invalidate upload");
        } catch (Exception error) when (error is OperationCanceledException or ServerRequestException) { }
        await logout!; Check(a.IsConnected && a.Identity is null, "C# logout invalidates upload without restoring identity");
        await a.LoginAsync(settings.Username, settings.Password);
        await using (var heldWriter = new FileStream(PathFor("parallel-a.bin"), FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
        {
            try { await a.UploadFileAsync(PathFor("parallel-a.bin")); throw new InvalidOperationException("Open source writer was not rejected"); }
            catch (IOException) { Check(a.IsConnected, "C# refuses a source already open for writing"); }
        }
        await using (var expiring = new SecureConnection(new Uri(settings.ExpiryAddress), caPath))
        {
            await expiring.ConnectAsync(); await expiring.LoginAsync(settings.Username, settings.Password);
            try {
                await expiring.UploadFileAsync(PathFor("parallel-a.bin"), new CallbackProgress(value => { if (value.ConfirmedBytes == 8192) Thread.Sleep(800); }));
                throw new InvalidOperationException("Expired upload succeeded");
            } catch (Exception error) when (error is OperationCanceledException or ServerRequestException) { }
            Check(expiring.Identity is null, "C# session expiry invalidates upload");
        }
        await MakeFile("ack-loss.bin", 8193);
        await using (var lost = new SecureConnection(new Uri(settings.LostAckAddress), caPath))
        {
            await lost.ConnectAsync(); await lost.LoginAsync(settings.Username, settings.Password);
            try { await lost.UploadFileAsync(PathFor("ack-loss.bin")); throw new InvalidOperationException("Expected lost final ACK"); }
            catch (UploadOutcomeUnknownException) { Check(!lost.IsConnected, "C# reports uncertain commit without automatic retransmission"); }
        }
        await using (var stopping = new SecureConnection(new Uri(settings.StoppingAddress), caPath))
        {
            await stopping.ConnectAsync(); await stopping.LoginAsync(settings.Username, settings.Password);
            try {
                await stopping.UploadFileAsync(PathFor("parallel-a.bin"), new CallbackProgress(value =>
                { if (value.ConfirmedBytes == 8192) { Console.WriteLine("READY_FOR_UPLOAD_STOP"); Thread.Sleep(500); } }));
                throw new InvalidOperationException("Stopped server upload succeeded");
            } catch (Exception error) when (error is IOException or OperationCanceledException or ServerRequestException) { }
            Check(!stopping.IsConnected && stopping.Identity is null, "C# server stop clears uploading connection and identity");
        }
        Console.WriteLine("C# P2 upload checks completed.");
    }
}
