namespace SecureFileTransfer.Client;

// A fast local transfer can report thousands of blocks before WinForms paints.
// Keep only the latest value and render on a UI timer instead of posting one
// message per block, so input, cancellation and identity changes remain usable.
internal sealed class UiTransferProgress<T> : IProgress<T>, IDisposable
{
    private readonly object gate = new();
    private readonly System.Windows.Forms.Timer timer;
    private readonly Action<T> render;
    private T? latest;
    private bool pending, disposed;

    // Construct and dispose on the UI thread; Report may run on a worker.
    public UiTransferProgress(Action<T> render)
    {
        this.render = render;
        timer = new System.Windows.Forms.Timer { Interval = 100 };
        timer.Tick += OnTick;
        timer.Start();
    }

    public void Report(T value)
    {
        lock (gate)
        {
            if (disposed) return;
            latest = value;
            pending = true;
        }
    }

    private void OnTick(object? sender, EventArgs e)
    {
        T value;
        lock (gate)
        {
            if (disposed || !pending) return;
            value = latest!;
            latest = default;
            pending = false;
        }
        render(value);
    }

    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            pending = false;
            latest = default;
        }
        timer.Stop();
        timer.Tick -= OnTick;
        timer.Dispose();
    }
}
