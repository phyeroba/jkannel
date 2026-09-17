<#
.SYNOPSIS
  The only sanctioned way to reach JKANNEL production over SSH.

.DESCRIPTION
  ROUTE
  ---------------------------------------------------------------------------
  Production is GCP instance `caps` (project speeda360, zone us-central1-b).
  Public port 22 is closed. The route in is an IAP TCP tunnel: gcloud opens a
  WebSocket to Google, Google connects to the VM's port 22 from its own range
  35.235.240.0/20, and ssh talks to a local port. Access is granted on the
  INSTANCE only, so project-wide gcloud calls are denied by design - always name
  the instance, project and zone.

  WHY EVERY CHECK IS LOCAL, AND WHY THERE IS NO RETRY
  ---------------------------------------------------------------------------
  On 2026-09-03 the office lost SSH for two weeks. Part of that was client-side
  faults that each produced failed logins: Git Bash's ssh cannot reach the
  Windows agent and fell back to password auth, and a name with no Host block
  sent the local Windows account "Peter Hyeroba" as the username. fail2ban
  counts failures inside `findtime` and a successful login does not reset it.

  Through IAP the stakes are higher, not lower: every login arrives from
  Google's SHARED range. If fail2ban banned one of those addresses, the tunnel
  itself would stop working. So a misconfiguration must be caught on this
  machine, before an authentication is ever attempted, and a failed login must
  never be retried automatically.

  The gates, in order: Windows OpenSSH client; gcloud present; the key file
  exists and matches the pinned fingerprint; the pinned host key is already in
  known_hosts (so the host check cannot fail mid-handshake); the local port is
  free. Only then does the tunnel open, and only once it is LISTENING does ssh
  run - once.

  THE HOST KEY IS PINNED
  ---------------------------------------------------------------------------
  ssh connects to localhost, so it would normally look up a host key for
  "[localhost]:2222". HostKeyAlias makes it check the key recorded for the real
  production address instead, with StrictHostKeyChecking=yes. On 2026-09-17 that
  key matched the one recorded before the crypto-miner compromise. If it ever
  stops matching, ssh aborts before authenticating - treat that as a security
  event, not an annoyance.

  ONE LOGIN PER TASK
  ---------------------------------------------------------------------------
  Connection multiplexing does not work on OpenSSH_for_Windows 9.5p1
  ("getsockname failed: Not a socket"). So -Script does not scp and then ssh;
  it sends the script on the login's stdin, where the remote side `cat`s it to
  a temp file BEFORE running it. Running `bash -s` directly would let any
  command inside the script that reads stdin swallow the rest of the script.
  Start-Process -RedirectStandardInput passes the bytes untouched; a PowerShell
  pipe would prepend a BOM and bash would fail on line 1.

  NOTE ON GCLOUD OUTPUT
  ---------------------------------------------------------------------------
  gcloud writes "Listening on port [N]" to its LOG FILE only, never to a
  redirected stderr. Readiness is therefore taken from the OS listening-socket
  table, which is local and sends nothing to the server.

.EXAMPLE
  powershell -NoProfile -File scripts\prod-ssh.ps1 -Check
  powershell -NoProfile -File scripts\prod-ssh.ps1 -Command "docker ps --format '{{.Names}}'"
  powershell -NoProfile -File scripts\prod-ssh.ps1 -Script scripts\deploy.sh
