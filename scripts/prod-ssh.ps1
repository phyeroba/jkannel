<#
.SYNOPSIS
  The only sanctioned way to reach JKANNEL production over SSH.

.DESCRIPTION
  WHY THIS EXISTS
  ---------------------------------------------------------------------------
  On 2026-09-03 the egress IP 41.220.210.18 was banned from port 22. The key
  had not been revoked and the server had not changed. Everything that failed,
  failed on this machine, in two ways that both LOOK like the server rejecting
  us:

   1. THE BASH CLIENT HAS NO KEY AT ALL. Git Bash ships its own OpenSSH, which
      cannot open a Windows named pipe, so it cannot reach the agent holding
      the key. There is no fallback either: every default identity path
      (~/.ssh/id_rsa, id_ecdsa, id_ed25519 ...) is ABSENT on this machine,
      because the real keys have custom names. So the client offers zero public
      keys and then degrades to password authentication against a key-only
      server. Every one of those is a fail2ban strike.

   2. OMITTING THE USERNAME SENDS AN INVALID ACCOUNT. Before the fix, no Host
      block matched `gw1.speedamobile.com`, so `User` fell back to the local
      Windows account and ssh sent "Peter Hyeroba"  -  an invalid user, with a
      SPACE in it. fail2ban treats invalid-user lines as its strongest signal.

  And the reason a long run of successful logins did not protect us:
  A SUCCESSFUL LOGIN DOES NOT RESET fail2ban's COUNTER. It counts failures
  inside `findtime` regardless of what else succeeded, so thirty good sessions
  and five broken ones in the same window still trips the jail.

  THE DESIGN RULE
  ---------------------------------------------------------------------------
  EVERY CHECK BELOW IS LOCAL AND RUNS BEFORE A PACKET REACHES PORT 22. A
  misconfigured attempt costs the server nothing, because it never arrives. A
  wrapper that connected first and diagnosed afterwards would be the very thing
  that caused the ban.

  The last gate is reachability, and it is a gate rather than a warning for a
  specific reason: hammering a port while banned is what extends a ban.
  fail2ban's recidive jail and `bantime.increment` both escalate on repeat
  offences, so an agent that retries politely every few minutes can convert an
  hour's ban into a week's. When port 22 is dark this script REFUSES to run ssh
  at all and prints the runbook instead.

  Connection multiplexing would be the obvious way to collapse many commands
  into one authentication. It is not available: verified on
  OpenSSH_for_Windows_9.5p1, `ssh -O check` returns "getsockname failed: Not a
  socket". The options parse and do nothing. So the substitute is batching  - 
  -Script sends one file and runs it in one session, which is why it is the
  preferred mode.

.EXAMPLE
  pwsh scripts/prod-ssh.ps1 -Check
  pwsh scripts/prod-ssh.ps1 -Command "docker ps --format '{{.Names}}'"
  pwsh scripts/prod-ssh.ps1 -Script scripts/deploy.sh
#>
[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
  [Parameter(ParameterSetName = 'Check')]  [switch] $Check,
  [Parameter(ParameterSetName = 'Cmd', Mandatory = $true)] [string] $Command,
  [Parameter(ParameterSetName = 'Script', Mandatory = $true)] [string] $Script,
  # Arguments appended after the remote script path.
  [Parameter(ParameterSetName = 'Script')] [string] $ScriptArgs = '',
  [string] $Target = 'cpaas-gcp',
  # The key that is allowed to reach production, pinned by fingerprint. A
  # public fingerprint is not a secret; pinning it means a DIFFERENT key
  # silently loaded into the agent cannot be offered here by accident.
  [string] $Fingerprint = 'SHA256:oIlLzFy2ZL+WsQH5s/vsRAoQMidP0VnT0mMc31ep/rY',
  [int] $ConnectTimeoutSeconds = 8
)

