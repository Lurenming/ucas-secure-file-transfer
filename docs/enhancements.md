# 安全文件传输增强版 4.0.0：实现、运行与验证

当前源码已实现可配置局域网连接、mTLS、账户证书管理、窗口传输连接池、账户聚合限速、持久化断点续传和部署 ACL。完整线协议见 [protocol-v4.md](protocol-v4.md)，GUI 人工步骤见 [manual-enhanced.md](manual-enhanced.md)。开发阶段证据见 [enhanced-20261124.json](evidence/enhanced-20261124.json)，最新验收修订证据见 [acceptance-20261125.json](evidence/acceptance-20261125.json)。旧 P5 人工验收属于备份版本，不能移用于本版。

实际验证包括 Node 回归、真实 C#/Node 通信、服务进程重启恢复、证书命令、迁移副本及独立低权限 Windows 身份下的访问边界。2026-11-25 验收修订补充了模拟磁盘空间不足、两处窗体状态回归及真实 GUI 自动操作，详见 [本轮验收记录](acceptance-20261125.md)；**真实跨机器通信待人工验证**。没有配置公网映射、部署独立 Windows 服务、创建正式运行账户、修改真实账户或迁移真实数据库。

## 架构与课件对应

一个窗口包含一条控制 WSS，以及默认4条、可配置1至8条可复用传输 WSS。每条传输连接一次只处理一个文件，窗口整体可同时执行多个上传和下载。控制连接完成密码或证书认证后，服务器签发最多60秒的窗口凭据；每条工作连接完成握手和凭据认证，服务器派生同一身份，客户端传入 userId 无效。mTLS 工作连接还必须持有同一客户端证书。注销和控制连接失联只撤销本窗口连接组，不注销其他独立窗口。

上传先记录完整文件身份，再按块刷盘并保存可信偏移；下载保存私有 part 和恢复 JSON。恢复必须重新确认账户、文件与偏移，最终完整 SHA-256 校验后才完成发布。上传和下载分别按账户限速，所有连接和窗口共享服务进程中的两个方向令牌桶。没有每个文件重建连接，也没有长期保存密码。

| 课件/要求 | 实现文件与主要入口 | 本轮实际验证 | 限制 |
| --- | --- | --- | --- |
| 第33页安全传输、多用户、完整性 | `tls.js/loadTlsOptions`、`auth.js/ConnectionAuth`、`uploads.js`、`downloads.js` | TLS/身份/隔离/SQL注入输入/资源上限回归、C#三方摘要 | 有界限制不等于抵御任意规模DDoS |
| 第36—37页长连接、显式keepalive、应用报头和时序 | `service.js/createService`、`SecureConnection.cs`、`UploadProtocol.cs`、`DownloadProtocol.cs` | 92字节头逐字节一致；真实闲置61秒后继续请求；连接复用 | 应用内部后台任务，未安装守护服务 |
| 第40页公钥身份加分 | `tls.js`、`auth.js/AUTH_CERT`、`window-auth.js`、`scripts/pki.js`、`scripts/admin.js` | mTLS正反例及真实C#携带私钥认证；11月25日实际GUI选择PFX、解锁、绑定账户登录 | 应用禁用表不是CRL/OCSP；证书库选择及GUI换另一用户仍待人工 |
| 第40页同GUI多文件加分 | `TransferForm.cs`、`TransferQueue.cs/WorkerAsync` | 核心联调及真实GUI同窗口2上传+2下载、暂停恢复、单项取消、注销和正常关窗恢复 | 最终GUI批次3完成、1主动取消；具体未点击的组合场景另列，不以核心测试替代 |
| 第40页用户等级带宽加分 | `bandwidth.js/AccountBandwidth`、`accounts.js/policy`、`admin.js/tier` | ordinary/VIP实测、同账户多连接上传及下载聚合、其他用户与health响应 | 短时突发8192字节；单服务进程统一调度 |
| 第40页断点续传加分 | `resume-store.js`、`migrations.js`、`SecureConnection.Resume.cs`、`TransferState.cs` | 非零偏移上传/下载恢复；真实服务进程退出重启；错误文件/偏移/归属/并发接管；完成ACK丢失；本地崩溃尾部 | 服务器24小时、本地7天；原始文件或恢复记录丢失需重新建立任务 |
| 第45页服务器ACL和运行权限 | `private-storage.js`、`tools/deploy-acl.ps1`、`tools/check-deployed-runtime.mjs` | 已在隔离目录由独立低权限身份实际启动HTTPS、写库及验证拒绝边界 | 未创建正式专用账户、未部署真实数据；不等于完整进程隔离 |
| 配置远端地址、严格验证 | `connection-config.js`、`ClientSettings.cs`、`health.js` | 随机端口实连、SAN匹配/不匹配、非回环显式开关 | 无第二台设备，真实双机未验证 |

