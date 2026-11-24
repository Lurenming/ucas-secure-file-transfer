# 4.0.0 本机 GUI 人工验收（2026-11-25 验收修订）

本轮已经实际执行真实桌面自动点击，结果和限制见 [验收记录](acceptance-20261125.md)。客户端核心测试、窗体方法测试、真实桌面自动操作和用户亲自点击分别记证。旧 P5 的验收.md 保持原样，不移用旧结果；本文件不替用户预填人工“通过”。不要求固定运行时长、长期压力、真实磁盘满或断电试验。

## 已准备好的隔离环境

项目根：D:\UCAS\软件与系统安全\lab1。下面用 $fixture 表示 artifacts\acceptance-20261125\manual 的绝对路径。本轮服务已停止；不要同时启动两个使用同一数据目录的实例。无须重新签发证书、初始化账户或迁移原数据库。

| 项目 | 密码兼容模式 | mTLS 必需模式 |
| --- | --- | --- |
| 监听及连接 | 127.0.0.1:62284 | 127.0.0.1:62287 |
| 数据目录 | $fixture\password-data | $fixture\mtls-data |
| 人工 GUI 状态目录（空任务列表） | $fixture\client-human-password | $fixture\client-human-mtls |
| 人工下载目录 | $fixture\downloads-human-password | $fixture\downloads-human-mtls |
| 普通测试账户 | accept_alice / Lab25-Ordinary-Only! | 本人 PFX 绑定 accept_alice |
| VIP 测试账户 | accept_bob / Lab25-Vip-Only! | 本人 PFX 绑定 accept_bob |

以上都是本轮新建的公开演示口令，不是原账户密码。两个模式的数据和账户 ID 独立。普通账户上、下行分别为65536字节/秒，VIP分别为262144字节/秒；每窗口并发默认4，每个测试服务存储预留上限128MiB。少量修复前诊断任务保留供复核，受24小时期限和配额约束；人工窗口使用新的空任务目录。

公共 CA：$fixture\certs\public\dev-ca.crt。服务器证书允许127.0.0.1和localhost，不是0.0.0.0。SHA-256 指纹：

~~~text
14:2E:27:0D:5B:F1:90:E2:CE:24:0A:B7:2F:F3:50:64:53:98:0C:B2:CD:9A:3B:5E:0B:81:E8:D7:E6:57:1F:0F
~~~

本人 PFX：$fixture\accept_alice\private\client.pfx 或 accept_bob\private\client.pfx，本轮解锁口令均为 Lab25-Pfx-Only!。只选本人 PFX。CA 私钥和服务器私钥不用于客户端，不导入系统信任库，不关闭 TLS 验证。PFX 口令只在临时解锁框输入，不保存在连接配置中。

## 准确启动命令

在正常登录的 Windows 用户 PowerShell 中执行。本机 Schannel 在受限沙箱身份下曾报告0x8009030E，不能因此关闭验证。服务器终端：

~~~powershell
Set-Location 'D:\UCAS\软件与系统安全\lab1'
$node = 'D:\UCAS\软件与系统安全\lab1-tools\node-v22.23.5-win-x64\node.exe'
& $node server-node/scripts/acceptance-server.js password
# 证书模式在另一终端运行下列命令；它使用独立数据目录：
# & $node server-node/scripts/acceptance-server.js mtls
~~~

GUI 终端：

~~~powershell
Set-Location 'D:\UCAS\软件与系统安全\lab1'
$fixture = Join-Path (Get-Location) 'artifacts\acceptance-20261125\manual'
$env:SFT_CLIENT_STATE_DIR = Join-Path $fixture 'client-human-password'
& '.\artifacts\ui-labels-20261125\build\SecureFileTransfer.Client.exe'
# 证书模式：正常关闭 GUI，改为 client-human-mtls 后执行同一 EXE。
~~~

人工配置已填好端口、公共 CA、并发4。完成后正常关闭 GUI，在自己启动的服务器终端按 Ctrl+C。不要用默认 tools/run-node.mjs start 开始本轮人工验收，它会指向原数据目录。

本机按钮文字修订版使用上述独立构建目录；已打开的旧窗口仍显示旧文字。重建此版本时，先关闭该目录启动的 GUI，再执行 `dotnet build SecureFileTransfer.Client/SecureFileTransfer.Client/SecureFileTransfer.Client.csproj --nologo --output artifacts/ui-labels-20261125/build`。源码包不含私钥和数据库；其他位置首次建立夹具可运行 & $node server-node/scripts/prepare-acceptance.js（需要OpenSSL，只允许不存在的目录），随后以新 fixture.json 的输出为准，不能照搬本机端口、指纹及人工目录。

