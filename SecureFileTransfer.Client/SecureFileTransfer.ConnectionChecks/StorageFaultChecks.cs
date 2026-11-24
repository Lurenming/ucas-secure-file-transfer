using System.Security.Cryptography;
using System.Text.Json;
using SecureFileTransfer.Client.Networking;

internal static class StorageFaultChecks
{
    static void Check(bool value, string description) { if (!value) throw new Exception(description); }
    static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    static async Task Report(object value)
    {
        Console.WriteLine(JsonSerializer.Serialize(value));
        if (await Console.In.ReadLineAsync() != "ok") throw new IOException("Fixture verification failed");
    }
    public static async Task RunAsync(string ca, Uri address)
    {
        using var config = JsonDocument.Parse((await Console.In.ReadLineAsync())!); var c = config.RootElement;
        string root = c.GetProperty("directory").GetString()!, password = c.GetProperty("password").GetString()!;
        string stateDir = TransferState.PrepareDirectory(Path.Combine(root, "state"));
        if (OperatingSystem.IsWindows())
        {
            var checkpoint = new TransferState { Directory = stateDir, Size = 65539 };
            checkpoint.Save(); checkpoint.Offset = 8192;
            var held = File.Open(checkpoint.RecordPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            bool oldOperationRejected = false;
            try { checkpoint.Save(); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { oldOperationRejected = true; }
            Check(oldOperationRejected, "The previous synchronous replacement must reproduce the real Windows sharing failure");
            Task commit = checkpoint.SaveAsync(); await Task.Delay(70);
            Check(!commit.IsCompleted, "Transient sharing denial must wait asynchronously for the old reader");
            held.Dispose(); await commit.WaitAsync(TimeSpan.FromSeconds(3));
            Check(TransferState.Load(stateDir).Single(s => s.Id == checkpoint.Id).Offset == 8192, "Replacement succeeds after reader releases record");
            checkpoint.Offset = 16384;
            using (File.Open(checkpoint.RecordPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                bool rejected = false;
                try { await checkpoint.SaveAsync().WaitAsync(TimeSpan.FromSeconds(3)); } catch (IOException) { rejected = true; }
                Check(rejected && TransferState.Load(stateDir).Single(s => s.Id == checkpoint.Id).Offset == 8192,
                    "Persistent sharing denial is bounded and preserves the last committed checkpoint");
            }
            await checkpoint.SaveAsync();
            await Report(new { kind = "checkpointContention", realWindowsFileLock = true, transientRecovered = true,
                persistentDenied = true, oldCheckpointPreserved = true, maxRenameAttempts = 6, maxRetryDelayMilliseconds = 385 });
        }
        await using var alice = new SecureConnection(address, ca); await alice.ConnectAsync(); var a = await alice.LoginAsync("alice", password);
        await using var bob = new SecureConnection(address, ca); await bob.ConnectAsync(); var b = await bob.LoginAsync("bob", password);
        await using var qa = new TransferQueue(alice, address, ca, 4);
        await using var qb = new TransferQueue(bob, address, ca, 4);
        var file = (await alice.ListFilesAsync()).Files.Single();
        TransferState New(string direction, string name, Guid owner) => new() { Directory = stateDir, Endpoint = address.AbsoluteUri,
            Owner = owner, Direction = direction, LocalPath = Path.Combine(root, name), Name = name, Size = 65539 };
        var initial = New("upload", "initial-record-failure.bin", a.UserId);
        byte[] initialBytes = RandomNumberGenerator.GetBytes((int)initial.Size); await File.WriteAllBytesAsync(initial.LocalPath, initialBytes);
        TransferFaults.BeforeIo = (where, current, _) => { if (where == "record-commit" && current.Id == initial.Id) throw new IOException("SIMULATED ERROR_DISK_FULL before queue registration commit", unchecked((int)0x80070070)); };
        bool initialRejected = false;
        try { _ = qa.Enqueue(initial); } catch (IOException) { initialRejected = true; } finally { TransferFaults.BeforeIo = null; }
        Check(initialRejected && initial.Status == "待恢复" && qa.Running == 0, "Initial save failure must not strand a registered queue job");
        await qa.Enqueue(initial).WaitAsync(TimeSpan.FromSeconds(40));
        Check(initial.Status == "完成" && initial.Sha256 == Hash(initialBytes), "Retry of same job after initial disk-full failure must work");
        await Report(new { kind = "initialRecordFailureRecovered", simulated = true, sha256 = initial.Sha256, initial.Size });
        foreach (string phase in new[] { "write", "flush", "checkpoint", "precommit", "commit" })
        {
            var state = New("upload", "fault-" + phase + ".bin", a.UserId);
            var survivor = New("upload", "survivor-" + phase + ".bin", b.UserId);
            byte[] source = RandomNumberGenerator.GetBytes((int)state.Size);
            await File.WriteAllBytesAsync(state.LocalPath, source); await File.WriteAllBytesAsync(survivor.LocalPath, source);
            await Task.WhenAll(qa.Enqueue(state), qb.Enqueue(survivor)).WaitAsync(TimeSpan.FromSeconds(40));
            Check(state.Status == "待恢复" && state.Offset >= 8192 && state.UploadId.HasValue, "Server fault must leave explicit recoverable task: " + state.Result);
            Check(survivor.Status == "完成", "Other account must survive isolated injected write failure");
            await Report(new { kind = "serverFault", phase, id = state.UploadId, confirmed = state.Offset, state.Status, survivor = survivor.UploadId });
            await qa.Enqueue(state).WaitAsync(TimeSpan.FromSeconds(40));
            Check(state.Status == "完成" && state.Sha256 == Hash(source), "Resume after cleared server fault failed: " + state.Result);
            await Report(new { kind = "recovered", phase, id = state.UploadId, size = state.Size, sha256 = state.Sha256 });
        }
        foreach (string phase in new[] { "download-write", "download-flush", "record-commit" })
        {
            var state = New("download", phase + ".bin", a.UserId); state.File = file; state.Size = file.Size; state.Sha256 = file.Sha256;
            var survivor = New("download", "survivor-" + phase + ".bin", a.UserId); survivor.File = file; survivor.Size = file.Size; survivor.Sha256 = file.Sha256;
            bool fired = false;
            TransferFaults.BeforeIo = (where, current, stream) =>
            {
                if (current.Id != state.Id || where != phase || current.Offset < (phase == "record-commit" ? 16384 : 8192)) return;
                if (fired && phase != "record-commit") return;
                fired = true;
                if (phase == "download-write") stream!.Write(new byte[117]); // Partial write before ENOSPC.
                throw new IOException("SIMULATED ERROR_DISK_FULL at " + phase, unchecked((int)0x80070070));
            };
            try { await Task.WhenAll(qa.Enqueue(state), qa.Enqueue(survivor)).WaitAsync(TimeSpan.FromSeconds(40)); }
            finally { TransferFaults.BeforeIo = null; }
            Check(fired && state.Status == "待恢复" && !File.Exists(state.LocalPath), "Failed download must not publish or stay running");
            Check(survivor.Status == "完成", "Other download must survive task-specific fault");
            using (File.Open(state.PartPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            var recovered = TransferState.Load(stateDir).Single(s => s.Id == state.Id);
            long saved = recovered.Offset; Check(saved >= 8192 && saved < file.Size, "Persisted prefix must be bounded and nonzero");
            await recovered.CheckPartAsync(); await qa.Enqueue(recovered).WaitAsync(TimeSpan.FromSeconds(40));
            Check(recovered.Status == "完成" && new FileInfo(recovered.LocalPath).Length == file.Size && Hash(await File.ReadAllBytesAsync(recovered.LocalPath)) == file.Sha256, "Actual download recovery digest mismatch");
            Check(!File.Exists(recovered.PartPath), "Completed download part must be released");
            await Report(new { kind = "clientFaultRecovered", phase, savedOffset = saved, size = file.Size, sha256 = file.Sha256, handleReleased = true, survivor.Status });
        }
        var existing = New("download", "existing-target.bin", a.UserId); existing.File = file; existing.Sha256 = file.Sha256;
        byte[] sentinel = RandomNumberGenerator.GetBytes(23); await File.WriteAllBytesAsync(existing.LocalPath, sentinel);
        await qa.Enqueue(existing); byte[] existingBytes = await File.ReadAllBytesAsync(existing.LocalPath);
        Check(existing.Status == "待恢复" && sentinel.SequenceEqual(existingBytes), "Existing target overwritten");
        await qa.DisposeAsync(); await qb.DisposeAsync(); await alice.DisconnectAsync(); await bob.DisconnectAsync();
        await Report(new { kind = "done", serverScenarios = 5, clientScenarios = 4, existingTargetPreserved = true, diskFullScenariosAreSimulated = true });
    }
}
