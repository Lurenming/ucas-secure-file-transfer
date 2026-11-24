using SecureFileTransfer.Client.Networking;
using System.Security.Cryptography.X509Certificates;
using System.Collections.Concurrent;

namespace SecureFileTransfer.Client;

public sealed class TransferForm : Form
{
    readonly TextBox host = new() { Width = 145 }, ca = new() { Width = 350 }, username = new() { Width = 100 }, password = new() { Width = 135, UseSystemPasswordChar = true };
    readonly NumericUpDown port = new() { Minimum = 1, Maximum = 65535, Width = 100 }, concurrency = new() { Minimum = 1, Maximum = 8, Width = 70 };
    readonly Button connect = new() { Text = "连接", AutoSize = true }, disconnect = new() { Text = "断开", AutoSize = true }, login = new() { Text = "登录", AutoSize = true }, logout = new() { Text = "注销", AutoSize = true };
    readonly Button browseCa = new() { Text = "CA 公共证书…", AutoSize = true }, browseCert = new() { Text = "客户端 PFX…", AutoSize = true }, storeCert = new() { Text = "证书库…", AutoSize = true }, clearCert = new() { Text = "清除证书", AutoSize = true };
    readonly Button upload = new() { Text = "上传", AutoSize = true }, download = new() { Text = "下载", AutoSize = true }, refresh = new() { Text = "刷新本人文件", AutoSize = true }, next = new() { Text = "下一页", AutoSize = true };
    readonly Button pause = new() { Text = "暂停所选", AutoSize = true }, resume = new() { Text = "继续 / 恢复", AutoSize = true }, cancel = new() { Text = "取消并清理", AutoSize = true };
    readonly Label connectionLabel = new() { Text = "未连接", AutoSize = true }, certificateLabel = new() { Text = "未选择客户端证书（密码兼容模式）", AutoSize = true };
    readonly ListView files = new() { View = View.Details, FullRowSelect = true, MultiSelect = true, Dock = DockStyle.Fill, HideSelection = false };
    readonly ListView tasks = new() { View = View.Details, FullRowSelect = true, MultiSelect = false, Dock = DockStyle.Fill, HideSelection = false };
    readonly TextBox log = new() { ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
    readonly List<TransferState> states = [];
    readonly ConcurrentDictionary<Guid, TransferProgress> progress = new();
    readonly Dictionary<Guid, (long bytes, DateTime time, double speed)> speeds = [];
    readonly System.Windows.Forms.Timer timer = new() { Interval = 250 };
    readonly string settingsPath, taskDirectory;
    SecureConnection? control;
    TransferQueue? queue;
    X509Certificate2? certificate;
    ClientSettings settings;
    string? cursor;
    bool busy, closing, closeAllowed;

    public TransferForm()
    {
        Text = "安全文件传输 · 并行与断点恢复"; Width = 1280; Height = 900; MinimumSize = new(1000, 720);
        AutoScaleMode = AutoScaleMode.Dpi;
        string stateRoot = Environment.GetEnvironmentVariable("SFT_CLIENT_STATE_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SecureFileTransfer");
        Directory.CreateDirectory(stateRoot); settingsPath = Path.Combine(stateRoot, "connection.json");
        taskDirectory = TransferState.PrepareDirectory(Path.Combine(stateRoot, "tasks"));
        settings = ClientSettings.Load(settingsPath); try { settings.Address(); } catch { settings = new(); }
        host.Text = settings.Host; port.Value = settings.Port; ca.Text = settings.PublicCa; concurrency.Value = settings.Concurrency;
        states.AddRange(TransferState.Load(taskDirectory));
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 8, Padding = new Padding(12) };
        for (int i = 0; i < 4; i++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 30)); layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 20));
        FlowLayoutPanel Row(params Control[] controls) { var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true }; panel.Controls.AddRange(controls); return panel; }
        Label Label(string text) => new() { Text = text, AutoSize = true, Margin = new Padding(3, 8, 3, 3) };
        layout.Controls.Add(Row(Label("服务器 IP / 域名"), host, Label("端口"), port, Label("并发"), concurrency, connect, disconnect, connectionLabel), 0, 0);
        layout.Controls.Add(Row(browseCa, ca, browseCert, storeCert, clearCert, certificateLabel), 0, 1);
        layout.Controls.Add(Row(Label("账户"), username, Label("密码"), password, login, logout, Label("mTLS 由服务器证书绑定确认身份；选证书后重新连接")), 0, 2);
        layout.Controls.Add(Row(refresh, next, upload, download), 0, 3);
        files.Columns.Add("文件名", 320); files.Columns.Add("大小（字节）", 130); files.Columns.Add("SHA-256", 490); files.Columns.Add("文件 ID", 290);
        layout.Controls.Add(files, 0, 4);
        layout.Controls.Add(Row(pause, resume, cancel, Label("暂停/断线/关窗保留恢复数据；主动取消清理；重新登录后手动恢复")), 0, 5);
        foreach (var (name, width) in new[] { ("方向", 65), ("文件名", 210), ("状态", 90), ("进度", 85), ("已传 / 总字节", 190), ("速度 KiB/s", 100), ("结果", 510) }) tasks.Columns.Add(name, width);
        layout.Controls.Add(tasks, 0, 6); layout.Controls.Add(log, 0, 7); Controls.Add(layout);
        browseCa.Click += (_, _) => PickCa(); browseCert.Click += (_, _) => PickPfx(); storeCert.Click += (_, _) => PickStoreCertificate();
        clearCert.Click += (_, _) => { certificate?.Dispose(); certificate = null; certificateLabel.Text = "未选择客户端证书"; };
        connect.Click += async (_, _) => await ActionAsync(ConnectAsync);
        disconnect.Click += async (_, _) => await ActionAsync(DisconnectAsync);
        login.Click += async (_, _) => await ActionAsync(LoginAsync);
        logout.Click += async (_, _) => await ActionAsync(LogoutAsync);
        refresh.Click += async (_, _) => await ActionAsync(() => LoadFilesAsync(null)); next.Click += async (_, _) => await ActionAsync(() => LoadFilesAsync(cursor));
        upload.Click += async (_, _) => await ActionAsync(AddUploadsAsync); download.Click += async (_, _) => await ActionAsync(AddDownloadsAsync);
        pause.Click += async (_, _) => await ActionAsync(() => ChangeTaskAsync("pause"));
        resume.Click += async (_, _) => await ActionAsync(() => ChangeTaskAsync("resume"));
        cancel.Click += async (_, _) => await ActionAsync(() => ChangeTaskAsync("cancel"));
        timer.Tick += (_, _) => { RenderTasks(); UpdateControls(); }; timer.Start();
        FormClosing += ClosingAsync; FormClosed += (_, _) => { timer.Dispose(); certificate?.Dispose(); };
        Shown += async (_, _) => await ExpireLocalTasksAsync();
        UpdateControls();
    }
    async Task ExpireLocalTasksAsync()
    {
        foreach (var state in states.Where(s => s.CreatedAt < DateTimeOffset.UtcNow.AddDays(-7) && s.Status is not ("完成" or "已取消")).ToArray())
        {
            try { if (state.Direction == "download") await Task.Run(state.DeletePartAsync); state.Status = "已取消"; state.Result = "超过本地 7 天保留期限；下载临时文件已清理，上传由服务器保留期限清理"; state.Save(); }
            catch (Exception error) { Log("过期任务需人工核对：" + error.Message); }
        }
    }
    void Log(string text) { log.AppendText($"[{DateTime.Now:HH:mm:ss}] {text}{Environment.NewLine}"); if (log.TextLength > 50000) log.Text = log.Text[^30000..]; }
    async Task ActionAsync(Func<Task> work)
    {
        if (busy || closing) return; busy = true; UpdateControls();
        try { await work(); } catch (Exception error) { Log(error.Message); }
        finally { busy = false; UpdateControls(); }
    }
    void PickCa()
    {
        using var dialog = new OpenFileDialog { Filter = "CA 公共证书|*.crt;*.pem", Title = "选择通过可信渠道取得的 CA 公共证书" };
        if (dialog.ShowDialog(this) == DialogResult.OK) ca.Text = dialog.FileName;
    }
    void PickPfx()
    {
        try
        {
            using var dialog = new OpenFileDialog { Filter = "客户端证书|*.pfx;*.p12", Title = "选择本人的客户端证书及私钥" };
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            using var prompt = new Form { Text = "PFX 解锁密码（不会保存）", Width = 430, Height = 160, StartPosition = FormStartPosition.CenterParent };
            var input = new TextBox { UseSystemPasswordChar = true, Dock = DockStyle.Top };
            var ok = new Button { Text = "解锁", DialogResult = DialogResult.OK, Dock = DockStyle.Bottom }; prompt.Controls.Add(input); prompt.Controls.Add(ok); prompt.AcceptButton = ok;
            if (prompt.ShowDialog(this) != DialogResult.OK) return;
            try { var selected = X509CertificateLoader.LoadPkcs12FromFile(dialog.FileName, input.Text, X509KeyStorageFlags.UserKeySet); SetCertificate(selected); }
            finally { input.Clear(); }
        } catch (Exception error) { Log("证书载入失败：" + error.Message); }
    }
    void PickStoreCertificate()
    {
        try
        {
            using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser); store.Open(OpenFlags.ReadOnly);
            var candidates = store.Certificates.Cast<X509Certificate2>().Where(c => c.HasPrivateKey && c.NotAfter > DateTime.Now && c.NotBefore <= DateTime.Now).ToArray();
            using var picker = new Form { Text = "当前 Windows 用户的个人证书", Width = 800, Height = 180, StartPosition = FormStartPosition.CenterParent };
            var list = new ComboBox { Dock = DockStyle.Top, DropDownStyle = ComboBoxStyle.DropDownList };
            foreach (var item in candidates) list.Items.Add(item.Subject + " | " + item.Thumbprint);
            if (list.Items.Count > 0) list.SelectedIndex = 0;
            var ok = new Button { Dock = DockStyle.Bottom, Text = "使用所选证书", DialogResult = DialogResult.OK }; picker.Controls.Add(list); picker.Controls.Add(ok);
            if (picker.ShowDialog(this) == DialogResult.OK && list.SelectedIndex >= 0) SetCertificate(candidates[list.SelectedIndex]);
        } catch (Exception error) { Log("证书库：" + error.Message); }
    }
    void SetCertificate(X509Certificate2 selected)
    {
        if (!selected.HasPrivateKey || !selected.Extensions.OfType<X509EnhancedKeyUsageExtension>().Any(e => e.EnhancedKeyUsages.Cast<System.Security.Cryptography.Oid>().Any(o => o.Value == "1.3.6.1.5.5.7.3.2")))
        { selected.Dispose(); throw new ArgumentException("请选择带私钥和 clientAuth 用途的证书。"); }
        certificate?.Dispose(); certificate = selected; certificateLabel.Text = "证书 SHA-256：" + selected.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256)[..24] + "…";
    }
    async Task ConnectAsync()
    {
        var candidate = new ClientSettings(host.Text.Trim(), (int)port.Value, ca.Text.Trim(), (int)concurrency.Value);
        var address = candidate.Address(); candidate.Save(settingsPath); settings = candidate;
        var connection = new SecureConnection(address, settings.PublicCa, certificate);
        try { await connection.ConnectAsync(); connection.RequireCapability("resume-v1"); }
        catch (Exception error) { string detail = connection.CertificateValidationError ?? error.Message; await connection.DisposeAsync(); throw new IOException("连接失败（检查地址、端口、CA、SAN 和证书）：" + detail); }
        control = connection; connectionLabel.Text = "已连接 · " + connection.AuthenticationMode;
        Log("控制连接 " + connection.ConnectionId + "；认证模式 " + connection.AuthenticationMode);
    }
    async Task LoginAsync()
    {
        if (control is null) return;
        if (queue is not null) { await queue.DisposeAsync(); queue = null; }
        try
        {
            SessionIdentity identity = control.AuthenticationMode == "mtls-required" ? await control.CertificateLoginAsync() : await control.LoginAsync(username.Text, password.Text);
            queue = new TransferQueue(control, settings.Address(), settings.PublicCa, settings.Concurrency, certificate);
            queue.Changed += (state, value) => { if (value is not null) progress[state.Id] = value; };
            Log("已认证：" + identity.Username + "；绝对到期 " + identity.ExpiresAt.ToLocalTime().ToString("HH:mm:ss"));
            await LoadFilesAsync(null);
        }
        finally { password.Clear(); }
    }
    async Task LogoutAsync()
    {
        if (queue is not null) { await queue.DisposeAsync(); queue = null; }
        if (control?.IsConnected == true) await control.LogoutAsync();
        files.Items.Clear(); tasks.Items.Clear(); cursor = null; Log("已注销本窗口；任务暂停，恢复需重新认证。其他独立客户端不受影响。");
    }
    async Task DisconnectAsync()
    {
        await LogoutAsync(); if (control is not null) { await control.DisposeAsync(); control = null; }
        connectionLabel.Text = "未连接";
    }
    async Task LoadFilesAsync(string? page)
    {
        if (control?.Identity is null) return;
        var result = await control.ListFilesAsync(page, 20); files.Items.Clear();
        foreach (var file in result.Files) files.Items.Add(new ListViewItem([file.Name, file.Size.ToString(), file.Sha256, file.FileId.ToString()]) { Tag = file });
        cursor = result.NextCursor;
    }
    TransferState NewTask(string direction, string path, string name, long size)
    {
        if (size < 0 || size > UploadProtocol.MaxFileBytes) throw new IOException("每个文件最多 100 MiB。");
        while (states.Count >= 100)
        {
            var finished = states.Where(s => s.Status is "完成" or "已取消").OrderBy(s => s.CreatedAt).FirstOrDefault();
            if (finished is null) throw new IOException("任务记录最多 100 项，请先取消或完成旧任务。");
            File.Delete(finished.RecordPath); states.Remove(finished); progress.TryRemove(finished.Id, out _); speeds.Remove(finished.Id);
        }
        if (states.Count(s => s.Status is not ("完成" or "已取消")) >= 100) throw new IOException("未完成任务最多 100 项。");
        if (direction == "download" && states.Where(s => s.Direction == "download" && s.Status is not ("完成" or "已取消")).Sum(s => s.Size) + size > 1024L * 1024 * 1024) throw new IOException("本地下载恢复数据预留超过 1 GiB。");
        var state = new TransferState { Directory = taskDirectory, Direction = direction, LocalPath = Path.GetFullPath(path), Endpoint = settings.Address().AbsoluteUri, Owner = control!.Identity!.UserId, Name = name, Size = size };
        states.Add(state); return state;
    }
    Task AddUploadsAsync()
    {
        if (queue is null) return Task.CompletedTask;
        using var picker = new OpenFileDialog { Multiselect = true, Title = "选择多个上传文件" };
        if (picker.ShowDialog(this) == DialogResult.OK) foreach (var path in picker.FileNames)
        { var state = NewTask("upload", path, Path.GetFileName(path), new FileInfo(path).Length); _ = queue.Enqueue(state); }
        return Task.CompletedTask;
    }
    Task AddDownloadsAsync()
    {
        if (queue is null || files.SelectedItems.Count == 0) return Task.CompletedTask;
        using var picker = new FolderBrowserDialog { Description = "选择下载目录（禁止覆盖已有文件）", UseDescriptionForTitle = true };
        if (picker.ShowDialog(this) != DialogResult.OK) return Task.CompletedTask;
        foreach (ListViewItem row in files.SelectedItems)
        {
            var file = (RemoteFile)row.Tag!; string path = Path.Combine(picker.SelectedPath, file.Name);
            if (File.Exists(path) || states.Any(s => s.LocalPath == path && s.Status is not ("完成" or "已取消"))) { Log("已跳过已有或已预留目标：" + path); continue; }
            var state = NewTask("download", path, file.Name, file.Size); state.File = file; state.Sha256 = file.Sha256; _ = queue.Enqueue(state);
        }
        return Task.CompletedTask;
    }
    async Task ChangeTaskAsync(string action)
    {
        if (queue is null || tasks.SelectedItems.Count != 1) return;
        var state = (TransferState)tasks.SelectedItems[0].Tag!;
        if (state.Status is "完成" or "已取消") return;
        if (action == "resume") { _ = queue.Enqueue(state); }
        else await queue.PauseAsync(state, action == "cancel");
    }
    void RenderTasks()
    {
        Guid? owner = control?.Identity?.UserId;
        var visible = states.Where(s => s.Owner == owner && s.Endpoint == settings.Address().AbsoluteUri).ToList();
        if (tasks.Items.Count != visible.Count || tasks.Items.Cast<ListViewItem>().Any(row => !visible.Contains((TransferState)row.Tag!)))
        { tasks.Items.Clear(); foreach (var state in visible) tasks.Items.Add(new ListViewItem(["", "", "", "", "", "", ""]) { Tag = state }); }
        foreach (ListViewItem row in tasks.Items)
        {
            var state = (TransferState)row.Tag!; long bytes = state.Offset; DateTime now = DateTime.UtcNow;
            var old = speeds.GetValueOrDefault(state.Id, (bytes, now, 0)); double speed = old.speed;
            if ((now - old.time).TotalSeconds >= 0.75) { speed = Math.Max(0, bytes - old.bytes) / (now - old.time).TotalSeconds / 1024; speeds[state.Id] = (bytes, now, speed); }
            else if (!speeds.ContainsKey(state.Id)) speeds[state.Id] = (bytes, now, 0);
            string[] values = [state.Direction == "upload" ? "上传" : "下载", state.Name, state.Status,
                state.Size == 0 ? (state.Status == "完成" ? "100%" : "0%") : $"{bytes * 100.0 / state.Size:F1}%", $"{bytes:N0} / {state.Size:N0}", state.Status == "传输中" ? speed.ToString("F1") : "—", state.Result];
            for (int i = 0; i < values.Length; i++) if (row.SubItems[i].Text != values[i]) row.SubItems[i].Text = values[i];
        }
    }
    void UpdateControls()
    {
        bool connected = control?.IsConnected == true, authenticated = connected && control?.Identity is not null;
        foreach (Control item in new Control[] { host, port, ca, concurrency, browseCa, browseCert, storeCert, clearCert, connect }) item.Enabled = !busy && !closing && control is null;
        disconnect.Enabled = !busy && control is not null; login.Enabled = !busy && connected && !authenticated; logout.Enabled = !busy && authenticated;
        username.Enabled = password.Enabled = !busy && connected && !authenticated && control?.AuthenticationMode == "password";
        foreach (var item in new[] { upload, download, refresh, pause, resume, cancel }) item.Enabled = !busy && authenticated;
        next.Enabled = !busy && authenticated && cursor is not null;
        if (!connected && control is not null) connectionLabel.Text = "连接中断，请断开后重新连接";
        else if (connected && !authenticated) { files.Items.Clear(); connectionLabel.Text = "已连接，未认证 / 身份已到期"; }
        else if (authenticated) connectionLabel.Text = "当前账户：" + control!.Identity!.Username;
    }
    async void ClosingAsync(object? sender, FormClosingEventArgs e)
    {
        if (closeAllowed) return; e.Cancel = true; if (closing) return; closing = true; timer.Stop(); Enabled = false;
        try { await DisconnectAsync(); } catch { if (control is not null) await control.DisposeAsync(); }
        finally { closeAllowed = true; Close(); }
    }
}
