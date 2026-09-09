[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Fast,
    [switch]$Full,
    [switch]$SkipBuild,
    # Sync and build for an existing service owner without restarting it or changing Serve.
    [switch]$PrepareOnly,
    [ValidateRange(15, 600)]
    [int]$WaitSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Fast -and $Full) {
    throw "-Fast and -Full cannot be used together."
}

if ($Full -and $SkipBuild) {
    throw "-Full and -SkipBuild cannot be used together."
}

$sourceRoot = "A:\Dev\Worktrees\t3code-workers-prototype"
$deployRoot = "A:\Dev\Worktrees\t3code-deploy"
$t3Home = "D:\MovedAppData\T3CodeServer"
$nodePath = "A:\Dev\Tooling\t3-node-v24.19.0\node.exe"
$expectedBranch = "feat/t3-workers-prototype"
$serverPort = 3774
$webPort = 6803
$tailnetServePort = 9445
$webPortOffset = $webPort - 5733
$expectedDevUrl = "http://127.0.0.1:$webPort/"
$expectedTailnetProxy = "http://127.0.0.1:$serverPort"
$planOnly = $DryRun -or [bool]$WhatIfPreference
$transcriptStarted = $false
$transcriptPath = $null
$needsTailscaleServe = $false
$startedRootPids = @()

# These paths are owned by the deploy checkout or by the D-backed runtime.
# The synchronizer never removes them and never copies over them.
$excludedRelativeFiles = @(
    ".git",
    ".env",
    ".env.local",
    "infra\relay\.env",
    "infra\relay\.env.local",
    "apps\mobile\src\features\usage\usageProviders.ts",
    "scripts\import-codex-history.mjs",
    "apps\desktop\tsconfig.tsbuildinfo",
    "apps\web\tsconfig.tsbuildinfo"
)

$excludedDirectoryNames = @(
    ".git",
    ".t3",
    ".vite-plus",
    "node_modules",
    "caches",
    "dist",
    "dist-electron",
    "target",
    "userdata",
    "work",
    "worktrees",
    "release"
)

function Write-Phase {
    param([Parameter(Mandatory)][string]$Name)
    Write-Host "[$Name]"
}

function Write-Plan {
    param([Parameter(Mandatory)][string]$Message)
    if ($planOnly) {
        Write-Host "  PLAN $Message"
    }
    else {
        Write-Host "  $Message"
    }
}

function Normalize-AbsolutePath {
    param([Parameter(Mandatory)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Test-SamePath {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )
    return (Normalize-AbsolutePath $Left).Equals((Normalize-AbsolutePath $Right), [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    if ($Path -notmatch '^[A-Za-z]:[\\/]') {
        throw "$Label must be an absolute path: $Path"
    }
    $resolved = Normalize-AbsolutePath $Path
    if ($resolved.Length -lt 4 -or $resolved -match '^[A-Za-z]:$') {
        throw "$Label resolves to an unsafe broad path: $resolved"
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "$Label does not exist as a directory: $resolved"
    }
    $item = Get-Item -LiteralPath $resolved -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label is a reparse point. Refusing to operate through it: $resolved"
    }
    return $resolved
}

function Assert-ContainedPath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Label
    )
    $rootFull = (Normalize-AbsolutePath $Root) + [System.IO.Path]::DirectorySeparatorChar
    $candidateFull = Normalize-AbsolutePath $Candidate
    if (-not $candidateFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label is outside its approved root: $candidateFull"
    }
    return $candidateFull
}

function Invoke-GitText {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $result = & git -C $Root @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed in $Root with exit code $LASTEXITCODE"
    }
    return (($result | Out-String).Trim())
}

function Test-ExcludedRelativePath {
    param([Parameter(Mandatory)][string]$RelativePath)
    $normalized = $RelativePath.Replace('/', '\').TrimStart('\')
    $comparison = $normalized.ToLowerInvariant()
    foreach ($excluded in $excludedRelativeFiles) {
        if ($comparison -eq $excluded.ToLowerInvariant()) {
            return $true
        }
    }
    foreach ($part in ($normalized -split '\\')) {
        if ($excludedDirectoryNames -contains $part.ToLowerInvariant()) {
            return $true
        }
    }
    return $false
}

function Get-IncludedFiles {
    param([Parameter(Mandatory)][string]$Root)
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Root)
    $files = New-Object 'System.Collections.Generic.List[object]'

    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
            $relative = $item.FullName.Substring($Root.Length).TrimStart('\', '/')
            if (Test-ExcludedRelativePath $relative) {
                continue
            }
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to traverse or copy a reparse point in the owned source projection: $($item.FullName)"
            }
            if ($item.PSIsContainer) {
                $pending.Push($item.FullName)
            }
            elseif ($item -is [System.IO.FileInfo]) {
                [void]$files.Add([pscustomobject]@{ Relative = $relative; FullName = $item.FullName })
            }
        }
    }
    return @($files.ToArray())
}

function Get-FileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-FingerprintMap {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][object[]]$Files
    )
    $map = @{}
    foreach ($file in $Files) {
        $map[$file.Relative.ToLowerInvariant()] = Get-FileSha256 $file.FullName
    }
    return $map
}

function Get-DependencyRelativePaths {
    param([Parameter(Mandatory)][object[]]$Files)
    return @($Files | Where-Object {
        $name = [System.IO.Path]::GetFileName($_.Relative)
        $name -eq "package.json" -or $name -eq "pnpm-lock.yaml" -or $name -eq "pnpm-workspace.yaml"
    } | ForEach-Object { $_.Relative.ToLowerInvariant() })
}

