using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace SecureFileTransfer.Client.Networking;

// Trust is scoped to this connection. Never modifies a Windows certificate store.
public sealed class DevelopmentCertificateValidator : IDisposable
{
    private const string ServerAuth = "1.3.6.1.5.5.7.3.1";
    private readonly X509Certificate2 root;
    private readonly string hostname;
    public string? LastError { get; private set; }

    public DevelopmentCertificateValidator(string publicCaPath, string hostname)
    {
        this.hostname = hostname;
        string pem = File.ReadAllText(publicCaPath);
        if (pem.Contains("PRIVATE KEY", StringComparison.Ordinal))
            throw new ArgumentException("请选择 CA 公共证书，不要选择任何私钥文件。");
        root = X509Certificate2.CreateFromPem(pem);
        if (!root.Extensions.OfType<X509BasicConstraintsExtension>().Any(x => x.CertificateAuthority)
            || !root.Extensions.OfType<X509KeyUsageExtension>().Any(x => x.KeyUsages.HasFlag(X509KeyUsageFlags.KeyCertSign)))
        {
            root.Dispose();
            throw new ArgumentException("所选证书不是可签发证书的 CA。");
        }
    }

    public bool Validate(object sender, X509Certificate? certificate, X509Chain? suppliedChain, SslPolicyErrors errors)
    {
        bool Reject(string reason) { LastError = reason; return false; }
        try
        {
            if (certificate is null || errors.HasFlag(SslPolicyErrors.RemoteCertificateNotAvailable))
                return Reject("Missing server certificate");
            using var leaf = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());
            if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch)
                || !leaf.MatchesHostname(hostname, allowWildcards: false, allowCommonName: false))
                return Reject("Hostname does not match certificate SAN");
            var now = DateTime.UtcNow;
            if (now < leaf.NotBefore.ToUniversalTime() || now > leaf.NotAfter.ToUniversalTime()
                || now < root.NotBefore.ToUniversalTime() || now > root.NotAfter.ToUniversalTime())
                return Reject("Certificate is outside its validity period");
            if (!leaf.Extensions.OfType<X509EnhancedKeyUsageExtension>()
                .Any(x => x.EnhancedKeyUsages.Cast<Oid>().Any(oid => oid.Value == ServerAuth)))
                return Reject("Certificate has no serverAuth usage");
            using var chain = new X509Chain();
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(root);
            chain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
            chain.ChainPolicy.ApplicationPolicy.Add(new Oid(ServerAuth));
            // This development CA has no CRL/OCSP service. Chain, time, name and EKU remain enforced.
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            chain.ChainPolicy.DisableCertificateDownloads = true;
            if (suppliedChain is not null)
                foreach (var element in suppliedChain.ChainElements.Cast<X509ChainElement>().Skip(1))
                    chain.ChainPolicy.ExtraStore.Add(element.Certificate);
            if (!chain.Build(leaf))
                return Reject("Certificate chain rejected: " + string.Join(", ", chain.ChainStatus.Select(x => x.Status)));
            LastError = null;
            return true;
        }
        catch (Exception error) when (error is CryptographicException or ArgumentException)
        {
            return Reject("Certificate validation failed: " + error.GetType().Name);
        }
    }

    public void Dispose() => root.Dispose();
}
