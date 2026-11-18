# Start Claude Code with Bruno's identity fetched from identity-runtime. This
# remains self-contained for Windows: it needs PowerShell and an installed
# Claude CLI, but no Bun or embedded credential.
#
#   claude-bruno.ps1                    launch Claude Code with Bruno's identity
#   claude-bruno.ps1 --force            ...re-fetching the identity even if the cache is fresh
#   claude-bruno.ps1 --check            read-only health check: runtime, recall, Hindsight, hooks
#   claude-bruno.ps1 --install-hooks    register the per-prompt recall hook + the Hindsight config
#   claude-bruno.ps1 --hook             the per-prompt recall hook itself (Claude Code runs it; stdin = hook JSON)
#   claude-bruno.ps1 --remember "text" [--tags a,b] [--source name]
#                                      write one memory into the tenant through identity-runtime
$ErrorActionPreference = "Stop"

$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$RuntimeUrl = if ($env:IDENTITY_RUNTIME_URL) { $env:IDENTITY_RUNTIME_URL } else { "http://127.0.0.1:13541" }
$TargetPath = if ($env:CORE_IDENTITY_PATH) { $env:CORE_IDENTITY_PATH } else { Join-Path $UserHome ".agent-runtime\bruno\CORE_IDENTITY.md" }
$StaleMs = 3 * 24 * 60 * 60 * 1000
$Force = $args -contains "--force"
$ScriptArgs = $args

# -- Host modes -------------------------------------------------------------
# Same tenant API as scripts/identity-runtime/host-session.ts (join once, keep the
# lease, then direct-recall / remember over HTTP), so Windows needs no Bun. Written
# for Windows PowerShell 5.1 and PowerShell 7 alike.
$Tenant = if ($env:IDENTITY_TENANT) { $env:IDENTITY_TENANT } elseif ($env:AGENT_NAME) { $env:AGENT_NAME } else { "bruno" }
$HostClientId = "claude-code-windows"
$HostSurfaceId = "claude-code-host-ps1"
$SessionPath = if ($env:IDENTITY_SESSION_PATH) { $env:IDENTITY_SESSION_PATH } else { Join-Path (Join-Path (Join-Path $UserHome ".agent-runtime") $Tenant) "session-windows.json" }
$SettingsPath = if ($env:CLAUDE_SETTINGS_PATH) { $env:CLAUDE_SETTINGS_PATH } else { Join-Path (Join-Path $UserHome ".claude") "settings.json" }
$HindsightConfigPath = if ($env:HINDSIGHT_CONFIG_PATH) { $env:HINDSIGHT_CONFIG_PATH } else { Join-Path (Join-Path $UserHome ".hindsight") "coding-agent.json" }
$RenewMarginMs = 60000
$RequestTimeoutSec = 10
$CheckFailures = 0

# Windows PowerShell 5.1's "-Encoding UTF8" writes a BOM, which Node's JSON.parse rejects.
function Write-Utf8NoBom($Path, $Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Get-ErrorText($ErrorRecord) {
    $text = $null
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        try { $text = ($ErrorRecord.ErrorDetails.Message | ConvertFrom-Json).error } catch { $text = $ErrorRecord.ErrorDetails.Message }
    }
    if (-not $text) { $text = $ErrorRecord.Exception.Message }
    return [string]$text
}

# The body goes out as UTF-8 bytes: Windows PowerShell 5.1 would otherwise encode a string body as Latin-1.
function Invoke-Runtime($Path, $Body) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Body -Depth 10 -Compress))
    return Invoke-RestMethod -Uri ($RuntimeUrl.TrimEnd("/") + $Path) -Method Post -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec $RequestTimeoutSec
}

function Join-Runtime($ClientId, $Message) {
    $body = Invoke-Runtime "/identity-runtime/$Tenant/join" @{ clientId = $ClientId; surfaceId = $HostSurfaceId; message = $Message }
    foreach ($key in "leaseId", "sessionToken", "stateHash") {
        if (-not $body.$key) { throw "join failed: response has no $key" }
    }
    return $body
}

function Read-HostSession {
    try {
        if (-not (Test-Path -LiteralPath $SessionPath)) { return $null }
        $state = Get-Content -Raw -LiteralPath $SessionPath | ConvertFrom-Json
        foreach ($key in "origin", "tenant", "clientId", "surfaceId", "leaseId", "sessionToken", "stateHash") {
            if (-not $state.$key) { return $null }
        }
        if ($null -eq $state.expiresAt) { return $null }
        return $state
    } catch { return $null }
}