## 现有工程启动（默认兼容密码模式）

使用正常登录的 Windows 用户终端，工作目录为项目根。没有依赖全局 Node。以下会启动现有数据目录，并在首次启动执行已在副本验证的版本化迁移；本轮尚未对真实目录执行该动作。先保留下面说明的私有备份。不要同时启动两个写入同一上传目录的服务。

```powershell
Set-Location 'D:\UCAS\软件与系统安全\lab1'
$node = 'D:\UCAS\软件与系统安全\lab1-tools\node-v22.23.5-win-x64\node.exe'
& $node tools/run-node.mjs info
& $node tools/run-node.mjs build
$env:SFT_LISTEN_HOST = '127.0.0.1'
$env:SFT_PORT = '8443'
$env:SFT_AUTH_MODE = 'password'
& $node tools/run-node.mjs start
```

新终端执行健康检查及 GUI；使用同一 Node 路径变量。新终端不继承另一个终端临时设置的环境变量，非默认配置须重新设定。

```powershell
$node = 'D:\UCAS\软件与系统安全\lab1-tools\node-v22.23.5-win-x64\node.exe'
& $node tools/run-node.mjs health
dotnet run --project SecureFileTransfer.Client/SecureFileTransfer.Client --no-build
```

GUI 默认127.0.0.1:8443；选择 `server-node/certs/public/dev-ca.crt`，连接后使用原有账户。并发设4，多选上传；刷新本人文件后 Ctrl多选、下载入队。每项可暂停、继续/恢复、取消并清理。注销、关窗保留可恢复数据但停止执行，必须重新认证后手动恢复。切换客户端证书先断开全部关联连接。连接配置仅保存 Host、Port、PublicCa、Concurrency，不保存口令或私钥；本地默认位置 `%LOCALAPPDATA%\SecureFileTransfer`，隔离测试可指定 `SFT_CLIENT_STATE_DIR`。

## 新 CA、服务器与客户端证书

需要 PATH 中有 OpenSSL；生产签发命令兼容本机已测 OpenSSL 3.x，专项过期证书夹具使用3.6的 `-not_before/-not_after`。以下在**全新目录**签发，不覆盖现有证书；IP `192.168.1.20` 是示例，应改为服务器真实局域网地址。目录 `secrets` 已被 Git 和交付包排除。CA目录保持离线，运行账户不得访问；服务器仅取得公共证书及服务器私钥。

```powershell
& $node tools/run-node.mjs pki init-ca secrets/offline-ca-2026
& $node tools/run-node.mjs pki server secrets/offline-ca-2026 secrets/server-lan-2026 --ip 127.0.0.1 --ip 192.168.1.20 --dns localhost --days 90
& $node tools/run-node.mjs pki check secrets/server-lan-2026 --ip 192.168.1.20 --dns localhost
& $node tools/run-node.mjs pki client secrets/offline-ca-2026 secrets/alice-2026 --name alice --pfx --days 90
& $node tools/run-node.mjs pki client secrets/offline-ca-2026 secrets/bob-2026 --name bob --pfx --days 90
openssl x509 -in secrets/offline-ca-2026/ca.crt -noout -fingerprint -sha256 -dates
```

