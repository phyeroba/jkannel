<#
.SYNOPSIS
  Ships per-deployment configuration from deploy/<host>/ to that host.

.DESCRIPTION
  Deployment configuration is deliberately NOT in git — see the block at the
  bottom of .gitignore. Ports, bind addresses and test fixtures belong to a
  machine, not to the product, and `docker-compose.override.yml` is auto-loaded
  by Compose, so committing one host's copy silently imposes it on every
  developer who pulls.

  This is the bridge: it copies deploy/<host>/ onto that host and nowhere else.

  It is deliberately DUMB about what it copies — every file in the directory
  goes, nothing is generated or templated. The file on your disk is byte-for-byte
  the file on the server, which is what makes "what is actually deployed?"
  answerable by checksum rather than by inference.

.PARAMETER TargetHost
  SSH host alias from ~/.ssh/config (e.g. cpaas-gcp).

.PARAMETER Name
  Directory under deploy/ holding that host's files. Defaults to TargetHost.

.PARAMETER RemotePath
  Project root on the server.

.PARAMETER WhatIf
  Show what would be copied, and diff it against the server, without writing.

.EXAMPLE
  ./scripts/deploy-config.ps1 -TargetHost cpaas-gcp -Name caps -WhatIf
  ./scripts/deploy-config.ps1 -TargetHost cpaas-gcp -Name caps
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$TargetHost,
  [string]$Name,
  [string]$RemotePath = '/home/hyeroba/jkannel',
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
if (-not $Name) { $Name = $TargetHost }

$root  = Split-Path $PSScriptRoot -Parent
$local = Join-Path $root "deploy\$Name"

if (-not (Test-Path $local)) {
  throw "No configuration for '$Name'. Expected $local. Start from docker-compose.override.example.yml."
}

$files = Get-ChildItem $local -File -Recurse
if (-not $files) { throw "$local is empty — nothing to ship." }

Write-Host "host   : $TargetHost"
Write-Host "source : $local"
Write-Host "target : $RemotePath"
Write-Host ""

# --- Refuse to ship anything that looks like a secret ------------------------
# Deployment config is not a secrets store. Secrets belong in the server's own
# 0600 .env, which this script must never touch — shipping one would put it in
# this machine's shell history and in any terminal capture of the run.
$suspect = $files | Where-Object {
  $_.Name -match '(^\.env$|\.env\.|\.pem$|\.key$|_rsa$|id_ed25519$|credentials)' -or
  (Select-String -Path $_.FullName -Pattern '(?i)(password|secret|api[_-]?key|token)\s*[:=]\s*\S' -Quiet)
}
if ($suspect) {
  Write-Host "REFUSING TO SHIP — these look like they carry secrets:" -ForegroundColor Red
  $suspect | ForEach-Object { Write-Host "  $($_.FullName.Substring($local.Length + 1))" }
  throw 'Move secrets into the server-side .env (0600) instead.'
}

# --- Compare against what is already there -----------------------------------
foreach ($f in $files) {
  $rel    = $f.FullName.Substring($local.Length + 1).Replace('\', '/')
  $remote = "$RemotePath/$rel"
  $localSum = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()

  $remoteSum = (ssh -o BatchMode=yes $TargetHost "sudo sha256sum '$remote' 2>/dev/null | cut -d' ' -f1" 2>$null | Out-String).Trim()

  if ($remoteSum -eq $localSum)      { Write-Host "  = $rel (identical, skipping)"; continue }
  elseif (-not $remoteSum)           { Write-Host "  + $rel (new on server)" -ForegroundColor Green }
  else                               { Write-Host "  ~ $rel (differs — server copy will be BACKED UP)" -ForegroundColor Yellow }

  if ($WhatIf) { continue }

  # Stage through /tmp: /home/hyeroba is not traversable by the login account,
  # so scp straight to the target path fails with Permission denied.
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stage = "/tmp/deploy-$([guid]::NewGuid().ToString('N').Substring(0,8))"
  scp -o BatchMode=yes -q $f.FullName "${TargetHost}:$stage"
  if ($LASTEXITCODE -ne 0) { throw "scp failed for $rel" }

  # Back up before overwriting, always. Timestamped, in place, matching the
  # convention the 15 Aug handover already established on this host.
  $cmd = @"
set -e
sudo mkdir -p "`$(dirname '$remote')"
if [ -f '$remote' ]; then sudo cp -p '$remote' '$remote.bak-$stamp'; fi
sudo mv '$stage' '$remote'
sudo chmod 644 '$remote'
sudo sha256sum '$remote' | cut -d' ' -f1
"@
  $applied = (ssh -o BatchMode=yes $TargetHost $cmd 2>&1 | Out-String).Trim() -split "`n" | Select-Object -Last 1

  if ($applied.Trim() -ne $localSum) { throw "Checksum mismatch after copying $rel (got $applied, expected $localSum)" }
  Write-Host "    shipped, verified $($localSum.Substring(0,12))…"
}

Write-Host ""
if ($WhatIf) { Write-Host 'WhatIf: nothing was written.' }
else { Write-Host 'Done. Every file verified by checksum on the server.' -ForegroundColor Green }
