using System.Security.Cryptography;
using System.Text.Json;
using SecureFileTransfer.Client.Networking;

internal static class DownloadChecks
{
    private sealed record Settings(string Username, string SecondUsername, string Password, string SourceDirectory, string DownloadDirectory,
        string ExpiryAddress, Guid ExpiryFileId, string DownloadStopAddress, Guid DownloadStopFileId, Guid[] DamagedFileIds);
    private sealed class Progress(Action<DownloadProgress> callback) : IProgress<DownloadProgress>
    { public void Report(DownloadProgress value) => callback(value); }
    private static void Check(bool value, string description)
    { if (!value) throw new InvalidOperationException("FAIL: " + description); Console.WriteLine("PASS: " + description); }
    private static async Task Reject(Func<Task> action)
    {
        try { await action(); }
        catch (Exception error) when (error is IOException or InvalidDataException or OperationCanceledException or ServerRequestException or UnauthorizedAccessException) { return; }
        throw new InvalidOperationException("Expected download rejection");
    }
    private static async Task<string> HashFile(string path)
    { await using var stream = File.OpenRead(path); return Convert.ToHexString(await SHA256.HashDataAsync(stream)).ToLowerInvariant(); }

    public static async Task RunAsync(string caPath, Uri address, Uri fragmentedFixture, string input)
    {
        var s = JsonSerializer.Deserialize<Settings>(input, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        string Target(string name) => Path.Combine(s.DownloadDirectory, name);
        void Clean() => Check(Directory.GetFiles(s.DownloadDirectory, ".sft-download-*.part").Length == 0, "C# removes only its unfinished temporary downloads");
        Console.WriteLine("DOWNLOAD_HEADER_HEX:" + Convert.ToHexString(DownloadProtocol.EncodeChunk(Guid.Parse("00112233-4455-4677-8899-aabbccddeeff"),
            Guid.Parse("ffeeddcc-bbaa-4988-8776-554433221100"), 0x01020304, new byte[] { 0xa5 })).ToLowerInvariant());
        await using var a = new SecureConnection(address, caPath);
        await using var b = new SecureConnection(address, caPath);
        await Task.WhenAll(a.ConnectAsync(), b.ConnectAsync());
        await Reject(async () => await a.ListFilesAsync()); await Reject(async () => await a.DownloadFileAsync(Guid.NewGuid(), Target("anonymous.bin")));
        await Task.WhenAll(a.LoginAsync(s.Username, s.Password), b.LoginAsync(s.SecondUsername, s.Password));
        var owned = new List<RemoteFile>(); string? cursor = null;
        do { var page = await a.ListFilesAsync(cursor, 3); owned.AddRange(page.Files); cursor = page.NextCursor; await Task.Delay(210); } while (cursor is not null);
        Check(owned.Select(x => x.FileId).Distinct().Count() == owned.Count && owned.Count > 3, "C# bounded pagination retains distinct file IDs");
        var validFiles = owned.Where(x => File.Exists(Path.Combine(s.SourceDirectory, x.Name))).ToArray();
        Check(validFiles.Select(x => x.Size).Intersect(new long[] { 0, 1, 8191, 8192, 8193, 48017 }).Count() == 6, "C# download boundary fixtures are present");
        Check(validFiles.Count(x => x.Name == "中文-8193.bin") == 2, "C# list preserves same-name files with distinct IDs");
        foreach (var file in validFiles)
        {
            string target = Target(file.FileId + ".bin"); long last = 0; bool verifying = false;
            var result = await a.DownloadFileAsync(file.FileId, target, new Progress(p =>
            { if (p.WrittenBytes < last || p.WrittenBytes > file.Size) throw new InvalidOperationException("Invalid written progress"); last = p.WrittenBytes; verifying |= p.Phase == "正在校验"; }));
            Check(verifying && new FileInfo(target).Length == file.Size && await HashFile(target) == file.Sha256
                && await HashFile(target) == await HashFile(Path.Combine(s.SourceDirectory, file.Name)), "C# actual disk download verified: " + file.Size);
            Console.WriteLine("DOWNLOAD_RESULT:" + JsonSerializer.Serialize(new { fileId = file.FileId, source = file.Name, download = Path.GetFileName(target), username = s.Username }));
        }
        Guid id = validFiles.First(x => x.Size > 8192).FileId;
        var bobPage = await b.ListFilesAsync(); Check(bobPage.Files.All(x => owned.All(y => x.FileId != y.FileId)), "C# Alice/Bob list isolation");
        try { await b.DownloadFileAsync(id, Target("forbidden.bin")); throw new InvalidOperationException("Foreign download accepted"); }
        catch (ServerRequestException error) { Check(error.Code == "FILE_NOT_FOUND", "C# cross-user download is refused"); }
        await using (var again = new SecureConnection(address, caPath))
        {
            await again.ConnectAsync(); await again.LoginAsync(s.Username, s.Password);
            await again.DownloadFileAsync(id, Target("same-account.bin"));
            Check(again.Identity is not null, "C# second connection can download its account's committed file");
        }
        await File.WriteAllTextAsync(Target("existing.bin"), "original user content");
        await Reject(async () => await a.DownloadFileAsync(id, Target("existing.bin")));
        Check(await File.ReadAllTextAsync(Target("existing.bin")) == "original user content", "C# existing destination is untouched");
        await Reject(async () => await a.DownloadFileWithFaultsAsync(id, Target("race.bin"), new(BeforePublish: () => File.WriteAllTextAsync(Target("race.bin"), "race winner"))));
        Check(await File.ReadAllTextAsync(Target("race.bin")) == "race winner", "C# final publication does not overwrite a concurrently created destination"); Clean();
        await Reject(async () => await a.DownloadFileWithFaultsAsync(id, Target("disk-failure.bin"), new(BeforeWrite: _ => throw new IOException("Injected disk write failure"))));
        Check(!File.Exists(Target("disk-failure.bin")), "C# injected write failure never publishes a target"); Clean();
        await Reject(async () => await a.DownloadFileAsync(id, Path.Combine(Target("existing.bin"), "bad.bin")));
        Check(await File.ReadAllTextAsync(Target("existing.bin")) == "original user content", "C# invalid/unwritable destination path preserves existing file");
        using (var cancel = new CancellationTokenSource())
        {
            await Reject(async () => await a.DownloadFileAsync(id, Target("cancel.bin"), new Progress(p => { if (p.WrittenBytes >= 8192) cancel.Cancel(); }), cancel.Token));
            Check(!File.Exists(Target("cancel.bin")) && (await a.MeAsync()).Username == s.Username, "C# cancellation keeps connection and identity without publishing"); Clean();
        }
        foreach (Guid damaged in s.DamagedFileIds)
        {
            await Reject(async () => await a.DownloadFileAsync(damaged, Target(damaged + ".bad")));
            Check(!File.Exists(Target(damaged + ".bad")), "C# missing/truncated/corrupt source never appears successful"); Clean();
        }
        Task? logout = null;
        await Reject(async () => await a.DownloadFileAsync(id, Target("logout.bin"), new Progress(p => { if (p.WrittenBytes == 8192 && logout is null) logout = a.LogoutAsync(); })));
        await logout!; Check(a.Identity is null && a.IsConnected && !File.Exists(Target("logout.bin")), "C# logout invalidates active download"); Clean();
        await a.LoginAsync(s.Username, s.Password);
        var bobFile = bobPage.Files.First();
        var upload = a.UploadFileAsync(Path.Combine(s.SourceDirectory, "parallel-a.bin"));
        var downloaded = b.DownloadFileAsync(bobFile.FileId, Target("parallel-b.bin"));
        await Task.WhenAll(upload, downloaded, b.MeAsync());
        Console.WriteLine("UPLOAD_RESULT:" + JsonSerializer.Serialize(new { fileId = upload.Result.FileId, source = "parallel-a.bin", username = s.Username }));
        Console.WriteLine("DOWNLOAD_RESULT:" + JsonSerializer.Serialize(new { fileId = bobFile.FileId, source = bobFile.Name, download = "parallel-b.bin", username = s.SecondUsername }));
        Check(a.IsConnected && b.IsConnected, "C# Alice upload and Bob download coexist with AUTH_ME");
        using (var cancelled = new CancellationTokenSource())
        {
            await Reject(async () => await a.DownloadFileWithFaultsAsync(id, Target("late-cancel.bin"), new(BeforePublish: () => { cancelled.Cancel(); return Task.CompletedTask; }), token: cancelled.Token));
            Check(!File.Exists(Target("late-cancel.bin")), "C# cancel after final server response still prevents local publication"); Clean();
        }
        await using (var expiring = new SecureConnection(new Uri(s.ExpiryAddress), caPath))
        {
            await expiring.ConnectAsync(); await expiring.LoginAsync(s.Username, s.Password);
            await Reject(async () => await expiring.DownloadFileAsync(s.ExpiryFileId, Target("expiry.bin"), new Progress(p => { if (p.WrittenBytes == 8192) Thread.Sleep(800); })));
            Check(expiring.Identity is null && !File.Exists(Target("expiry.bin")), "C# session expiry cleans incomplete download"); Clean();
        }
        Task? disconnect = null;
        await Reject(async () => await a.DownloadFileAsync(id, Target("disconnect.bin"), new Progress(p => { if (p.WrittenBytes == 8192 && disconnect is null) disconnect = a.DisconnectAsync(); })));
        await disconnect!; Check(a.Identity is null && !File.Exists(Target("disconnect.bin")), "C# disconnect cleans download without inheriting identity"); Clean();
        await using (var stop = new SecureConnection(new Uri(s.DownloadStopAddress), caPath))
        {
            await stop.ConnectAsync(); await stop.LoginAsync(s.Username, s.Password);
            await Reject(async () => await stop.DownloadFileAsync(s.DownloadStopFileId, Target("server-stop.bin"), new Progress(p =>
            { if (p.WrittenBytes == 8192) { Console.WriteLine("READY_FOR_DOWNLOAD_STOP"); Thread.Sleep(500); } })));
            Check(!stop.IsConnected && stop.Identity is null && !File.Exists(Target("server-stop.bin")), "C# server stop closes download and clears identity"); Clean();
        }
        await using (var late = new SecureConnection(fragmentedFixture, caPath))
        {
            await late.ConnectAsync(); await late.LoginAsync(s.Username, s.Password);
            var listing = late.ListFilesAsync(); await late.LogoutAsync();
            await Reject(async () => await listing);
            Check(late.Identity is null, "C# stale list response cannot cross an authentication generation");
        }
        Console.WriteLine("C# P3 download checks completed.");
    }
}
