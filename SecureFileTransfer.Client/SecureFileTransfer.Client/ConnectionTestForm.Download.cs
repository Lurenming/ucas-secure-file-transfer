using SecureFileTransfer.Client.Networking;

namespace SecureFileTransfer.Client;

public sealed partial class ConnectionTestForm
{
    private readonly ListView files = new() { View = View.Details, FullRowSelect = true, MultiSelect = false, Dock = DockStyle.Fill, HideSelection = false };
    private readonly Button refreshFiles = new() { Text = "刷新本人文件", AutoSize = true };
    private readonly Button previousPage = new() { Text = "上一页", AutoSize = true };
    private readonly Button nextPage = new() { Text = "下一页", AutoSize = true };
    private readonly Button download = new() { Text = "下载所选文件…", AutoSize = true };
    private readonly Button cancelDownload = new() { Text = "取消下载", AutoSize = true };
    private readonly Label pageLabel = new() { Text = "尚未加载", AutoSize = true };
    private readonly ProgressBar downloadProgress = new() { Width = 240, Maximum = 1000 };
    private readonly Label downloadStatus = new() { Text = "尚未下载", AutoSize = true };
    private bool listing, downloading;
    private int listOperation, downloadOperation;
    private long listIdentityGeneration = -1;
    private SecureConnection? listConnection;
    private string? currentCursor, nextCursor;
    private List<string?> previousCursors = [];
    private Task<DownloadResult>? fileDownloadTask;

    private void InitializeDownloads(TableLayoutPanel layout)
    {
        files.Columns.Add("文件名", 330); files.Columns.Add("字节数", 100); files.Columns.Add("提交时间", 180); files.Columns.Add("文件标识", 300);
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
        actions.Controls.AddRange([refreshFiles, previousPage, nextPage, download, pageLabel]);
        layout.Controls.Add(actions, 0, 9); layout.SetColumnSpan(actions, 3);
        layout.Controls.Add(files, 0, 10); layout.SetColumnSpan(files, 3);
        var progress = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
        progress.Controls.AddRange([cancelDownload, downloadProgress, downloadStatus]);
        layout.Controls.Add(progress, 0, 11); layout.SetColumnSpan(progress, 3);
        refreshFiles.Click += async (_, _) => await LoadFilesAsync(null, []);
        nextPage.Click += async (_, _) => { if (nextCursor is not null) await LoadFilesAsync(nextCursor, [.. previousCursors, currentCursor]); };
        previousPage.Click += async (_, _) => { if (previousCursors.Count > 0) await LoadFilesAsync(previousCursors[^1], previousCursors.Take(previousCursors.Count - 1).ToList()); };
        download.Click += async (_, _) => await DownloadSelectedAsync();
        cancelDownload.Click += (_, _) => { active?.CancelDownload(); downloadStatus.Text = "正在取消下载"; };
        files.SelectedIndexChanged += (_, _) => UpdateControls();
    }

    private void ResetDownloadDisplay()
    {
        if (downloading) downloadStatus.Text = "连接已断开，下载未完成";
        downloading = false; downloadOperation++;
    }

    private void UpdateDownloadControls(bool connected, bool authOperation)
    {
        long epoch = active?.IdentityGeneration ?? -1;
        if (listConnection != active || listIdentityGeneration != epoch)
        {
            listConnection = active; listIdentityGeneration = epoch; listOperation++; listing = false;
            files.Items.Clear(); previousCursors.Clear(); currentCursor = nextCursor = null; pageLabel.Text = "尚未加载";
        }
        bool allowed = connected && active?.Identity is not null && !authOperation;
        refreshFiles.Enabled = allowed && !listing;
        previousPage.Enabled = allowed && !listing && previousCursors.Count > 0;
        nextPage.Enabled = allowed && !listing && nextCursor is not null;
        download.Enabled = allowed && !listing && !uploading && !downloading && files.SelectedItems.Count == 1;
        cancelDownload.Enabled = connected && downloading;
    }

    private async Task LoadFilesAsync(string? cursor, List<string?> history)
    {
        var connection = active;
        if (closing || connection?.Identity is null) return;
        UpdateControls(); // Observe the new identity before capturing this list request's UI generation.
        long epoch = connection.IdentityGeneration; int operation = ++listOperation;
        bool Current() => !closing && active == connection && connection.IdentityGeneration == epoch && operation == listOperation;
        listing = true; UpdateControls();
        try
        {
            var page = await connection.ListFilesAsync(cursor, 10, windowLifetime.Token);
            if (!Current()) return;
            files.BeginUpdate(); files.Items.Clear();
            foreach (var file in page.Files)
                files.Items.Add(new ListViewItem([file.Name, file.Size.ToString(), file.CommittedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss"), file.FileId.ToString()]) { Tag = file });
            files.EndUpdate(); currentCursor = cursor; nextCursor = page.NextCursor; previousCursors = history;
            pageLabel.Text = $"第 {history.Count + 1} 页 · {page.Files.Count} 个文件";
        }
        catch (Exception error) { if (Current()) AppendLog("文件列表：" + error.Message); }
        finally { if (Current()) { listing = false; UpdateControls(); } }
    }

    private async Task DownloadSelectedAsync()
    {
        var connection = active;
        if (closing || uploading || downloading || connection?.Identity is null || files.SelectedItems.Count != 1) return;
        var file = (RemoteFile)files.SelectedItems[0].Tag!;
        using var picker = new SaveFileDialog { Title = "保存下载文件（请选择尚不存在的目标名称）", FileName = Path.GetFileName(file.Name), OverwritePrompt = true, CheckPathExists = true, AddExtension = false };
        if (picker.ShowDialog(this) != DialogResult.OK) return;
        long epoch = connection.IdentityGeneration; int operation = ++downloadOperation;
        bool Current() => !closing && active == connection && operation == downloadOperation;
        downloading = true; downloadProgress.Value = 0; downloadStatus.Text = "准备下载"; UpdateControls();
        using var progress = new UiTransferProgress<DownloadProgress>(value =>
        {
            if (!Current() || !downloading || connection.IdentityGeneration != epoch) return;
            downloadProgress.Value = value.TotalBytes == 0 ? (value.Phase == "下载成功" ? 1000 : 0) : (int)Math.Clamp(value.WrittenBytes * 1000 / value.TotalBytes, 0, 1000);
            downloadStatus.Text = $"{value.Phase} · {value.WrittenBytes}/{value.TotalBytes} 字节";
        });
        try
        {
            fileDownloadTask = connection.DownloadFileAsync(file.FileId, picker.FileName, progress, windowLifetime.Token);
            var result = await fileDownloadTask;
            if (Current() && connection.IdentityGeneration == epoch)
            {
                downloadProgress.Value = 1000; downloadStatus.Text = "下载成功（大小与 SHA-256 已校验）";
                AppendLog($"下载成功：{result.SavedPath}；fileId={result.File.FileId}；{result.File.Size} 字节；SHA-256={result.File.Sha256}");
            }
        }
        catch (Exception error)
        {
            if (Current()) { downloadStatus.Text = error is OperationCanceledException ? "下载已取消" : "下载未完成"; AppendLog("下载：" + error.Message); }
        }
        finally { if (Current()) { downloading = false; UpdateControls(); } }
    }
}
