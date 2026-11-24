using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SecureFileTransfer.Client.Networking;

public sealed partial class SecureConnection
{
    private long RequireIdentity()
    { lock (authLock) { if (identity is null || !IsConnected) throw new ServerRequestException("AUTH_REQUIRED"); return authGeneration; } }
    private void CheckIdentity(long generation)
    { lock (authLock) if (identity is null || generation != authGeneration || !IsConnected) throw new ServerRequestException("AUTH_CANCELLED"); }

    private static RemoteFile ParseFile(JsonElement data)
    {
        Guid id = data.GetProperty("fileId").GetGuid();
        string name = data.GetProperty("name").GetString() ?? "";
        long size = data.GetProperty("size").GetInt64();
        string hash = data.GetProperty("sha256").GetString() ?? "";
        if (name.Length is < 1 or > 120 || Encoding.UTF8.GetByteCount(name) > 240 || Path.GetFileName(name) != name
            || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || size is < 0 or > UploadProtocol.MaxFileBytes
            || !Regex.IsMatch(hash, "^[0-9a-f]{64}$")) throw new InvalidDataException("文件元数据无效。");
        return new(id, name, size, hash, data.GetProperty("committedAt").GetDateTimeOffset());
    }

    public async Task<FilePage> ListFilesAsync(string? cursor = null, int limit = 10, CancellationToken token = default)
    {
        if (limit is < 1 or > 20 || cursor?.Length > 256) throw new ArgumentException("分页参数无效。");
        long generation = RequireIdentity();
        var reply = await ControlAsync("FILES_LIST", new { cursor, limit }, generation, token).ConfigureAwait(false);
        CheckIdentity(generation);
        var data = reply.GetProperty("data");
        var files = data.GetProperty("files");
        if (files.ValueKind != JsonValueKind.Array || files.GetArrayLength() > limit) throw new InvalidDataException("文件列表超过页大小。");
        var result = files.EnumerateArray().Select(ParseFile).ToArray();
        string? next = data.GetProperty("nextCursor").GetString();
        if (next?.Length > 256 || (next is not null && result.Length == 0)) throw new InvalidDataException("分页游标无效。");
        return new(result, next);
    }

    private void HandleDownloadFrame(byte[] bytes)
    {
        DownloadBlock block = DownloadProtocol.DecodeChunk(bytes);
        if (!pending.TryGetValue(block.RequestId, out var waiting)) return; // Valid but late reply to a timed-out request.
        if (waiting.BinaryResult is null || waiting.ExpectedType != "DOWNLOAD_CHUNK_RESULT"
            || block.DownloadId != waiting.DownloadId || block.Offset != waiting.Offset || block.Data.Length != waiting.Length)
            throw new InvalidDataException("下载块与当前请求不匹配。");
        try { CheckIdentity(waiting.AuthGeneration); }
        catch (ServerRequestException error) { waiting.Fail(error); return; }
        waiting.BinaryResult.TrySetResult(block);
    }