#>
[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
  [Parameter(ParameterSetName = 'Check')] [switch] $Check,
  [Parameter(ParameterSetName = 'Cmd', Mandatory = $true)] [string] $Command,
  [Parameter(ParameterSetName = 'Script', Mandatory = $true)] [string] $Script,
  [Parameter(ParameterSetName = 'Script')] [string] $ScriptArgs = '',

  [string] $Instance = 'caps',
  [string] $Project = 'speeda360',
  [string] $Zone = 'us-central1-b',
  [string] $User = 'hyeroba',
  [string] $KeyFile = "$HOME\.ssh\caps_hyeroba",
  # Public fingerprints, not secrets. Pinning the key means a different key in
  # the agent can never be offered by accident; pinning the host alias means the
  # host check is against the real production key.
  [string] $Fingerprint = 'SHA256:V4SoRbIVaHm12V+9L2QDouLCJ0kwezvgHpMAm0yS34Y',
  [string] $HostKeyAlias = '34.134.248.1',
  [int] $LocalPort = 2222,
  [int] $TunnelWaitSeconds = 45,
  [int] $ConnectTimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
$failures = New-Object Collections.Generic.List[string]
function Pass([string] $m) { Write-Host ("  [ok]   " + $m) }
function Fail([string] $m, [string] $fix) {
  Write-Host ("  [FAIL] " + $m) -ForegroundColor Red
  $failures.Add($m + "`n         fix: " + $fix)
}

Write-Host ""
Write-Host "PRODUCTION SSH PREFLIGHT  ->  $User@$Instance ($Project / $Zone) via IAP"
Write-Host ("-" * 72)

# --- 1. the right client -------------------------------------------------------
$sshCmd = Get-Command ssh -ErrorAction SilentlyContinue
$sshPath = if ($sshCmd) { $sshCmd.Source } else { '' }
if ($sshPath -like '*System32\OpenSSH*') { Pass "client is Windows OpenSSH" }
else {
  Fail "ssh resolves to '$sshPath', not Windows OpenSSH" `
       "run from PowerShell, not Git Bash - Git Bash's ssh cannot reach the Windows agent"
}

# --- 2. gcloud -----------------------------------------------------------------
# It is often installed AFTER a shell started, so PATH alone is not trusted.
$gcloud = (Get-Command gcloud.cmd -ErrorAction SilentlyContinue).Source
if (-not $gcloud) {
  $gcloud = @(
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ($gcloud) { Pass "gcloud found" } else { Fail "gcloud not found" "install the Google Cloud SDK" }

# --- 3. the key ----------------------------------------------------------------
if (Test-Path $KeyFile) {
  $actual = ((& ssh-keygen -lf $KeyFile 2>&1) -join ' ')
  if ($actual -match [regex]::Escape($Fingerprint)) { Pass "key matches the pinned fingerprint" }
  else {
    Fail "key file fingerprint is not the pinned one ($actual)" `
         "the key was replaced - update -Fingerprint only if that was intended"
  }
} else {
  Fail "key file $KeyFile is missing" "restore it; the private key exists only on this workstation"
}

# --- 4. the host key is already known ------------------------------------------
# Without this, StrictHostKeyChecking=yes fails DURING the handshake - which the
# server still logs as a dropped connection.
$known = & ssh-keygen -F $HostKeyAlias 2>$null
if ($known) { Pass "production host key is pinned in known_hosts ($HostKeyAlias)" }
else { Fail "no known_hosts entry for $HostKeyAlias" "verify the host key out of band before adding it" }

# --- 5. the local port ---------------------------------------------------------
if (Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue) {
  Fail "local port $LocalPort is already in use" "a stale tunnel is probably still running - stop it first"
} else { Pass "local port $LocalPort is free" }

Write-Host ("-" * 72)
if ($failures.Count -gt 0) {
  Write-Host ""
  Write-Host "REFUSING TO CONNECT. $($failures.Count) precondition(s) failed; nothing was sent:" -ForegroundColor Red
  foreach ($f in $failures) { Write-Host ("  - " + $f) }
  exit 1
}

