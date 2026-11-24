param([Parameter(Mandatory=$true)][string]$DeploymentRoot,[Parameter(Mandatory=$true)][string]$ForbiddenDirectory,[Parameter(Mandatory=$true)][string]$CaPrivateKey)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($DeploymentRoot)
if (!(Test-Path -LiteralPath (Join-Path $root '.sft-deployment'))) { throw 'Unmarked deployment directory' }
function DeniedRead([string]$path) {
    try { $stream=[IO.File]::Open($path,'Open','Read','ReadWrite'); $stream.Dispose(); return $false }
    catch [UnauthorizedAccessException] { return $true }
}
function DeniedWrite([string]$directory) {
    $probe=Join-Path $directory ('sft-boundary-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try { $stream=[IO.File]::Open($probe,'CreateNew','Write','None'); $stream.Dispose(); Remove-Item -LiteralPath $probe; return $false }
    catch [UnauthorizedAccessException] { return $true }
}
$result=[ordered]@{Identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name; Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; IsAdministrator=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}
foreach ($name in @('data','logs','temp')) {
    $path=Join-Path (Join-Path $root $name) ('probe-' + [guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($path,'isolated boundary probe'); $result[$name+'Writable']=[IO.File]::ReadAllText($path) -eq 'isolated boundary probe'; Remove-Item -LiteralPath $path
}
$result['AppWriteDenied']=DeniedWrite (Join-Path $root 'app')
$result['ConfigWriteDenied']=DeniedWrite (Join-Path $root 'config')
$result['ServerKeyReadable']=!(DeniedRead (Join-Path $root 'certs/private/server.key'))
$result['CaKeyReadDenied']=DeniedRead $CaPrivateKey
$result['UnrelatedPrivateReadDenied']=DeniedRead (Join-Path $ForbiddenDirectory 'sentinel.txt')
$result['UnrelatedPrivateWriteDenied']=DeniedWrite $ForbiddenDirectory
$result | ConvertTo-Json
if ($result.IsAdministrator -or @($result.Keys | Where-Object { $_ -notin @('Identity','Sid','IsAdministrator') -and !$result[$_] }).Count) { exit 1 }