function Sync-TrackedSourceFiles {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DeployRoot,
        [switch]$PlanOnly
    )
    $sourceFiles = @(Get-IncludedFiles $SourceRoot)
    $deployFiles = @(Get-IncludedFiles $DeployRoot)
    $sourceMap = Get-FingerprintMap $SourceRoot $sourceFiles
    $deployMap = Get-FingerprintMap $DeployRoot $deployFiles
    $mismatches = @($sourceFiles | Where-Object {
        $key = $_.Relative.ToLowerInvariant()
        -not $deployMap.ContainsKey($key) -or $deployMap[$key] -ne $sourceMap[$key]
    })
    if ($mismatches.Count -eq 0) {
        Write-Plan "Deploy projection already matches source."
        return 0
    }
    if ($PlanOnly) {
        Write-Plan "Would copy $($mismatches.Count) source files into deploy without deleting anything."
        return $mismatches.Count
    }
    foreach ($file in $mismatches) {
        $destination = Assert-ContainedPath $DeployRoot (Join-Path $DeployRoot $file.Relative) "sync destination"
        $parent = [System.IO.Path]::GetDirectoryName($destination)
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        $parentItem = Get-Item -LiteralPath $parent -Force
        if (($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Sync destination parent is a reparse point: $parent"
        }
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    }
    Write-Host "  copied $($mismatches.Count) files. No deploy files were deleted."
    return $mismatches.Count
}

function Get-ProcessCommandLine {
    param([Parameter(Mandatory)][object]$Process)
    if ($null -eq $Process.CommandLine) {
        return ""
    }
    return (($Process.CommandLine -replace '\r|\n', ' ') -replace '\s+', ' ').Trim()
}

function Test-ManagedDesktopCommand {
    param(
        [Parameter(Mandatory)][object]$Process,
        [Parameter(Mandatory)][string]$HomePath
    )
    $command = Get-ProcessCommandLine $Process
    $embeddedDesktopServer = $command -match '(?i)apps[\\/]server[\\/]dist[\\/]bin\.mjs\s+--bootstrap-fd\s+3(?:\s|$)'
    if ($embeddedDesktopServer) {
        return $Process.Name -match '^electron(\.exe)?$' -and
            $command -match '(?i)apps[\\/]server[\\/]dist[\\/]bin\.mjs'
    }
    # A previous supported launcher used the packaged server entrypoint as a
    # standalone process. Recognize that exact deploy/home/port shape so a
    # transition run can replace it, but never broaden ownership to an
    # arbitrary Node process or another server on the same port.
    $deployPattern = [regex]::Escape((Normalize-AbsolutePath $deployRoot))
    $homePattern = [regex]::Escape((Normalize-AbsolutePath $HomePath))
    $quotePattern = [regex]::Escape([string][char]34)
    $legacyServerPattern = "(?i)$deployPattern[\\/]apps[\\/]server[\\/]dist[\\/]bin\.mjs(?:$quotePattern)?\s+serve\s+--host\s+127\.0\.0\.1\s+--port\s+$serverPort\s+--base-dir\s+(?:$quotePattern)?$homePattern(?:$quotePattern)?\s+--no-browser(?:\s|$)"
    $legacyServerRoot = $command -match $legacyServerPattern
    if ($legacyServerRoot) {
        return $Process.Name -match '^node(\.exe)?$'
    }
    if ($Process.Name -notmatch '^node(\.exe)?$') {
        return $false
    }
    if ($null -ne $Process.ExecutablePath -and -not (Test-SamePath $Process.ExecutablePath $nodePath)) {
        return $false
    }
    $homePattern = [regex]::Escape($HomePath)
    # `dev` is the existing hot-reload browser stack used by the deploy
    # checkout, while `dev:desktop` adds the Electron renderer. Both are valid
    # launcher-owned roots when they carry the approved home, server port, and
    # web origin. Descendant listener ownership below still rejects any port
    # held outside this exact T3 process tree.
    $isDesktopMode = $command -match '(?i)scripts[\\/]dev-runner\.ts\s+dev:desktop(?:\s|$)'
    $hasExpectedDesktopUrl = $command -match "(?i)--dev-url\s+[^\s]*$webPort"
    $runnerRoot = $command -match '(?i)scripts[\\/]dev-runner\.ts\s+dev(?::desktop)?(?:\s|$)' -and
        $command -match "(?i)--home-dir\s+.*$homePattern" -and
        $command -match "(?i)--port\s+$serverPort(\s|$)" -and
        (-not $isDesktopMode -or $hasExpectedDesktopUrl)
    $directServerRoot = $command -match '(?i)(?:^|\s|[\\/])apps[\\/]server[\\/]src[\\/]bin\.ts\s+--host\s+127\.0\.0\.1(?:\s|$)'
    # In desktop development the authenticated server is spawned by Electron
    # with the bootstrap envelope on fd 3. It must stay in the same process
    # tree as Electron so the desktop-issued bearer token matches the server
    # that owns port 3774. Keep recognizing the old direct-server form while
    # existing managed instances drain, but never launch that form here.
    return $runnerRoot -or $directServerRoot -or $embeddedDesktopServer
}

function Get-ManagedDesktopRoots {
    param([Parameter(Mandatory)][string]$HomePath)
    return @(Get-CimInstance Win32_Process | Where-Object { Test-ManagedDesktopCommand $_ $HomePath })
}

