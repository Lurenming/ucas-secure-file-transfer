using SecureFileTransfer.Client.Networking;

namespace SecureFileTransfer.Client;

public sealed class ConnectionTestForm : Form
{
    private readonly TextBox address = new() { Text = "wss://127.0.0.1:8443/ws", Dock = DockStyle.Fill };
    private readonly TextBox caPath = new() { Dock = DockStyle.Fill };
    private readonly TextBox message = new() { Text = "你好，安全文件传输！", MaxLength = 1024, Dock = DockStyle.Fill };
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

    public ConnectionTestForm()
    {
        Text = "安全文件传输 · P0.2 连接测试";
        ClientSize = new Size(980, 600);
        MinimumSize = new Size(800, 480);
        AutoScaleMode = AutoScaleMode.Font;
        StartPosition = FormStartPosition.CenterScreen;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 3, RowCount = 6 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        for (int row = 0; row < 5; row++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(new Label { Text = "服务器地址", AutoSize = true }, 0, 0);
        layout.Controls.Add(address, 1, 0);
        layout.SetColumnSpan(address, 2);
        layout.Controls.Add(new Label { Text = "CA 公共证书", AutoSize = true }, 0, 1);
        layout.Controls.Add(caPath, 1, 1);
        layout.Controls.Add(browse, 2, 1);
        var hint = new Label { Text = "仅选择可信本机目录的 dev-ca.crt；不会导入系统证书库。开发 CA 不提供吊销查询。", AutoSize = true, Padding = new Padding(0, 6, 0, 10) };
        layout.Controls.Add(hint, 0, 2);
        layout.SetColumnSpan(hint, 3);
        layout.Controls.Add(new Label { Text = "测试文本", AutoSize = true }, 0, 3);
        layout.Controls.Add(message, 1, 3);
        layout.SetColumnSpan(message, 2);
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Padding = new Padding(0, 6, 0, 8) };
        actions.Controls.AddRange([connect, send, disconnect, status]);
        layout.Controls.Add(actions, 0, 4);
        layout.SetColumnSpan(actions, 3);
        layout.Controls.Add(log, 0, 5);
        layout.SetColumnSpan(log, 3);
        Controls.Add(layout);
        caPath.Text = FindLocalCa();
        browse.Click += (_, _) => BrowseCa();
        connect.Click += async (_, _) => await ConnectAsync();
        send.Click += async (_, _) => await SendAsync();
        disconnect.Click += async (_, _) => await DisconnectAsync();
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
        generation++;
        windowLifetime.Cancel();
        UpdateControls();
        var connection = active;
        active = null;
        if (connection is not null) await connection.DisposeAsync();
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
    }

    private void AppendLog(string text)
    {
        if (log.TextLength > 80000) log.Text = log.Text[^40000..];
        log.AppendText($"[{DateTime.Now:HH:mm:ss}] {text}{Environment.NewLine}");
    }
}