# --- the tunnel ----------------------------------------------------------------
# No `exit` or `return` inside the try: both can skip or outrun `finally`, which
# is what closes the tunnel, and `return` loses the exit code.
$tunnelErr = Join-Path $env:TEMP "prod-ssh-tunnel.err"
$tunnelOut = Join-Path $env:TEMP "prod-ssh-tunnel.out"
$tunnel = $null
$exitCode = 1
try {
  $tunnel = Start-Process -FilePath $gcloud -NoNewWindow -PassThru `
    -RedirectStandardError $tunnelErr -RedirectStandardOutput $tunnelOut `
    -ArgumentList @('compute', 'start-iap-tunnel', $Instance, '22',
                    "--local-host-port=localhost:$LocalPort",
                    '--project', $Project, '--zone', $Zone)

  $up = $false
  for ($i = 0; $i -lt $TunnelWaitSeconds; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue) { $up = $true; break }
    if ($tunnel.HasExited) { break }
  }

  if (-not $up) {
    Write-Host "  [FAIL] IAP tunnel did not come up within ${TunnelWaitSeconds}s - no login attempted" -ForegroundColor Red
    Get-Content $tunnelErr -ErrorAction SilentlyContinue | Where-Object { $_ -match 'ERROR|4003|4033|denied' } |
      ForEach-Object { Write-Host "         $_" }
    Write-Host "         gcloud's full log: $env:APPDATA\gcloud\logs (4033 = IAM, 4003 = firewall/backend)"
    $exitCode = 1
  }
  elseif ($PSCmdlet.ParameterSetName -eq 'Check') {
    Pass "IAP tunnel listening on localhost:$LocalPort"
    Write-Host "All preconditions met; tunnel verified. No login was attempted." -ForegroundColor Green
    $exitCode = 0
  }
  else {
    Pass "IAP tunnel listening on localhost:$LocalPort"
    # BatchMode and publickey-only: a login can never sit on a prompt or fall
    # back to a password. IdentitiesOnly plus -i: exactly ONE key is offered, so
    # a failure costs one strike, not one per key in the agent.
    $sshArgs = @(
      '-p', "$LocalPort",
      '-o', "HostKeyAlias=$HostKeyAlias",
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'BatchMode=yes',
      '-o', "ConnectTimeout=$ConnectTimeoutSeconds",
      '-o', 'IdentitiesOnly=yes',
      '-o', 'PreferredAuthentications=publickey',
      '-o', 'NumberOfPasswordPrompts=0',
      '-o', 'ServerAliveInterval=30',
      '-i', $KeyFile,
      "$User@localhost"
    )

    if ($PSCmdlet.ParameterSetName -eq 'Cmd') {
      Write-Host "`n> $Command`n"
      & ssh @sshArgs $Command
      $exitCode = $LASTEXITCODE
    }
    elseif (-not (Test-Path $Script)) {
      Write-Host "no such script: $Script" -ForegroundColor Red
      $exitCode = 1
    }
    else {
      $body = [IO.File]::ReadAllText((Resolve-Path $Script)) -replace "`r`n", "`n"
      $staged = Join-Path $env:TEMP ("prod-ssh-" + [IO.Path]::GetFileName($Script))
      [IO.File]::WriteAllText($staged, $body, (New-Object Text.UTF8Encoding $false))

      # cat drains stdin to a file first, so nothing the script runs can eat the
      # rest of the script. The temp file is removed whatever the exit status.
      $remote = 'f=$(mktemp /tmp/prod-ssh.XXXXXX) && cat > "$f" && bash "$f" ' + $ScriptArgs + '; rc=$?; rm -f "$f"; exit $rc'
      Write-Host "`n> $([IO.Path]::GetFileName($Script)) $ScriptArgs  (sent on stdin, one login)`n"
      $quoted = ($sshArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
      $proc = Start-Process -FilePath $sshPath -NoNewWindow -Wait -PassThru `
        -RedirectStandardInput $staged `
        -ArgumentList ($quoted + ' "' + $remote.Replace('"', '\"') + '"')
      $exitCode = $proc.ExitCode
      Remove-Item $staged -ErrorAction SilentlyContinue
    }
  }
}
finally {
  if ($tunnel -and -not $tunnel.HasExited) { & taskkill /PID $tunnel.Id /T /F 2>&1 | Out-Null }
}
exit $exitCode