function Get-ManagedElectronRoots {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '^node(\.exe)?$' -and
        $null -ne $_.ExecutablePath -and
        (Test-SamePath $_.ExecutablePath $nodePath) -and
        (Get-ProcessCommandLine $_) -match '(?i)apps[\\/]desktop[\\/]scripts[\\/]start-electron\.mjs(?:\s|$)'
    })
}

function Get-ManagedWebRoots {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '^node(\.exe)?$' -and
        $null -ne $_.ExecutablePath -and
        (Test-SamePath $_.ExecutablePath $nodePath) -and
        (Get-ProcessCommandLine $_) -match '(?i)node_modules[\\/]vite-plus[\\/]bin[\\/]vp\s+dev\s+--host\s+127\.0\.0\.1(?:\s+--port\s+6803)?(?:\s|$)'
    })
}

function Get-ListeningProcesses {
    param([Parameter(Mandatory)][int]$Port)
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
        throw "Get-NetTCPConnection is required to validate port ownership."
    }
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    $processes = @{}
    foreach ($connection in $connections) {
        $processId = [int]$connection.OwningProcess
        if (-not $processes.ContainsKey($processId)) {
            $processes[$processId] = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
        }
    }
    return @($processes.Values | Where-Object { $null -ne $_ })
}

function Wait-Until {
    param(
        [Parameter(Mandatory)][scriptblock]$Condition,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [Parameter(Mandatory)][string]$Description
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (& $Condition) {
            return
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out after $TimeoutSeconds seconds waiting for $Description."
}

function Test-HttpEndpoint {
    param([Parameter(Mandatory)][string]$Uri)
    try {
        & curl.exe --fail --silent --show-error --max-time 5 --output NUL $Uri 2>$null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

function Test-EnvironmentTransport {
    param([Parameter(Mandatory)][string]$BaseUri)
    try {
        $raw = & curl.exe --fail --silent --show-error --max-time 5 "$($BaseUri.TrimEnd('/'))/api/auth/session" 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $false
        }
        $state = ($raw | Out-String) | ConvertFrom-Json
        $hasBearerSession = @($state.auth.sessionMethods) -contains "bearer-access-token"
        $hasDesktopBootstrap = @($state.auth.bootstrapMethods) -contains "desktop-bootstrap"
        return $null -ne $state.authenticated -and
            $null -ne $state.auth -and
            $state.auth.policy -eq "desktop-managed-local" -and
            $hasDesktopBootstrap -and
            $hasBearerSession
    }
    catch {
        return $false
    }
}

function Read-TailscaleJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $raw = & $tailscalePath @Arguments 2>$null | Out-String
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        throw "tailscale $($Arguments -join ' ') failed. No CLI output was retained."
    }
    try {
        return $raw | ConvertFrom-Json
    }
    catch {
        throw "tailscale $($Arguments -join ' ') returned invalid JSON."
    }
}

function Get-TailscaleProxy {
    param(
        [Parameter(Mandatory)][object]$ServeStatus,
        [Parameter(Mandatory)][int]$ServePort
    )
    if ($null -eq $ServeStatus.Web) {
        return $null
    }
    foreach ($entry in @($ServeStatus.Web.PSObject.Properties)) {
        if ($entry.Name -notmatch ":$ServePort$") {
            continue
        }
        if ($null -eq $entry.Value.Handlers) {
            continue
        }
        foreach ($handler in @($entry.Value.Handlers.PSObject.Properties)) {
            if ($handler.Name -eq "/" -and $null -ne $handler.Value.Proxy) {
                return ([string]$handler.Value.Proxy).TrimEnd('/')
            }
        }
    }
    return $null
}

function Invoke-ProjectCommand {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter()][string]$WorkingDirectory
    )
    Write-Host "  RUN $Label"
    if ($planOnly) {
        Write-Host "       vp $($Arguments -join ' ')"
        return
    }
    if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $WorkingDirectory = $deployRoot
    }
    Push-Location $WorkingDirectory
    $oldPath = $env:Path
    $oldCodexEnvironment = @{}
    try {
        $env:Path = "$([System.IO.Path]::GetDirectoryName($nodePath));$oldPath"
        # The desktop launcher is a project command boundary. These are
        # agent-host markers, not T3 build settings; Vite+ treats them as an
        # agent invocation and promotes ordinary build warnings to failures.
        foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like "CODEX_*" })) {
            $oldCodexEnvironment[$entry.Name] = $entry.Value
            Remove-Item -LiteralPath "Env:$($entry.Name)" -ErrorAction SilentlyContinue
        }
        & $vpPath @Arguments 1>> $LogPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "$Label failed with exit code $LASTEXITCODE. See $LogPath"
        }
    }
    finally {
        $env:Path = $oldPath
        foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like "CODEX_*" })) {
            Remove-Item -LiteralPath "Env:$($entry.Name)" -ErrorAction SilentlyContinue
        }
        foreach ($name in $oldCodexEnvironment.Keys) {
            Set-Item -Path "Env:$name" -Value $oldCodexEnvironment[$name]
        }
        Pop-Location
    }
}

