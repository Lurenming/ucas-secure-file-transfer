using System.Text.Json;
namespace SecureFileTransfer.Client.Networking;
public sealed record ClientSettings(string Host = "127.0.0.1", int Port = 8443, string PublicCa = "", int Concurrency = 4)
{
    public Uri Address()
    {
        if (string.IsNullOrWhiteSpace(Host) || Host.Contains('/') || Host.Contains('@') || Host is "0.0.0.0" or "::" || Port is < 1 or > 65535 || Concurrency is < 1 or > 8)
            throw new ArgumentException("请填写服务器实际 IP/域名、1–65535 端口和 1–8 并发数。");
        var uri = new UriBuilder("wss", Host, Port, "/ws").Uri;
        if (uri.HostNameType == UriHostNameType.Unknown) throw new ArgumentException("服务器地址无效。");
        return uri;
    }
    // Only public endpoint preferences. No credentials, tickets, private keys or PFX passwords.
    public void Save(string path) => File.WriteAllText(path, JsonSerializer.Serialize(this));
    public static ClientSettings Load(string path)
    { try { return JsonSerializer.Deserialize<ClientSettings>(File.ReadAllText(path)) ?? new(); } catch { return new(); } }
}
