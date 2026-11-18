namespace SecureFileTransfer.Client.Networking;

public sealed record SessionIdentity(Guid UserId, string Username, DateTimeOffset ExpiresAt);

public sealed class ServerRequestException(string code) : Exception(MessageFor(code))
{
    public string Code { get; } = code;
    private static string MessageFor(string code) => code switch
    {
        "AUTH_FAILED" => "用户名或密码错误",
        "AUTH_REQUIRED" => "请先登录",
        "AUTH_ALREADY_LOGGED_IN" => "请先注销再切换账户",
        "AUTH_BUSY" => "登录校验正在进行",
        "AUTH_RATE_LIMITED" => "登录尝试过于频繁，请稍后重试",
        "AUTH_SERVER_BUSY" => "认证服务繁忙，请稍后重试",
        "AUTH_CANCELLED" => "登录已取消或会话已失效",
        "INVALID_MESSAGE" => "消息格式或字段无效",
        _ => "请求暂时无法完成"
    };
}
