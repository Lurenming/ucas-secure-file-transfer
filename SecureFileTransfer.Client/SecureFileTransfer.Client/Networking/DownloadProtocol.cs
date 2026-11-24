using System.Buffers.Binary;
using System.Text;
using System.Text.RegularExpressions;

namespace SecureFileTransfer.Client.Networking;

public sealed record RemoteFile(Guid FileId, string Name, long Size, string Sha256, DateTimeOffset CommittedAt);
public sealed record FilePage(IReadOnlyList<RemoteFile> Files, string? NextCursor);
public sealed record DownloadProgress(long WrittenBytes, long TotalBytes, string Phase);
public sealed record DownloadResult(RemoteFile File, string SavedPath);
public sealed record DownloadBlock(Guid RequestId, Guid DownloadId, long Offset, byte[] Data);

public static class DownloadProtocol
{
    private static readonly Regex Uuid = new("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    public static byte[] EncodeChunk(Guid requestId, Guid downloadId, long offset, ReadOnlySpan<byte> data)
    {
        byte[] frame = UploadProtocol.EncodeChunk(requestId, downloadId, offset, data);
        "SFTD"u8.CopyTo(frame); frame[5] = 2;
        return frame;
    }
    public static DownloadBlock DecodeChunk(byte[] frame)
    {
        if (frame.Length < UploadProtocol.HeaderBytes || !frame.AsSpan(0, 4).SequenceEqual("SFTD"u8)
            || frame[4] != 1 || frame[5] != 2 || frame[6] != 0 || frame[7] != 0)
            throw new InvalidDataException("下载二进制头无效。");
        string request = Encoding.Latin1.GetString(frame, 8, 36), download = Encoding.Latin1.GetString(frame, 44, 36);
        ulong offset = BinaryPrimitives.ReadUInt64BigEndian(frame.AsSpan(80, 8));
        uint count = BinaryPrimitives.ReadUInt32BigEndian(frame.AsSpan(88, 4));
        if (!Uuid.IsMatch(request) || !Uuid.IsMatch(download) || offset > (ulong)UploadProtocol.MaxFileBytes
            || count is < 1 or > UploadProtocol.ChunkBytes || frame.Length != UploadProtocol.HeaderBytes + count)
            throw new InvalidDataException("下载块标识、偏移或长度无效。");
        return new(Guid.Parse(request), Guid.Parse(download), (long)offset, frame.AsSpan(UploadProtocol.HeaderBytes).ToArray());
    }
}