$ErrorActionPreference = 'Stop'
$failures = New-Object Collections.Generic.List[string]
function Pass([string] $m) { Write-Host ("  [ok]   " + $m) }
function Fail([string] $m, [string] $fix) {
  Write-Host ("  [FAIL] " + $m) -ForegroundColor Red
  $failures.Add($m + "`n         fix: " + $fix)
}

Write-Host ""
Write-Host "PRODUCTION SSH PREFLIGHT  ->  $Target"
Write-Host ("-" * 72)

# --- 1. the right client ------------------------------------------------------
# Git Bash's ssh is the one that cannot see the agent. Catching it here is the
# difference between a clear local error and a password attempt on the server.
$sshCmd = Get-Command ssh -ErrorAction SilentlyContinue
$sshPath = if ($sshCmd) { $sshCmd.Source } else { '' }
if ($sshPath -and $sshPath -like '*System32\OpenSSH*') {
  Pass "client is Windows OpenSSH ($sshPath)"
} else {
  Fail "ssh resolves to '$sshPath', which is not Windows OpenSSH" `
       "run this from PowerShell, or call C:\Windows\System32\OpenSSH\ssh.exe explicitly"
}

# --- 2. the agent, and the right key in it ------------------------------------
if (-not $env:SSH_AUTH_SOCK) { $env:SSH_AUTH_SOCK = '\\.\pipe\openssh-ssh-agent' }
$agentSvc = Get-Service ssh-agent -ErrorAction SilentlyContinue
if ($agentSvc -and $agentSvc.Status -eq 'Running') { Pass "ssh-agent service is running" }
else { Fail "ssh-agent service is '$(if($agentSvc){$agentSvc.Status}else{'absent'})'" "Start-Service ssh-agent" }

if (Test-Path '\\.\pipe\openssh-ssh-agent') { Pass "agent pipe is present" }
else { Fail "agent pipe \\.\pipe\openssh-ssh-agent is absent" "Start-Service ssh-agent" }

$agentKeys = & ssh-add -l 2>&1 | Out-String
if ($agentKeys -match [regex]::Escape($Fingerprint)) {
  Pass "the production key is loaded ($Fingerprint)"
} else {
  Fail "the production key is NOT in the agent" `
       "ssh-add `$HOME\.ssh\cpaas_gcp   (it is passphrase-protected; agent contents do not survive a reboot)"
  Write-Host ("         agent holds: " + $agentKeys.Trim())
}

# --- 3. what ssh would actually SEND ------------------------------------------
# This is the gate that would have prevented the ban outright.
$resolved = & ssh -G $Target 2>&1
$user = (($resolved | Select-String '^user ').Line -replace '^user ', '').Trim()
$auths = (($resolved | Select-String '^preferredauthentications ').Line -replace '^preferredauthentications ', '').Trim()
$host22 = (($resolved | Select-String '^hostname ').Line -replace '^hostname ', '').Trim()
$port = (($resolved | Select-String '^port ').Line -replace '^port ', '').Trim()

if ($user -eq 'hyeroba') {
  Pass "resolved user is 'hyeroba'"
} else {
  Fail "resolved user is '$user'  -  an invalid account, which is fail2ban's strongest trigger" `
       "add this name to the 'Host cpaas-gcp ...' block in ~/.ssh/config"
}
if ($user -match '\s') { Fail "the resolved username contains whitespace" "as above  -  no Host block is matching" }

if ($auths -eq 'publickey') {
  Pass "publickey is the only authentication method offered"
} else {
  Fail "preferredauthentications is '$auths'  -  a keyless client could fall through to passwords" `
       "set 'PreferredAuthentications publickey' and 'NumberOfPasswordPrompts 0' on the Host block"
}

# --- 4. reachability, LAST, and a hard gate -----------------------------------
# Deliberately one attempt. Retrying a banned port is how an hour becomes a week.
$reachable = $false
$client = New-Object Net.Sockets.TcpClient
try {
  $reachable = $client.BeginConnect($host22, [int]$port, $null, $null).AsyncWaitHandle.WaitOne($ConnectTimeoutSeconds * 1000, $false) -and $client.Connected
} catch { $reachable = $false } finally { $client.Close() }

