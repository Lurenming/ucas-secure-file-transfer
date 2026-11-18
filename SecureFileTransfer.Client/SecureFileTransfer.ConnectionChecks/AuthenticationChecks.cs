using System.Security.Cryptography;
using System.Text.Json;
using SecureFileTransfer.Client.Networking;

internal static class AuthenticationChecks
{
    private sealed record Credentials(string Username, string SecondUsername, string Password, string ExpiryAddress, string WaitingAddress);
    public static async Task RunAsync(string caPath, Uri address, Uri fixtureAddress, string input)
    {
        var credentials = JsonSerializer.Deserialize<Credentials>(input, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidDataException("Missing isolated test credentials.");
        input = "";
        void Check(bool condition, string description)
        {
            if (!condition) throw new InvalidOperationException("FAIL: " + description);
            Console.WriteLine("PASS: " + description);
        }
        async Task<ServerRequestException> Reject(Func<Task> operation, string code)
        {
            try { await operation(); }
            catch (ServerRequestException error) { Check(error.Code == code, "C# authentication rejection: " + code); return error; }
            throw new InvalidOperationException("Expected authentication rejection.");
        }
        var logs = new List<string>();
        await using var a = new SecureConnection(address, caPath);
        await using var b = new SecureConnection(address, caPath);
        a.Log += text => { lock (logs) logs.Add(text); };
        b.Log += text => { lock (logs) logs.Add(text); };
        await Task.WhenAll(a.ConnectAsync(), b.ConnectAsync());
        await Reject(async () => { await a.MeAsync(); }, "AUTH_REQUIRED");
        string wrong = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
        var wrongTask = Reject(async () => { await a.LoginAsync(credentials.Username, wrong); }, "AUTH_FAILED");
        var missingTask = Reject(async () => { await b.LoginAsync("missing_user", wrong); }, "AUTH_FAILED");
        await Task.WhenAll(wrongTask, missingTask);
        Check(wrongTask.Result.Message == missingTask.Result.Message, "C# nonexistent account and wrong password have the same message");
        await Task.Delay(1100); // Respect the real failed-attempt backoff.
        var first = await a.LoginAsync(credentials.Username, credentials.Password);
        var second = await b.LoginAsync(credentials.SecondUsername, credentials.Password);
        Check(first.UserId != second.UserId && a.Identity?.UserId == first.UserId, "C# two authenticated connections remain isolated");
        Check((await a.MeAsync()).Username == credentials.Username && (await b.MeAsync()).Username == credentials.SecondUsername, "C# AUTH_ME reports each bound identity");
        await Reject(async () => { await a.LoginAsync(credentials.SecondUsername, credentials.Password); }, "AUTH_ALREADY_LOGGED_IN");
        await a.LogoutAsync();
        Check(a.IsConnected && a.Identity is null, "C# logout clears identity and keeps WSS connected");
        await Reject(async () => { await a.MeAsync(); }, "AUTH_REQUIRED");
        await a.LoginAsync(credentials.Username, credentials.Password);
        await a.DisconnectAsync();
        Check(a.Identity is null, "C# disconnect clears identity");
        await using var reconnect = new SecureConnection(address, caPath);
        await reconnect.ConnectAsync();
        await Reject(async () => { await reconnect.MeAsync(); }, "AUTH_REQUIRED");
        var login = reconnect.LoginAsync(credentials.Username, credentials.Password);
        await Reject(async () => { await reconnect.LoginAsync(credentials.Username, credentials.Password); }, "AUTH_BUSY");
        await login;
        await reconnect.LogoutAsync();
        var cancelled = reconnect.LoginAsync(credentials.Username, credentials.Password);
        await Task.Delay(20);
        await reconnect.LogoutAsync();
        await Reject(async () => { await cancelled; }, "AUTH_CANCELLED");
        await Reject(async () => { await reconnect.MeAsync(); }, "AUTH_REQUIRED");
        Check(reconnect.Identity is null, "C# in-flight login cannot undo logout");

        await using (var expiring = new SecureConnection(new Uri(credentials.ExpiryAddress), caPath))
        {
            await expiring.ConnectAsync();
            await expiring.LoginAsync(credentials.Username, credentials.Password);
            await Task.Delay(900);
            Check(expiring.IsConnected && expiring.Identity is null, "C# session expiration clears local identity without dropping WSS");
            await Reject(async () => { await expiring.MeAsync(); }, "AUTH_REQUIRED");
            await expiring.LoginAsync(credentials.Username, credentials.Password);
            Check(expiring.Identity is not null, "C# can authenticate again on the expired session's connection");
        }
        await using (var waiting = new SecureConnection(new Uri(credentials.WaitingAddress), caPath))
        {
            await waiting.ConnectAsync();
            await waiting.EchoAsync("ECHO does not authenticate");
            await waiting.Completion.WaitAsync(TimeSpan.FromSeconds(3));
            Check(!waiting.IsConnected && waiting.Identity is null, "C# handles unauthenticated waiting timeout");
        }
        // Malicious/delayed test peer: a late success after logout must not restore client identity.
        await using (var stale = new SecureConnection(fixtureAddress, caPath))
        {
            await stale.ConnectAsync();
            var late = stale.LoginAsync(credentials.Username, credentials.Password);
            await stale.LogoutAsync();
            await Reject(async () => { await late; }, "AUTH_CANCELLED");
            Check(stale.Identity is null, "C# generation guard rejects a late successful login reply");
        }
        lock (logs) Check(logs.All(text => !text.Contains(credentials.Password) && !text.Contains(wrong)), "C# connection logs contain no test passwords");
        Console.WriteLine("C# authentication checks completed with isolated accounts.");
    }
}
