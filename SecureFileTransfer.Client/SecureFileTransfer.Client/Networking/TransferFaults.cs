#if SFT_TEST_IO
namespace SecureFileTransfer.Client.Networking;
// Compiled only into ConnectionChecks, never into the WinForms application.
// Test code injects disk errors at real IO boundaries; no protocol/config switch enables this.
internal static class TransferFaults
{
    internal static Action<string, TransferState, FileStream?>? BeforeIo;
    internal static void Check(string phase, TransferState state, FileStream? stream = null) => BeforeIo?.Invoke(phase, state, stream);
}
#endif
