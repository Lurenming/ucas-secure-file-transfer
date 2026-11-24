# EX1B 录屏脚本（尚未录制）

本文件是后续录屏顺序，不是视频。2026-11-24 GUI人工验收已补录27项通过、D05条件性未覆盖，已有真实截图和日志，详见docs/evidence/gui-20261124.md；尚未找到实际MP4，不能用截图冒充录制。按课件第3页命名 `姓名_学号_ex1B_play.mp4`；录制编译、部署、测试全过程，密码只能在掩码框/隐藏输入中输入，不展示证书私钥、数据库内容或终端凭据。无需新增网页或容器。

## 录制前

1. 复用已完成的 [统一GUI验收](gui-p2-p3.md) 准备条件，无需为文档更新重复整套测试；录屏时真实演示所选步骤。填写 `submission-info.json` 中真实姓名、学号和真实Git仓库链接。Git提交/远端/公开状态仍须真实完成，录屏不伪造。
2. 保留已有证书和账户。若8443占用，检查归属，在自己原服务终端正常Ctrl+C；不要按端口杀进程。
3. 正式录屏使用 [P5便携运行方式](p5.md)：明确调用已验证的Node 22.23.5；系统Node仍为22.16.0，不能直接用裸node/npm命令冒充新版本。P4旧版本证据保持不变。
4. 用系统已有录屏工具选择MP4输出。录屏时长没有在课件中给出硬性数字；展示关键过程，真实61秒保活等待可说明并保留可核查画面，不伪称加速画面为实时测试。

## 1. 构建（录下命令与成功结果）

```powershell
Set-Location 'D:\UCAS\软件与系统安全\lab1'
$Node = 'D:\UCAS\软件与系统安全\lab1-tools\node-v22.23.5-win-x64\node.exe'
& $Node .\tools\run-node.mjs info
dotnet --version
& $Node .\tools\run-node.mjs build
# 新解压源码副本首次运行需要：& $Node .\tools\run-node.mjs npm-ci
# 已有依赖无需为录屏重装。后续命令均在源码根目录执行。
```

展示四项目保留、0错误（以录制当次真实输出为准），解释实际WinForms使用的Networking源码也被ConnectionChecks编译。不要把项目旧C# Server称为当前后端；当前后端是Node。

## 2. 部署与连接

```powershell
# 仅缺少证书的新副本首次执行；已有证书不覆盖：
& $Node .\tools\run-node.mjs certs
# 仅首次创建所需账户，已存在账户不要重复创建或覆盖：
& $Node .\tools\run-node.mjs user-create alice
& $Node .\tools\run-node.mjs user-create bob
& $Node .\tools\run-node.mjs start
```

新终端：

```powershell
Set-Location 'D:\UCAS\软件与系统安全\lab1'
$Node = 'D:\UCAS\软件与系统安全\lab1-tools\node-v22.23.5-win-x64\node.exe'
& $Node .\tools\run-node.mjs health
dotnet run --project .\SecureFileTransfer.Client\SecureFileTransfer.Client\SecureFileTransfer.Client.csproj --no-build
```

启动第二客户端可在第三终端重复dotnet run。选择可信本机CA公共证书，连接WSS，展示HELLO/connectionId和“已连接未登录”。说明证书链、有效期、SAN、serverAuth都验证，CA不自动导入全局根库。

## 3. 准备非敏感测试文件

```powershell
$demoRoot = Join-Path $env:TEMP ('SFT-DEMO-' + [guid]::NewGuid().ToString('N'))
$sourceDirectory = Join-Path $demoRoot 'sources'
$downloadDirectory = Join-Path $demoRoot 'downloads'
New-Item -ItemType Directory -Path $sourceDirectory,$downloadDirectory | Out-Null
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  foreach ($size in 0,1,8191,8192,8193,48017,16777216) {
    $bytes = New-Object byte[] $size
    $generator.GetBytes($bytes)
    [IO.File]::WriteAllBytes((Join-Path $sourceDirectory ("中文-$size.bin")), $bytes)
  }
  1..12 | ForEach-Object { [IO.File]::WriteAllText((Join-Path $sourceDirectory ("分页-$_.txt")), "demo $_") }
} finally { $generator.Dispose() }
Write-Output $demoRoot
```

最多约17MiB人工演示数据，有明确上限，不填满磁盘。目录随机新建，源文件与下载分开。该命令只准备数据，不代表界面测试已完成。实际客户端逐块流式处理，不采用此辅助命令中的整数组方式上传。

## 4. 登录、上传与列表

未登录查询ME应拒绝；错误密码显示统一错误（间隔等待限速提示）。Alice、Bob分别正确登录，展示不同身份。Alice上传中文边界/多块文件，说明8KiB有效块、服务器写完ACK后更新进度、正在校验后才成功。再次上传同名文件，两个fileId不同。上传12个小分页文件，刷新/翻页，Bob列表不出现Alice文件。

展示成功后connectionId未改变，继续查询ME或ECHO；ECHO仅诊断，不能证明登录。两窗口可让Alice上传、Bob下载自己的已提交文件，说明合计四个传输预算，不能把应用限额说成能抵御任意DDoS。

## 5. 下载、校验与防覆盖

从列表选择文件，SaveFileDialog保存到新目标，展示写入字节进度、正在校验、成功后的文件标识/大小/SHA-256。在终端独立计算源文件和下载文件：

```powershell
Get-Item -LiteralPath '替换为源文件路径','替换为下载文件路径' | Select-Object FullName,Length
Get-FileHash -LiteralPath '替换为源文件路径','替换为下载文件路径' -Algorithm SHA256
```

需要三方核对时按返回fileId只读比较 `server-node\data\uploads\objects\<fileId>.bin`。服务器路径不由网络返回。再尝试保存到已存在目标，展示拒绝且原内容不变。说明SHA-256与可信WSS元数据一起使用，摘要不是身份认证。

## 6. 取消、异常提示与复用

选择16MiB文件尝试在传输中取消上传/下载；若已完成，诚实说明未赶上取消，换新目标重做。取消后查询ME、手动重试、展示原connectionId；不自动重传。上传最终ACK丢失的“不确定结果”、后台模拟IO故障不便在GUI稳定重现，可展示自动日志并明确标为自动测试，不表演假的界面错误。

传输中注销/切换Bob，检查旧进度/列表不污染新身份。断开重连需要重新登录。在本次后端终端Ctrl+C，窗口应清除连接/身份。按需重启并手动连接。最后关闭两个窗口和本次服务；只清理明确属于本次demoRoot的测试文件，保留用户原始数据。

## 7. 展示自动证据及收尾

```powershell
Set-Location 'D:\UCAS\软件与系统安全\lab1'
$Node = 'D:\UCAS\软件与系统安全\lab1-tools\node-v22.23.5-win-x64\node.exe'
& $Node .\tools\run-node.mjs backend
& $Node .\tools\run-node.mjs csharp
git log --oneline -4
git status --short
```

录制当次命令是新的运行证据，不能用静态文本伪造输出。完整回归含真实等待，预留时间。仅在需要录制或验证新修改时重跑；当前P4已通过的日志无需无意义重复。

导出MP4后人工播放检查声音/画面及隐私，保留已补录GUI结果与本次视频证据的区别；报告加入真实截图、结果和Git URL，导出PDF或DOCX。然后按 [交付说明](delivery.md) 生成最终未加密ZIP，**由用户**在北京时间2026-11-24 23:55前提交课程网站。
