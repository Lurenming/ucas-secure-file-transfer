using SecureFileTransfer.Client.Networking;

namespace SecureFileTransfer.Client;

public sealed partial class ConnectionTestForm : Form
{
    private readonly TextBox address = new() { Text = "wss://127.0.0.1:8443/ws", Dock = DockStyle.Fill };
    private readonly TextBox caPath = new() { Dock = DockStyle.Fill };
    private readonly TextBox message = new() { Text = "你好，安全文件传输！", MaxLength = 1024, Dock = DockStyle.Fill };
    private readonly TextBox username = new() { Text = "alice", MaxLength = 0, Dock = DockStyle.Fill };
    // Validate the complete input in SecureConnection; never silently truncate pasted credentials.
    private readonly TextBox password = new() { UseSystemPasswordChar = true, MaxLength = 0, Dock = DockStyle.Fill };
    private readonly Button login = new() { Text = "登录", AutoSize = true };
    private readonly Button logout = new() { Text = "注销", AutoSize = true };
    private readonly Button me = new() { Text = "查询当前身份", AutoSize = true };
    private readonly Label identityLabel = new() { Text = "未登录", AutoSize = true, Padding = new Padding(0, 8, 0, 0) };
    private readonly TextBox filePath = new() { ReadOnly = true, Dock = DockStyle.Fill };
    private readonly Button chooseFile = new() { Text = "选择文件…", AutoSize = true };
    private readonly Button upload = new() { Text = "开始上传", AutoSize = true };
    private readonly Button cancelUpload = new() { Text = "取消上传", AutoSize = true };
    private readonly ProgressBar uploadProgress = new() { Width = 240, Maximum = 1000 };
    private readonly Label uploadStatus = new() { Text = "尚未上传", AutoSize = true };
    private bool uploading;
    private int uploadGeneration;
    private Task<UploadResult>? fileUploadTask;
    private readonly Button browse = new() { Text = "选择 CA…", AutoSize = true };
    private readonly Button connect = new() { Text = "连接", AutoSize = true };
    private readonly Button send = new() { Text = "发送测试消息", AutoSize = true };
    private readonly Button disconnect = new() { Text = "断开", AutoSize = true };
    private readonly Label status = new() { Text = "未连接", AutoSize = true, Padding = new Padding(0, 8, 0, 0) };
    private readonly TextBox log = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Dock = DockStyle.Fill };
    private readonly CancellationTokenSource windowLifetime = new();
    private SecureConnection? active;
    private int generation;
    private bool connecting;
    private bool sending;
    private bool closing;
    private bool allowClose;
    private bool authenticating;
    private bool loggingOut;
    private bool queryingIdentity;

    public ConnectionTestForm()
    {
        Text = "安全文件传输 · P3 本人文件与下载";
        ClientSize = new Size(1100, 900);
        MinimumSize = new Size(800, 480);
        AutoScaleMode = AutoScaleMode.Font;
        StartPosition = FormStartPosition.CenterScreen;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 3, RowCount = 13 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        for (int row = 0; row < 9; row++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        layout.Controls.Add(new Label { Text = "服务器地址", AutoSize = true }, 0, 0);
        layout.Controls.Add(address, 1, 0);
        layout.SetColumnSpan(address, 2);
        layout.Controls.Add(new Label { Text = "CA 公共证书", AutoSize = true }, 0, 1);
        layout.Controls.Add(caPath, 1, 1);
        layout.Controls.Add(browse, 2, 1);
        var hint = new Label { Text = "仅选择可信本机目录的 dev-ca.crt；不会导入系统证书库。开发 CA 不提供吊销查询。", AutoSize = true, Padding = new Padding(0, 6, 0, 10) };
        layout.Controls.Add(hint, 0, 2);
        layout.SetColumnSpan(hint, 3);
        var credentials = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 4, RowCount = 1 };
        credentials.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        credentials.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 40));
        credentials.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 70));
        credentials.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 60));
        credentials.Controls.Add(new Label { Text = "用户名", AutoSize = true }, 0, 0);
        credentials.Controls.Add(username, 1, 0);
        credentials.Controls.Add(new Label { Text = "密码", AutoSize = true }, 2, 0);
        credentials.Controls.Add(password, 3, 0);
        layout.Controls.Add(credentials, 0, 3);
        layout.SetColumnSpan(credentials, 3);
        var authActions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Padding = new Padding(0, 6, 0, 8) };
        authActions.Controls.AddRange([login, logout, me, identityLabel]);
        layout.Controls.Add(authActions, 0, 4);
        layout.SetColumnSpan(authActions, 3);
        layout.Controls.Add(new Label { Text = "诊断文本", AutoSize = true }, 0, 5);
        layout.Controls.Add(message, 1, 5);
        layout.SetColumnSpan(message, 2);
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Padding = new Padding(0, 6, 0, 8) };
        actions.Controls.AddRange([connect, send, disconnect, status]);
        layout.Controls.Add(actions, 0, 6);
        layout.SetColumnSpan(actions, 3);
        layout.Controls.Add(new Label { Text = "上传文件", AutoSize = true }, 0, 7);
        layout.Controls.Add(filePath, 1, 7);
        layout.Controls.Add(chooseFile, 2, 7);
        var uploadActions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Padding = new Padding(0, 8, 0, 8) };
        uploadActions.Controls.AddRange([upload, cancelUpload, uploadProgress, uploadStatus]);
        layout.Controls.Add(uploadActions, 0, 8);
        layout.SetColumnSpan(uploadActions, 3);
        InitializeDownloads(layout);
        layout.Controls.Add(log, 0, 12);
        layout.SetColumnSpan(log, 3);
        Controls.Add(layout);
        caPath.Text = FindLocalCa();
        browse.Click += (_, _) => BrowseCa();
        connect.Click += async (_, _) => await ConnectAsync();
        send.Click += async (_, _) => await SendAsync();
        disconnect.Click += async (_, _) => await DisconnectAsync();
        login.Click += async (_, _) => await AuthenticateAsync("login");
        logout.Click += async (_, _) => await AuthenticateAsync("logout");
        me.Click += async (_, _) => await AuthenticateAsync("me");
        chooseFile.Click += (_, _) => ChooseFile();
        upload.Click += async (_, _) => await UploadSelectedAsync();
        cancelUpload.Click += (_, _) => { active?.CancelUpload(); uploadStatus.Text = "正在取消；已提交的文件不会删除"; };
        FormClosing += OnClosingAsync;
        FormClosed += (_, _) => windowLifetime.Dispose();
        UpdateControls();
    }

    private static string FindLocalCa()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            string candidate = Path.Combine(directory.FullName, "server-node", "certs", "public", "dev-ca.crt");
            if (File.Exists(candidate)) return candidate;
        }
        return "";
    }

    private void BrowseCa()
    {
        using var picker = new OpenFileDialog { Title = "从可信本机目录选择 CA 公共证书", Filter = "PEM 公共证书 (*.crt;*.pem)|*.crt;*.pem", CheckFileExists = true };
        if (picker.ShowDialog(this) == DialogResult.OK) caPath.Text = picker.FileName;
    }

    private async Task ConnectAsync()
    {
        if (closing || connecting || active is not null) return;
        connecting = true;
        int current = ++generation;
        SecureConnection? connection = null;
        status.Text = "正在连接…";
        UpdateControls();
        try
        {
            connection = new SecureConnection(new Uri(address.Text.Trim()), caPath.Text.Trim());
            active = connection;
            connection.Log += text => Post(connection, current, () => AppendLog(text));
            connection.IdentityChanged += () => Post(connection, current, UpdateControls);
            await connection.ConnectAsync(windowLifetime.Token);
            if (closing || active != connection || current != generation) return;
            status.Text = "已连接";
            _ = MonitorAsync(connection, current);
        }
        catch (Exception error)
        {
            if (!closing && current == generation)
            {
                AppendLog("连接失败：" + (connection?.CertificateValidationError ?? error.Message));
                status.Text = "连接失败";
                active = null;
            }
            if (connection is not null) await connection.DisposeAsync();
        }
        finally
        {
            if (!closing && current == generation) { connecting = false; UpdateControls(); }
        }
    }

    private async Task SendAsync()
    {
        var connection = active;
        int current = generation;
        if (connection is null || sending || closing) return;
        sending = true;
        UpdateControls();
        try { await connection.EchoAsync(message.Text, windowLifetime.Token); }
        catch (Exception error)
        {
            if (!closing && active == connection && current == generation) AppendLog("发送失败：" + error.Message);
        }
        finally
        {
            if (!closing && active == connection && current == generation) { sending = false; UpdateControls(); }
        }
    }

    private async Task MonitorAsync(SecureConnection connection, int current)
    {
        await connection.Completion;
        await connection.DisposeAsync();
        Post(connection, current, () =>
        {
            active = null;
            generation++;
            sending = false;
            authenticating = loggingOut = queryingIdentity = false;
            if (uploading) uploadStatus.Text = "连接已断开，上传未确认";
            uploading = false;
            ResetDownloadDisplay();
            password.Clear();
            status.Text = "已断开";
            UpdateControls();
        });
    }

    private async Task DisconnectAsync()
    {
        var connection = active;
        if (connection is null || closing) return;
        active = null;
        generation++; // Queued callbacks from the old connection are now ignored.
        connecting = true;
        sending = false;
        authenticating = loggingOut = queryingIdentity = false;
        if (uploading) uploadStatus.Text = "连接已断开，上传未确认";
        uploading = false;
        ResetDownloadDisplay();
        password.Clear();
        status.Text = "正在断开…";
        UpdateControls();
        try { await connection.DisposeAsync(); }
        finally
        {
            if (!closing)
            {
                connecting = false;
                status.Text = "已断开";
                AppendLog("连接资源已清理。");
                UpdateControls();
            }
        }
    }

    private async void OnClosingAsync(object? sender, FormClosingEventArgs e)
    {
        if (allowClose) return;
        e.Cancel = true;
        if (closing) return;
        closing = true;
        password.Clear();
        generation++;
        windowLifetime.Cancel();
        UpdateControls();
        var connection = active;
        active = null;
        if (connection is not null) await connection.DisposeAsync();
        if (fileUploadTask is not null) { try { await fileUploadTask; } catch { } }
        if (fileDownloadTask is not null) { try { await fileDownloadTask; } catch { } }
        allowClose = true;
        Close();
    }

    private void Post(SecureConnection source, int current, Action action)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try
        {
            BeginInvoke((Action)(() =>
            {
                if (!closing && !IsDisposed && active == source && current == generation) action();
            }));
        }
        catch (InvalidOperationException) { /* Window is already closing. */ }
    }

    private void UpdateControls()
    {
        bool idle = !closing && !connecting && active is null;
        connect.Enabled = idle;
        browse.Enabled = idle;
        address.Enabled = idle;
        caPath.Enabled = idle;
        send.Enabled = !closing && !connecting && !sending && active?.IsConnected == true;
        disconnect.Enabled = !closing && !connecting && active is not null;
        bool connected = !closing && !connecting && active?.IsConnected == true;
        bool authOperation = authenticating || loggingOut || queryingIdentity;
        login.Enabled = connected && !authOperation && active!.Identity is null;
        logout.Enabled = connected && !loggingOut && (active!.Identity is not null || authenticating);
        me.Enabled = connected && !authOperation;
        username.Enabled = !closing && !authOperation && active?.Identity is null;
        password.Enabled = username.Enabled;
        var identity = active?.Identity;
        chooseFile.Enabled = !closing && !uploading && !downloading;
        upload.Enabled = connected && identity is not null && !uploading && !downloading && filePath.TextLength > 0 && !authOperation;
        cancelUpload.Enabled = connected && uploading;
        identityLabel.Text = identity is null ? "未登录" : $"{identity.Username} · {identity.UserId}";
        UpdateDownloadControls(connected, authOperation);
        if (!closing && !connecting) status.Text = !connected ? "未连接" : identity is null ? "已连接未登录" : "已登录";
    }

    private async Task AuthenticateAsync(string operation)
    {
        var connection = active;
        int current = generation;
        if (connection?.IsConnected != true || closing) return;
        if (operation == "login") authenticating = true;
        else if (operation == "logout") loggingOut = true;
        else queryingIdentity = true;
        UpdateControls();
        try
        {
            if (operation == "login")
            {
                await connection.LoginAsync(username.Text, password.Text, windowLifetime.Token);
                if (!closing && active == connection && current == generation) AppendLog("登录请求成功。");
            }
            else if (operation == "logout")
            {
                await connection.LogoutAsync(windowLifetime.Token);
                if (!closing && active == connection && current == generation) AppendLog("已注销，连接保留。");
            }
            else
            {
                var identity = await connection.MeAsync(windowLifetime.Token);
                if (!closing && active == connection && current == generation) AppendLog($"当前身份：{identity.Username}，userId={identity.UserId}");
            }
        }
        catch (Exception error)
        {
            if (!closing && active == connection && current == generation) AppendLog("认证操作：" + error.Message);
        }
        finally
        {
            if (!closing && active == connection && current == generation)
            {
                if (operation == "login") { password.Clear(); authenticating = false; }
                else if (operation == "logout") loggingOut = false;
                else queryingIdentity = false;
                UpdateControls();
            }
        }
    }

    private void ChooseFile()
    {
        using var picker = new OpenFileDialog { Title = "选择上传文件（最多 100 MiB）", CheckFileExists = true, Multiselect = false };
        if (picker.ShowDialog(this) == DialogResult.OK) { filePath.Text = picker.FileName; UpdateControls(); }
    }

    private async Task UploadSelectedAsync()
    {
        var connection = active;
        int current = generation;
        if (connection is null || uploading || downloading || closing) return;
        long identityGeneration = connection.IdentityGeneration;
        int operation = ++uploadGeneration;
        uploading = true; uploadProgress.Value = 0; uploadStatus.Text = "准备上传"; UpdateControls();
        using var progress = new UiTransferProgress<UploadProgress>(value =>
        {
            if (closing || active != connection || current != generation || operation != uploadGeneration || !uploading
                || connection.IdentityGeneration != identityGeneration) return;
            uploadProgress.Value = value.TotalBytes == 0 ? (value.Phase == "上传成功" ? 1000 : 0)
                : (int)Math.Clamp(value.ConfirmedBytes * 1000 / value.TotalBytes, 0, 1000);
            uploadStatus.Text = $"{value.Phase} · {value.ConfirmedBytes}/{value.TotalBytes} 字节";
        });
        try
        {
            fileUploadTask = connection.UploadFileAsync(filePath.Text, progress, windowLifetime.Token);
            var result = await fileUploadTask;
            if (!closing && active == connection && current == generation)
            {
                if (connection.IdentityGeneration != identityGeneration)
                {
                    uploadStatus.Text = "会话已改变，请登录原账户核对上传结果";
                    return;
                }
                uploadProgress.Value = 1000; uploadStatus.Text = "上传成功";
                AppendLog($"上传成功：fileId={result.FileId}，大小={result.Size} 字节，SHA-256={result.Sha256}");
                await LoadFilesAsync(null, []);
            }
        }
        catch (Exception error)
        {
            if (error is UploadOutcomeUnknownException && !closing
                && ((active == connection && current == generation) || (active is null && generation == current + 1)))
            {
                uploadStatus.Text = "提交结果未确认；请核对，勿自动重传";
                AppendLog(error.Message);
            }
            else if (!closing && active == connection && current == generation)
            {
                uploadStatus.Text = connection.IdentityGeneration != identityGeneration ? "会话已改变，原上传已失效或结束"
                    : error is OperationCanceledException ? "上传已取消" : "上传未完成";
                AppendLog(error is OperationCanceledException ? "上传已取消，未自动重传。" : error.Message);
            }
        }
        finally
        {
            if (!closing && active == connection && current == generation) { uploading = false; UpdateControls(); }
        }
    }

    private void AppendLog(string text)
    {
        if (log.TextLength > 80000) log.Text = log.Text[^40000..];
        log.AppendText($"[{DateTime.Now:HH:mm:ss}] {text}{Environment.NewLine}");
    }
}