    private async Task<DownloadBlock> RequestDownloadChunkAsync(Guid downloadId, long offset, int length, long generation)
    {
        bool admitted = false;
        Guid requestId = Guid.NewGuid();
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new { version = 1, type = "DOWNLOAD_CHUNK", requestId, data = new { downloadId, offset } });
        try
        {
            CheckIdentity(generation);
            if (!await requestSlots.WaitAsync(0, lifetime.Token).ConfigureAwait(false)) throw new InvalidOperationException("最多允许 8 个待完成请求。");
            admitted = true;
            var completion = new TaskCompletionSource<DownloadBlock>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending[requestId] = new("DOWNLOAD_CHUNK_RESULT", generation, null, null, completion, downloadId, offset, length);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(120));
            await SendFrameAsync(body, timeout.Token).ConfigureAwait(false);
            return await completion.Task.WaitAsync(timeout.Token).ConfigureAwait(false);
        }
        finally { pending.TryRemove(requestId, out _); if (admitted) requestSlots.Release(); }
    }

    public Task<DownloadResult> DownloadFileAsync(Guid fileId, string targetPath, IProgress<DownloadProgress>? progress = null, CancellationToken token = default)
        => DownloadCoreAsync(fileId, targetPath, progress, token, null);
    internal Task<DownloadResult> DownloadFileWithFaultsAsync(Guid fileId, string targetPath, DownloadFaults faults,
        IProgress<DownloadProgress>? progress = null, CancellationToken token = default)
        => DownloadCoreAsync(fileId, targetPath, progress, token, faults);

    private async Task<DownloadResult> DownloadCoreAsync(Guid fileId, string targetPath, IProgress<DownloadProgress>? progress, CancellationToken token, DownloadFaults? faults)
    {
        long generation = RequireIdentity();
        var cancellation = AcquireTransfer("download", token);
        bool began = false, finished = false;
        try
        {
            return await Task.Run(async () =>
            {
                void Check() { cancellation.Token.ThrowIfCancellationRequested(); CheckIdentity(generation); }
                Check();
                await using var target = new DownloadTarget(targetPath);
                began = true;
                var response = await ControlAsync("DOWNLOAD_BEGIN", new { fileId }, generation).ConfigureAwait(false);
                Check();
                var data = response.GetProperty("data");
                RemoteFile file = ParseFile(data);
                Guid downloadId = data.GetProperty("downloadId").GetGuid();
                if (file.FileId != fileId || data.GetProperty("chunkBytes").GetInt32() != UploadProtocol.ChunkBytes)
                    throw new InvalidDataException("下载元数据与请求不匹配。");
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                long written = 0;
                progress?.Report(new(0, file.Size, "正在下载"));
                while (written < file.Size)
                {
                    Check();
                    int expected = (int)Math.Min(UploadProtocol.ChunkBytes, file.Size - written);
                    DownloadBlock block = await RequestDownloadChunkAsync(downloadId, written, expected, generation).ConfigureAwait(false);
                    Check();
                    if (faults?.BeforeWrite is not null) await faults.BeforeWrite(written).ConfigureAwait(false);
                    Check();
                    await target.WriteAsync(block.Data, cancellation.Token).ConfigureAwait(false);
                    Check(); hash.AppendData(block.Data); written += block.Data.Length;
                    progress?.Report(new(written, file.Size, "正在下载"));
                }
                Check(); progress?.Report(new(written, file.Size, "正在校验"));
                string digest = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                if (written != file.Size || digest != file.Sha256) throw new InvalidDataException("下载大小或 SHA-256 校验失败，未发布目标文件。");
                var complete = await ControlAsync("DOWNLOAD_COMPLETE", new { downloadId }, generation).ConfigureAwait(false);
                Check();
                var confirmation = complete.GetProperty("data");
                if (confirmation.GetProperty("downloadId").GetGuid() != downloadId || confirmation.GetProperty("fileId").GetGuid() != fileId
                    || confirmation.GetProperty("size").GetInt64() != written || confirmation.GetProperty("sha256").GetString() != digest)
                    throw new InvalidDataException("下载最终确认无效。");
                finished = true;
                await target.CloseForPublishAsync(cancellation.Token).ConfigureAwait(false);
                if (faults?.BeforePublish is not null) await faults.BeforePublish().ConfigureAwait(false);
                lock (authLock) { Check(); target.Publish(); } // No await between final session check and non-overwriting publication.
                progress?.Report(new(written, file.Size, "下载成功"));
                return new DownloadResult(file, target.TargetPath);
            }, CancellationToken.None).ConfigureAwait(false);
        }
        catch
        {
            if (began && !finished && IsConnected)
            {
                try { await ControlAsync("DOWNLOAD_CANCEL", new { }, generation).ConfigureAwait(false); }
                catch (ServerRequestException error) when (error.Code is "AUTH_REQUIRED" or "DOWNLOAD_NOT_FOUND") { }
                catch { await DisconnectAsync().ConfigureAwait(false); }
            }
            throw;
        }
        finally { ReleaseTransfer(cancellation); }
    }
}
