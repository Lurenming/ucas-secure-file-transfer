using System.Text.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using SecureFileTransfer.Client.Networking;

internal static class EnhancedChecks
{
    sealed class Progress(Action<TransferProgress> action) : IProgress<TransferProgress> { public void Report(TransferProgress value) => action(value); }
    static void Check(bool value, string text) { if (!value) throw new Exception("FAIL: " + text); Console.WriteLine("PASS: " + text); }
    public static async Task RunAsync(string ca, Uri address)
    {
        using var config = JsonDocument.Parse(await Console.In.ReadToEndAsync()); var c = config.RootElement;
        string password = c.GetProperty("password").GetString()!, directory = c.GetProperty("directory").GetString()!;
        string taskDir = TransferState.PrepareDirectory(Path.Combine(directory, "state"));
        await using var control = new SecureConnection(address, ca); await control.ConnectAsync();
        var identity = await control.LoginAsync("alice", password);
        var page = await control.ListFilesAsync(); Check(page.Files.Count == 2, "C# sees isolated seeded files");
        TransferState State(string direction, string path, string name, long size) => new() { Directory = taskDir, Direction = direction, Endpoint = address.AbsoluteUri,
            Owner = identity.UserId, LocalPath = path, Name = name, Size = size };
        var states = new List<TransferState>();
        for (int i = 0; i < 2; i++)
        {
            string path = Path.Combine(directory, $"csharp-parallel-{i}.bin"); await File.WriteAllBytesAsync(path, RandomNumberGenerator.GetBytes(262144));
            states.Add(State("upload", path, Path.GetFileName(path), 262144));
        }
        foreach (var file in page.Files)
        {
            var state = State("download", Path.Combine(directory, "download-" + file.Name), file.Name, file.Size); state.File = file; state.Sha256 = file.Sha256; states.Add(state);
        }
        await using var queue = new TransferQueue(control, address, ca, 4);
        var connectionIds = new System.Collections.Concurrent.ConcurrentBag<Guid>(); queue.WorkerConnected += connectionIds.Add;
        int max = 0;
        queue.Changed += (_, _) => { int running = states.Count(s => s.Status == "传输中"); if (running > max) max = running; };
        await Task.WhenAll(states.Select(queue.Enqueue));
        Check(max == 4 && states.All(s => s.Status == "完成"), "same C# queue truly overlaps two uploads and two downloads");
        Check(connectionIds.Count == 4, "four worker connections authenticated with one control identity");
        foreach (var state in states.Where(s => s.Direction == "download"))
        { Check(new FileInfo(state.LocalPath).Length == state.Size && Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(state.LocalPath))).ToLowerInvariant() == state.Sha256, "C# resumed download publishes verified bytes"); }
        var reusePath = Path.Combine(directory, "reuse.bin"); await File.WriteAllBytesAsync(reusePath, RandomNumberGenerator.GetBytes(8193));
        var reuse = State("upload", reusePath, "reuse.bin", 8193); await queue.Enqueue(reuse);
        Check(reuse.Status == "完成" && connectionIds.Count == 4, "next file reuses an existing authenticated long connection");

        await using var direct = new SecureConnection(address, ca); await direct.ConnectAsync(); await direct.LoginAsync("alice", password);
        string resumePath = Path.Combine(directory, "resume-source.bin"); byte[] original = RandomNumberGenerator.GetBytes(196613); await File.WriteAllBytesAsync(resumePath, original);
        var resumable = State("upload", resumePath, "resume-source.bin", original.Length);
        using (var pause = new CancellationTokenSource())
        {
            try { await direct.ResumeUploadAsync(resumable, new Progress(v => { if (v.Bytes >= 32768) pause.Cancel(); }), pause.Token); }
            catch (OperationCanceledException) { }
        }
        Check(resumable.Offset >= 32768 && resumable.Offset < original.Length && resumable.UploadId.HasValue, "upload pause preserves nonzero durable position");
        await File.WriteAllBytesAsync(resumePath, RandomNumberGenerator.GetBytes(original.Length));
        bool changed = false; try { await direct.ResumeUploadAsync(resumable); } catch (IOException error) { changed = error.Message.Contains("变化"); }
        Check(changed, "changed source rejected before upload resume");
        await File.WriteAllBytesAsync(resumePath, original); await direct.DisconnectAsync();
        await using var resumedConnection = new SecureConnection(address, ca); await resumedConnection.ConnectAsync(); await resumedConnection.LoginAsync("alice", password);
        long startOffset = resumable.Offset; long firstOffset = -1;
        var result = await resumedConnection.ResumeUploadAsync(resumable, new Progress(v => { if (v.Phase == "上传中" && firstOffset < 0) firstOffset = v.Bytes; }));
        Check(firstOffset == startOffset && result.Sha256 == Convert.ToHexString(SHA256.HashData(original)).ToLowerInvariant(), "C# reconnect resumes from server offset with full original digest");
        var listed = (await resumedConnection.ListFilesAsync()).Files.Single(f => f.FileId == result.FileId);
        var download = State("download", Path.Combine(directory, "resumed-download.bin"), listed.Name, listed.Size); download.File = listed; download.Sha256 = listed.Sha256;
        using (var pause = new CancellationTokenSource())
        {
            try { await resumedConnection.ResumeDownloadAsync(download, new Progress(v => { if (v.Bytes >= 32768) pause.Cancel(); }), pause.Token); }
            catch (OperationCanceledException) { }
        }
        Check(download.Offset >= 32768 && File.Exists(download.PartPath) && !File.Exists(download.LocalPath), "download pause retains only its verified temporary prefix");
        await using (var suffix = new FileStream(download.PartPath, FileMode.Append, FileAccess.Write, FileShare.None))
            await suffix.WriteAsync(RandomNumberGenerator.GetBytes(117));
        var reloaded = TransferState.Load(taskDir).Single(s => s.Id == download.Id); long downloadOffset = reloaded.Offset;
        firstOffset = -1;
        await resumedConnection.ResumeDownloadAsync(reloaded, new Progress(v => { if (firstOffset < 0) firstOffset = v.Bytes; }));
        byte[] downloaded = await File.ReadAllBytesAsync(reloaded.LocalPath);
        Check(firstOffset == downloadOffset && original.SequenceEqual(downloaded), "persisted download state reload resumes actual prefix and matches source");
        Check(!File.Exists(reloaded.PartPath), "uncheckpointed crash suffix is removed from owned temporary file before resume");
        bool overwrite = false; try { await resumedConnection.ResumeDownloadAsync(reloaded); } catch (IOException error) { overwrite = error.Message.Contains("覆盖"); }
        byte[] preserved = await File.ReadAllBytesAsync(reloaded.LocalPath);
        Check(overwrite && original.SequenceEqual(preserved), "resume retains existing-target no-overwrite protection");

        string cancelPath = Path.Combine(directory, "cancel-isolated.bin"); await File.WriteAllBytesAsync(cancelPath, RandomNumberGenerator.GetBytes(524288));
        var cancel = State("upload", cancelPath, "cancel-isolated.bin", 524288);
        var survivor = State("upload", resumePath, "resume-source.bin", original.Length);
        Task cancelTask = queue.Enqueue(cancel), survivorTask = queue.Enqueue(survivor);
        while (cancel.Offset == 0) await Task.Delay(20);
        await queue.PauseAsync(cancel, true); await Task.WhenAll(cancelTask, survivorTask);
        Check(cancel.Status == "已取消" && survivor.Status == "完成", "single task cancel cleans its upload while other task completes");

        var logoutTask = State("upload", cancelPath, "cancel-isolated.bin", 524288); Task pending = queue.Enqueue(logoutTask);
        while (logoutTask.Offset == 0) await Task.Delay(20);
        await control.LogoutAsync(); await pending;
        Check(logoutTask.Status != "完成" && control.Identity is null, "window logout stops associated worker tasks");
        Check((await resumedConnection.MeAsync()).UserId == identity.UserId, "independent client identity survives window logout");
        await queue.DisposeAsync();
        await control.LoginAsync("bob", password); Check((await control.ListFilesAsync()).Files.Count == 0, "switching account has isolated file list");
        bool ownerRejected = false; try { await control.ResumeUploadAsync(logoutTask); } catch (InvalidOperationException) { ownerRejected = true; }
        Check(ownerRejected, "old window task cannot resume under switched identity");

        string lostPath = Path.Combine(directory, "lost-confirmation.bin"); await File.WriteAllBytesAsync(lostPath, RandomNumberGenerator.GetBytes(48017));
        var lost = State("upload", lostPath, "lost-confirmation.bin", 48017);
        try { await resumedConnection.ResumeUploadAsync(lost); } catch (Exception) { }
        await using var query = new SecureConnection(address, ca); await query.ConnectAsync(); await query.LoginAsync("alice", password);
        var recovered = await query.ResumeUploadAsync(lost);
        Check(recovered.FileId == lost.UploadId && (await query.ListFilesAsync()).Files.Count(f => f.FileId == lost.UploadId) == 1, "lost completion is resolved by persisted status without duplicate commit");

        using var pem = X509Certificate2.CreateFromPemFile(c.GetProperty("clientCert").GetString()!, c.GetProperty("clientKey").GetString()!);
        // Schannel uses a per-user temporary key container. No PersistKeySet or plaintext key file is created by the client.
        using var client = X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pkcs12), null, X509KeyStorageFlags.UserKeySet);
        var mtlsAddress = new Uri(c.GetProperty("mtlsAddress").GetString()!);
        await using var mtls = new SecureConnection(mtlsAddress, ca, client); await mtls.ConnectAsync();
        Check((await mtls.CertificateLoginAsync()).UserId == identity.UserId, "real C# mTLS authenticates bound account with private key proof");
        await mtls.LogoutAsync(); Check(mtls.Identity is null, "valid TLS certificate alone does not undo business logout");
        bool loginFailed = false; try { await mtls.LoginAsync("alice", password); } catch (ServerRequestException) { loginFailed = true; }
        Check(loginFailed, "mTLS-required refuses password fallback");
        await mtls.CertificateLoginAsync();
        await using var mtlsQueue = new TransferQueue(mtls, mtlsAddress, ca, 2, client);
        var secureJob = State("upload", reusePath, "reuse.bin", 8193); secureJob.Endpoint = mtlsAddress.AbsoluteUri;
        await mtlsQueue.Enqueue(secureJob); Check(secureJob.Status == "完成", "mTLS worker pool presents client certificate and authenticates each socket");
        Console.WriteLine("ENHANCED_CSHARP_COMPLETE");
    }
}
