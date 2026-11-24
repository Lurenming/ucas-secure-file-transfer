using System.Threading.Channels;
using System.Collections.Concurrent;
using System.Security.Cryptography.X509Certificates;

namespace SecureFileTransfer.Client.Networking;

// One control socket plus 1..8 reusable authenticated worker sockets in a window.
public sealed class TransferQueue : IAsyncDisposable
{
    private sealed class Job(TransferState state)
    {
        public TransferState State = state;
        public CancellationTokenSource Stop = new();
        public bool Cancel;
        public TaskCompletionSource Done = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    private readonly SecureConnection control;
    private readonly Uri address;
    private readonly string ca;
    private readonly X509Certificate2? certificate;
    private readonly Guid owner;
    private readonly Channel<Job> channel = Channel.CreateBounded<Job>(new BoundedChannelOptions(100) { FullMode = BoundedChannelFullMode.Wait });
    private readonly ConcurrentDictionary<Guid, Job> jobs = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim attachGate = new(1);
    private readonly Task[] workers;
    private bool disposed;
    public event Action<TransferState, TransferProgress?>? Changed;
    public event Action<Guid>? WorkerConnected;
    public int Running => jobs.Values.Count(j => j.State.Status == "传输中");
    public TransferQueue(SecureConnection control, Uri address, string ca, int concurrency = 4, X509Certificate2? certificate = null)
    {
        if (concurrency is < 1 or > 8) throw new ArgumentOutOfRangeException(nameof(concurrency));
        control.RequireCapability("window-auth-v1"); control.RequireCapability("resume-v1");
        this.control = control; this.address = address; this.ca = ca; this.certificate = certificate;
        owner = control.Identity?.UserId ?? throw new ServerRequestException("AUTH_REQUIRED");
        control.IdentityChanged += OnIdentity;
        workers = Enumerable.Range(0, concurrency).Select(_ => Task.Run(WorkerAsync)).ToArray();
    }
    private void OnIdentity() { if (control.Identity?.UserId != owner) StopAll(); }
    public Task Enqueue(TransferState state)
    {
        if (disposed || lifetime.IsCancellationRequested || control.Identity?.UserId != owner) throw new ServerRequestException("AUTH_REQUIRED");
        if (state.Owner != owner || state.Endpoint != address.AbsoluteUri) throw new InvalidOperationException("恢复任务必须使用原服务器和原账户。");
        if (state.CreatedAt < DateTimeOffset.UtcNow.AddDays(-7)) throw new IOException("本地恢复记录已超过 7 天保留期限，请清理后重新创建任务。");
        if (jobs.Count >= 100) throw new IOException("任务队列最多 100 项。");
        var job = new Job(state);
        if (!jobs.TryAdd(state.Id, job)) throw new InvalidOperationException("该任务已在运行。");
        state.Status = "等待"; state.Result = "";
        try { state.Save(); }
        catch (Exception error)
        {
            jobs.TryRemove(state.Id, out _); job.Stop.Dispose();
            state.Status = "待恢复"; state.Result = "本地任务记录保存失败：" + error.Message;
            Changed?.Invoke(state, null); throw;
        }
        Changed?.Invoke(state, null);
        if (!channel.Writer.TryWrite(job)) { jobs.TryRemove(state.Id, out _); job.Stop.Dispose(); throw new IOException("任务队列已满或关闭。"); }
        return job.Done.Task;
    }
    public async Task PauseAsync(TransferState state, bool cancel = false)
    {
        if (jobs.TryGetValue(state.Id, out var job)) { job.Cancel = cancel; job.Stop.Cancel(); await job.Done.Task.ConfigureAwait(false); return; }
        if (cancel)
        {
            if (state.Direction == "upload" && state.UploadId.HasValue)
            {
                try { await control.ForgetUploadAsync(state.UploadId.Value).ConfigureAwait(false); }
                catch (ServerRequestException error) when (error.Code == "UPLOAD_NOT_FOUND") { }
            }
            if (state.Direction == "download") await state.DeletePartAsync().ConfigureAwait(false);
            state.Status = "已取消"; state.Result = "未完成数据已清理"; await state.SaveAsync().ConfigureAwait(false); Changed?.Invoke(state, null);
        }
    }
    private async Task<SecureConnection> ConnectWorkerAsync()
    {
        await attachGate.WaitAsync(lifetime.Token).ConfigureAwait(false);
        SecureConnection? connection = null;
        try
        {
            if (control.Identity?.UserId != owner) throw new ServerRequestException("AUTH_REQUIRED");
            connection = new SecureConnection(address, ca, certificate);
            await connection.ConnectAsync(lifetime.Token).ConfigureAwait(false);
            string ticket = await control.WindowTicketAsync(lifetime.Token).ConfigureAwait(false);
            var identity = await connection.AttachWindowAsync(ticket, lifetime.Token).ConfigureAwait(false);
            if (identity.UserId != owner) throw new IOException("传输连接身份不一致。");
            WorkerConnected?.Invoke(connection.ConnectionId!.Value); return connection;
        }
        catch { if (connection is not null) await connection.DisposeAsync().ConfigureAwait(false); throw; }
        finally { attachGate.Release(); }
    }
    private sealed class CallbackProgress(Action<TransferProgress> callback) : IProgress<TransferProgress>
    { public void Report(TransferProgress value) => callback(value); }
    private async Task WorkerAsync()
    {
        SecureConnection? connection = null;
        try
        {
            await foreach (var job in channel.Reader.ReadAllAsync())
            {
                var state = job.State;
                using var stop = CancellationTokenSource.CreateLinkedTokenSource(job.Stop.Token, lifetime.Token);
                try
                {
                    stop.Token.ThrowIfCancellationRequested();
                    if (connection?.IsConnected != true || connection.Identity?.UserId != owner)
                    { if (connection is not null) await connection.DisposeAsync().ConfigureAwait(false); connection = await ConnectWorkerAsync().ConfigureAwait(false); }
                    state.Status = "传输中"; Changed?.Invoke(state, null);
                    var progress = new CallbackProgress(value => Changed?.Invoke(state, value));
                    if (state.Direction == "upload")
                    {
                        var result = await connection.ResumeUploadAsync(state, progress, stop.Token).ConfigureAwait(false);
                        state.Result = $"fileId={result.FileId}; SHA-256={result.Sha256}";
                    }
                    else
                    {
                        var result = await connection.ResumeDownloadAsync(state, progress, stop.Token).ConfigureAwait(false);
                        state.Result = $"已保存 {result.SavedPath}; SHA-256={result.File.Sha256}";
                    }
                    state.Status = "完成";
                }
                catch (Exception error)
                {
                    state.Status = stop.IsCancellationRequested ? "已暂停" : "待恢复";
                    state.Result = error.Message;
                    if (job.Cancel && control.Identity?.UserId == owner)
                    {
                        try
                        {
                            if (state.Direction == "upload" && state.UploadId.HasValue) await control.ForgetUploadAsync(state.UploadId.Value).ConfigureAwait(false);
                            if (state.Direction == "download") await state.DeletePartAsync().ConfigureAwait(false);
                            state.Status = "已取消"; state.Result = "未完成数据已清理";
                        }
                        catch (ServerRequestException cancelError) when (cancelError.Code == "UPLOAD_ALREADY_COMMITTED")
                        { state.Status = "完成"; state.Result = "取消前服务器已经提交，请刷新列表"; }
                        catch (Exception cancelError) { state.Status = "取消待重试"; state.Result = cancelError.Message; }
                    }
                }
                finally
                {
                    try { await state.SaveAsync().ConfigureAwait(false); } catch (Exception error) { state.Result += "；恢复记录保存失败：" + error.Message; }
                    jobs.TryRemove(state.Id, out _); Changed?.Invoke(state, null); job.Stop.Dispose(); job.Done.TrySetResult();
                }
            }
        }
        finally { if (connection is not null) await connection.DisposeAsync().ConfigureAwait(false); }
    }
    private void StopAll()
    {
        lifetime.Cancel(); channel.Writer.TryComplete();
        foreach (var job in jobs.Values) try { job.Stop.Cancel(); } catch (ObjectDisposedException) { }
    }
    public async ValueTask DisposeAsync()
    {
        if (disposed) return; disposed = true; control.IdentityChanged -= OnIdentity; StopAll();
        await Task.WhenAll(workers).ConfigureAwait(false); lifetime.Dispose(); attachGate.Dispose();
    }
}
