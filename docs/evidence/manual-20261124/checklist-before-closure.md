# 安全文件传输软件：P5 后人工验收总清单

整理日期：2026-11-19。适用工程：D:\UCAS\软件与系统安全\lab1。

**本文件是操作清单，所有结果初始为“待测”，不是已经通过的验收报告。** 根据已提供的 P1–P5 记录整理：P1 核心 GUI 已有历史通过记录；P2/P3 GUI、P4 身份切换回调修复、P5 新启动器真实 Ctrl+C 仍需实际操作。P5 已有自动回归和独立复现证据，无需为每个 GUI 项目重跑整套自动测试。

## 1. 本次范围与判定规则

本轮完成核心 GUI、实际文件核对、启动停止，以及最终材料的人工审阅。先执行 A–G，再处理交付表 J。标为“条件项”的项目，在具备对应环境时执行；否则记录未覆盖及已有自动证据，不假填通过。长时间或破坏性测试不作为这次普通 GUI 验收的前置条件。

每项记录：通过 / 失败 / 未覆盖，测试时间、账户、文件名和 fileId（如适用）、实际提示、截图或日志位置。首次失败应保留原文；修复后补记复测结果，不覆盖首次失败。

特别注意：
- 使用便携 Node 22.23.5；系统 Node 仍为 22.16.0。当前功能 stage=P3、协议 version=1、包版本3.0.1均正常。
- 登录会话为绝对15分钟；操作或心跳不会续期。验收途中正常过期时重新登录，记录真实原因。连接后未登录约120秒会关闭，所以先准备文件，再连接。
- 取消要发生在传输尚未完成时。已经完成或已经进入最终提交的操作可能返回成功，不能要求撤销已提交文件。若没赶上，记“未覆盖”，另一次重测。
- 小文件“正在校验”可能转瞬即逝；不能仅因肉眼没看到就判失败。
- 文件 SHA-256 可以显示；密码、密码派生哈希、盐和私钥不应出现在 UI 日志或录屏。
- 本次只读核对服务器对象。不要修改真实 SQLite、objects 文件或私钥来模拟故障。
- 原工程已有账户和证书直接复用，不重建。若遗忘密码，先处理账户问题，不清空数据库。

## 2. 启动：四个终端的分工

| 终端 | 用途 |
| --- | --- |
| A | 后端保持运行；稍后在这里按 Ctrl+C |
| B | 健康检查、构建、准备文件、哈希核对；建议保持打开 |
| C | Alice 客户端 |
| D | Bob 客户端；需要时注销后改用 Alice 测同账户第二连接 |

每个 PowerShell 的变量独立；新终端必须重新定义需要的变量。

### 终端 A：后端

~~~powershell
Set-Location -LiteralPath 'D:\UCAS\软件与系统安全\lab1'
$sftNode = 'D:\UCAS\软件与系统安全\lab1-tools\node-v22.23.5-win-x64\node.exe'
& $sftNode .\tools\run-node.mjs info
& $sftNode .\tools\run-node.mjs start
~~~

检查实际 Node 为22.23.5、路径指向便携目录，后端监听回环8443。端口冲突时先识别原服务，不批量结束 Node 进程。

### 终端 B：健康检查与一次构建

~~~powershell
Set-Location -LiteralPath 'D:\UCAS\软件与系统安全\lab1'
$sftNode = 'D:\UCAS\软件与系统安全\lab1-tools\node-v22.23.5-win-x64\node.exe'
& $sftNode .\tools\run-node.mjs health
& $sftNode .\tools\run-node.mjs build
~~~

健康结果应为 status=ok、service=SecureFileTransfer.Server、stage=P3。构建成功后再启动客户端；构建失败先记录并解决。

### 终端 C 和 D：分别运行同一条客户端命令

~~~powershell
Set-Location -LiteralPath 'D:\UCAS\软件与系统安全\lab1'
dotnet run --project .\SecureFileTransfer.Client\SecureFileTransfer.Client\SecureFileTransfer.Client.csproj --no-build
~~~

两个窗口均使用：
- 地址：wss://127.0.0.1:8443/ws
- CA：D:\UCAS\软件与系统安全\lab1\server-node\certs\public\dev-ca.crt
- 分别登录原有 alice、bob。

