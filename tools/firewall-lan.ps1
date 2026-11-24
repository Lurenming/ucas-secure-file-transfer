param([ValidateRange(1024,65535)][int]$Port=8443,[Parameter(Mandatory=$true)][string]$LocalAddress,[Parameter(Mandatory=$true)][string]$RemoteSubnet,[switch]$Apply)
$ErrorActionPreference='Stop'
if ($LocalAddress -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or $RemoteSubnet -notmatch '^\d{1,3}(\.\d{1,3}){3}/(1[6-9]|2\d|3[0-2])$') { throw 'Specify a private IPv4 server address and a narrow LAN CIDR (/16 through /32).' }
$parameters=@{DisplayName="SFT LAN TCP $Port";Direction='Inbound';Action='Allow';Protocol='TCP';LocalPort=$Port;LocalAddress=$LocalAddress;RemoteAddress=$RemoteSubnet;Profile='Private';EdgeTraversalPolicy='Block'}
if ($Apply) { New-NetFirewallRule @parameters } else { $parameters | ConvertTo-Json; Write-Output 'Preview only; firewall unchanged. An administrator can rerun with -Apply after verifying addresses.' }