function Save-HostSession($State) {
    New-Item -ItemType Directory -Force -Path (Split-Path $SessionPath -Parent) | Out-Null
    Write-Utf8NoBom $SessionPath (ConvertTo-Json -InputObject $State -Compress)
}

function Join-HostSession {
    $body = Join-Runtime $HostClientId "Claude Code Windows host client for $Tenant (per-turn recall / remember)."
    $expires = if ($null -ne $body.expiresAt) { [long]$body.expiresAt } else { (Get-NowMs) }
    $state = [pscustomobject]@{
        origin = $RuntimeUrl.TrimEnd("/"); tenant = $Tenant; clientId = $HostClientId; surfaceId = $HostSurfaceId
        leaseId = $body.leaseId; sessionToken = $body.sessionToken; stateHash = $body.stateHash
        expiresAt = $expires; joinedAt = (Get-NowMs)
    }
    Save-HostSession $state
    return $state
}

function Get-HostSession {
    $state = Read-HostSession
    if ($state -and $state.origin -eq $RuntimeUrl.TrimEnd("/") -and $state.tenant -eq $Tenant -and $state.clientId -eq $HostClientId `
        -and (([long]$state.expiresAt) - (Get-NowMs)) -gt $RenewMarginMs) { return $state }
    return Join-HostSession
}

# Call an authorized endpoint; if the runtime says the session is bad, join again and retry once.
function Invoke-Authorized($Path, [scriptblock]$Build) {
    $state = Get-HostSession
    try {
        return Invoke-Runtime $Path (& $Build $state)
    } catch {
        if ((Get-ErrorText $_) -notmatch '\b(lease|stale|session)\b') { throw }
        $state = Join-HostSession
        return Invoke-Runtime $Path (& $Build $state)
    }
}

function Get-ProjectName($Cwd) {
    if (-not $Cwd) { $Cwd = (Get-Location).Path }
    try {
        $top = (& git -C $Cwd rev-parse --show-toplevel 2>$null | Select-Object -First 1)
        if ($top) { return (Split-Path ([string]$top) -Leaf) }
    } catch { }
    return (Split-Path ([string]$Cwd) -Leaf)
}

# Mirrors promptToQuery / composeQuery in scripts/claude/identity-client.ts.
function ConvertTo-RecallQuery($Prompt, $Cwd) {
    if (-not $Prompt) { return $null }
    $text = [regex]::Replace([string]$Prompt, '</?[a-zA-Z][^>]*>', ' ')
    $text = ([regex]::Replace($text, '\s+', ' ')).Trim()
    if ($text.Length -lt 12 -or $text.StartsWith("/")) { return $null }
    if ($text.Length -gt 300) { $text = $text.Substring(0, 300) }
    if ($text.Length -lt 60) {
        $project = Get-ProjectName $Cwd
        if ($project) { $text = "$text (project: $project)" }
    }
    return $text
}

function Format-Recall($Results) {
    $sections = @()
    foreach ($r in @($Results)) {
        if (-not $r -or -not $r.content) { continue }
        $content = ([string]$r.content).Trim()
        if ($content -eq "" -or $content -match '^\(no results\)$') { continue }
        if ($content.Length -gt 600) { $content = $content.Substring(0, 600) }
        $sections += "## $($r.source)`n$content"
    }
    $joined = $sections -join "`n`n"
    if ($joined.Length -gt 1800) { $joined = $joined.Substring(0, 1800) }
    return $joined
}

# Rate-limits the "recall unavailable" note (once per 10 minutes) through a marker file's mtime.
function Test-NoteDue {
    try { return ((Get-Date) - (Get-Item -LiteralPath "$SessionPath.note").LastWriteTime).TotalMinutes -gt 10 } catch { return $true }
}
function Set-NoteMarked {
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path $SessionPath -Parent) | Out-Null
        if (Test-Path -LiteralPath "$SessionPath.note") { (Get-Item -LiteralPath "$SessionPath.note").LastWriteTime = Get-Date }
        else { Set-Content -LiteralPath "$SessionPath.note" -Value "" }
    } catch { }
}