function Stop-ManagedDesktop {
    param([Parameter(Mandatory)][string]$HomePath)
    $roots = @(Get-ManagedDesktopRoots $HomePath)
    $electronRoots = @(Get-ManagedElectronRoots)
    $webRoots = @(Get-ManagedWebRoots)
    Write-Host "  managed candidates server=$($roots.Count) web=$($webRoots.Count) electron=$($electronRoots.Count)"
    $embeddedRoots = @($roots | Where-Object {
        (Get-ProcessCommandLine $_) -match '(?i)apps[\\/]server[\\/]dist[\\/]bin\.mjs\s+--bootstrap-fd\s+3(?:\s|$)'
    })
    $directRoots = @($roots | Where-Object {
        (Get-ProcessCommandLine $_) -match '(?i)apps[\\/]server[\\/]src[\\/]bin\.ts\s+--host\s+127\.0\.0\.1(?:\s|$)'
    })
    # A failed previous launch can leave the old standalone server beside the
    # Electron-owned server. Both are launcher-owned and are stopped together;
    # any second root of the same kind remains a fail-closed condition.
    $isKnownTransitionPair = $roots.Count -eq 2 -and $embeddedRoots.Count -eq 1 -and $directRoots.Count -eq 1 -and $electronRoots.Count -eq 1
    if ($roots.Count -gt 1 -and -not $isKnownTransitionPair) {
        throw "Found $($roots.Count) managed T3 desktop roots for this home. Refusing to choose one."
    }
    if ($electronRoots.Count -gt 1) {
        throw "Found $($electronRoots.Count) managed T3 Electron roots. Refusing to choose one."
    }
    if ($webRoots.Count -gt 1) {
        throw "Found $($webRoots.Count) managed T3 web roots. Refusing to choose one."
    }
    $listeners = @()
    $listeners += @(Get-ListeningProcesses $serverPort)
    $listeners += @(Get-ListeningProcesses $webPort)
    $ownedPid = @{}
    if ($roots.Count -eq 1 -or $webRoots.Count -eq 1 -or $electronRoots.Count -eq 1) {
        foreach ($root in @($roots + $webRoots + $electronRoots)) {
            $ownedPid[[int]$root.ProcessId] = $true
        }
        $all = @(Get-CimInstance Win32_Process)
        $changed = $true
        while ($changed) {
            $changed = $false
            foreach ($process in $all) {
                if ($ownedPid.ContainsKey([int]$process.ParentProcessId) -and -not $ownedPid.ContainsKey([int]$process.ProcessId)) {
                    $ownedPid[[int]$process.ProcessId] = $true
                    $changed = $true
                }
            }
        }
    }
    foreach ($listener in $listeners) {
        if (-not $ownedPid.ContainsKey([int]$listener.ProcessId)) {
            throw "Port $serverPort or $webPort is held by an unrelated process. Refusing to stop it."
        }
    }
    if ($roots.Count -eq 0 -and $webRoots.Count -eq 0 -and $electronRoots.Count -eq 0) {
        if ($listeners.Count -gt 0) {
            throw "A required T3 port is occupied but no managed desktop root owns it."
        }
        Write-Plan "No existing managed server/web root found."
    }
    if ($webRoots.Count -eq 1) {
        Write-Plan "Stopping managed Vite root PID $($webRoots[0].ProcessId) and its process tree."
    }
    if ($roots.Count -eq 1) {
        Write-Plan "Stopping managed server/web root PID $($roots[0].ProcessId) and its process tree."
    }
    if ($electronRoots.Count -eq 1) {
        Write-Plan "Stopping managed Electron root PID $($electronRoots[0].ProcessId) and its process tree."
    }
    if (-not $planOnly) {
        foreach ($root in @($roots + $webRoots + $electronRoots)) {
            $taskKillExit = 0
            try {
                & taskkill.exe /PID ([string]$root.ProcessId) /T /F 1>$null 2>$null
                $taskKillExit = $LASTEXITCODE
            }
            catch {
                $taskKillExit = 1
            }
            if ($taskKillExit -ne 0) {
                # taskkill can report races for descendants that exited while
                # /T was walking the tree. The root PID is the ownership
                # decision; the wait below still proves every managed child
                # has drained before a replacement starts.
                $rootStillRunning = $null -ne (Get-CimInstance Win32_Process -Filter "ProcessId = $($root.ProcessId)" -ErrorAction SilentlyContinue)
                if ($rootStillRunning) {
                    # Electron's GPU/resource-monitor children can make
                    # taskkill /T return nonzero even though every process is
                    # already in the verified owned tree. Reap that captured
                    # tree by PID, then let the managed-root wait below prove
                    # that no owned child remains.
                    foreach ($ownedProcessId in @($ownedPid.Keys | Sort-Object -Descending)) {
                        try {
                            Stop-Process -Id ([int]$ownedProcessId) -Force -ErrorAction SilentlyContinue
                        }
                        catch {
                            # The process may have exited between the snapshot
                            # and this targeted fallback.
                        }
                    }
                    Start-Sleep -Milliseconds 500
                    $rootStillRunning = $null -ne (Get-CimInstance Win32_Process -Filter "ProcessId = $($root.ProcessId)" -ErrorAction SilentlyContinue)
                    if ($rootStillRunning) {
                        throw "taskkill could not stop managed T3 root PID $($root.ProcessId)."
                    }
                }
                Write-Host "  managed T3 root PID $($root.ProcessId) exited while descendants were being reaped."
            }
        }
        Wait-Until -TimeoutSeconds 30 -Description "the managed T3 desktop process tree to stop" -Condition {
            @(Get-ManagedDesktopRoots $HomePath).Count -eq 0 -and
            @(Get-ManagedWebRoots).Count -eq 0 -and
            @(Get-ManagedElectronRoots).Count -eq 0
        }
    }
}

