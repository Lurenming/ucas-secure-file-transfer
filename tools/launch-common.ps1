# Shared local launch configuration. No account, authentication or bandwidth implementation here.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:SftProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Resolve-SftDirectory([string]$RelativePath) {
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath)) {
        throw 'startup.json 中的目录必须是项目内的相对路径。'
    }
    $path = [IO.Path]::GetFullPath((Join-Path $script:SftProject $RelativePath))
    if (!$path.StartsWith($script:SftProject + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw '运行目录必须位于当前项目副本内，不能指向上级目录。'
    }
    $probe = $path
    while ($probe -and $probe -ne $script:SftProject) {
        if (Test-Path -LiteralPath $probe) {
            if ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "拒绝通过链接或目录联接访问运行路径：$probe"
            }
        }
        $probe = Split-Path -Parent $probe
    }
    return $path
}

function Get-SftConfig {
    $config = Get-Content -LiteralPath (Join-Path $script:SftProject 'startup.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.runtimeDirectory -notmatch '^runtime(?:[-_][A-Za-z0-9_-]+)?$') {
        throw 'runtimeDirectory 只允许 runtime 或 runtime-名称 / runtime_名称；不会使用原 server-node/data。'
    }
    $runtime = Resolve-SftDirectory $config.runtimeDirectory
    $listener = $null
    if (![Net.IPAddress]::TryParse([string]$config.listenHost, [ref]$listener)) { throw 'listenHost 必须是 IP 地址。' }
    if ($config.allowLan -isnot [bool]) { throw 'allowLan 必须是 true 或 false。' }
    if (![Net.IPAddress]::IsLoopback($listener) -and !$config.allowLan) { throw '局域网监听需在 startup.json 中显式设置 allowLan: true。' }
    $clientHost = [string]$config.clientHost
    if ($clientHost -in @('0.0.0.0', '::') -or [Uri]::CheckHostName($clientHost) -eq [UriHostNameType]::Unknown) {
        throw 'clientHost 必须是客户端实际连接的 IP 或域名，不能是通配监听地址。'
    }
    if ($config.port -isnot [ValueType] -or $config.port -ne [Math]::Truncate($config.port) -or $config.port -lt 1 -or $config.port -gt 65535) {
        throw 'port 必须为 1 到 65535 的整数。'
    }
    return [pscustomobject]@{
        Project = $script:SftProject; Runtime = $runtime
        NodeDirectory = Resolve-SftDirectory $config.nodeDirectory
        Data = Join-Path $runtime 'data'; Certs = Join-Path $runtime 'certs'
        Authority = Join-Path $runtime 'offline-ca'; ClientState = Join-Path $runtime 'client'
        PublicCa = Join-Path $runtime 'certs/public/dev-ca.crt'
        Publish = Join-Path $script:SftProject 'publish/client'
        ListenHost = [string]$config.listenHost; ClientHost = $clientHost
        Port = [int]$config.port; AllowLan = $config.allowLan
    }
}

function Set-SftEnvironment($Config) {
    $env:SFT_DATA_DIR = $Config.Data
    $env:SFT_CERT_DIR = $Config.Certs
    $env:SFT_LISTEN_HOST = $Config.ListenHost
    $env:SFT_CONNECT_HOST = $Config.ClientHost
    $env:SFT_SERVER_NAME = $Config.ClientHost
    $env:SFT_PORT = [string]$Config.Port
    $env:SFT_ALLOW_LAN = if ($Config.AllowLan) { '1' } else { '0' }
    $env:SFT_CLIENT_STATE_DIR = $Config.ClientState
    # These entries are for a fresh local demo owned by the current administrator, not a deployed service.
    foreach ($name in @('SFT_ACL_MODE', 'SFT_STORAGE_SID', 'SFT_DEPLOY_ADMIN_SID', 'SFT_RUNTIME_AUDIT', 'SFT_ACCEPTANCE_IO_TRACE', 'DOTNET_STARTUP_HOOKS', 'NODE_OPTIONS')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
}

function Get-SftNode($Config) {
    $node = Join-Path $Config.NodeDirectory 'node.exe'
    if (!(Test-Path -LiteralPath $node -PathType Leaf)) {
        throw ('缺少便携 Node 22.23.5。请安装 Python 3.11+，在项目根执行：python tools/prepare-node.py --directory tools/runtime；或放入完整的 node-v22.23.5-win-x64 目录。')
    }
    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ne '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a') {
        throw 'node.exe 与已验证版本的 SHA-256 不符，请重新使用 tools/prepare-node.py 准备运行时。'
    }
    $version = & $node --version
    if ($LASTEXITCODE -ne 0 -or $version -ne 'v22.23.5') { throw '需要 Windows x64 Node 22.23.5。' }
    $env:Path = $Config.NodeDirectory + ';' + $env:Path
    return $node
}

function Assert-SftServerDependencies($Config, [string]$Node) {
    Push-Location (Join-Path $Config.Project 'server-node')
    try {
        & $Node --no-warnings -e "require('express'); require('ws'); require('node:sqlite');"
        if ($LASTEXITCODE -ne 0) { throw '服务器依赖缺失。请执行首次配置，或使用 tools/launch.ps1 -Action Cli npm-ci 还原 package-lock.json。' }
    } finally { Pop-Location }
}

function Assert-SftDesktopRuntime {
    if (!(Get-Command dotnet.exe -ErrorAction SilentlyContinue)) { throw '缺少 .NET。运行客户端需要 x64 .NET Desktop Runtime 10；从源码构建还需支持 net10.0-windows 的 SDK。' }
    $runtimes = & dotnet.exe --list-runtimes
    if ($LASTEXITCODE -ne 0 -or !($runtimes -match '^Microsoft.WindowsDesktop.App 10\.')) {
        throw '缺少 x64 .NET Desktop Runtime 10（Microsoft.WindowsDesktop.App 10.x），仅安装 ASP.NET 或其他主版本不能运行此客户端。'
    }
}

function Assert-SftClientFiles($Config) {
    foreach ($name in @('SecureFileTransfer.Client.exe','SecureFileTransfer.Client.dll','SecureFileTransfer.Client.deps.json','SecureFileTransfer.Client.runtimeconfig.json','SecureFileTransfer.Protocol.dll')) {
        if (!(Test-Path -LiteralPath (Join-Path $Config.Publish $name) -PathType Leaf)) {
            throw '客户端发布文件不完整。请按 README 重新发布整个 publish/client 目录，不能只复制 EXE。'
        }
    }
}

function Invoke-SftCli($Config, [string]$Node, [string[]]$Arguments) {
    & $Node (Join-Path $Config.Project 'tools/run-node.mjs') @Arguments
    if ($LASTEXITCODE -ne 0) { throw "现有 CLI 执行失败（退出码 $LASTEXITCODE），请查看上方提示。" }
}

function Assert-SftInitialized($Config) {
    if (!(Test-Path -LiteralPath (Join-Path $Config.Runtime '.sft-initialized.json') -PathType Leaf)) {
        throw '当前运行目录尚未完成配置，请先双击“首次配置.cmd”。已有目录不会被覆盖；失败目录请保留检查，并在 startup.json 选择新的 runtime-名称。'
    }
}

function Show-SftEndpoint($Config) {
    Write-Host "`n数据目录（服务器与账户管理共用）：$($Config.Data)"
    Write-Host "客户端地址：$($Config.ClientHost)"
    Write-Host "客户端端口：$($Config.Port)"
    Write-Host "公共 CA 路径：$($Config.PublicCa)"
    Write-Host '客户端只分发公共 CA；不分发服务器或 CA 私钥。'
}