PFX导出时 OpenSSL交互输入保护密码，不放在命令行、JSON或源码。分别把 `alice-2026/private/client.pfx` / `bob-2026/private/client.pfx` 安全交给各自用户；密码经独立可信渠道告知，客户端在临时密码框解锁，或导入当前用户个人证书库后选择。客户端只需要该用户的私钥和CA公共证书，不应取得其他用户、服务器或CA私钥。公共CA通过可信介质/渠道分发，双方用 `openssl x509 ... -fingerprint -sha256` 核对证书指纹，不能把未经核验的自签证书当成已建立信任。工具也检查CA/叶证书有效期、CA约束、用途、链、SAN及私钥匹配。

仅为**不存在的账户**交互创建口令，既有账户直接登记证书；重复 user-create 拒绝修改已有账户。

```powershell
# 需与服务端使用同一数据目录；默认就是 server-node/data
$env:SFT_CERT_DIR = (Resolve-Path secrets/server-lan-2026).Path
& $node tools/run-node.mjs user-create alice
& $node tools/run-node.mjs admin bind alice secrets/alice-2026/public/client.crt
& $node tools/run-node.mjs admin bind bob secrets/bob-2026/public/client.crt
& $node tools/run-node.mjs admin tier alice ordinary 65536 65536
& $node tools/run-node.mjs admin tier bob vip 262144 262144
& $node tools/run-node.mjs admin show alice
```

`bob`不存在时先执行 `user-create bob`。CN/显示名称不决定账户，管理员 `bind` 的服务器映射才决定身份。同一证书不能绑定到两个账户。服务器mTLS模式必须明确配置，失败不回退密码：

```powershell
$env:SFT_AUTH_MODE = 'mtls-required'
$env:SFT_LISTEN_HOST = '192.168.1.20' # 服务器监听地址
$env:SFT_ALLOW_LAN = '1'
$env:SFT_PORT = '8443'
$env:SFT_SERVER_NAME = '192.168.1.20' # 启动时附加核对SAN
& $node tools/run-node.mjs start
```

另一台客户端填写 `192.168.1.20:8443`，CA选择新公共CA，选择**自己的**PFX或证书库私钥，再连接并明确点击登录。`0.0.0.0`只能用于服务器显式监听，不能填写为客户端地址。DNS连接则DNS解析和证书SAN都须匹配。健康检查在mTLS下也要提交可信客户端证书：

```powershell
$env:SFT_CONNECT_HOST = '192.168.1.20'
$env:SFT_HEALTH_CERT = (Resolve-Path secrets/alice-2026/public/client.crt).Path
$env:SFT_HEALTH_KEY = (Resolve-Path secrets/alice-2026/private/client.key).Path
& $node tools/run-node.mjs health
```

证书轮换先签发到新目录，用 `pki check` 核验，停自己的服务后切换 `SFT_CERT_DIR` 再启动。CA轮换还需先可信分发新CA并重新签发/登记客户端证书；当前实现一次使用一个CA，不提供双CA无中断过渡。客户端换证书：

```powershell
& $node tools/run-node.mjs pki client secrets/offline-ca-2026 secrets/alice-next --name alice --pfx
& $node tools/run-node.mjs admin replace alice secrets/alice-next/public/client.crt
# show 返回64位无冒号SHA-256；以实际旧/现有指纹代替下方值
& $node tools/run-node.mjs admin disable alice ACTUAL_64_HEX_SHA256
```

replace在一个数据库事务中禁用旧登记并绑定新证书；disable对新认证立即生效，既有认证连接每次操作及最多1秒周期复查，关联任务停止但保留恢复检查点。这是应用登记禁用，不是CA级CRL/OCSP；已禁用证书的TLS握手可能仍可建立，但无法获得业务身份。注销后TLS证书仍有效，也不会自动恢复业务身份。

## 专用运行账户与权限