function Start-ManagedDesktop {
    param(
        [Parameter(Mandatory)][string]$HomePath,
        [Parameter(Mandatory)][string]$StdOutPath,
        [Parameter(Mandatory)][string]$StdErrPath
    )
    $webArguments = @("$deployRoot/node_modules/vite-plus/bin/vp", "dev", "--host", "127.0.0.1", "--port", [string]$webPort)
    Write-Plan "Starting one hot-reload Vite root with Node $nodePath; Electron owns the authenticated T3 server."
    if ($planOnly) {
        Write-Host "       node $($webArguments -join ' ')"
        return $null
    }
    $oldPath = $env:Path
    $oldOffset = $env:T3CODE_PORT_OFFSET
    try {
        $env:Path = "$([System.IO.Path]::GetDirectoryName($nodePath));$oldPath"
        $env:T3CODE_PORT_OFFSET = [string]$webPortOffset
        $env:T3CODE_HOME = $HomePath
        $env:T3CODE_PORT = [string]$serverPort
        $env:PORT = [string]$webPort
        $env:T3CODE_SINGLE_ORIGIN_DEV = "1"
        $web = Start-Process -FilePath $nodePath -ArgumentList $webArguments -WorkingDirectory (Join-Path $deployRoot "apps\web") -WindowStyle Hidden -RedirectStandardOutput ($StdOutPath + ".vite") -RedirectStandardError ($StdErrPath + ".vite") -PassThru
        return $web
    }
    finally {
        $env:Path = $oldPath
        if ($null -eq $oldOffset) {
            Remove-Item Env:T3CODE_PORT_OFFSET -ErrorAction SilentlyContinue
        }
        else {
            $env:T3CODE_PORT_OFFSET = $oldOffset
        }
    }
}

function Start-ManagedElectron {
    param(
        [Parameter(Mandatory)][string]$StdOutPath,
        [Parameter(Mandatory)][string]$StdErrPath
    )
    $arguments = @("apps/desktop/scripts/start-electron.mjs")
    Write-Plan "Starting one hidden Electron dev root with Node $nodePath."
    if ($planOnly) {
        Write-Host "       node $($arguments -join ' ')"
        return $null
    }
    $oldPath = $env:Path
    $oldDevUrl = $env:VITE_DEV_SERVER_URL
    try {
        $env:Path = "$([System.IO.Path]::GetDirectoryName($nodePath));$oldPath"
        $env:VITE_DEV_SERVER_URL = $expectedDevUrl
        $env:T3CODE_HOME = $t3Home
        $env:T3CODE_PORT = [string]$serverPort
        return Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $deployRoot -WindowStyle Hidden -RedirectStandardOutput $StdOutPath -RedirectStandardError $StdErrPath -PassThru
    }
    finally {
        $env:Path = $oldPath
        if ($null -eq $oldDevUrl) { Remove-Item Env:VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue }
        else { $env:VITE_DEV_SERVER_URL = $oldDevUrl }
    }
}

