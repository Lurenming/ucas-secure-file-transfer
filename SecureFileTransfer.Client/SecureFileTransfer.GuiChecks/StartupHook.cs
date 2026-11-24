// Loaded only by the acceptance harness using DOTNET_STARTUP_HOOKS.
// No reference or startup hook is configured by the production client.
internal static class StartupHook
{
    public static void Initialize()
    {
        string? report = Environment.GetEnvironmentVariable("SFT_ACCEPTANCE_IO_TRACE");
        if (report is null || !Path.GetFullPath(report).Contains("acceptance-20261125")) return;
        File.AppendAllText(report, "StartupHook active; pid=" + Environment.ProcessId + "\n");
        object gate = new();
        int count = 0;
        AppDomain.CurrentDomain.FirstChanceException += (_, e) =>
        {
            if (e.Exception is OperationCanceledException) return;
            lock (gate) if (count++ < 1000) File.AppendAllText(report, DateTimeOffset.UtcNow + "\n" + e.Exception + "\n");
        };
    }
}