# UserPromptSubmit hook: prints hook JSON to stdout, never fails the turn.
function Invoke-RecallHook {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $context = $null
    try {
        $script:RequestTimeoutSec = 3
        $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
        $hookInput = $reader.ReadToEnd() | ConvertFrom-Json
        $query = ConvertTo-RecallQuery $hookInput.prompt $hookInput.cwd
        if (-not $query) { return }
        try {
            $build = { param($s) @{ leaseId = $s.leaseId; clientId = $s.clientId; sessionToken = $s.sessionToken; stateHash = $s.stateHash; query = $query } }
            $text = Format-Recall (Invoke-Authorized "/identity-runtime/continuity/direct-recall" $build.GetNewClosure())
            if ($text) { $context = "RECALLED MEMORY (identity-runtime, per-turn):`n$text" }
        } catch {
            if (Test-NoteDue) { $context = "[identity-runtime recall unavailable: $(Get-ErrorText $_)]"; Set-NoteMarked }
        }
    } catch { return }
    if (-not $context) { return }
    $json = ConvertTo-Json -InputObject @{ hookSpecificOutput = @{ hookEventName = "UserPromptSubmit"; additionalContext = $context } } -Depth 5 -Compress
    $bytes = $utf8.GetBytes($json)
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Get-ArgValue($Name) {
    $i = [array]::IndexOf($ScriptArgs, $Name)
    if ($i -ge 0 -and $i + 1 -lt $ScriptArgs.Count) { return [string]$ScriptArgs[$i + 1] }
    return $null
}

# One lease carries exactly one write (a write advances the canonical revision but not the lease's
# stateHash), so the spent session is expired afterwards, like HostSession.remember does.
function Invoke-Remember($Content, $Tags, $Source) {
    if (-not $Content -or -not $Content.Trim()) { throw "--remember needs the text to remember" }
    $scope = "observation"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes((@($Tenant, $scope, $Source, $Content) -join "`n")))
    $idempotencyKey = -join ($hash | ForEach-Object { $_.ToString("x2") })
    $tagList = @()
    if ($Tags) { $tagList = @($Tags.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    # The memory inbox keeps tags but drops "source", so the origin travels as a tag.
    $tagList += "source:$Source"
    $build = {
        param($s)
        @{
            leaseId = $s.leaseId; clientId = $s.clientId; sessionToken = $s.sessionToken; stateHash = $s.stateHash
            idempotencyKey = $idempotencyKey
            entry = @{ scope = $scope; content = $Content; tags = $tagList; confidence = 0.7; source = $Source }
        }
    }
    $saved = Invoke-Authorized "/identity-runtime/continuity/remember" $build.GetNewClosure()
    $state = Read-HostSession
    if ($state) { $state.expiresAt = 0; Save-HostSession $state }
    return $saved
}

function Write-Check($Level, $Label, $Detail) {
    if ($Level -eq "FAIL") { $script:CheckFailures++ }
    Write-Host ("[{0}] {1}: {2}" -f $Level, $Label, $Detail)
}

function Get-HindsightSettings {
    $config = $null
    try { if (Test-Path -LiteralPath $HindsightConfigPath) { $config = Get-Content -Raw -LiteralPath $HindsightConfigPath | ConvertFrom-Json } } catch { }
    $url = if ($env:HINDSIGHT_API_URL) { $env:HINDSIGHT_API_URL } elseif ($config -and $config.apiUrl) { [string]$config.apiUrl } else { $null }
    $token = if ($env:HINDSIGHT_API_TOKEN) { $env:HINDSIGHT_API_TOKEN } elseif ($config -and $config.apiToken) { [string]$config.apiToken } else { $null }
    return [pscustomobject]@{ Url = $url; Token = $token }
}

function Get-HookCommands {
    $commands = @()
    try {
        if (Test-Path -LiteralPath $SettingsPath) {
            $settings = Get-Content -Raw -LiteralPath $SettingsPath | ConvertFrom-Json
            if ($settings.hooks) {
                foreach ($event in $settings.hooks.PSObject.Properties) {
                    foreach ($group in @($event.Value)) {
                        foreach ($hook in @($group.hooks)) { if ($hook.command) { $commands += [pscustomobject]@{ Event = $event.Name; Command = [string]$hook.command } } }
                    }
                }
            }
        }
    } catch { }
    return $commands
}

# Read-only: never writes memory and never prints a token.
function Invoke-Check {
    Write-Host "claude-bruno.ps1 --check  (runtime $RuntimeUrl, tenant $Tenant)"
    try {
        $body = Join-Runtime "claude-code-windows-check" "Health check from claude-bruno.ps1 --check."
        $chars = ([string]$body.projection).Length
        Write-Check $(if ($chars -gt 0) { "PASS" } else { "FAIL" }) "identity-runtime join" "projection $chars chars"
    } catch { Write-Check "FAIL" "identity-runtime join" (Get-ErrorText $_) }

    try {
        $build = { param($s) @{ leaseId = $s.leaseId; clientId = $s.clientId; sessionToken = $s.sessionToken; stateHash = $s.stateHash; query = "identity-runtime health check" } }
        $count = @(@(Invoke-Authorized "/identity-runtime/continuity/direct-recall" $build) | Where-Object { $_ }).Count
        Write-Check "PASS" "direct recall" "$count result(s); host session at $SessionPath"
    } catch { Write-Check "FAIL" "direct recall" (Get-ErrorText $_) }

    $hindsight = Get-HindsightSettings
    if (-not $hindsight.Url -or -not $hindsight.Token) {
        Write-Check "WARN" "Hindsight" "apiUrl/apiToken not configured (run --install-hooks)"
    } else {
        try {
            Invoke-RestMethod -Uri ($hindsight.Url.TrimEnd("/") + "/v1/default/banks") -Headers @{ Authorization = "Bearer $($hindsight.Token)" } -TimeoutSec $RequestTimeoutSec | Out-Null
            Write-Check "PASS" "Hindsight" "$($hindsight.Url) accepted the token"
        } catch {
            $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
            Write-Check "FAIL" "Hindsight" $(if ($status -eq 401) { "$($hindsight.Url) rejected the token (401)" } else { Get-ErrorText $_ })
        }
    }

    $commands = @(Get-HookCommands)
    $ours = @($commands | Where-Object { $_.Event -eq "UserPromptSubmit" -and $_.Command -match 'claude-bruno\.ps1.*--hook' })
    Write-Check $(if ($ours.Count -gt 0) { "PASS" } else { "WARN" }) "recall hook in $SettingsPath" $(if ($ours.Count -gt 0) { "UserPromptSubmit -> claude-bruno.ps1 --hook" } else { "not installed (run --install-hooks)" })
    $plugin = @($commands | Where-Object { $_.Command -match 'hindsight.coding-agents' })
    Write-Check $(if ($plugin.Count -gt 0) { "PASS" } else { "WARN" }) "Hindsight plugin hooks" $(if ($plugin.Count -gt 0) { "$($plugin.Count) hook(s) registered" } else { "not installed (npx @vectorize-io/hindsight-coding-agents install claude-code)" })

    if ($script:CheckFailures -gt 0) { Write-Host "$($script:CheckFailures) check(s) failed."; exit 1 }
    Write-Host "All required checks passed."
}

# Adds the recall hook to settings.json without touching anything else: backs the file up first,
# replaces an earlier copy of this hook, and restores the backup if the result does not parse back.
function Install-RecallHook {
    $exe = if ($PSVersionTable.PSEdition -eq "Core") { "pwsh" } else { "powershell" }
    $command = "$exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" --hook"
    $settings = [pscustomobject]@{}
    $backup = $null
    if (Test-Path -LiteralPath $SettingsPath) {
        $settings = Get-Content -Raw -LiteralPath $SettingsPath | ConvertFrom-Json   # throws on JSON with comments: nothing is changed then
        $backup = "$SettingsPath.bak-" + (Get-Date -Format "yyyyMMddHHmmss")
        Copy-Item -LiteralPath $SettingsPath -Destination $backup
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $SettingsPath -Parent) | Out-Null
    }
    if (-not $settings.PSObject.Properties["hooks"]) { $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) }
    $groups = @()
    if ($settings.hooks.PSObject.Properties["UserPromptSubmit"]) {
        foreach ($group in @($settings.hooks.UserPromptSubmit)) {
            $isOurs = @(@($group.hooks) | Where-Object { $_.command -match 'claude-bruno\.ps1.*--hook' }).Count -gt 0
            if (-not $isOurs) { $groups += $group }
        }
    }
    $groups += [pscustomobject]@{ hooks = @([pscustomobject]@{ type = "command"; command = $command; timeout = 10 }) }
    if ($settings.hooks.PSObject.Properties["UserPromptSubmit"]) { $settings.hooks.UserPromptSubmit = $groups }
    else { $settings.hooks | Add-Member -NotePropertyName UserPromptSubmit -NotePropertyValue $groups }
    $json = ConvertTo-Json -InputObject $settings -Depth 20
    try { $null = $json | ConvertFrom-Json } catch { throw "refusing to write settings.json: generated JSON does not parse ($($_.Exception.Message))" }
    Write-Utf8NoBom $SettingsPath $json
    Write-Host "[OK] recall hook -> $SettingsPath"
    if ($backup) { Write-Host "     backup: $backup" }
}

