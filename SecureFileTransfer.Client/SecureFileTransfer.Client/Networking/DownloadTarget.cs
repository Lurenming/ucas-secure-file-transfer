namespace SecureFileTransfer.Client.Networking;

// Only the random temporary file created by this instance may be deleted.
internal sealed class DownloadTarget : IAsyncDisposable
{
    public string TargetPath { get; }
    private readonly string temporary;
    private FileStream? stream;
    private bool published;
    public DownloadTarget(string target)
    {
        TargetPath = Path.GetFullPath(target);
        if (File.Exists(TargetPath) || Directory.Exists(TargetPath)) throw new IOException("目标已存在，请另选名称；不会覆盖。");
        string directory = Path.GetDirectoryName(TargetPath) ?? throw new IOException("保存目录无效。");
        temporary = Path.Combine(directory, ".sft-download-" + Guid.NewGuid().ToString("N") + ".part");
        stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
    }
    public Task WriteAsync(byte[] bytes, CancellationToken token) => stream!.WriteAsync(bytes, token).AsTask();
    public async Task CloseForPublishAsync(CancellationToken token)
    {
        await stream!.FlushAsync(token).ConfigureAwait(false);
        stream.Flush(flushToDisk: true);
        await stream.DisposeAsync().ConfigureAwait(false); stream = null;
    }
    public void Publish()
    {
        // Same directory and no overwrite, including a target created after the initial check.
        File.Move(temporary, TargetPath, overwrite: false);
        published = true;
    }
    public async ValueTask DisposeAsync()
    {
        if (stream is not null) { await stream.DisposeAsync().ConfigureAwait(false); stream = null; }
        if (!published) File.Delete(temporary);
    }
}

// Internal deterministic IO fault seam, never supplied by the GUI or a network message.
internal sealed record DownloadFaults(Func<long, Task>? BeforeWrite = null, Func<Task>? BeforePublish = null);
