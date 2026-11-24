using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using SecureFileTransfer.Client;
using SecureFileTransfer.Client.Networking;

internal static class Program
{
    const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    static T Field<T>(object form, string name) => (T)form.GetType().GetField(name, Private)!.GetValue(form)!;
    static object? Call(object form, string name) => form.GetType().GetMethod(name, Private)!.Invoke(form, null);
    static void Await(Task task) { while (!task.IsCompleted) { Application.DoEvents(); Thread.Sleep(1); } task.GetAwaiter().GetResult(); }
    [STAThread]
    static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        if (args.Length == 2 && args[0] == "--diagnostic-ui")
        {
            // Test host only: show the actual form and record unexpected I/O locations.
            // No hook is installed in the delivered client executable.
            string report = Path.GetFullPath(args[1]);
            if (!report.Contains("acceptance-20261125")) throw new IOException("Isolated evidence path required");
            var gate = new object();
            AppDomain.CurrentDomain.FirstChanceException += (_, e) =>
            {
                if (e.Exception is not (IOException or UnauthorizedAccessException)) return;
                lock (gate) File.AppendAllText(report, DateTimeOffset.UtcNow + "\n" + e.Exception + "\n");
            };
            Application.Run(new TransferForm());
            return 0;
        }
        string root = Path.GetFullPath(args[0]);
        if (!root.Contains("acceptance-20261125") || System.IO.Directory.Exists(root)) throw new IOException("Fresh isolated regression directory required");
        System.IO.Directory.CreateDirectory(root); Environment.SetEnvironmentVariable("SFT_CLIENT_STATE_DIR", root);
        var checks = new List<string>();
        void Check(bool ok, string text) { if (!ok) throw new Exception(text); checks.Add(text); Console.WriteLine("PASS: " + text); }
        try
        {
            using var form = new TransferForm();
            var original = Field<ClientSettings>(form, "settings");
            foreach (string invalid in new[] { "0.0.0.0", "bad/host" })
            {
                Field<TextBox>(form, "host").Text = invalid;
                bool rejected = false; try { Await((Task)Call(form, "ConnectAsync")!); } catch (ArgumentException) { rejected = true; }
                Check(rejected && ReferenceEquals(original, Field<ClientSettings>(form, "settings")), "Rejected address leaves last valid form configuration intact: " + invalid);
                Call(form, "RenderTasks"); Call(form, "UpdateControls");
                Check(!File.Exists(Path.Combine(root, "connection.json")), "Rejected connection is not persisted and subsequent render does not throw");
            }
            var states = Field<List<TransferState>>(form, "states"); string taskDir = Field<string>(form, "taskDirectory");
            string source = Path.Combine(root, "original-source.bin"); byte[] bytes = RandomNumberGenerator.GetBytes(16384); File.WriteAllBytes(source, bytes);
            TransferState Create(string direction) => new() { Directory = taskDir, Direction = direction, LocalPath = source, Size = bytes.Length,
                Offset = 8192, CreatedAt = DateTimeOffset.UtcNow.AddDays(-8), Status = "待恢复" };
            var upload = Create("upload"); upload.UploadId = Guid.NewGuid(); upload.Save(); states.Add(upload);
            var download = Create("download"); File.WriteAllBytes(download.PartPath, bytes[..8192]);
            download.PartCreatedUtcTicks = File.GetCreationTimeUtc(download.PartPath).Ticks;
            download.PrefixSha256 = Convert.ToHexString(SHA256.HashData(bytes[..8192])).ToLowerInvariant(); download.Save(); states.Add(download);
            var unrelated = Create("download"); File.WriteAllBytes(unrelated.PartPath, [1, 2, 3]); unrelated.Save(); states.Add(unrelated);
            string unrelatedPath = unrelated.PartPath;
            Await((Task)Call(form, "ExpireLocalTasksAsync")!);
            Check(upload.Status == "已取消" && bytes.SequenceEqual(File.ReadAllBytes(source)), "Expired partial upload has no local part requirement and does not delete source");
            Check(download.Status == "已取消" && !File.Exists(download.PartPath), "Expired owned download part is cleaned");
            Check(unrelated.Status != "已取消" && File.ReadAllBytes(unrelatedPath).SequenceEqual(new byte[] { 1, 2, 3 }), "Unverifiable foreign part is retained");
            Check(TransferState.Load(taskDir).Single(s => s.Id == upload.Id).Status == "已取消", "Expired upload terminal state persists across reload");
            Field<System.Windows.Forms.Timer>(form, "timer").Stop();
            File.WriteAllText(Path.Combine(root, "result.json"), JsonSerializer.Serialize(new { passed = true, checks, classification = "WinForms form-method integration regression; not desktop clicks" }, new JsonSerializerOptions { WriteIndented = true }));
            return 0;
        }
        catch (Exception error) { File.WriteAllText(Path.Combine(root, "failure.txt"), error.ToString()); Console.Error.WriteLine(error); return 1; }
    }
}