# Writes ~/.hindsight/coding-agent.json (URL + token) and offers the plugin installer, which
# registers Hindsight's own SessionStart / UserPromptSubmit / Stop hooks. The token is never printed.
function Install-HindsightConfig {
    $existing = Get-HindsightSettings
    $url = if ($existing.Url) { $existing.Url } else { "http://" + ([uri]$RuntimeUrl).Host + ":8891" }
    $token = $existing.Token
    if (-not $token) {
        try {
            $secure = Read-Host "Hindsight API token (from the Hindsight server's tenant key file; Enter to skip)" -AsSecureString
            $token = [System.Net.NetworkCredential]::new("", $secure).Password
        } catch { $token = $null }
    }
    if (-not $token) { Write-Host "[SKIP] Hindsight: no token given. Set HINDSIGHT_API_TOKEN or re-run --install-hooks."; return }
    $config = [ordered]@{}
    try { if (Test-Path -LiteralPath $HindsightConfigPath) { foreach ($p in (Get-Content -Raw -LiteralPath $HindsightConfigPath | ConvertFrom-Json).PSObject.Properties) { $config[$p.Name] = $p.Value } } } catch { }
    $config["serverMode"] = "self-hosted"; $config["apiUrl"] = $url; $config["apiToken"] = $token
    New-Item -ItemType Directory -Force -Path (Split-Path $HindsightConfigPath -Parent) | Out-Null
    Write-Utf8NoBom $HindsightConfigPath (ConvertTo-Json -InputObject $config)
    Write-Host "[OK] Hindsight config -> $HindsightConfigPath ($url)"
    $installer = "npx --yes @vectorize-io/hindsight-coding-agents install claude-code"
    if (Get-Command npx -ErrorAction SilentlyContinue) {
        $answer = try { Read-Host "Run the Hindsight plugin installer now? ($installer) [y/N]" } catch { "" }
        if ($answer -match '^(y|yes)$') { & npx --yes "@vectorize-io/hindsight-coding-agents" install claude-code }
        else { Write-Host "     later: $installer" }
    } else {
        Write-Host "[TODO] npx (Node.js) not found; install Node.js, then run: $installer"
    }
}