if ($reachable) {
  Pass "tcp $host22`:$port is open"
} else {
  Fail "tcp $host22`:$port did not answer within ${ConnectTimeoutSeconds}s (silently dropped, not refused)" `
       "the IP is banned or firewalled - see the runbook printed below"
}

Write-Host ("-" * 72)
if ($failures.Count -gt 0) {
  Write-Host ""
  Write-Host "REFUSING TO CONNECT. $($failures.Count) precondition(s) failed:" -ForegroundColor Red
  foreach ($f in $failures) { Write-Host ("  - " + $f) }
  if (-not $reachable) {
    $egress = try { (Invoke-RestMethod 'https://api.ipify.org?format=json' -TimeoutSec 8).ip } catch { '<unknown>' }
    Write-Host ""
    Write-Host "PORT 22 IS DARK. Nothing was sent. To clear it, from a path that is not port 22"
    Write-Host "(GCP console SSH-in-browser, or: gcloud compute ssh --tunnel-through-iap):"
    Write-Host ""
    Write-Host "    sudo fail2ban-client status                     # which jails exist"
    Write-Host "    sudo fail2ban-client status sshd"
    Write-Host "    sudo fail2ban-client status recidive            # the long bans live here"
    Write-Host "    sudo fail2ban-client unban $egress"
    Write-Host "    sudo iptables -S | grep $egress                 # confirm the rule is gone"
    Write-Host ""
    Write-Host "  If the address appears in no jail, it is not fail2ban - check the VPC:"
    Write-Host "    gcloud compute firewall-rules list --filter='allowed.ports=22'"
    Write-Host ""
    Write-Host "  Do not retry in a loop. bantime.increment and the recidive jail both"
    Write-Host "  escalate on repeat offences, so polling turns an hour into a week."
  }
  exit 1
}

Write-Host "All preconditions met." -ForegroundColor Green
if ($PSCmdlet.ParameterSetName -eq 'Check') { exit 0 }

# --- the connection itself ----------------------------------------------------
# BatchMode belongs here rather than in ssh_config: a human at a terminal should
# still be allowed to unlock the key, but an unattended run must never sit on a
# prompt, and must never turn into an authentication attempt it cannot complete.
$common = @('-o', 'BatchMode=yes', '-o', "ConnectTimeout=$ConnectTimeoutSeconds")

if ($PSCmdlet.ParameterSetName -eq 'Cmd') {
  Write-Host "`n> $Command`n"
  & ssh @common $Target $Command
  exit $LASTEXITCODE
}

# -Script: one upload, one execution, one cleanup - in two connections, because
# multiplexing is unavailable on this platform (see the header).
if (-not (Test-Path $Script)) { Write-Host "no such script: $Script" -ForegroundColor Red; exit 1 }
# CRLF and a BOM both break bash on line 1, and the failure reads as a bug in
# the script rather than as a transfer problem.
$body = [IO.File]::ReadAllText((Resolve-Path $Script)) -replace "`r`n", "`n"
$staged = Join-Path $env:TEMP ("prod-" + [IO.Path]::GetFileName($Script))
[IO.File]::WriteAllText($staged, $body, (New-Object Text.UTF8Encoding $false))

$remote = "/tmp/" + [IO.Path]::GetFileName($Script)
Write-Host "`n> scp $([IO.Path]::GetFileName($Script)) -> $Target`:$remote"
& scp @common $staged "$Target`:$remote"
if ($LASTEXITCODE -ne 0) { Write-Host "upload failed" -ForegroundColor Red; exit $LASTEXITCODE }

Write-Host "> bash $remote $ScriptArgs`n"
& ssh @common $Target "bash $remote $ScriptArgs; rc=`$?; rm -f $remote; exit `$rc"
exit $LASTEXITCODE
