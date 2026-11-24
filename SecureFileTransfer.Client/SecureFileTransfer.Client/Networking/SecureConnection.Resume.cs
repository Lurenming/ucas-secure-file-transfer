using System.Security.Cryptography;
using System.Text.Json;

namespace SecureFileTransfer.Client.Networking;

public sealed partial class SecureConnection
{
    private void CheckTask(TransferState state)
    {
        RequireCapability("resume-v1");
        if (state.Owner != Identity?.UserId || state.Endpoint != address.AbsoluteUri) throw new InvalidOperationException("任务与当前服务器/用户不匹配，请重新认证原账户。");
    }
    public async Task<UploadResult> ResumeUploadAsync(TransferState state, IProgress<TransferProgress>? progress = null, CancellationToken token = default)
    {
        CheckTask(state); long generation = RequireIdentity();
        var cancellation = AcquireTransfer("upload", token);
        try
        {
            return await Task.Run(async () =>
            {
                void Check() { cancellation.Token.ThrowIfCancellationRequested(); CheckIdentity(generation); }
                Check();
                await using var source = new FileStream(state.LocalPath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
                if (source.Length > UploadProtocol.MaxFileBytes) throw new IOException("文件超过 100 MiB。");
                progress?.Report(new(state.Offset, source.Length, "核对源文件"));
                string digest = Convert.ToHexString(await SHA256.HashDataAsync(source, cancellation.Token).ConfigureAwait(false)).ToLowerInvariant();
                Check();
                string name = Path.GetFileName(state.LocalPath);
                if (state.UploadId.HasValue && (state.Size != source.Length || state.Sha256 != digest || state.Name != name))
                    throw new IOException("源文件已变化，拒绝错误续传；可取消旧任务后新建上传。");
                state.Size = source.Length; state.Sha256 = digest; state.Name = name;
                if (state.UploadId.HasValue)
                {
                    var status = (await ControlAsync("UPLOAD_STATUS", new { uploadId = state.UploadId }, generation).ConfigureAwait(false)).GetProperty("data");
                    if (status.GetProperty("sha256").GetString() != digest || status.GetProperty("size").GetInt64() != state.Size) throw new IOException("服务器任务身份不匹配。");
                    if (status.GetProperty("state").GetString() == "committed")
                    { state.Offset = state.Size; await state.SaveAsync().ConfigureAwait(false); return new UploadResult(state.UploadId.Value, name, state.Size, digest); }
                }
                var begin = await ControlAsync(state.UploadId.HasValue ? "UPLOAD_RESUME" : "UPLOAD_OPEN",
                    new { uploadId = state.UploadId, name, size = state.Size, sha256 = digest }, generation).ConfigureAwait(false);
                var data = begin.GetProperty("data");
                state.UploadId = data.GetProperty("uploadId").GetGuid(); state.Offset = data.GetProperty("received").GetInt64();
                if (state.Offset < 0 || state.Offset > state.Size || data.GetProperty("chunkBytes").GetInt32() != UploadProtocol.ChunkBytes) throw new IOException("服务器恢复位置无效。");
                await state.SaveAsync().ConfigureAwait(false); source.Position = state.Offset;
                byte[] buffer = new byte[UploadProtocol.ChunkBytes];
                progress?.Report(new(state.Offset, state.Size, "上传中"));
                while (state.Offset < state.Size)
                {
                    Check();
                    int count = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, state.Size - state.Offset)), cancellation.Token).ConfigureAwait(false);
                    if (count == 0) throw new IOException("源文件提前结束。");
                    Guid request = Guid.NewGuid();
                    var reply = await RequestAsync(request, "UPLOAD_CHUNK_RESULT", UploadProtocol.EncodeChunk(request, state.UploadId.Value, state.Offset, buffer.AsSpan(0, count)), generation, null, lifetime.Token, true).ConfigureAwait(false);
                    var ack = reply.GetProperty("data");
                    if (ack.GetProperty("uploadId").GetGuid() != state.UploadId || ack.GetProperty("received").GetInt64() != state.Offset + count) throw new IOException("恢复分块确认无效。");
                    state.Offset += count; await state.SaveAsync().ConfigureAwait(false); progress?.Report(new(state.Offset, state.Size, "上传中"));
                }
                Check();
                var result = (await ControlAsync("UPLOAD_COMPLETE", new { uploadId = state.UploadId, sha256 = digest }, generation).ConfigureAwait(false)).GetProperty("data");
                if (result.GetProperty("fileId").GetGuid() != state.UploadId || result.GetProperty("size").GetInt64() != state.Size || result.GetProperty("sha256").GetString() != digest) throw new IOException("上传最终确认无效，请恢复任务查询真实状态。");
                return new UploadResult(state.UploadId.Value, name, state.Size, digest);
            }).ConfigureAwait(false);
        }
        catch
        {
            if (IsConnected && Identity is not null)
            {
                try { await ControlAsync("UPLOAD_PAUSE", new { uploadId = state.UploadId }, generation).ConfigureAwait(false); }
                catch (ServerRequestException error) when (error.Code is "UPLOAD_NOT_FOUND" or "UPLOAD_ALREADY_COMMITTED") { }
                catch { await DisconnectAsync().ConfigureAwait(false); }
            }
            throw;
        }
        finally { ReleaseTransfer(cancellation); }
    }

    public async Task<DownloadResult> ResumeDownloadAsync(TransferState state, IProgress<TransferProgress>? progress = null, CancellationToken token = default)
    {
        CheckTask(state); long generation = RequireIdentity();
        var cancellation = AcquireTransfer("download", token);
        Guid? downloadId = null;
        try
        {
            return await Task.Run(async () =>
            {
                void Check() { cancellation.Token.ThrowIfCancellationRequested(); CheckIdentity(generation); }
                Check();
                RemoteFile file = state.File ?? throw new IOException("缺少下载文件身份。");
                if (System.IO.File.Exists(state.LocalPath)) throw new IOException("目标文件已存在，禁止覆盖。");
                await state.CheckPartAsync(cancellation.Token).ConfigureAwait(false);
                bool exists = System.IO.File.Exists(state.PartPath);
                await using var target = new FileStream(state.PartPath, exists ? FileMode.Open : FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read, 65536, true);
                if (!exists) { state.PartCreatedUtcTicks = System.IO.File.GetCreationTimeUtc(state.PartPath).Ticks; await state.SaveAsync().ConfigureAwait(false); }
                // A crash can leave a fully written block beyond the last atomic metadata save.
                // CheckPart verified the persisted prefix; discard only this task's uncheckpointed suffix.
                if (target.Length > state.Offset) { target.SetLength(state.Offset); target.Flush(true); }
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                byte[] buffer = new byte[65536];
                for (int count; (count = await target.ReadAsync(buffer, cancellation.Token).ConfigureAwait(false)) > 0;) hash.AppendData(buffer, 0, count);
                var data = (await ControlAsync("DOWNLOAD_OPEN", new { fileId = file.FileId, size = file.Size, sha256 = file.Sha256, offset = state.Offset, prefixSha256 = state.PrefixSha256 }, generation).ConfigureAwait(false)).GetProperty("data");
                downloadId = data.GetProperty("downloadId").GetGuid();
                if (ParseFile(data) != file || data.GetProperty("offset").GetInt64() != state.Offset) throw new IOException("下载恢复元数据不匹配。");
                progress?.Report(new(state.Offset, state.Size, "下载中"));
                while (state.Offset < file.Size)
                {
                    Check();
                    var block = await RequestDownloadChunkAsync(downloadId.Value, state.Offset, (int)Math.Min(UploadProtocol.ChunkBytes, file.Size - state.Offset), generation).ConfigureAwait(false);
                    Check();
#if SFT_TEST_IO
                    TransferFaults.Check("download-write", state, target);
#endif
                    await target.WriteAsync(block.Data, CancellationToken.None).ConfigureAwait(false);
#if SFT_TEST_IO
                    TransferFaults.Check("download-flush", state, target);
#endif
                    target.Flush(true); hash.AppendData(block.Data); state.Offset += block.Data.Length;
                    state.PrefixSha256 = Convert.ToHexString(hash.GetCurrentHash()).ToLowerInvariant(); await state.SaveAsync().ConfigureAwait(false);
                    progress?.Report(new(state.Offset, state.Size, "下载中"));
                }
                Check();
                if (state.Offset != file.Size || Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() != file.Sha256) throw new IOException("下载完整摘要校验失败。");
                var done = (await ControlAsync("DOWNLOAD_COMPLETE", new { downloadId }, generation).ConfigureAwait(false)).GetProperty("data");
                if (done.GetProperty("fileId").GetGuid() != file.FileId || done.GetProperty("size").GetInt64() != file.Size || done.GetProperty("sha256").GetString() != file.Sha256) throw new IOException("下载完成确认无效。");
                target.Flush(true); await target.DisposeAsync().ConfigureAwait(false);
                lock (authLock) { Check(); System.IO.File.Move(state.PartPath, state.LocalPath, false); }
                return new DownloadResult(file, state.LocalPath);
            }).ConfigureAwait(false);
        }
        finally
        {
            if (downloadId.HasValue && IsConnected && Identity is not null)
            {
                try { await ControlAsync("DOWNLOAD_CANCEL", new { downloadId }, generation).ConfigureAwait(false); }
                catch (ServerRequestException error) when (error.Code is "DOWNLOAD_NOT_FOUND" or "AUTH_REQUIRED") { }
                catch { await DisconnectAsync().ConfigureAwait(false); }
            }
            ReleaseTransfer(cancellation);
        }
    }
}
