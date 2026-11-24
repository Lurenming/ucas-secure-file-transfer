namespace SecureFileTransfer.Client.Networking;

public sealed partial class SecureConnection
{
    private readonly object transferLock = new();
    private CancellationTokenSource? transferCancellation;
    private string? transferKind;
    public long IdentityGeneration { get { lock (authLock) return authGeneration; } }

    private CancellationTokenSource AcquireTransfer(string kind, CancellationToken token)
    {
        lock (transferLock)
        {
            if (transferCancellation is not null) throw new ServerRequestException("TRANSFER_BUSY");
            transferKind = kind;
            return transferCancellation = CancellationTokenSource.CreateLinkedTokenSource(token);
        }
    }
    private void ReleaseTransfer(CancellationTokenSource cancellation)
    {
        lock (transferLock)
        {
            if (ReferenceEquals(transferCancellation, cancellation)) { transferCancellation = null; transferKind = null; }
            cancellation.Dispose();
        }
    }
    private void CancelTransfer(string? kind = null)
    { lock (transferLock) if (kind is null || kind == transferKind) transferCancellation?.Cancel(); }
    public void CancelUpload() => CancelTransfer("upload");
    public void CancelDownload() => CancelTransfer("download");
}