if ($args -contains "--hook") { Invoke-RecallHook; exit 0 }
if ($args -contains "--check") { Invoke-Check; exit 0 }
if ($args -contains "--install-hooks") {
    Install-RecallHook
    Install-HindsightConfig
    Write-Host "Next: claude-bruno.ps1 --check"
    exit 0
}
if ($args -contains "--remember") {
    $source = Get-ArgValue "--source"; if (-not $source) { $source = "bruno-windows" }
    $saved = Invoke-Remember (Get-ArgValue "--remember") (Get-ArgValue "--tags") $source
    Write-Host "remembered: $($saved.id) ($($saved.createdAt))"
    exit 0
}

New-Item -ItemType Directory -Force -Path (Split-Path $TargetPath -Parent) | Out-Null

$NeedsFetch = $Force -or -not (Test-Path $TargetPath)
if (-not $NeedsFetch) {
    $AgeMs = ((Get-Date) - (Get-Item $TargetPath).LastWriteTime).TotalMilliseconds
    $NeedsFetch = $AgeMs -ge $StaleMs
}

if ($NeedsFetch) {
    $Body = @{ clientId = "claude"; surfaceId = "claudia-bruno"; message = "Fetch Bruno identity projection for Claude Code CLI (claudia-bruno)." } | ConvertTo-Json
    $Response = Invoke-RestMethod -Uri "$RuntimeUrl/identity-runtime/bruno/join" -Method Post -ContentType "application/json" -Body $Body
    if (-not $Response.projection) { throw "join failed: no projection returned" }
    Set-Content -Path $TargetPath -Value $Response.projection -NoNewline
}

$ClaudeBin = if ($env:CLAUDE_BIN) { $env:CLAUDE_BIN } else { "claude" }
$ClaudeArgs = @($args | Where-Object { $_ -ne "--force" })
& $ClaudeBin --dangerously-skip-permissions --append-system-prompt-file $TargetPath @ClaudeArgs
