param([Parameter(Mandatory=$true)][string]$RuntimeAccount)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path $workspace 'artifacts/acl-deployment'
if (Test-Path -LiteralPath $root) { throw 'Fixture exists; never overwrite an existing deployment' }
New-Item -ItemType Directory -Path $root | Out-Null
[IO.File]::WriteAllText((Join-Path $root '.sft-deployment'),'isolated ACL test fixture v1')
foreach ($name in @('app','config','certs','data','logs','temp')) { New-Item -ItemType Directory -Path (Join-Path $root $name) | Out-Null }
$server=Join-Path $root 'app/server-node'
New-Item -ItemType Directory -Path $server | Out-Null
foreach ($name in @('src','scripts','node_modules','package.json','package-lock.json')) { Copy-Item -LiteralPath (Join-Path $workspace ('server-node/'+$name)) -Destination $server -Recurse }
Copy-Item -LiteralPath (Join-Path $workspace 'artifacts/enhanced-csharp-certs/public') -Destination (Join-Path $root 'certs') -Recurse
New-Item -ItemType Directory -Path (Join-Path $root 'certs/private') | Out-Null
Copy-Item -LiteralPath (Join-Path $workspace 'artifacts/enhanced-csharp-certs/private/server.key') -Destination (Join-Path $root 'certs/private/server.key')
foreach ($name in @('acl-offline-ca','acl-unrelated-private')) {
    $path=Join-Path $workspace ('artifacts/'+$name)
    if (Test-Path -LiteralPath $path) { throw 'Private sentinel directory already exists' }
    New-Item -ItemType Directory -Path $path | Out-Null
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    Set-Acl -LiteralPath $path -AclObject $acl
}
Copy-Item -LiteralPath (Join-Path $workspace 'artifacts/enhanced-csharp-certs/private/ca.key') -Destination (Join-Path $workspace 'artifacts/acl-offline-ca/ca.key')
[IO.File]::WriteAllText((Join-Path $workspace 'artifacts/acl-unrelated-private/sentinel.txt'),'Test sentinel, not user data')
& (Join-Path $PSScriptRoot 'deploy-acl.ps1') -DeploymentRoot $root -RuntimeAccount $RuntimeAccount -Apply | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $workspace 'artifacts/baseline/acl-deployment-applied.json')
Write-Output 'Isolated ACL fixture prepared; no existing application data or repository ACL changed.'