try {
    Write-Phase "validate"
    $sourceRoot = Assert-SafeRoot $sourceRoot "canonical source"
    $deployRoot = Assert-SafeRoot $deployRoot "deploy mirror"
    $t3Home = Assert-SafeRoot $t3Home "D-backed T3 home"
    if (Test-SamePath $sourceRoot $deployRoot) {
        throw "Canonical source and deploy mirror resolve to the same path."
    }
    if (-not (Test-SamePath $sourceRoot "A:\Dev\Worktrees\t3code-workers-prototype") -or
        -not (Test-SamePath $deployRoot "A:\Dev\Worktrees\t3code-deploy")) {
        throw "Resolved repository paths do not match the approved T3 Code owners."
    }

    $requiredPaths = @(
        (Join-Path $sourceRoot "package.json"),
        (Join-Path $sourceRoot "pnpm-lock.yaml"),
        (Join-Path $sourceRoot "pnpm-workspace.yaml"),
        (Join-Path $sourceRoot "scripts\dev-runner.ts"),
        (Join-Path $sourceRoot "apps\desktop\package.json"),
        (Join-Path $sourceRoot "apps\desktop\scripts\start-electron.mjs"),
        (Join-Path $deployRoot "package.json"),
        (Join-Path $deployRoot "pnpm-lock.yaml"),
        (Join-Path $deployRoot "scripts\dev-runner.ts"),
        (Join-Path $t3Home "userdata")
    )
    foreach ($required in $requiredPaths) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "Required project/runtime path is missing: $required"
        }
    }

    $sourceTop = Normalize-AbsolutePath (Invoke-GitText $sourceRoot @("rev-parse", "--show-toplevel"))
    $deployTop = Normalize-AbsolutePath (Invoke-GitText $deployRoot @("rev-parse", "--show-toplevel"))
    if (-not (Test-SamePath $sourceTop $sourceRoot) -or -not (Test-SamePath $deployTop $deployRoot)) {
        throw "Git ownership does not match the approved source/deploy roots."
    }
    $sourceBranch = Invoke-GitText $sourceRoot @("branch", "--show-current")
    if ($sourceBranch -ne $expectedBranch) {
        throw "Source branch is '$sourceBranch', expected '$expectedBranch'."
    }
    $deployBranch = & git -C $deployRoot symbolic-ref --quiet --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace(($deployBranch | Out-String))) {
        throw "Deploy mirror is attached to a branch. It must remain detached."
    }
    $sourceCommit = Invoke-GitText $sourceRoot @("rev-parse", "HEAD")
    $deployCommitBefore = Invoke-GitText $deployRoot @("rev-parse", "HEAD")
    Write-Host "  source $sourceBranch $sourceCommit"
    Write-Host "  deploy detached $deployCommitBefore"

    $sourcePackage = Get-Content -LiteralPath (Join-Path $sourceRoot "package.json") -Raw | ConvertFrom-Json
    $desktopCommand = [string]$sourcePackage.scripts.'dev:desktop'
    if ($desktopCommand -ne "node scripts/dev-runner.ts dev:desktop") {
        throw "The documented dev:desktop launcher changed unexpectedly: $desktopCommand"
    }

    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
        throw "Official isolated Node 24.19.0 is missing: $nodePath"
    }
    $nodeVersion = (& $nodePath --version 2>$null | Select-Object -First 1).Trim()
    if ($nodeVersion -ne "v24.19.0") {
        throw "Official Node path reports '$nodeVersion', expected v24.19.0."
    }
    $vpPath = Join-Path $deployRoot "node_modules\.bin\vp.ps1"
    if (-not (Test-Path -LiteralPath $vpPath -PathType Leaf)) {
        throw "Deploy-local vp shim is missing: $vpPath"
    }
    $oldPathForVersion = $env:Path
    try {
        $env:Path = "$([System.IO.Path]::GetDirectoryName($nodePath));$oldPathForVersion"
        $vpVersion = (& $vpPath --version 2>$null | Select-Object -First 1).Trim()
    }
    finally {
        $env:Path = $oldPathForVersion
    }
    if ($vpVersion -notmatch '^vp v\d+\.\d+\.\d+') {
        throw "Resolved vp did not report a recognized version: $vpVersion"
    }
    Write-Host "  toolchain Node $nodeVersion, $vpVersion"

    Write-Phase "inspect"
    $sourceFiles = @(Get-IncludedFiles $sourceRoot)
    $deployFiles = @(Get-IncludedFiles $deployRoot)
    $sourceMap = Get-FingerprintMap $sourceRoot $sourceFiles
    $deployMap = Get-FingerprintMap $deployRoot $deployFiles
    $sourceRelatives = @{}
    foreach ($file in $sourceFiles) {
        $sourceRelatives[$file.Relative.ToLowerInvariant()] = $file
    }
    $deployOnlyFiles = @($deployFiles | Where-Object {
        -not $sourceRelatives.ContainsKey($_.Relative.ToLowerInvariant())
    })
    if ($deployOnlyFiles.Count -gt 0) {
        Write-Host "  preserving $($deployOnlyFiles.Count) deploy-only files absent from source"
    }
    $mismatches = New-Object 'System.Collections.Generic.List[object]'
    foreach ($file in $sourceFiles) {
        $key = $file.Relative.ToLowerInvariant()
        if (-not $deployMap.ContainsKey($key) -or $deployMap[$key] -ne $sourceMap[$key]) {
            [void]$mismatches.Add($file)
        }
    }
    $dependencyRelatives = @(Get-DependencyRelativePaths $sourceFiles)
    $dependencyProbePaths = @(
        "apps\web\node_modules\@vitejs\plugin-react\package.json",
        "apps\web\node_modules\@rolldown\plugin-babel\package.json",
        "apps\web\node_modules\@tanstack\router-plugin\package.json",
        "apps\web\node_modules\compression\package.json",
        "node_modules\vite-plus\package.json"
    ) | ForEach-Object { Join-Path $deployRoot $_ }
    $missingDependencyProbes = @($dependencyProbePaths | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
    $dependencyNeedsInstall =
        -not (Test-Path -LiteralPath (Join-Path $deployRoot "node_modules\.modules.yaml")) -or
        $missingDependencyProbes.Count -gt 0
    foreach ($relative in $dependencyRelatives) {
        if (-not $deployMap.ContainsKey($relative) -or $deployMap[$relative] -ne $sourceMap[$relative]) {
            $dependencyNeedsInstall = $true
        }
    }
    Write-Host "  source projection files $($sourceFiles.Count), deploy mismatches $($mismatches.Count)"
    if ($missingDependencyProbes.Count -gt 0) {
        Write-Host "  missing dependency links $($missingDependencyProbes.Count)"
    }
    Write-Host "  dependency state $(if ($dependencyNeedsInstall) { 'requires vp i' } else { 'matches lock/manifests' })"

    Write-Phase "sync"
    [void](Sync-TrackedSourceFiles $sourceRoot $deployRoot -PlanOnly:$planOnly)

    $verificationDir = Join-Path $t3Home "userdata\verification"
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $transcriptPath = Join-Path $verificationDir "launch-t3-code-$stamp.transcript.log"
    $commandLogPath = Join-Path $verificationDir "launch-t3-code-$stamp.commands.log"
    $desktopStdOutPath = Join-Path $verificationDir "launch-t3-code-$stamp.desktop.stdout.log"
    $desktopStdErrPath = Join-Path $verificationDir "launch-t3-code-$stamp.desktop.stderr.log"
    $electronStdOutPath = Join-Path $verificationDir "launch-t3-code-$stamp.electron.stdout.log"
    $electronStdErrPath = Join-Path $verificationDir "launch-t3-code-$stamp.electron.stderr.log"
    Write-Host "  transcript $transcriptPath"
    if (-not $planOnly) {
        New-Item -ItemType Directory -Path $verificationDir -Force | Out-Null
        Start-Transcript -LiteralPath $transcriptPath -Force | Out-Null
        $transcriptStarted = $true
    }

    Write-Phase "dependencies"
    if ($dependencyNeedsInstall) {
        # Install the exact source lockfile without resolving or rewriting versions.
        $oldNpmConfigLockfile = $env:npm_config_lockfile
        try {
            $env:npm_config_lockfile = "true"
            Invoke-ProjectCommand "vp i --frozen-lockfile" @("i", "--frozen-lockfile") $commandLogPath
        }
        finally {
            if ($null -eq $oldNpmConfigLockfile) {
                Remove-Item Env:npm_config_lockfile -ErrorAction SilentlyContinue
            }
            else {
                $env:npm_config_lockfile = $oldNpmConfigLockfile
            }
        }
    }
    else {
        Write-Plan "Dependency state is current. Skipping vp i."
    }

    Write-Phase "final sync"
    [void](Sync-TrackedSourceFiles $sourceRoot $deployRoot -PlanOnly:$planOnly)

    Write-Phase "checks and builds"
    if ($Fast -or $SkipBuild) {
        Write-Plan "Fast readiness mode selected. Skipping full contract/server/web/desktop checks and builds."
    }
    else {
        Invoke-ProjectCommand "contracts typecheck" @("run", "--filter", "@t3tools/contracts", "typecheck") $commandLogPath
        Invoke-ProjectCommand "server typecheck" @("run", "--filter", "t3", "typecheck") $commandLogPath
        Invoke-ProjectCommand "web typecheck" @("run", "--filter", "@t3tools/web", "typecheck") $commandLogPath
        Invoke-ProjectCommand "desktop typecheck" @("run", "--filter", "@t3tools/desktop", "typecheck") $commandLogPath
        Invoke-ProjectCommand "web build" @("build", "--logLevel", "error") $commandLogPath (Join-Path $deployRoot "apps\web")
        Invoke-ProjectCommand "server bundle" @("pack", "--logLevel", "error") $commandLogPath (Join-Path $deployRoot "apps\server")
        Invoke-ProjectCommand "server service-launcher bundle" @("pack", "src/service-launcher.ts", "--out-dir", "dist", "--no-clean", "--logLevel", "error") $commandLogPath (Join-Path $deployRoot "apps\server")
        Invoke-ProjectCommand "desktop bundle" @("pack", "--logLevel", "error") $commandLogPath (Join-Path $deployRoot "apps\desktop")
        Invoke-ProjectCommand "desktop Electron runtime" @("run", "--filter", "@t3tools/desktop", "ensure:electron") $commandLogPath
    }

    Write-Phase "tailscale"
    $tailscaleCommands = @(Get-Command tailscale.exe -All -ErrorAction SilentlyContinue)
    if ($tailscaleCommands.Count -ne 1) {
        throw "Expected exactly one tailscale.exe command, found $($tailscaleCommands.Count)."
    }
    $tailscalePath = $tailscaleCommands[0].Source
    $tailscaleStatus = Read-TailscaleJson @("status", "--json")
    $dnsName = ([string]$tailscaleStatus.Self.DNSName).Trim().TrimEnd('.')
    if ([string]::IsNullOrWhiteSpace($dnsName)) {
        throw "Tailscale is running without a MagicDNS identity."
    }
    $serveStatus = Read-TailscaleJson @("serve", "status", "--json")
    $existingProxy = Get-TailscaleProxy $serveStatus $tailnetServePort
    if ($null -eq $existingProxy) {
        Write-Plan "Tailscale HTTPS $tailnetServePort has no mapping."
        $needsTailscaleServe = $true
    }
    if ($null -ne $existingProxy -and $existingProxy -ne $expectedTailnetProxy) {
        throw "Tailscale HTTPS $tailnetServePort points to '$existingProxy', not $expectedTailnetProxy. Refusing to replace unrelated Serve config."
    }
    $tailnetUrl = "https://$dnsName`:$tailnetServePort/"
    Write-Host "  MagicDNS $dnsName"
    Write-Host "  HTTPS $tailnetUrl -> $expectedTailnetProxy"

    if (-not $PrepareOnly) {
    Write-Phase "desktop"
    Stop-ManagedDesktop $t3Home
    $desktopProcess = Start-ManagedDesktop $t3Home $desktopStdOutPath $desktopStdErrPath
    if ($null -ne $desktopProcess) {
        $startedRootPids += [int]$desktopProcess.Id
    }

    if (-not $planOnly) {
        if ($needsTailscaleServe) {
            & $tailscalePath serve --bg "--https=$tailnetServePort" $expectedTailnetProxy *> $null
            if ($LASTEXITCODE -ne 0) {
                throw "Could not create the missing Tailscale HTTPS mapping on port $tailnetServePort."
            }
            $serveStatus = Read-TailscaleJson @("serve", "status", "--json")
            $existingProxy = Get-TailscaleProxy $serveStatus $tailnetServePort
            if ($existingProxy -ne $expectedTailnetProxy) {
                throw "Tailscale HTTPS $tailnetServePort did not resolve to $expectedTailnetProxy after setup."
            }
        }
        Wait-Until -TimeoutSeconds $WaitSeconds -Description "T3 web app on 127.0.0.1:$webPort" -Condition {
            Test-HttpEndpoint "http://127.0.0.1:$webPort/"
        }
        $electronProcess = Start-ManagedElectron $electronStdOutPath $electronStdErrPath
        if ($null -ne $electronProcess) {
            $startedRootPids += [int]$electronProcess.Id
        }
        Wait-Until -TimeoutSeconds 30 -Description "exactly one managed Electron root" -Condition {
            $electronRoots = @(Get-ManagedElectronRoots)
            if ($electronRoots.Count -gt 1) {
                throw "More than one managed Electron root appeared after launch."
            }
            return $electronRoots.Count -eq 1
        }
        Wait-Until -TimeoutSeconds $WaitSeconds -Description "the Electron-owned authenticated T3 server root" -Condition {
            $roots = @(Get-ManagedDesktopRoots $t3Home)
            if ($roots.Count -gt 1) {
                throw "More than one managed desktop server root appeared after Electron launch."
            }
            return $roots.Count -eq 1
        }
        Wait-Until -TimeoutSeconds $WaitSeconds -Description "T3 server on 127.0.0.1:$serverPort" -Condition {
            Test-HttpEndpoint "http://127.0.0.1:$serverPort/.well-known/t3/environment"
        }
        Wait-Until -TimeoutSeconds $WaitSeconds -Description "the authenticated environment session transport" -Condition {
            Test-EnvironmentTransport "http://127.0.0.1:$serverPort"
        }
        Write-Host "  environment transport/auth session probe passed"
        if ($null -eq $existingProxy) {
            throw "Tailscale mapping was not available after the planned no-write dry path."
        }
        Wait-Until -TimeoutSeconds $WaitSeconds -Description "Tailscale HTTPS health at $tailnetUrl" -Condition {
            Test-HttpEndpoint "${tailnetUrl}.well-known/t3/environment"
        }
        $finalRoots = @(Get-ManagedDesktopRoots $t3Home)
        if ($finalRoots.Count -ne 1) {
            throw "Final managed desktop root count is $($finalRoots.Count), expected exactly one."
        }
        $finalRootCommand = Get-ProcessCommandLine $finalRoots[0]
        Write-Host "  root PID $($finalRoots[0].ProcessId) validated"
        Write-Host "  root command $finalRootCommand"
        $finalElectronRoots = @(Get-ManagedElectronRoots)
        if ($finalElectronRoots.Count -ne 1) {
            throw "Final managed Electron root count is $($finalElectronRoots.Count), expected exactly one."
        }
        Write-Host "  Electron PID $($finalElectronRoots[0].ProcessId) validated"
        Write-Host "  Electron command $(Get-ProcessCommandLine $finalElectronRoots[0])"
    }

    }

    $finalSourceFiles = @(Get-IncludedFiles $sourceRoot)
    $finalDeployFiles = @(Get-IncludedFiles $deployRoot)
    $finalSourceMap = Get-FingerprintMap $sourceRoot $finalSourceFiles
    $finalDeployMap = Get-FingerprintMap $deployRoot $finalDeployFiles
    $finalParity = 0
    foreach ($file in $finalSourceFiles) {
        $key = $file.Relative.ToLowerInvariant()
        if (-not $finalDeployMap.ContainsKey($key) -or $finalDeployMap[$key] -ne $finalSourceMap[$key]) {
            $finalParity++
        }
    }
    if ($planOnly) {
        Write-Phase "dry run summary"
        Write-Host "  no files, processes, dependencies, builds, or Tailscale settings changed"
        Write-Host "  source commit $sourceCommit"
        Write-Host "  deploy detached commit $deployCommitBefore"
        Write-Host "  planned projection mismatches $($mismatches.Count)"
        Write-Host "  planned endpoints http://127.0.0.1:$serverPort, http://127.0.0.1:$webPort, $tailnetUrl"
        Write-Host "  readiness not probed because this was a no-write run"
    }
    else {
        $deployCommitAfter = Invoke-GitText $deployRoot @("rev-parse", "HEAD")
        if ($deployCommitAfter -ne $deployCommitBefore) {
            throw "Deploy detached commit changed unexpectedly from $deployCommitBefore to $deployCommitAfter."
        }
        if ($finalParity -ne 0) {
            throw "Source/deploy parity check found $finalParity mismatched files after sync."
        }
        if ($PrepareOnly) { Write-Phase "prepared" }
        else { Write-Phase "ready" }
        Write-Host "  source commit $sourceCommit"
        Write-Host "  deploy detached commit $deployCommitAfter"
        Write-Host "  projection parity exact, excluded state preserved"
        if ($PrepareOnly) {
            Write-Host "  code and bundles prepared; running processes and Tailscale settings unchanged"
            Write-Host "  restart and verify the existing service owner separately"
        }
        else {
            Write-Host "  process exactly one managed desktop root"
            Write-Host "  endpoints http://127.0.0.1:$serverPort, http://127.0.0.1:$webPort, $tailnetUrl"
            Write-Host "  server/web/Tailscale readiness passed"
        }
        Write-Host "  logs $transcriptPath"
        Write-Host "  command output $commandLogPath"
    }
}
catch {
    $failure = $_
    Write-Host ("  failure at " + $failure.InvocationInfo.PositionMessage)
    Write-Host ("  stack " + $failure.ScriptStackTrace)
    Write-Error ("launch-t3-code.ps1 FAILED: " + $failure.Exception.Message) -ErrorAction Continue
    if (-not $planOnly) {
        foreach ($startedRootPid in $startedRootPids) {
            try {
                & taskkill.exe /PID ([string]$startedRootPid) /T /F *> $null
            }
            catch {
                Write-Host "  cleanup could not stop captured root PID $startedRootPid"
            }
        }
    }
    if ($transcriptStarted) {
        try { Stop-Transcript | Out-Null } catch { }
    }
    exit 1
}
finally {
    if ($transcriptStarted) {
        try { Stop-Transcript | Out-Null } catch { }
    }
}
