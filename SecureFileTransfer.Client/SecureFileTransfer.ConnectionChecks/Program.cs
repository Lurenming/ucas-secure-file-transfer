using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Diagnostics;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using SecureFileTransfer.Client.Networking;

if (args.Length < 2) throw new ArgumentException("Usage: ConnectionChecks <public-ca.crt> <wss-url> [fixture-url] [--expect-server-stop]");
string caPath = Path.GetFullPath(args[0]);
var address = new Uri(args[1]);
int scriptOption = Array.IndexOf(args, "--tls-fixture-script");
string tlsFixtureScript = scriptOption >= 0 ? args[scriptOption + 1]
    : Path.GetFullPath(Path.Combine(Path.GetDirectoryName(caPath)!, "../../scripts/tls-negative-fixture.js"));
void Check(bool condition, string description)
{
    if (!condition) throw new InvalidOperationException("FAIL: " + description);
    Console.WriteLine("PASS: " + description);
}

using (var untrusted = new ClientWebSocket())
{
    untrusted.Options.Proxy = null;
    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    bool rejected = false;
    try { await untrusted.ConnectAsync(address, deadline.Token); }
    catch (WebSocketException) { rejected = true; }
    Check(rejected, "C# default trust rejects the untrusted development CA");
}

using var rootKey = RSA.Create(2048);
var rootRequest = new CertificateRequest("CN=P02 isolated test CA", rootKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
rootRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
rootRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
using var testRoot = rootRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-2), DateTimeOffset.UtcNow.AddDays(30));
string temporary = Path.Combine(Path.GetTempPath(), "sft-p02-csharp-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(temporary);
string wrongCaPath = Path.Combine(temporary, "test-ca.crt");
await File.WriteAllTextAsync(wrongCaPath, testRoot.ExportCertificatePem()); // Public certificate only.
try
{
    await using (var wrongCa = new SecureConnection(address, wrongCaPath))
    {
        try { await wrongCa.ConnectAsync(); } catch (WebSocketException) { }
        Check(wrongCa.CertificateValidationError?.Contains("chain rejected") == true, "C# custom root rejects wrong CA during a real WSS handshake");
    }
    foreach (string problem in new[] { "hostname", "expired", "usage" })
    {
        using var leafKey = RSA.Create(2048);
        var request = new CertificateRequest("CN=local test server", leafKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        var san = new SubjectAlternativeNameBuilder();
        if (problem == "hostname") san.AddDnsName("mismatch.invalid"); else san.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(san.Build());
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new(problem == "usage" ? "1.3.6.1.5.5.7.3.2" : "1.3.6.1.5.5.7.3.1") }, true));
        using var publicLeaf = request.Create(testRoot, DateTimeOffset.UtcNow.AddDays(-1), problem == "expired" ? DateTimeOffset.UtcNow.AddHours(-1) : DateTimeOffset.UtcNow.AddDays(1), RandomNumberGenerator.GetBytes(16));
        using var leaf = publicLeaf.CopyWithPrivateKey(leafKey);
        // Schannel on this Windows version cannot serve ephemeral-key test certificates.
        // Node serves the deliberately invalid fixtures; the client and validator remain real C#.
        // Certificate and key travel only over this private child-process stdin pipe, never logs/files.
        using var fixture = new Process
        {
            StartInfo = new ProcessStartInfo("node")
            {
                ArgumentList = { tlsFixtureScript }, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            }
        };
        fixture.Start();
        try
        {
            await fixture.StandardInput.WriteAsync(JsonSerializer.Serialize(new { cert = leaf.ExportCertificatePem(), key = leafKey.ExportPkcs8PrivateKeyPem() }));
            fixture.StandardInput.Close();
            string? portLine = await fixture.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
            if (!int.TryParse(portLine, out int port)) throw new InvalidOperationException("Negative TLS fixture failed to start.");
            await using var connection = new SecureConnection(new Uri($"wss://127.0.0.1:{port}/ws"), wrongCaPath);
            try { await connection.ConnectAsync(); } catch (Exception error) when (error is WebSocketException or OperationCanceledException) { }
            string expected = problem switch { "hostname" => "Hostname", "expired" => "validity", _ => "serverAuth" };
            Console.WriteLine($"Certificate rejection detail ({problem}): {connection.CertificateValidationError ?? "callback not reached"}");
            Check(connection.CertificateValidationError?.Contains(expected) == true, $"C# rejects {problem} certificate during actual TLS validation");
        }
        finally
        {
            if (!fixture.HasExited) fixture.Kill();
            await fixture.WaitForExitAsync();
        }
    }
}
finally
{
    File.Delete(wrongCaPath);
    Directory.Delete(temporary); // Empty directory; private keys were never written.
}