如客户端已有错误/旧路径，应通过界面选择以上实际公共 CA。不导入系统根库、不关闭证书校验。

## 3. 一次性准备专用测试文件

在终端 B 执行。每次产生项目外的新目录，不覆盖已有文件。包含六个字节边界文件、12个分页文件、Alice/Bob区分标记、两份各64MiB的大文件和一个防覆盖目标。生成的大文件总计128MiB；本次服务器存储仍受原配额限制。

~~~powershell
$manualRoot = Join-Path 'D:\UCAS\软件与系统安全' (
    'lab1-manual-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' +
    [guid]::NewGuid().ToString('N').Substring(0,8)
)
$sourceDir = Join-Path $manualRoot 'sources'
$aliceDownloads = Join-Path $manualRoot 'downloads-alice'
$bobDownloads = Join-Path $manualRoot 'downloads-bob'
$evidenceDir = Join-Path $manualRoot 'evidence'
New-Item -ItemType Directory -Path $sourceDir,$aliceDownloads,$bobDownloads,$evidenceDir -ErrorAction Stop | Out-Null

$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    foreach ($size in @(0,1,8191,8192,8193,48017)) {
        $bytes = New-Object byte[] $size
        if ($size -gt 0) { $rng.GetBytes($bytes) }
        [IO.File]::WriteAllBytes((Join-Path $sourceDir "中文-$size.bin"), $bytes)
    }
    foreach ($i in 1..12) {
        [IO.File]::WriteAllText((Join-Path $sourceDir "分页-$i.txt"), "page-demo-$i")
    }
    [IO.File]::WriteAllText((Join-Path $sourceDir 'Alice专用.txt'), 'Alice test content')
    [IO.File]::WriteAllText((Join-Path $sourceDir 'Bob专用.txt'), 'Bob test content')
    $buffer = New-Object byte[] (1MB)
    foreach ($account in @('Alice','Bob')) {
        $largeFile = Join-Path $sourceDir "$account-64MiB.bin"
        $stream = [IO.File]::Open($largeFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            for ($i=0; $i -lt 64; $i++) {
                $rng.GetBytes($buffer)
                $stream.Write($buffer,0,$buffer.Length)
            }
        } finally { $stream.Dispose() }
    }
} finally { $rng.Dispose() }

$sentinelPath = Join-Path $aliceDownloads '禁止覆盖.txt'
[IO.File]::WriteAllText($sentinelPath, 'KEEP-ORIGINAL-SFT-MANUAL-TEST')
$sentinelHashBefore = (Get-FileHash -LiteralPath $sentinelPath -Algorithm SHA256).Hash
$sentinelHashBefore | Set-Content -LiteralPath (Join-Path $evidenceDir 'sentinel-before-sha256.txt') -Encoding UTF8

