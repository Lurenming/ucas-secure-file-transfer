# 安全文件传输 4.0.0 — 最终源码与本机运行

本轮只整理启动入口、配置和交付，不改变认证、数据库、传输、限速或客户端界面业务代码。当前交付说明见 [docs/delivery.md](docs/delivery.md)，导出范围逐文件列于 [tools/release-files.txt](tools/release-files.txt)。

## 首次运行（Windows x64）

1. 将整个交付目录解压到可写位置，保留目录结构。需要 Windows PowerShell 5.1、OpenSSL 命令、**x64 .NET Desktop Runtime 10**。只有源码时，还需要 Python 3.11+、支持 `net10.0-windows` 的 .NET SDK 及可用的 npm / NuGet 下载源。
2. 交付的可运行副本包含完整 `publish/client`、便携 Node 22.23.5（含 npm）和按锁文件还原的服务器依赖。纯源码包不带这些生成物；先在项目根执行 `python tools/prepare-node.py --directory tools/runtime`，首次配置会还原 npm 依赖并发布客户端。
3. 检查 `startup.json`：默认连接 `127.0.0.1:8443`，独立运行目录为本副本的 `runtime`。端口占用时换一个空闲端口；不会终止其他进程。脚本按自身位置定位，不依赖当前终端目录或原来的 D 盘路径。
4. 双击 **首次配置.cmd**。它复用 `pki.js` 创建新的测试 CA 和服务器证书，在 `runtime/data` 预留数据目录，不预设账户或密码，也不导入系统信任库。任何已有 `runtime` 都会被拒绝覆盖。失败后的半成品保留供检查；需要重试时，将配置中的目录改成未使用过的 `runtime-新名称`（名称用 ASCII 字母、数字、下划线或连字符）。
5. 双击 **账户管理.cmd**，选 `1` 创建账户；按现有 CLI 提示交互输入两次密码，不回显、不写入脚本或配置。用户名为 3–32 位 ASCII 字母、数字、下划线，以字母开头；密码至少 12 个字符、最多 256 个 UTF-8 字节。

测试证书默认有效期 90 天；到期后通过现有 PKI 工具签发到新目录并人工规划替换，不覆盖旧证书。不要将初始化后的运行目录重新打包给别人。

## 日常运行

1. 双击 **启动服务器.cmd**，选 `1` 密码模式或 `2` mTLS 模式。窗口显示客户端应填写的地址、端口、公共 CA 完整路径和实际数据目录。两种模式共享同一账户库和上传目录，切换前在服务器窗口按 `Ctrl+C` 正常停止；不要并行启动两个实例。
2. 双击 **启动客户端.cmd**。它使用完整的 `publish/client` 发布目录，启动时按 `startup.json` 填入地址、端口和公共 CA；GUI 状态仅放在该运行目录的 `client` 中。点击“连接”，输入账户密码后点击“登录”。选择小文件上传，再从本人文件列表下载并核对。窗口内临时改地址可用于本次连接；下次使用入口启动会重新采用公共配置。
3. 管理员在服务器本机运行 **账户管理.cmd**：`1` 创建普通账户；`2` 查询；`3` 设普通或 VIP；`0` 退出。每次创建成功会再调用现有 `admin tier` 命令设置普通策略。若策略设置失败，菜单明确报告，先用菜单 `3` 修复后再使用账户。

| 等级 | `tier` | 上传字节/秒 | 下载字节/秒 |
| --- | --- | ---: | ---: |
| 普通用户 | `ordinary` | 65536 | 65536 |
| VIP | `vip` | 262144 | 262144 |

两个方向分别限速，沿用现有账户聚合限速逻辑。菜单不提供网络管理接口，不给普通客户端增加管理权限；只有持有服务器本机数据权限的管理员使用。权限隔离仍由现有存储 ACL 和操作系统账户实施。入口用于本机运行，不替代已有专用账户部署流程。

## mTLS 首次绑定

