[CmdletBinding(PositionalBinding=$false)]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Setup','Server','Client','Accounts','Cli')][string]$Action,
    [ValidateSet('password','mtls-required')][string]$Mode,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$CliArguments
)
. (Join-Path $PSScriptRoot 'launch-common.ps1')
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

try {
    $config = Get-SftConfig
    Set-SftEnvironment $config
    Set-Location -LiteralPath $config.Project
    if ($Action -eq 'Client') {
        Assert-SftDesktopRuntime
        Assert-SftInitialized $config
        $exe = Join-Path $config.Publish 'SecureFileTransfer.Client.exe'
        Assert-SftClientFiles $config
        [IO.Directory]::CreateDirectory($config.ClientState) | Out-Null
        # This entry uses the shared endpoint. The existing GUI persists no credentials here.
        $settings = @{ Host=$config.ClientHost; Port=$config.Port; PublicCa=$config.PublicCa; Concurrency=4 } | ConvertTo-Json
        [IO.File]::WriteAllText((Join-Path $config.ClientState 'connection.json'), $settings, (New-Object Text.UTF8Encoding($false)))
        Show-SftEndpoint $config
        $client = Start-Process -FilePath $exe -WorkingDirectory $config.Publish -PassThru
        $client.WaitForExit()
        if ($client.ExitCode -ne 0) { throw "客户端退出码：$($client.ExitCode)" }
        exit 0
    }

    $node = Get-SftNode $config
    if ($Action -eq 'Cli') {
        if (!$CliArguments) { throw '用法：powershell -File tools/launch.ps1 -Action Cli <现有 run-node.mjs 命令及参数>' }
        Invoke-SftCli $config $node $CliArguments
        exit 0
    }
    if ($Action -eq 'Setup') {
        if (Test-Path -LiteralPath $config.Runtime) { throw "拒绝覆盖已有运行目录：$($config.Runtime)。日常使用请直接启动服务器 / 客户端。" }
        if (!(Get-Command openssl.exe -ErrorAction SilentlyContinue)) { throw '缺少 OpenSSL 命令。请安装 OpenSSL 并加入当前用户 PATH，再运行首次配置。' }
        Assert-SftDesktopRuntime
        if (!(Test-Path -LiteralPath (Join-Path $config.Publish 'SecureFileTransfer.Client.exe'))) {
            $sdks = & dotnet.exe --list-sdks
            if (!($sdks -match '^(1[0-9]|[2-9][0-9])\.')) { throw '源码构建需要支持 net10.0-windows 的 .NET SDK（10 或更新版本及目标包）。' }
            & dotnet.exe publish 'SecureFileTransfer.Client/SecureFileTransfer.Client/SecureFileTransfer.Client.csproj' -c Release --self-contained false -o $config.Publish --nologo
            if ($LASTEXITCODE -ne 0) { throw '客户端发布失败，请检查 SDK / NuGet 访问。未创建运行数据。' }
        }
        Assert-SftClientFiles $config
        if (!(Test-Path -LiteralPath (Join-Path $config.Project 'server-node/node_modules/express/package.json')) -or !(Test-Path -LiteralPath (Join-Path $config.Project 'server-node/node_modules/ws/package.json'))) {
            Invoke-SftCli $config $node @('npm-ci', (Join-Path $config.Project '.cache/npm'))
        }
        Assert-SftServerDependencies $config $node
        [IO.Directory]::CreateDirectory($config.Runtime) | Out-Null
        Invoke-SftCli $config $node @('pki','init-ca',$config.Authority)
        $san = $null
        $sanOption = if ([Net.IPAddress]::TryParse($config.ClientHost, [ref]$san)) { '--ip' } else { '--dns' }
        Invoke-SftCli $config $node @('pki','server',$config.Authority,$config.Certs,$sanOption,$config.ClientHost)
        [IO.Directory]::CreateDirectory($config.Data) | Out-Null
        [IO.Directory]::CreateDirectory($config.ClientState) | Out-Null
        $marker = @{ initializedAt=[DateTime]::UtcNow.ToString('o'); purpose='local test certificates; no pre-created accounts' } | ConvertTo-Json
        [IO.File]::WriteAllText((Join-Path $config.Runtime '.sft-initialized.json'), $marker, (New-Object Text.UTF8Encoding($false)))
        Show-SftEndpoint $config
        Write-Host "`n首次配置完成。请用“账户管理.cmd”创建账户，然后启动服务器和客户端。"
        Write-Host 'mTLS 客户端证书签发和绑定沿用已有 CLI，步骤见 README。'
        exit 0
    }

    Assert-SftInitialized $config
    Assert-SftServerDependencies $config $node
    Show-SftEndpoint $config
    if ($Action -eq 'Server') {
        if (!$Mode) {
            do {
                Write-Host "`n1. 密码认证`n2. mTLS（必须已签发并绑定客户端证书）`n0. 退出"
                $choice = Read-Host '请选择模式'
                if ($choice -eq '0') { exit 0 }
            } while ($choice -notin @('1','2'))
            $Mode = if ($choice -eq '1') { 'password' } else { 'mtls-required' }
        }
        $env:SFT_AUTH_MODE = $Mode
        Write-Host "认证模式：$Mode；监听：$($config.ListenHost):$($config.Port)"
        Write-Host '本窗口按 Ctrl+C 正常停止。两种模式使用同一数据目录，请勿同时启动。'
        Invoke-SftCli $config $node @('start')
        exit 0
    }

    Write-Host "`n账户管理仅供服务器管理员在本机执行，不向客户端提供管理接口。"
    while ($true) {
        Write-Host "`n1. 创建账户（普通用户）`n2. 查看指定账户信息`n3. 设置普通用户或 VIP`n0. 退出"
        $choice = Read-Host '请选择操作'
        if ($choice -eq '0') { break }
        if ($choice -notin @('1','2','3')) { Write-Host '请输入 0、1、2 或 3。'; continue }
        $username = Read-Host '账户名（3–32 位 ASCII 字母 / 数字 / 下划线，以字母开头）'
        try {
            switch ($choice) {
                '1' {
                    Invoke-SftCli $config $node @('user-create',$username)
                    try { Invoke-SftCli $config $node @('admin','tier',$username,'ordinary','65536','65536') }
                    catch { throw '账户已创建，但普通用户限速未设置成功。请立即用菜单 3 修复后再使用该账户。' }
                    Invoke-SftCli $config $node @('admin','show',$username)
                }
                '2' { Invoke-SftCli $config $node @('admin','show',$username) }
                '3' {
                    Write-Host "1. 普通用户：上传 / 下载各 65536 字节/秒`n2. VIP：上传 / 下载各 262144 字节/秒"
                    $tierChoice = Read-Host '请选择等级'
                    if ($tierChoice -notin @('1','2')) { throw '无效等级，未修改账户。' }
                    $tier = if ($tierChoice -eq '1') { 'ordinary' } else { 'vip' }
                    $rate = if ($tierChoice -eq '1') { '65536' } else { '262144' }
                    Invoke-SftCli $config $node @('admin','tier',$username,$tier,$rate,$rate)
                    Invoke-SftCli $config $node @('admin','show',$username)
                }
            }
        } catch { Write-Host ('操作未完成：' + $_.Exception.Message) -ForegroundColor Red }
    }
    exit 0
} catch {
    Write-Host ("`n无法继续：" + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
