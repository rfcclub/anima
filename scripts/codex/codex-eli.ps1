# Start patched Codex with Eli's identity, fetched over the network from
# identity-runtime (no local core-identity-compiler on Windows, so this is the
# only source). Self-contained: no Bun dependency.
$ErrorActionPreference = "Stop"

$RuntimeUrl = if ($env:IDENTITY_RUNTIME_URL) { $env:IDENTITY_RUNTIME_URL } else { "http://127.0.0.1:13541" }
$TargetPath = if ($env:CORE_IDENTITY_PATH) { $env:CORE_IDENTITY_PATH } else { Join-Path $env:USERPROFILE ".agent-runtime\eli\CORE_IDENTITY.md" }
$StaleMs = 3 * 24 * 60 * 60 * 1000
$Force = $args -contains "--force"

New-Item -ItemType Directory -Force -Path (Split-Path $TargetPath -Parent) | Out-Null

$NeedsFetch = $Force -or -not (Test-Path $TargetPath)
if (-not $NeedsFetch) {
    $AgeMs = ((Get-Date) - (Get-Item $TargetPath).LastWriteTime).TotalMilliseconds
    $NeedsFetch = $AgeMs -ge $StaleMs
}

if ($NeedsFetch) {
    $Body = @{ clientId = "codex"; surfaceId = "codex-eli"; message = "Fetch Eli identity projection for Codex CLI (codex-eli)." } | ConvertTo-Json
    $Response = Invoke-RestMethod -Uri "$RuntimeUrl/identity-runtime/eli/join" -Method Post -ContentType "application/json" -Body $Body
    if (-not $Response.projection) { throw "join failed: no projection returned" }
    Set-Content -Path $TargetPath -Value $Response.projection -NoNewline
}

# TOML multiline literal string delimiter; a context containing it would break the -c override below.
$Context = Get-Content -Path $TargetPath -Raw
if ($Context -match "'''") { throw "context contains TOML literal delimiter (''')" }

$CodexBin = $env:CODEXIA_BIN
if (-not $CodexBin) { throw "CODEXIA_BIN is required: set it to the path of codex-patched.exe" }
$CodexArgs = @($args | Where-Object { $_ -ne "--force" })
& $CodexBin -c "developer_instructions = '''$Context'''" @CodexArgs