先在管理菜单创建账户（示例名 `demo_user`），正常停止服务器。在项目根 PowerShell 执行下列**现有 CLI 包装**。默认 `runtime` 示例；若改过运行目录，请同步替换命令中的 `runtime`。参数 `--pfx` 让 OpenSSL 交互询问导出密码，不要把密码写在命令行或脚本中。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/launch.ps1 -Action Cli pki client runtime/offline-ca runtime/demo_user --name demo_user --pfx
powershell -NoProfile -ExecutionPolicy Bypass -File tools/launch.ps1 -Action Cli admin bind demo_user runtime/demo_user/public/client.crt
```

再启动服务器选 `2`；客户端选择本人的 `runtime/demo_user/private/client.pfx`，交互解锁后重新连接并登录。此模式由证书绑定确认账户身份。只给客户端分发公共 CA 和其本人的 PFX，不分发 CA 私钥、服务器私钥或其他账户的 PFX。

## 配置、依赖与重新构建

服务器、账户管理、PKI 包装均读取同一 `startup.json`，明确设置 `SFT_DATA_DIR` 和 `SFT_CERT_DIR`，不会落回原 `server-node/data`。子进程设置只在当前入口内有效，不修改全局 PATH。启动时校验便携 Node 的版本和已固定 SHA-256；缺依赖会给出修复步骤，不偷偷选用全局旧 Node。

局域网使用：配置 `listenHost` 为服务器监听 IP、`clientHost` 为客户端实际访问的 IP / 域名，并显式设置 `allowLan: true`；然后在**新的运行目录**首次配置以生成匹配 SAN 的测试证书。不要让客户端填写 `0.0.0.0` / `::`。防火墙和真实双机通信仍按部署环境单独配置，本轮只验证本机回环。

重新发布客户端（先正常关闭客户端；保留整个输出目录）：

```powershell
dotnet publish SecureFileTransfer.Client/SecureFileTransfer.Client/SecureFileTransfer.Client.csproj -c Release --self-contained false -o publish/client --nologo
powershell -NoProfile -ExecutionPolicy Bypass -File tools/launch.ps1 -Action Cli npm-ci
```

服务端测试的 `test/helpers.js` 和子进程样本被多个工具直接导入，全部保留；五个 .NET 项目及项目引用也完整保留。样本由测试代码现场生成，不需要历史 `artifacts` 中的数据库、上传对象或证书。需要开发回归时才按对应工具运行；本轮没有重跑完整后端回归或压力测试。

## 提交与校验

最终源码取 `交付/SFT-4.0.0-git-final-20261125/SFT-4.0.0`，源码包为同级 `SFT-4.0.0-source.zip`，文件清单和 SHA-256 也在该目录。这里仅包含源码与必要说明；此前已验收的完整可运行副本仍保留在 `交付/SFT-4.0.0-final/SFT-4.0.0`。不要从旧 `artifacts/delivery` 取包，也不要打包原工作目录中的运行数据、私有备份或 `.git`。

本次 Git 收尾以已验收交付副本的 115 个源码文件为清单基础，保留 `tools/launch.ps1`、它依赖的工具以及必要测试代码。已提交时，最终包直接使用该提交的 Git blob 内容（含 Git 规范化的文本换行）；写入受阻时，清单明确标为经过核对的待提交源码。清单及哈希以包内 `SOURCE-MANIFEST.json`、外层 `DELIVERY-MANIFEST.json` 和 `SHA256SUMS.txt` 为准。

原工作目录保留原 Git 历史；从最新版本取消跟踪的旧资料仍保留在本地及既有历史中。`SOURCE-MANIFEST.json` 记录真实 HEAD、父提交和源码对应关系；历史验收记录保持原样，其中的 Git 状态仅描述当时的快照。本次收尾不增加功能、不追加验收、不运行测试、不推送远端。这是最终**源码交付**，不替代课程另行要求的署名报告、录像或真实远端仓库。
