using System.Buffers.Binary;
using System.Text;

namespace SecureFileTransfer.Client.Networking;

public static class UploadProtocol
{
    public const int ChunkBytes = 8192;
    public const int HeaderBytes = 92;
    public const long MaxFileBytes = 100 * 1024 * 1024;

    public static byte[] EncodeChunk(Guid requestId, Guid uploadId, long offset, ReadOnlySpan<byte> data)
    {
        if (offset < 0 || data.Length is < 1 or > ChunkBytes) throw new ArgumentException("上传块参数无效。");
        byte[] frame = new byte[HeaderBytes + data.Length];
        "SFTU"u8.CopyTo(frame); frame[4] = 1; frame[5] = 1;
        // UUID text has the same byte order everywhere; do not use Guid.ToByteArray().
        Encoding.ASCII.GetBytes(requestId.ToString("D"), frame.AsSpan(8, 36));
        Encoding.ASCII.GetBytes(uploadId.ToString("D"), frame.AsSpan(44, 36));
        BinaryPrimitives.WriteUInt64BigEndian(frame.AsSpan(80, 8), (ulong)offset);
        BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(88, 4), (uint)data.Length);
        data.CopyTo(frame.AsSpan(HeaderBytes));
        return frame;
    }
}

public sealed record UploadProgress(long ConfirmedBytes, long TotalBytes, string Phase);
public sealed record UploadResult(Guid FileId, string Name, long Size, string Sha256);
public sealed class UploadOutcomeUnknownException(Guid? uploadId, Exception inner)
    : IOException($"上传提交结果未确认（标识 {uploadId}）。请人工核对服务器记录；不要自动重传。", inner);