## 按顺序执行的最小清单

上传文件在 $fixture\upload-files：0、8193、48017字节、两份2MiB，以及便于操作中途状态的“操作-甲-8MiB.bin”“操作-乙-8MiB.bin”。每个服务器账户均已备好“下载-甲-2MiB.bin”“下载-乙-2MiB.bin”“下载-小文件.bin”。每项记日期、截图和实际结果，数据结果另记完整 SHA-256。

| 顺序 | 点击什么 | 预期与通过判据 | 需要记录 |
| --- | --- | --- | --- |
| 1 | 地址改0.0.0.0，点“连接”；再恢复127.0.0.1，“CA 公共证书…”选上述CA，连接并登录普通账户 | 无效地址明确拒绝且窗口继续响应；正确登录显示accept_alice和本人文件 | 错误提示、CA、端口、身份 |
| 2 | “上传”选48017字节小文件；刷新后选此文件，“下载”选 downloads-human-password\basic | 两项均完成；下载与源文件大小、SHA-256一致 | fileId、两份文件大小与摘要 |
| 3 | 同窗口上传两份8MiB；趁传输中多选两份2MiB种子文件下载到 downloads-human-password\parallel | 四项实际同时传输，并发4；方向、进度、字节、速度、结果完整 | 四项重叠截图；observations-password.json 中 up/down 同时为2 |
| 4 | 一项下载“暂停所选”，记录非零进度，再“继续 / 恢复”；一项上传同样操作 | 暂停时其他任务继续；恢复不从零起；最终摘要正确 | 暂停与恢复前后字节数、状态 |
| 5 | 传输中仅选一项，“取消并清理” | 仅该项已取消，其余继续或完成；不删除已完成文件 | 取消对象与其他结果 |
| 6 | 上传中“注销”；再登录原账户并手动恢复；上传中点X正常关窗，再重开、连接、登录、恢复 | 注销后不可操作；关窗进程退出；重开不会自动恢复身份或任务；检查点保留 | 前后偏移、重新认证、最终结果 |
| 7 | 下载小种子文件到 $fixture\no-write；失败后选该任务“取消并清理” | 已实测对当前Admin身份不可写；任务报错/待恢复，不能显示完成；目录仅含原keep.txt | 提示、状态、哨兵摘要、目录内容 |
| 8 | 关密码GUI，启动mTLS服务；用client-human-mtls启动GUI；“客户端 PFX…”选本人证书、解锁、连接、登录，上传小文件 | mtls-required；账户口令框禁用；显示绑定账户accept_alice；上传完成 | 证书指纹前缀、身份、结果 |
| 9 | 证书模式“注销”，不点登录，再正常关窗 | 证书仍有效也维持未认证；文件和任务操作不可用 | 注销界面 |

不可写目录仅限制本轮 manual\no-write，没有修改磁盘、系统或.git权限。这是**真实目录访问拒绝**，与自动测试的**模拟磁盘空间不足**不同。换Windows身份时须重查ACL条件。

~~~powershell
Get-Item -LiteralPath "$fixture\upload-files\小文件-48017.bin","$fixture\downloads-human-password\basic\小文件-48017.bin" | Select-Object FullName,Length
Get-FileHash -Algorithm SHA256 -LiteralPath "$fixture\upload-files\小文件-48017.bin","$fixture\downloads-human-password\basic\小文件-48017.bin"
Get-FileHash -Algorithm SHA256 -LiteralPath "$fixture\no-write\keep.txt"
~~~

keep.txt 应为 F7DF515A374E26F599430D261D7F7770F8FC7A541FD24E756BFB5F4A8C914DFF。服务端对象由管理员按fileId在本轮目录只读核对，不放宽私有存储权限。

## 继续保留的边界

真实双机局域网通信、正式专用账户部署、证书库选择（PFX已点验）、真实GUI换成另一用户证书及多项同时在途时关窗未完成对应点击验收。相关身份隔离、注销、连接池核心测试已通过，不能替代这些具体界面操作。旧GUI过期任务启动清理已通过实际窗体方法回归，未伪造系统时间另做桌面点击。

原E01“一个窗口只能一个传输”由单连接任务约束及窗口多任务隔离替代。长连接闲置、会话到期、证书负例、限速聚合、服务进程重启续传沿用相关代码一致的既有证据或本轮回归，不要求重复等待固定时长。真实断电和长期压力不属于本轮课程验收必做项。
