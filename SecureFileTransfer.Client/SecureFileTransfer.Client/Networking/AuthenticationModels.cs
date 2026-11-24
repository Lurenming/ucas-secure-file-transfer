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
        "UPLOAD_BUSY" => "当前连接正在上传，请等待或取消",
        "UPLOAD_LIMIT" => "活动上传数已达上限，请稍后重试",
        "UPLOAD_QUOTA" => "服务器存储配额已满",
        "UPLOAD_SIZE" => "文件大小或接收长度不符合要求",
        "UPLOAD_HASH" => "文件 SHA-256 校验不一致",
        "UPLOAD_OFFSET" => "上传块偏移不符合顺序",
        "UPLOAD_NOT_FOUND" => "当前连接没有对应上传",
        "UPLOAD_CANCELLED" => "上传已取消或失效",
        "UPLOAD_STORAGE_ERROR" => "服务器暂时无法保存文件",
        "UPLOAD_ALREADY_COMMITTED" => "文件已提交，不能取消",
        "TRANSFER_BUSY" => "当前连接已有文件传输，请等待或取消",
        "TRANSFER_LIMIT" => "服务器活动传输数已达上限",
        "FILE_NOT_FOUND" => "文件不存在或不可访问",
        "FILE_UNAVAILABLE" => "文件暂时不可用或完整性异常",
        "INVALID_CURSOR" => "分页游标无效，请刷新列表",
        "FILE_RATE_LIMITED" => "列表请求过于频繁，请稍后重试",
        "DOWNLOAD_NOT_FOUND" => "当前连接没有对应下载",
        "DOWNLOAD_OFFSET" => "下载偏移或完成状态无效",
        "DOWNLOAD_CANCELLED" => "下载已取消或失效",
        _ => "请求暂时无法完成"
    };
}