默认开发模式沿用“仅当前SID”数据ACL。正式专用账户部署应先由部署管理员为独立目录配置权限，再设 `SFT_ACL_MODE=verify`，避免运行时把管理员和运行身份权限重写。`SFT_STORAGE_SID`填写运行账户SID，`SFT_DEPLOY_ADMIN_SID`填写部署操作者SID，两者都由脚本输出。

| 部署子目录 | 运行账户权限 | 内容 |
| --- | --- | --- |
| app | 读取、执行 | 后端代码、依赖；便携Node也须可读执行 |
| config | 读取 | 非秘密配置，不给写入权限 |
| certs | 读取 | `public/dev-ca.crt`、`public/server.crt`、`private/server.key` |
| data | 修改 | SQLite、WAL/SHM、objects及可恢复part |
| logs / temp | 修改 | 可选stdout重定向日志、限定临时目录 |
| 独立离线CA目录 | 无权限 | CA私钥；绝不能复制到部署root |

本轮隔离部署使用现有低权限账户 `desktop-ftjkmnk\codexsandboxoffline`，与部署操作者 `desktop-ftjkmnk\admin` 不同；实际启动并验证了上述边界。未声称正式 `sft-runtime` 已创建或服务已安装。正式部署可在有权限的管理员终端交互创建账户（不加入Administrators）：

```powershell
$credential = Read-Host '新运行账户密码' -AsSecureString
New-LocalUser -Name 'sft-runtime' -Password $credential -Description 'Secure file transfer runtime'
$credential.Dispose()
# 部署目录必须预先只复制所需代码/依赖/服务器证书，明确标记；不要放.git或CA私钥
New-Item -ItemType File -Path 'D:\SFT-Deployment\.sft-deployment'
.\tools\deploy-acl.ps1 -DeploymentRoot 'D:\SFT-Deployment' -RuntimeAccount "$env:COMPUTERNAME\sft-runtime"
.\tools\deploy-acl.ps1 -DeploymentRoot 'D:\SFT-Deployment' -RuntimeAccount "$env:COMPUTERNAME\sft-runtime" -Apply
```

脚本仅处理root下app/config/certs/data/logs/temp，拒绝工程根、盘根、系统目录、.git、链接及CA私钥。默认检查，`-Apply`才应用。受本机脚本执行策略阻止时使用组织许可的签名脚本/终端，不通过设置Bypass绕过。以运行账户启动时在该终端设三个ACL环境变量、SFT_DATA_DIR/SFT_CERT_DIR/TEMP/TMP到对应目录，再运行Node；可使用 Windows `runas /user:计算机名\sft-runtime powershell.exe` 交互进入。普通运行不需要管理员权限。

防火墙只准备了限定规则，未实际应用。真实地址/网段核对后，管理员才执行第二行；不关闭防火墙，不开放公网：

```powershell
.\tools\firewall-lan.ps1 -LocalAddress 192.168.1.20 -RemoteSubnet 192.168.1.0/24 -Port 8443
.\tools\firewall-lan.ps1 -LocalAddress 192.168.1.20 -RemoteSubnet 192.168.1.0/24 -Port 8443 -Apply
```

## 自动复核、迁移、备份和真实状态

所有网络夹具使用新临时账户/目录/随机端口，不清理未知服务。`backend`包含新专项；不要并行跑两个针对同一部署数据的服务。证书预备必须使用新目录，以避免重生成真实证书。

```powershell
$env:SFT_CERT_DIR = Join-Path $PWD 'artifacts/my-validation-certs'
& $node tools/run-node.mjs certs
& $node tools/run-node.mjs build
& $node tools/run-node.mjs backend
& $node tools/run-node.mjs csharp
& $node tools/run-node.mjs csharp-enhanced
& $node tools/run-node.mjs pki-check
& $node tools/run-node.mjs smoke
```

每次结果、时间、退出码和stdout/stderr SHA-256均在 `artifacts/validation/<UTC时间>-<检查名>`。本机沙箱身份无法取得C# Schannel凭证，初次TLS回归失败；在正常Windows登录身份下、仍使用隔离夹具重跑通过，没有关闭TLS验证。专项过期证书测试需要OpenSSL3.6；OpenSSL3.0拒绝构造夹具时不能记成目标安全功能通过。

