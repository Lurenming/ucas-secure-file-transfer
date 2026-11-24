param(
    [Parameter(Mandatory=$true)][string]$DeploymentRoot,
    [Parameter(Mandatory=$true)][string]$RuntimeAccount,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($DeploymentRoot).TrimEnd('\')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\') -or $root -eq $workspace -or $root -match '(?i)\\(windows|program files|\.git)(\\|$)') { throw 'Use a dedicated isolated deployment directory, never the workspace/system root.' }
if (!(Test-Path -LiteralPath (Join-Path $root '.sft-deployment'))) { throw 'Missing .sft-deployment marker; create this marker only in an explicitly prepared deployment directory.' }
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Deployment root cannot be a link' }
$runtimeSid = ([Security.Principal.NTAccount]$RuntimeAccount).Translate([Security.Principal.SecurityIdentifier])
$operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($Apply -and $operatorSid -eq $runtimeSid) { throw 'Provision ACLs from an identity distinct from the runtime account.' }
$adminSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-544'
$systemSid = [Security.Principal.SecurityIdentifier]'S-1-5-18'
$spec = [ordered]@{ 'app'='ReadAndExecute'; 'config'='ReadAndExecute'; 'certs'='ReadAndExecute'; 'data'='Modify'; 'logs'='Modify'; 'temp'='Modify' }
foreach ($entry in $spec.GetEnumerator()) {
    $path = [IO.Path]::GetFullPath((Join-Path $root $entry.Key))
    if (!$path.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Scope escaped deployment root' }
    if (!(Test-Path -LiteralPath $path)) { if ($Apply) { New-Item -ItemType Directory -Path $path | Out-Null } else { throw "Missing directory $path" } }
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked deployment directory' }
    # Inventory before changing inheritance so forbidden metadata never receives a changed ACL.
    # If the provisioning identity cannot read the prepared tree, stop without widening access.
    $all = @((Get-Item -LiteralPath $path)) + @(Get-ChildItem -LiteralPath $path -Force -Recurse)
    if (@($all | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Reparse points are forbidden in deployment ACL scope' }
    if (@($all | Where-Object { $_.Name -eq '.git' -or $_.Name -eq 'ca.key' }).Count) { throw 'Repository metadata and CA private keys must stay outside deployment' }
    foreach ($item in $all) {
        if ($Apply) {
            if ($item.PSIsContainer) { $aclItem=New-Object IO.DirectoryInfo($item.FullName); $inherit='ContainerInherit,ObjectInherit' }
            else { $aclItem=New-Object IO.FileInfo($item.FullName); $inherit='None' }
            $acl=$aclItem.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
            $acl.SetAccessRuleProtection($true,$false)
            foreach ($old in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($old) }
            foreach ($sid in @($adminSid,$systemSid,$operatorSid)) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,'None','Allow'))) }
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($runtimeSid,$entry.Value,$inherit,'None','Allow')))
            $aclItem.SetAccessControl($acl)
        }
        $got=Get-Acl -LiteralPath $item.FullName
        $rules=@($got.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
        $allowed=@($runtimeSid.Value,$adminSid.Value,$systemSid.Value,$operatorSid.Value)
        if (@($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed }).Count) { throw "Unexpected access rule: $($item.FullName)" }
        $expected=[Security.AccessControl.FileSystemRights]$entry.Value
        if (!@($rules | Where-Object { $_.IdentityReference -eq $runtimeSid -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $expected) -eq $expected }).Count) { throw 'Expected runtime permission missing' }
    }
    [pscustomobject]@{Path=$path; RuntimeSid=$runtimeSid.Value; Rights=$entry.Value; Applied=[bool]$Apply; Checked=$all.Count}
}
Write-Output ('Set SFT_ACL_MODE=verify, SFT_STORAGE_SID=' + $runtimeSid.Value + ', SFT_DEPLOY_ADMIN_SID=' + $operatorSid.Value + ' for the deployed server and administrator CLI.')
