import { chmodSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Only call for the application's dedicated storage directory or its known database files.
export function restrictPrivatePath(path, directory = true) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe private storage path');
  if (process.platform !== 'win32') { chmodSync(path, directory ? 0o700 : 0o600); return; }
  if (process.env.SFT_ACL_MODE === 'verify') {
    const sid = process.env.SFT_STORAGE_SID;
    if (!/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(sid ?? '')) throw new Error('SFT_STORAGE_SID required in deployed ACL verify mode');
    const verify = `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:SFT_PRIVATE_PATH;
      $rules=$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);
      $allowed=@($env:SFT_STORAGE_SID,$env:SFT_DEPLOY_ADMIN_SID,'S-1-5-18','S-1-5-32-544');
      if (@($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed }).Count) { throw 'Unexpected principal on private storage' };
      if (!@($rules | Where-Object { $_.IdentityReference.Value -eq $env:SFT_STORAGE_SID -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Modify) -eq [Security.AccessControl.FileSystemRights]::Modify }).Count) { throw 'Runtime Modify permission missing' };`;
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(verify, 'utf16le').toString('base64')], { env: { ...process.env, SFT_PRIVATE_PATH: path }, windowsHide: true, stdio: 'pipe' }); }
    catch { throw new Error('Deployed storage ACL verification failed; runtime never rewrites deployment permissions.'); }
    return;
  }
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=$env:SFT_PRIVATE_PATH; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    if ($env:SFT_PRIVATE_KIND -eq 'directory') { $item=New-Object IO.DirectoryInfo($p); $inheritance='ContainerInherit,ObjectInherit' } else { $item=New-Object IO.FileInfo($p); $inheritance='None' };
    $expectedInheritance=[Security.AccessControl.InheritanceFlags]$inheritance;
    $acl=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access);
    $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);
    if ($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference -eq $sid -and $rules[0].AccessControlType -eq 'Allow' -and $rules[0].FileSystemRights -eq 'FullControl' -and $rules[0].InheritanceFlags -eq $expectedInheritance -and $rules[0].PropagationFlags -eq 'None') { exit 0 };
    $acl.SetAccessRuleProtection($true,$false);
    foreach ($old in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($old) };
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inheritance,'None','Allow');
    $acl.AddAccessRule($rule); $item.SetAccessControl($acl);
    $got=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access);
    $rules=$got.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);
    if (!$got.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl' -or $rules[0].InheritanceFlags -ne $expectedInheritance -or $rules[0].PropagationFlags -ne 'None') { throw 'Unexpected private storage ACL' };`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, SFT_PRIVATE_PATH: path, SFT_PRIVATE_KIND: directory ? 'directory' : 'file' }, windowsHide: true, stdio: 'pipe' });
  } catch { throw new Error('Cannot secure application private storage ACL; run as its owner and inspect permissions.'); }
}
