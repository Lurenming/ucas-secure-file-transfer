using System.Security.Cryptography;
using System.Text.Json;

namespace SecureFileTransfer.Client.Networking;

public sealed partial class SecureConnection
{
    public async Task<UploadResult> UploadFileAsync(string path, IProgress<UploadProgress>? progress = null, CancellationToken token = default)
    {
        CancellationTokenSource cancellation;
        long generation;
        lock (authLock)
        {
            if (identity is null || !IsConnected) throw new ServerRequestException("AUTH_REQUIRED");
            generation = authGeneration;
        }
        cancellation = AcquireTransfer("upload", token);
        Guid? uploadId = null;
        bool began = false, completing = false, committed = false;
        try
        {
            // Yield even for cached small files. File opening/reading/hash work never runs on the UI context.
            return await Task.Run(async () =>
            {
                cancellation.Token.ThrowIfCancellationRequested();
                // Windows denies writers/deletion for the entire upload. Fail if a writer already has it open.
                await using var source = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
                    UploadProtocol.ChunkBytes, FileOptions.Asynchronous | FileOptions.SequentialScan);
                long size = source.Length;
                if (size > UploadProtocol.MaxFileBytes) throw new ArgumentException("文件不能超过 100 MiB。");
                string name = Path.GetFileName(path);
                DateTime modified = File.GetLastWriteTimeUtc(path);
                void CheckSession()
                {
                    cancellation.Token.ThrowIfCancellationRequested();
                    lock (authLock)
                        if (generation != authGeneration || identity is null || !IsConnected) throw new ServerRequestException("AUTH_REQUIRED");
                }
                CheckSession();
                began = true;
                var begin = await ControlAsync("UPLOAD_BEGIN", new { name, size }, generation).ConfigureAwait(false);
                var info = begin.GetProperty("data");
                uploadId = info.GetProperty("uploadId").GetGuid();
                if (info.GetProperty("chunkBytes").GetInt32() != UploadProtocol.ChunkBytes) throw new InvalidDataException("上传块大小不匹配。");
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                byte[] buffer = new byte[UploadProtocol.ChunkBytes];
                long confirmed = 0;
                progress?.Report(new(0, size, "正在上传"));
                while (confirmed < size)
                {
                    CheckSession();
                    int count = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, size - confirmed)), cancellation.Token).ConfigureAwait(false);
                    if (count == 0) throw new IOException("源文件提前结束，上传已取消。");
                    hash.AppendData(buffer, 0, count);
                    var requestId = Guid.NewGuid();
                    byte[] frame = UploadProtocol.EncodeChunk(requestId, uploadId.Value, confirmed, buffer.AsSpan(0, count));
                    // User cancel is observed between requests, never halfway through a socket send.
                    var ack = await RequestAsync(requestId, "UPLOAD_CHUNK_RESULT", frame, generation, null, lifetime.Token, binary: true).ConfigureAwait(false);
                    var acknowledged = ack.GetProperty("data");
                    if (acknowledged.GetProperty("uploadId").GetGuid() != uploadId || acknowledged.GetProperty("received").GetInt64() != confirmed + count)
                        throw new InvalidDataException("分块确认与发送进度不匹配。");
                    confirmed += count;
                    progress?.Report(new(confirmed, size, "正在上传"));
                }
                CheckSession();
                if (source.Length != size || File.GetLastWriteTimeUtc(path) != modified
                    || await source.ReadAsync(buffer.AsMemory(0, 1), cancellation.Token).ConfigureAwait(false) != 0)
                    throw new IOException("源文件在上传期间发生变化，上传已取消。");
                string digest = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                progress?.Report(new(size, size, "正在校验"));
                CheckSession();
                completing = true; // Once issued, commit may win a cancellation race. Await its definitive result.
                var finish = await ControlAsync("UPLOAD_COMPLETE", new { uploadId, sha256 = digest }, generation).ConfigureAwait(false);
                var result = finish.GetProperty("data");
                var uploaded = new UploadResult(result.GetProperty("fileId").GetGuid(), result.GetProperty("name").GetString()!,
                    result.GetProperty("size").GetInt64(), result.GetProperty("sha256").GetString()!);
                if (uploaded.FileId != uploadId || uploaded.Size != size || uploaded.Name != name || uploaded.Sha256 != digest)
                    throw new InvalidDataException("最终上传确认不匹配。");
                committed = true;
                progress?.Report(new(size, size, "上传成功"));
                return uploaded;
            }, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            if (completing && error is not ServerRequestException)
            {
                await DisconnectAsync().ConfigureAwait(false);
                throw new UploadOutcomeUnknownException(uploadId, error);
            }
            if (began && !committed && IsConnected)
            {
                try
                {
                    // Omitting the id cancels only this connection's current upload (including a pending BEGIN).
                    await ControlAsync("UPLOAD_CANCEL", new { }, generation).ConfigureAwait(false);
                }
                catch (ServerRequestException cancelError) when (cancelError.Code is "AUTH_REQUIRED" or "UPLOAD_NOT_FOUND") { }
                catch { await DisconnectAsync().ConfigureAwait(false); }
            }
            throw;
        }
        finally
        {
            ReleaseTransfer(cancellation);
        }
    }

    private Task<JsonElement> ControlAsync(string type, object data, long generation, CancellationToken? token = null)
    {
        var requestId = Guid.NewGuid();
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new { version = 1, type, requestId, data });
        return RequestAsync(requestId, type + "_RESULT", body, generation, null, token ?? lifetime.Token);
    }
}