$sourceManifest = foreach ($file in Get-ChildItem -LiteralPath $sourceDir -File) {
    [pscustomobject]@{
        Name = $file.Name
        Length = $file.Length
        SHA256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
}
$sourceManifest | Export-Csv -LiteralPath (Join-Path $evidenceDir 'source-manifest.csv') -NoTypeInformation -Encoding UTF8
Write-Output "本次测试目录：$manualRoot"
Write-Output "源文件：$sourceDir"
Write-Output "Alice下载：$aliceDownloads"
Write-Output "Bob下载：$bobDownloads"
Write-Output "证据：$evidenceDir"
~~~

记下打印路径；界面选择文件时使用这些路径。不要把上述辅助脚本一次创建数组的方式误认为产品上传实现：产品仍是8KiB流式传输。

## 4. 必做 GUI 项目：按表顺序执行

### A. 连接、登录和基本交互

| 编号 | 操作 | 预期与判定 | 结果 / 证据 |
| --- | --- | --- | --- |
| A01 | 使用终端A/B启动、health、构建，再打开两窗口 | 明确使用便携Node22.23.5；health=P3；构建成功；没有误连其他服务 | 待测 |
| A02 | 正确CA连接，先不登录；再登录Alice/Bob | 未登录不能上传/列出/下载；连接和认证状态分开；成功后各自显示正确身份。若未登录ME按钮可点击，应提示先登录 | 待测 |
| A03 | Alice先输入一次错误密码，再输入正确密码；查询身份 | 错误凭据不能建立身份；密码掩码、提交后的清空行为正确；正确登录可查询Alice。错误密码用至少12字符，避免只测到长度校验；按实际限速提示等待 | 待测 |
| A04（条件项） | 在新开或已断开的测试窗口使用另一个已有的测试CA，尝试连接；恢复正确CA | 错误CA不能连成已连接/已登录，提示可理解；恢复正确CA可连接。没有其他测试CA时标未覆盖；证书负例已有自动证据。不要覆盖现有证书或拿私钥当CA | 待测 |

### B. 上传

| 编号 | 操作 | 预期与判定 | 结果 / 证据 |
| --- | --- | --- | --- |
| B01 | 打开“选择文件”后取消对话框 | 不开始上传、不出现假成功；已有选择按实际设计保留或清空，状态不自相矛盾 | 待测 |
| B02 | Alice分别上传中文-0/1/8191/8192/8193/48017.bin | 六种大小分别成功；空文件合法；成功结果含fileId、大小、SHA-256；各自记录ID。上传后ME仍是Alice，connectionId保持 | 待测 |
| B03 | 再上传同一个中文-8193.bin | 得到不同fileId；列表保留两个对象；分别下载到不同目标均匹配源文件，旧文件未被覆盖 | 待测 |
| B04 | Alice上传Alice-64MiB.bin，过程中拖动窗口、观察进度 | 界面响应；已确认字节进度向前；校验完成后才显示成功。保留此已提交大文件供后续下载测试 | 待测 |
| B05 | 再开始一次大文件上传，在进度未完成时取消；随后ME并手动重试 | 取消确认后连接/身份仍有效，connectionId不变，能再次上传。未提交上传不应出现在已完成列表。若已提交，允许成功，需另一次覆盖真正取消 | 待测 |

### C. 文件列表与分页

| 编号 | 操作 | 预期与判定 | 结果 / 证据 |
| --- | --- | --- | --- |
| C01 | 上传Alice专用.txt并刷新，查看成功文件的名称、大小、时间、ID | 列表包含本人已提交文件；与上传结果一致；同名文件用ID区分。已有历史文件可以存在，不要求列表为空 | 待测 |
| C02 | 上传12个分页文件，暂停新增上传后前后翻页、返回首页并刷新 | 每页及翻页控件正常；稳定列表遍历无无故重复或遗漏；列表不是冻结快照，新增文件后应刷新首页再比较 | 待测 |
| C03 | Bob上传Bob专用.txt并刷新，比较两个窗口 | Bob列表不出现Alice的专用标记，Alice列表不出现Bob的专用标记；不把两个账户恰有同名文件当串号。直接伪造fileId越权由自动测试覆盖 | 待测 |

### D. 下载、落盘与校验

| 编号 | 操作 | 预期与判定 | 结果 / 证据 |
| --- | --- | --- | --- |
| D01 | 选择列表中文件，先取消保存对话框；再依次下载六个边界文件到新目标 | 取消对话框不发起实际下载；六个文件均可成功保存，空文件也成立；文件名是建议，目标目录由用户选；成功后原连接仍可ME或继续下载 | 待测 |
| D02 | 按第5节分别核对六个边界文件；至少再核对一个完整大文件 | 源文件、按fileId找到的服务器.bin、下载文件三者大小和SHA-256一致；客户端显示摘要也一致。仅比较客户端文字不算独立核对 | 待测 |
| D03 | 将任意下载目标选为本次创建的“禁止覆盖.txt”；若弹覆盖确认，确认以检查应用自身拒绝；比较前后摘要 | 已有目标被拒绝覆盖；原文件内容/大小/摘要不变；另选新目标可成功。只操作专用哨兵文件，不用重要文件 | 待测 |
| D04 | 下载大文件到新目标，在未完成时取消；ME后换新目标重试 | 不出现最终完整文件；正常取消清理本次.part；身份和connectionId保持；重试可成功。磁盘检查只看本次目标目录，不删除陌生文件 | 待测 |
| D05（条件项） | 若有已知、现成的不可写位置，尝试保存 | 对话框或程序明确拒绝，不能假报成功；随后选可写新目标恢复。没有合适环境就记未覆盖，不为此修改系统/仓库ACL；模拟写入失败已有自动证据 | 待测 |

### E. 互斥与并发

| 编号 | 操作 | 预期与判定 | 结果 / 证据 |
| --- | --- | --- | --- |
| E01 | Alice上传时尝试下载，再在下载时尝试上传 | 同一连接一次一个传输，另一方向应禁用或明确拒绝；原任务不受损；结束/取消后按钮恢复 | 待测 |
| E02 | 先让Bob完整上传Bob-64MiB.bin；随后Alice上传自己的大文件，同时Bob下载自己的大文件；终端B运行health | 两窗口实际传输时间有重叠；各自进度和身份正确、无卡死，health正常。一个结束才开始另一个只算串行，不能记为并行通过 | 待测 |
| E03 | Bob窗口正常注销后登录Alice，查看并下载Alice已有文件；测完恢复Bob | 同一账户另一连接可以新建下载自己的文件；不与原窗口混淆。接管别人的活动downloadId属于自动测试，普通GUI无需伪造 | 待测 |

### F. 生命周期与重点修复

| 编号 | 操作 | 预期与判定 | 结果 / 证据 |
| --- | --- | --- | --- |
| F01 | 无传输时注销，随后查询身份（若按钮允许）、重新登录 | 注销清空身份和文件列表；连接保留；重新登录可用；未登录不允许文件操作 | 待测 |
| F02 | Alice上传大文件时注销并切换Bob；再单独覆盖下载中的同类操作 | 原未完成任务失效；旧进度、结果和列表不能污染Bob。重点观察切换后几秒内是否出现迟到的Alice回调。已提交Alice文件允许保留，不能因此视为失败。两种方向分别记录；操作过晚未覆盖并发就重测 | 待测 |
| F03 | 分别在上传、下载尚未完成时点击断开；重新连接登录 | 清除身份和列表；未完成下载正常清理本次临时文件；重连得到新connectionId，必须重新登录，不自动恢复旧传输 | 待测 |
| F04 | 两窗口传输中，在终端A对新启动器按真实Ctrl+C；检查监听，然后用同样命令重启、重连并登录 | 启动器及本次服务正常退出，终端返回提示符，8443无LISTENING；两端清除身份/连接，尚未完成确认的任务不能假报成功；重启可用；原已提交文件仍可列出并下载。这是P5新启动器尚缺的实际交互验证 | 待测 |
| F05 | 分别在上传、下载过程中正常关闭客户端窗口；再开新窗口连接 | 没有长期挂起或未处理异常；dotnet run终端返回；新窗口可登录。下载正常关窗清理本次临时文件；正常关窗与任务管理器强杀不是同一用例 | 待测 |
| F06 | 刚登录后记录connectionId，不发ECHO/ME/文件操作静置70秒，再ME并传输 | 仍是原connectionId和有效身份；继续操作正常。记录真实等待开始/结束时间，不用静态截图冒称长时间等待。不能把这70秒表述为长时间压力测试 | 待测 |

### G. 界面和日志

| 编号 | 操作 | 预期与判定 | 结果 / 证据 |
| --- | --- | --- | --- |
| G01 | 在当前显示缩放（你的设备此前为150%）下最大化、还原、调整窗口，使用中文长路径 | 关键按钮、列表、进度和错误信息可操作；长文本可合理滚动或复制；传输中不冻结。记录实际缩放；未测100%/200%就不宣称都通过 | 待测 |
| G02 | 查看成功、失败、取消、切换身份、停服的日志和界面状态 | 提示与真实状态一致；文件ID/大小/文件摘要可读；无密码、密码派生哈希、盐、私钥、原始认证包或内部SQL异常。ECHO只是诊断，不能替代ME证明已认证 | 待测 |

## 5. 独立三方文件比较

在终端 B 定义以下函数。fileId 必须来自对应那一次成功上传或列表行，特别注意同名文件存在多个ID。默认服务器目录适用于未设置SFT_DATA_DIR的工程；若设置过，传入实际专用objects目录。

~~~powershell
function Test-SftFile {
    param(
        [Parameter(Mandatory=$true)][string]$Source,
        [Parameter(Mandatory=$true)][guid]$FileId,
        [Parameter(Mandatory=$true)][string]$Downloaded,
        [string]$ServerObjects = 'D:\UCAS\软件与系统安全\lab1\server-node\data\uploads\objects'
    )
    $serverFile = Join-Path $ServerObjects ($FileId.ToString('D') + '.bin')
    $paths = @($Source, $serverFile, $Downloaded)
    $labels = @('源文件', '服务器文件', '下载文件')
    $rows = for ($i=0; $i -lt 3; $i++) {
        $item = Get-Item -LiteralPath $paths[$i] -ErrorAction Stop
        $hash = Get-FileHash -LiteralPath $paths[$i] -Algorithm SHA256 -ErrorAction Stop
        [pscustomobject]@{
            Role = $labels[$i]
            Path = $item.FullName
            Bytes = $item.Length
            SHA256 = $hash.Hash
        }
    }
    $rows | Format-List
    [pscustomobject]@{
        FileId = $FileId.ToString('D')
        SizeEqual = ($rows[0].Bytes -eq $rows[1].Bytes -and $rows[0].Bytes -eq $rows[2].Bytes)
        SHA256Equal = ($rows[0].SHA256 -eq $rows[1].SHA256 -and $rows[0].SHA256 -eq $rows[2].SHA256)
    } | Format-List
}

Test-SftFile -Source (Read-Host '源文件完整路径，不加引号') -FileId (Read-Host '该文件的fileId') -Downloaded (Read-Host '下载文件完整路径，不加引号')
~~~

两项Equal都应为True；找不到文件或命令报错不能算通过。可将结果复制到本次evidence目录的文本文件，标明对应测试编号。摘要十六进制字母大小写不同不影响比较。

防覆盖后在原终端 B 核对哨兵：
~~~powershell
$sentinelHashAfter = (Get-FileHash -LiteralPath $sentinelPath -Algorithm SHA256 -ErrorAction Stop).Hash
[pscustomobject]@{
    Path = $sentinelPath
    Unchanged = ($sentinelHashAfter -eq $sentinelHashBefore)
} | Format-List
~~~

## 6. Ctrl+C与重启的具体检查

只在终端 A 停止本次启动的服务。观察原终端返回提示符；用终端 B 检查监听：
~~~powershell
netstat.exe -ano -p tcp | Select-String ':8443\s+.*LISTENING'
~~~
没有输出表示该次快照未见8443监听；TIME_WAIT不是仍在监听。若仍有监听，记录PID/终端输出，不批量杀进程。

再在终端 A 执行原来的：
~~~powershell
& $sftNode .\tools\run-node.mjs start
~~~
终端 B：
~~~powershell
& $sftNode .\tools\run-node.mjs health
~~~
客户端重新连接并登录；检查原已提交文件可用。窗口显示EndpointUnavailable/1001与主动停服相符；未经预期的持续挂起、监听残留或无法重启应记录为异常。

如果原终端变量已丢失，重新执行第2节完整Set-Location与$sftNode定义，不使用系统node替代。

## 7. 补充检查：可选，不把未做写成通过

| 编号 | 检查 | 方法与边界 |
| --- | --- | --- |
| T01 | 默认120秒未认证期限 | 新连接后不登录，真实等待超过120秒，预期被关闭；与已登录70秒保活区分 |
| T02 | 默认15分钟会话期限 | 新登录后记录时间，不重新登录，观察超过15分钟时身份/列表失效，原连接可重新认证；操作不续期。到期后还受新的120秒认证等待约束 |
| T03 | 其他缩放/显示器 | 有条件再测100%/200%或第二显示器；记录实际范围，不为测试强制注销系统 |
| T04 | 权限可视化 | 可只读查看应用专用目录的Windows安全属性并截图；不改变ACL。规则查看不等于用另一Windows账户实际测试拒绝 |

以下继续使用已有自动证据，不要求你手工构造：SQL注入和伪造owner/任务ID；畸形二进制、偏移、超限；四个传输槽及配额；证书期限/用途/主机名负例；提交失败/恢复/最终ACK丢失；发布竞争；精确的旧回调时序；模拟IO失败。

真实磁盘满、损坏、断电、全容量与长期压力、跨Windows账户访问拒绝，以及30秒无进展/10分钟绝对传输期限的完整控制实验，保持其现有未验证范围。不要通过破坏真实数据或填满磁盘补做普通GUI验收。

## 8. 证据和反馈模板

建议从启动构建开始录一份真实操作视频，出现问题也保留；正式演示可在问题修复后重新录制。连续视频可以覆盖多个用例，不要求每条都单独截图。

优先保留：运行时/构建/health；上传成功；分页；下载成功及三方哈希；防覆盖前后；两个账户并行；上传/下载取消后的ME和相同connectionId；切换身份；真实Ctrl+C、无监听和重新启动。

单项记录模板：
~~~text
编号：
结果：通过 / 失败 / 未覆盖
时间：
账户及connectionId（适用时）：
源文件及大小：
fileId / 下载目标（适用时）：
实际行为或完整报错：
截图、视频时间点或日志：
修复与复测（若有）：
~~~

截图/视频不要出现密码或私钥。若部分用例未触发，写清原因，不能把“点过按钮”直接记为通过。可分批反馈结果，例如先A+B+C，再D+E，最后F+G。

清理只涉及明确属于本次manualRoot的本地源/下载临时文件；在证据保存及必要报告截图完成前先保留。不要手工删除真实服务器对象或修改数据库；服务器内已提交测试文件与其元数据必须保持一致。

## 9. 课程交付的人工确认

这些属于最后交付检查，不要求在开始GUI验收前全部完成。

| 编号 | 检查 | 完成标准 | 状态 |
| --- | --- | --- | --- |
| J01 | 记录GUI验收 | 将真实结果补到工程docs/gui-p2-p3.md，P4回调和P5 Ctrl+C明确记录；失败修复后复测，未覆盖如实保留 | 待完成 |
| J02 | MP4视频 | 播放检查画面/声音/隐私；展示真实编译、部署、登录及传输测试，不能只有静态截图；不用旧系统Node启动命令 | 待完成 |
| J03 | 正式报告 | 填真实姓名、学号和Git链接；更新P5实际环境；协议图渲染可读；加入真实截图、结果和限制；导出PDF或DOCX并逐页检查 | 待完成 |
| J04 | 本地Git历史 | 在正常允许写入的环境审阅并提交累计P2–P5修改；记录真实提交号，不伪造历史日期。若仍权限拒绝，保留错误和快照，不删除未知锁/重建.git | 待完成 |
| J05 | 远端与公开要求 | 报告URL指向实际项目，确有对应源码和历史；按课程要求处理开源及访问状态（课件允许提交后公开）。远端操作应由用户明确执行或授权 | 待完成 |
| J06 | 最终打包 | 如实填写submission-info.json审核字段；使用真实报告/MP4运行final；缺项时不通过改标志或空文件冒充；复核无秘密及运行数据 | 待完成 |
| J07 | 最终ZIP与提交 | 解压查看内容和命名；报告/MP4实际可打开；ZIP无加密；保留提交版本与哈希并提交课程网站、核对回执 | 待完成 |

最终打包命令（仅在实际满足条件后）：
~~~powershell
Set-Location -LiteralPath 'D:\UCAS\软件与系统安全\lab1'
python .\tools\delivery.py final --report '正式报告完整路径.pdf' --video '真实演示完整路径.mp4'
~~~

课件命名：外层目录“姓名_学号_EX1B”；源码“姓名_学号_ex1B_src”；视频“姓名_学号_ex1B_play.mp4”；报告“姓名_学号_ex1B_report.pdf”或.docx。最终为未加密ZIP。截止：北京时间2026-11-24 23:55。

P5-CANDIDATE-final.zip仍是待验收候选，不因文件名含final就成为最终课程提交包。自动测试通过、GUI通过、视频完成、正式交付完成应分别记录。

