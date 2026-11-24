using System.Security.Cryptography;
using System.Text.Json;
using System.Security.AccessControl;
using System.Security.Principal;

namespace SecureFileTransfer.Client.Networking;

public sealed class TransferState
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Direction { get; set; } = "upload";
    public string Endpoint { get; set; } = "";
    public Guid Owner { get; set; }
    public string LocalPath { get; set; } = "";
    public string Name { get; set; } = "";
    public long Size { get; set; }
    public string Sha256 { get; set; } = "";
    public Guid? UploadId { get; set; }
    public RemoteFile? File { get; set; }
    public long Offset { get; set; }
    public long PartCreatedUtcTicks { get; set; }
    public string PrefixSha256 { get; set; } = Convert.ToHexString(SHA256.HashData([])).ToLowerInvariant();
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public string Status { get; set; } = "等待";
    public string Result { get; set; } = "";
    [System.Text.Json.Serialization.JsonIgnore] public string Directory { get; set; } = "";
    [System.Text.Json.Serialization.JsonIgnore] public string RecordPath => Path.Combine(Directory, Id + ".json");
    [System.Text.Json.Serialization.JsonIgnore] public string PartPath => Path.Combine(Directory, Id + ".part");
    private string WritePendingRecord()
    {
#if SFT_TEST_IO
        TransferFaults.Check("record-commit", this);
#endif
        string path = RecordPath + ".new";
        using (var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None))
        { JsonSerializer.Serialize(stream, this); stream.Flush(true); }
        return path;
    }
    public void Save() => System.IO.File.Move(WritePendingRecord(), RecordPath, true);
    public async Task SaveAsync()
    {
        string path = WritePendingRecord();
        // Windows may briefly deny replacement while an observer holds the old record.
        // Retry only the rename of the already flushed new record, never acknowledge
        // a failed commit. Permanent permissions and disk-full failures remain errors.
        int[] delays = [10, 25, 50, 100, 200];
        for (int attempt = 0; ; attempt++)
        {
            try { System.IO.File.Move(path, RecordPath, true); return; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                int code = error.HResult & 0xffff;
                if (!OperatingSystem.IsWindows() || code is not (5 or 32 or 33) || attempt == delays.Length)
                    throw new IOException("本地恢复记录提交失败；请检查任务目录权限和可用空间后恢复。", error);
                await Task.Delay(delays[attempt]).ConfigureAwait(false);
            }
        }
    }
    public async Task CheckPartAsync(CancellationToken token = default)
    {
        if (!System.IO.File.Exists(PartPath)) { if (Offset == 0) return; throw new IOException("恢复临时文件不存在。"); }
        if ((System.IO.File.GetAttributes(PartPath) & FileAttributes.ReparsePoint) != 0 || PartCreatedUtcTicks == 0 || System.IO.File.GetCreationTimeUtc(PartPath).Ticks != PartCreatedUtcTicks) throw new IOException("临时文件归属标记不匹配，拒绝使用或删除。");
        await using var stream = new FileStream(PartPath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
        if (stream.Length < Offset || stream.Length > Size) throw new IOException("临时文件长度与恢复记录不匹配，已保留供检查。");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); byte[] buffer = new byte[65536];
        for (long remaining = Offset; remaining > 0;) {
            int read = await stream.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), token).ConfigureAwait(false);
            if (read == 0) throw new IOException("临时文件提前结束。"); hash.AppendData(buffer, 0, read); remaining -= read;
        }
        string digest = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        if (digest != PrefixSha256) throw new IOException("临时文件摘要与恢复记录不匹配，拒绝恢复或删除。");
    }
    public async Task DeletePartAsync()
    {
        await CheckPartAsync().ConfigureAwait(false);
        if (System.IO.File.Exists(PartPath)) System.IO.File.Delete(PartPath);
    }
    public static string PrepareDirectory(string path)
    {
        string root = Path.GetFullPath(path); System.IO.Directory.CreateDirectory(root);
        if ((System.IO.File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new IOException("任务目录不能是链接。");
        if (OperatingSystem.IsWindows())
        {
            var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(root).SetAccessControl(security);
        }
        return root;
    }
    public static IEnumerable<TransferState> Load(string directory)
    {
        foreach (string path in System.IO.Directory.EnumerateFiles(directory, "*.json").Take(101))
        {
            if (!Guid.TryParseExact(Path.GetFileNameWithoutExtension(path), "D", out var id)) continue;
            TransferState? state;
            try { state = JsonSerializer.Deserialize<TransferState>(System.IO.File.ReadAllText(path)); } catch { continue; }
            if (state is null || state.Id != id || state.Size < 0 || state.Size > UploadProtocol.MaxFileBytes || state.Offset < 0 || state.Offset > state.Size) continue;
            state.Directory = directory;
            if (state.Status is not ("完成" or "已取消")) state.Status = "待恢复";
            yield return state;
        }
    }
}

public sealed record TransferProgress(long Bytes, long Total, string Phase);