await using var first = new SecureConnection(address, caPath);
await using var second = new SecureConnection(address, caPath);
await Task.WhenAll(first.ConnectAsync(), second.ConnectAsync());
Check(first.ConnectionId.HasValue && first.ConnectionId != second.ConnectionId, "two C# clients have isolated connection IDs");
Guid originalId = first.ConnectionId!.Value;
for (int i = 0; i < 3; i++)
{
    var replies = await Task.WhenAll(first.EchoAsync($"A-{i} 中文"), second.EchoAsync($"B-{i}"));
    Check(replies[0].ConnectionId == originalId && replies[0].RequestId != replies[1].RequestId, $"persistent C# ECHO round {i + 1}");
}
var parallel = await Task.WhenAll(Enumerable.Range(0, 8).Select(i => first.EchoAsync("concurrent-" + i)));
Check(parallel.Select(x => x.RequestId).Distinct().Count() == 8 && parallel.All(x => x.ConnectionId == originalId), "serialized concurrent sends preserve request correlation");
await second.DisconnectAsync();
Check(second.Completion.IsCompleted && !second.IsConnected, "C# disconnect completes receive loop and releases resources");
await using var reconnected = new SecureConnection(address, caPath);
await reconnected.ConnectAsync();
Check(reconnected.ConnectionId != second.ConnectionId, "C# reconnect has a fresh connection ID");
await reconnected.EchoAsync("reconnected");

if (args.Length >= 3 && args[2].StartsWith("wss://", StringComparison.Ordinal))
{
    var fixtureAddress = new Uri(args[2]);
    await using (var fragmented = new SecureConnection(fixtureAddress, caPath))
    {
        await fragmented.ConnectAsync();
        var result = await fragmented.EchoAsync("fragmented 中文");
        Check(result.Text == "fragmented 中文", "C# assembles fragmented HELLO and ECHO_RESULT");
    }
    foreach (var invalid in new[] { "oversize", "binary", "bad-json" })
    {
        await using var connection = new SecureConnection(fixtureAddress, caPath);
        await connection.ConnectAsync();
        bool rejected = false;
        try { await connection.EchoAsync(invalid); }
        catch (Exception error) when (error is IOException or InvalidDataException or OperationCanceledException or JsonException) { rejected = true; }
        await connection.Completion.WaitAsync(TimeSpan.FromSeconds(5));
        Check(rejected && !connection.IsConnected, $"C# rejects {invalid} inbound messages and ends receive loop");
    }
}

if (args.Contains("--auth-stdin"))
{
    string credentials = await Console.In.ReadLineAsync() ?? throw new InvalidDataException("Missing test input.");
    await AuthenticationChecks.RunAsync(caPath, address, new Uri(args[2]), credentials);
    credentials = "";
}

Console.WriteLine("C# idle acceptance started: 61 seconds without application ECHO (within the 120-second unauthenticated wait).");
await Task.Delay(TimeSpan.FromSeconds(61));
var afterIdle = await first.EchoAsync("after C# idle");
Check(afterIdle.ConnectionId == originalId, "C# connection remains usable after 61 seconds idle");
if (args.Contains("--expect-server-stop"))
{
    Console.WriteLine("READY_FOR_SERVER_STOP");
    await Task.WhenAll(first.Completion, reconnected.Completion).WaitAsync(TimeSpan.FromSeconds(12));
    Check(!first.IsConnected && !reconnected.IsConnected, "server stop closes all C# receive loops");
}
Console.WriteLine("C# connection and certificate checks completed.");
