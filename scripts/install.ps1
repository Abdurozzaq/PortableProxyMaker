<#
.SYNOPSIS
  Installer for Windows (Docker Desktop): installs Docker Desktop if missing, creates .env,
  opens Windows Firewall and starts PortableProxyMaker.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -PortMin 30000 -PortCount 100
#>
param(
  [int]$PanelPort = 8080,
  [int]$PortMin = 20000,
  # Docker Desktop publishes every port individually, so keep this range small.
  [int]$PortCount = 200,
  # Address put in the proxy URLs. Defaults to this PC's LAN IP.
  [string]$PublicHost = '',
  [switch]$SkipFirewall,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogFile = Join-Path $Root 'install.log'

# The elevated run happens in a separate window; its key messages also go to
# install.log so the original terminal can show them afterwards.
function Log($msg) { if ($Elevated) { Add-Content -Path $LogFile -Value $msg -Encoding UTF8 } }
function Info($msg) { Write-Host $msg; Log $msg }
function Say($msg) { Write-Host "`n==> $msg" -ForegroundColor Yellow; Log "==> $msg" }
function Pause-IfElevated { if ($Elevated) { Read-Host "`nPress Enter to close this window" | Out-Null } }
function Fail($msg) {
  Write-Host "`n[x] $msg" -ForegroundColor Red
  Log "[x] $msg"
  Pause-IfElevated
  exit 1
}

# Any unexpected error: show it instead of letting the window vanish.
trap { Fail ("Unexpected error: " + $_.Exception.Message + " (install.ps1 line " + $_.InvocationInfo.ScriptLineNumber + ")") }

# Native commands are run through cmd so their stderr never reaches PowerShell:
# Windows PowerShell 5.1 turns redirected stderr into terminating errors under 'Stop'.
function Test-Quiet([string]$cmdline) {
  & cmd /c "$cmdline >nul 2>&1"
  return ($LASTEXITCODE -eq 0)
}

# ---- elevate (needed for firewall rules) --------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $SkipFirewall) {
  Say 'Restarting as Administrator (needed to add firewall rules)'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) { if ($kv.Value) { $argList += "-$($kv.Key)" } }
    else { $argList += "-$($kv.Key)"; $argList += "`"$($kv.Value)`"" }
  }
  Remove-Item $LogFile -ErrorAction SilentlyContinue
  try {
    $proc = Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait -PassThru
  } catch {
    Fail 'Administrator permission was refused. Re-run with -SkipFirewall to install without firewall rules.'
  }
  Write-Host 'Administrator window finished. Summary:' -ForegroundColor Cyan
  if (Test-Path $LogFile) { Get-Content $LogFile | ForEach-Object { Write-Host "  $_" } }
  exit $proc.ExitCode
}

# ---- Docker Desktop -------------------------------------------------------------
function Test-DockerCli { [bool](Get-Command docker -ErrorAction SilentlyContinue) }
function Test-DockerDaemon {
  if (-not (Test-DockerCli)) { return $false }
  return (Test-Quiet 'docker info')
}

if (-not (Test-DockerCli)) {
  $dockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
  if (Test-Path $dockerExe) {
    $env:Path = "C:\Program Files\Docker\Docker\resources\bin;$env:Path"
  } else {
    Say 'Docker Desktop not found, installing with winget'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Fail 'winget is not available. Install Docker Desktop manually from https://www.docker.com/products/docker-desktop/ and run this script again.'
    }
    & winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop installation failed.' }
    Info ''
    Info 'Docker Desktop is installed. Usually Windows needs a restart (WSL2), then open'
    Info 'Docker Desktop once to finish its setup, and run this script again.'
    Pause-IfElevated
    exit 0
  }
}

if (-not (Test-DockerDaemon)) {
  $desktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  if (Test-Path $desktop) {
    Say 'Starting Docker Desktop (this can take a minute)'
    Start-Process $desktop
  }
  $deadline = (Get-Date).AddMinutes(3)
  while (-not (Test-DockerDaemon)) {
    if ((Get-Date) -gt $deadline) { Fail 'Docker engine did not start. Open Docker Desktop, wait until it says "Engine running", then run this script again.' }
    Start-Sleep -Seconds 3
    Write-Host '.' -NoNewline
  }
  Write-Host ''
}

if (-not (Test-Quiet 'docker compose version')) { Fail '"docker compose" is not available. Update Docker Desktop.' }

# ---- .env -----------------------------------------------------------------------
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$envPath = Join-Path $Root '.env'

function Set-EnvValue([string[]]$lines, [string]$key, [string]$value) {
  $found = $false
  $out = foreach ($l in $lines) {
    if ($l -match "^$key=") { $found = $true; "$key=$value" } else { $l }
  }
  if (-not $found) { $out = @($out) + "$key=$value" }
  return , @($out)
}

if (-not (Test-Path $envPath)) {
  Say 'Creating .env'
  if (-not $PublicHost) {
    $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    if ($cfg) { $PublicHost = @($cfg.IPv4Address)[0].IPAddress } else { $PublicHost = 'localhost' }
  }
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 16
  $rng.GetBytes($bytes)
  $adminPw = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })

  $lines = [IO.File]::ReadAllLines((Join-Path $Root '.env.example'))
  $lines = Set-EnvValue $lines 'PANEL_PORT' $PanelPort
  $lines = Set-EnvValue $lines 'PANEL_HOST' '0.0.0.0'
  $lines = Set-EnvValue $lines 'ADMIN_PASSWORD' $adminPw
  $lines = Set-EnvValue $lines 'PUBLIC_HOST' $PublicHost
  $lines = Set-EnvValue $lines 'PROXY_PORT_MIN' $PortMin
  $lines = Set-EnvValue $lines 'PROXY_PORT_MAX' ($PortMin + $PortCount - 1)
  $lines = @($lines) + @('', '# Windows: use the Docker Desktop override (published ports, named volume).',
    'COMPOSE_FILE=docker-compose.yml;docker-compose.windows.yml')
  # LF + no BOM so docker compose parses it cleanly.
  [IO.File]::WriteAllText($envPath, (($lines -join "`n") + "`n"), $utf8NoBom)
}

# Read back the effective settings.
$envMap = @{}
foreach ($l in [IO.File]::ReadAllLines($envPath)) {
  if ($l -match '^\s*([A-Z_]+)=(.*)$') { $envMap[$Matches[1]] = $Matches[2].Trim() }
}
if (-not $envMap['COMPOSE_FILE']) {
  Say 'Adding COMPOSE_FILE to existing .env (Windows override)'
  [IO.File]::AppendAllText($envPath, "`nCOMPOSE_FILE=docker-compose.yml;docker-compose.windows.yml`n", $utf8NoBom)
}
$panel = [int]$envMap['PANEL_PORT']
$pMin = [int]$envMap['PROXY_PORT_MIN']
$pMax = [int]$envMap['PROXY_PORT_MAX']
if (($pMax - $pMin) -gt 1000) {
  Write-Host "Warning: publishing $($pMax - $pMin + 1) ports on Docker Desktop is slow. Consider a smaller PROXY_PORT_MIN/MAX range in .env." -ForegroundColor DarkYellow
}

# ---- firewall -------------------------------------------------------------------
if (-not $SkipFirewall) {
  Say "Opening Windows Firewall: panel $panel + proxy range $pMin-$pMax"
  Get-NetFirewallRule -DisplayName 'PortableProxyMaker*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  $null = New-NetFirewallRule -DisplayName 'PortableProxyMaker Panel' -Direction Inbound -Protocol TCP -LocalPort $panel -Action Allow -Profile Any
  $null = New-NetFirewallRule -DisplayName 'PortableProxyMaker Proxies' -Direction Inbound -Protocol TCP -LocalPort "$pMin-$pMax" -Action Allow -Profile Any
}

# ---- HTTPS inspection CA --------------------------------------------------------
# Antivirus HTTPS scanning (Avast, Kaspersky, ...) or a corporate proxy re-signs TLS
# with its own root, which Windows trusts but the Linux container does not. Export the
# issuer that containers actually receive (the check runs inside the node image because
# that traffic is what gets intercepted), find that root on this PC and save it to
# certs/, so the build and the app trust it. Nothing is written if nothing intercepts.
function Find-RootByCN([string]$cn) {
  $files = @()
  if ($env:NODE_EXTRA_CA_CERTS) { $files += $env:NODE_EXTRA_CA_CERTS -split ';' }
  # Avast/AVG keep their root here instead of the Windows store.
  $files += 'C:\ProgramData\Avast Software\Avast\wscert.pem', 'C:\ProgramData\AVG\Antivirus\wscert.pem'
  foreach ($file in $files) {
    if (-not $file -or -not (Test-Path $file)) { continue }
    try {
      $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2($file)
      if ($c.Subject.Contains("CN=$cn")) { return $c }
    } catch { }
  }
  foreach ($store in 'Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root', 'Cert:\LocalMachine\CA', 'Cert:\CurrentUser\CA') {
    $c = Get-ChildItem $store -ErrorAction SilentlyContinue | Where-Object { $_.Subject.Contains("CN=$cn") } | Select-Object -First 1
    if ($c) { return $c }
  }
  return $null
}

$certDir = Join-Path $Root 'certs'
if (-not (Test-Path $certDir)) { New-Item -ItemType Directory $certDir | Out-Null }
$probeDir = Join-Path $env:TEMP 'ppm-tls-probe'
if (-not (Test-Path $probeDir)) { New-Item -ItemType Directory $probeDir | Out-Null }
$probe = @'
const tls = require('tls');
const fs = require('fs');
const host = 'registry.npmjs.org';
const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
  if (s.authorized) { console.log('OK'); return s.end(); }
  let c = s.getPeerCertificate(true);
  while (c.issuerCertificate && c.issuerCertificate.fingerprint256 !== c.fingerprint256) c = c.issuerCertificate;
  if (c.issuerCertificate) {
    // The interceptor sent its self-signed root along: save it directly.
    const pem = '-----BEGIN CERTIFICATE-----\n' + c.raw.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
    fs.writeFileSync('/certs/host-intercept-root.pem', pem);
    console.log('ROOT ' + (c.subject.CN || c.subject.O));
  } else {
    console.log('ISSUER ' + (c.issuer.CN || c.issuer.O));
  }
  s.end();
});
s.setTimeout(15000, () => { console.log('TIMEOUT'); s.destroy(); });
s.on('error', (e) => console.log('ERROR ' + e.message));
'@
[IO.File]::WriteAllText((Join-Path $probeDir 'probe.js'), $probe, $utf8NoBom)

Say 'Checking HTTPS interception (antivirus / corporate proxy)'
$probeOut = & docker run --rm -v "${probeDir}:/probe:ro" -v "${certDir}:/certs" node:24-bookworm-slim node /probe/probe.js
$probeOut = ($probeOut | Out-String).Trim()
$rootPem = Join-Path $certDir 'host-intercept-root.pem'
if ($probeOut -like 'ROOT *') {
  Info ("HTTPS is re-signed by '" + $probeOut.Substring(5) + "'. Its root CA was saved to certs\host-intercept-root.pem.")
} elseif ($probeOut -like 'ISSUER *') {
  $issuer = $probeOut.Substring(7)
  $rootCert = Find-RootByCN $issuer
  if ($rootCert) {
    $b64 = [Convert]::ToBase64String($rootCert.RawData, 'InsertLineBreaks') -replace "`r`n", "`n"
    [IO.File]::WriteAllText($rootPem, "-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----`n", $utf8NoBom)
    Info "HTTPS is re-signed by '$issuer'. Its root CA was saved to certs\host-intercept-root.pem and will be trusted inside the container."
  } else {
    Info "HTTPS is re-signed by '$issuer' but its root CA was not found on this PC."
    Info 'Export that root CA as PEM into the certs\ folder, or turn off HTTPS scanning in your antivirus, then run this script again.'
  }
} elseif ($probeOut -eq 'OK') {
  Info 'No HTTPS interception detected.'
} else {
  Info "Could not check HTTPS interception ($probeOut); continuing."
}

# ---- start ----------------------------------------------------------------------
Say 'Building and starting container'
& docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed (see output above).' }

Say 'Waiting for the panel'
$url = "http://localhost:$panel/"
$ready = $false
for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
  try {
    $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    $ready = $true
  } catch { Start-Sleep -Seconds 2 }
}

Say 'Done'
Info "Panel  : http://$($envMap['PUBLIC_HOST']):$panel  (or $url)"
Info "Login  : $($envMap['ADMIN_USER']) / $($envMap['ADMIN_PASSWORD'])"
Info "Ports  : $pMin-$pMax"
Info 'Logs   : docker compose logs -f'
if (-not $ready) { Info 'The panel did not answer yet; check "docker compose logs -f".' }
else { Start-Process $url }

Pause-IfElevated