迁移在 `migrations.js` 使用SQLite `PRAGMA user_version` 和事务，0→1增加账户策略/证书登记及恢复字段，不改变账户口令或已提交文件。更高未知schema拒绝启动。实际私有副本 `artifacts/migration-copy` 已完成迁移，2用户及39已提交文件的ID/归属/大小/摘要保持一致，两库integrity_check=ok；真实数据未迁移。恢复旧版本时只在停服后向**新的空目录**恢复整套源码和匹配数据备份，不把旧数据库覆盖到正在运行的服务。

最终只读哈希核对：原有71个数据/证书文件内容和大小全部不变，`验收.md`不变。目录不是逐项完全不变：只读SQLite备份在旧目录 `server-node/data/uploads-backup-20261124-191550` 旁生成 `uploads.sqlite-wal`（0字节）及 `uploads.sqlite-shm`（32768字节），创建时间在备份清单写入前约1秒；没有更改数据库内容。辅助文件保留，不擅自删除。首次严格目录比对因此报差异，后续证据明确区分“原内容不变”和“新增辅助文件”。

源代码基线：`artifacts/baseline/P5-accepted-before-enhancements.zip`，108文件，SHA-256 `7f9daf1fa06cbc5f9ab2060ca6487057a6e4d9024e06c5c405e64a2a141bae13`。原材料另存 `artifacts/baseline/original-materials.zip`。完整私有备份在 `artifacts/private-backups/accepted-runtime-full/server-node`，与源码归档分开，限制为原Admin SID，排除Git/公开交付。开发完成快照 `artifacts/delivery/Enhanced-v4-source.zip` 及验收修订 `artifacts/delivery/Enhanced-v4-acceptance-20261125-source.zip` 保留。当前按钮文字修订版为 `artifacts/delivery/Enhanced-v4-final-ui-20261125-source.zip`，附清单及SHA-256，不含数据、证书私钥、依赖和构建输出；变更范围及本轮核对见 [按钮文字修订记录](ui-labels-20261125.md)。

Git仍在master，HEAD=`2aa0e325ba0d93f73265c7b96920d8b24c5ae3fa`。增强开发阶段创建分支曾被`.git/refs/heads/...lock: Permission denied`拒绝；验收阶段只读核对，没有反复尝试绕过权限、删锁、重建仓库、伪造提交或推送。修改留在工作区，由真实源码快照提供恢复点。这是源码交付，不是完整课程报告/视频/远端仓库均齐备的最终作业包。

## 可用于报告的文字

**实现概述：** 本系统采用C# WinForms客户端与Node.js服务端，通过HTTPS/WSS进行安全文件传输。客户端使用独立控制连接和有界传输连接池，同一业务身份可并行上传和下载多个文件；服务端根据认证账户检查文件归属，并对各账户的上传和下载分别聚合限速。增强版加入基于客户端证书登记的mTLS身份认证、版本化SQLite迁移、上传持久检查点和下载临时文件恢复机制。文件分块仍使用92字节自定义头，最终通过完整大小及SHA-256校验确认内容一致。

**实验结论：** 在隔离测试环境中，自动回归与真实C#/Node联调验证了TLS和账户隔离、两项上传与两项下载并行、单任务取消隔离、连接复用、非零偏移恢复、服务进程重启后的上传恢复，以及普通/VIP和同账户多连接聚合限速。独立低权限Windows身份能够运行服务并访问授权数据，同时被拒绝修改程序、读取离线CA私钥和指定无关私有目录。上述结果不等同于新版GUI人工验收或真实双机部署验收；这两项以及正式专用运行账户部署仍需补充人工验证。

2026-11-25新增的真实GUI自动操作、模拟磁盘空间不足和检查点修复结论，请使用 [验收记录中的更新文字](acceptance-20261125.md#可用于报告的两段文字)。它包含本轮失败、修复和复测，不把桌面自动化写成用户人工签字或真实双机通过。
