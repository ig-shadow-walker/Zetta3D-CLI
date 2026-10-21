# Zetta 3D CLI installer for Windows.
#
#   irm https://zetta3d.ai/install.ps1 | iex
#
# Installs the single self-contained zetta.exe into %LOCALAPPDATA%\zetta\bin (no admin rights,
# nothing else needed) and adds that folder to your user PATH. Running it again upgrades in place.
# Works in Windows PowerShell 5.1 and PowerShell 7+.
#
# Environment overrides (set them first, e.g. $env:ZETTA_VERSION = '1.2.3'):
#   ZETTA_VERSION          install this version instead of the latest
#   ZETTA_INSTALL_DIR      install into this folder instead of %LOCALAPPDATA%\zetta\bin
#   ZETTA_DOWNLOAD_BASE    download host (default https://downloads.zetta3d.ai/cli)
#   ZETTA_NO_MODIFY_PATH=1 do not change the user PATH
#
# Everything is inside a script block that runs on the last line, so a partly downloaded script
# does nothing, and no variables or preferences leak into your session.

& {
    $DefaultBase = 'https://downloads.zetta3d.ai/cli'

    # Scoped to this block: hide the slow progress bar of Invoke-WebRequest in Windows PowerShell.
    $ProgressPreference = 'SilentlyContinue'

    $Interactive = -not [Console]::IsOutputRedirected
    $UseColor = $Interactive -and -not $env:NO_COLOR

    function Write-Step([string]$Message) {
        if ($Interactive) {
            if ($UseColor) { Write-Host $Message -ForegroundColor DarkGray } else { Write-Host $Message }
        }
    }

    function Write-Line([string]$Message, [string]$Color) {
        if ($UseColor -and $Color) { Write-Host $Message -ForegroundColor $Color } else { Write-Host $Message }
    }

    function Fail([string]$Message) {
        throw [System.Exception]::new($Message)
    }

    function Get-Arch {
        $arch = $null
        try { $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { }
        if (-not $arch) {
            $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        }
        switch -Regex ($arch) {
            '^(X64|AMD64)$' { return 'x64' }
            '^(Arm64|ARM64)$' { return 'arm64' }
            default { Fail "zetta does not support the $arch CPU architecture. It runs on 64-bit Windows (x64 or Arm64)." }
        }
    }

    function Test-Avx2 {
        # PF_AVX2_INSTRUCTIONS_AVAILABLE = 40. If the check itself fails, assume a modern CPU.
        try {
            $k32 = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int f);' `
                -Name 'ZettaCpu' -Namespace 'ZettaInstall' -PassThru -ErrorAction Stop
            return [bool]$k32::IsProcessorFeaturePresent(40)
        } catch {
            return $true
        }
    }

    function Get-Download([string]$Url, [string]$OutFile) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -ErrorAction Stop
        } catch {
            $failure = $_
            $status = $null
            try { $status = [int]$failure.Exception.Response.StatusCode } catch { }
            if ($status -eq 404) { return 404 }
            Fail "could not download $Url ($($failure.Exception.Message)). Check your internet connection (and ZETTA_DOWNLOAD_BASE, if you set it)."
        }
        return 200
    }

    function Test-SamePath([string]$A, [string]$B) {
        $x = [Environment]::ExpandEnvironmentVariables($A).TrimEnd('\')
        $y = [Environment]::ExpandEnvironmentVariables($B).TrimEnd('\')
        return [string]::Equals($x, $y, [StringComparison]::OrdinalIgnoreCase)
    }

    function Add-ToUserPath([string]$Dir) {
        # Edit the registry value directly so entries like %USERPROFILE%\bin stay unexpanded.
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
        try {
            $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $parts = @($current -split ';' | Where-Object { $_ })
            if ($parts | Where-Object { Test-SamePath $_ $Dir }) { return $false }
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
            if ($current) {
                try { $kind = $key.GetValueKind('Path') } catch { }
            }
            $key.SetValue('Path', ((@($Dir) + $parts) -join ';'), $kind)
        } finally {
            $key.Close()
        }
        # Tell Explorer and new terminals that the environment changed (SetEnvironmentVariable
        # broadcasts WM_SETTINGCHANGE).
        [Environment]::SetEnvironmentVariable('ZETTA_INSTALL_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('ZETTA_INSTALL_REFRESH', $null, 'User')
        return $true
    }

    function Install-Zetta {
        if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
            Fail "this is the Windows installer. On macOS or Linux run: curl -fsSL https://zetta3d.ai/install.sh | sh"
        }
        # Windows PowerShell 5.1 may default to old TLS versions.
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        } catch { }

        $arch = Get-Arch
        $key = "windows-$arch"
        $baseline = ($arch -eq 'x64') -and -not (Test-Avx2)

        $base = if ($env:ZETTA_DOWNLOAD_BASE) { $env:ZETTA_DOWNLOAD_BASE.Trim() } else { $DefaultBase }
        $base = $base.TrimEnd('/')

        if ($env:ZETTA_INSTALL_DIR) {
            $dir = $env:ZETTA_INSTALL_DIR
        } else {
            $local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
            $dir = Join-Path $local 'zetta\bin'
        }
        try {
            $dir = (New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop).FullName
        } catch {
            Fail "cannot create $dir. Set ZETTA_INSTALL_DIR to a folder you can write to."
        }
        $exe = Join-Path $dir 'zetta.exe'

        # Scratch space next to the exe, so the final rename stays on one volume.
        $work = Join-Path $dir ".zetta-install-$PID"
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
        New-Item -ItemType Directory -Path $work -Force | Out-Null
        try {
            if ($env:ZETTA_VERSION) {
                $version = $env:ZETTA_VERSION.Trim() -replace '^v', ''
            } else {
                Write-Step 'Finding the latest zetta release...'
                $latestFile = Join-Path $work 'latest.json'
                if ((Get-Download "$base/latest.json" $latestFile) -eq 404) { Fail "$base/latest.json was not found." }
                try {
                    $version = [string](Get-Content -LiteralPath $latestFile -Raw | ConvertFrom-Json).version
                } catch {
                    Fail "$base/latest.json is not valid JSON."
                }
                if (-not $version) { Fail "$base/latest.json does not name a version." }
            }
            if ($version -notmatch '^[0-9A-Za-z.+-]+$') { Fail "'$version' is not a valid zetta version." }

            $sumsFile = Join-Path $work 'SHA256SUMS'
            if ((Get-Download "$base/v$version/SHA256SUMS" $sumsFile) -eq 404) { Fail "zetta $version was not found on $base." }
            $sums = @{}
            foreach ($line in Get-Content -LiteralPath $sumsFile) {
                if ($line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$') { $sums[$Matches[2]] = $Matches[1].ToLowerInvariant() }
            }

            # Pick the build: native first, then one that still runs here.
            $candidates = @()
            if ($baseline) { $candidates += "zetta-$key-baseline.exe" } else { $candidates += "zetta-$key.exe" }
            if ($arch -eq 'arm64') { $candidates += 'zetta-windows-x64.exe' }  # runs under x64 emulation
            $name = $candidates | Where-Object { $sums.ContainsKey($_) } | Select-Object -First 1
            if (-not $name) {
                if ($baseline) { Fail "zetta $version has no build for this CPU (an x64 processor without AVX2)." }
                Fail "zetta $version has no build for $key."
            }

            Write-Step "Downloading zetta $version ($($name -replace '^zetta-|\.exe$', ''))..."
            $tmp = Join-Path $work 'zetta.exe'
            $gzName = "$name.gz"
            if ($sums.ContainsKey($gzName)) {
                # The gzip copy is about half the size.
                $gzTmp = "$tmp.gz"
                if ((Get-Download "$base/v$version/$gzName" $gzTmp) -eq 404) { Fail "$base/v$version/$gzName was not found." }
                $gzActual = (Get-FileHash -LiteralPath $gzTmp -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($gzActual -ne $sums[$gzName]) {
                    Fail "checksum mismatch for $gzName (expected $($sums[$gzName]), got $gzActual). The download is corrupted or was tampered with. Nothing was installed."
                }
                $in = [System.IO.File]::OpenRead($gzTmp)
                try {
                    $gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
                    $out = [System.IO.File]::Create($tmp)
                    try { $gz.CopyTo($out) } finally { $out.Dispose(); $gz.Dispose() }
                } finally { $in.Dispose() }
                Remove-Item -LiteralPath $gzTmp -Force -ErrorAction SilentlyContinue
            } elseif ((Get-Download "$base/v$version/$name" $tmp) -eq 404) { Fail "$base/v$version/$name was not found." }

            $actual = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $sums[$name]) {
                Fail "checksum mismatch for $name (expected $($sums[$name]), got $actual). The download is corrupted or was tampered with. Nothing was installed."
            }
            Write-Step 'Checksum verified.'

            # Prove it runs here before replacing anything.
            $versionOut = ''
            try {
                $versionOut = (& $tmp --version 2>&1 | Out-String).Trim()
                $ran = ($LASTEXITCODE -eq 0)
            } catch {
                $versionOut = $_.Exception.Message
                $ran = $false
            }
            if (-not $ran) { Fail "the downloaded zetta does not run on this system ($key): $versionOut" }

            # A running zetta.exe cannot be overwritten, but it can be renamed out of the way.
            $existed = Test-Path -LiteralPath $exe
            $old = "$exe.old"
            if ($existed) {
                Remove-Item -LiteralPath $old -Force -ErrorAction Ignore
                if (Test-Path -LiteralPath $old) { $old = "$exe.$([DateTime]::UtcNow.Ticks).old" }
                Move-Item -LiteralPath $exe -Destination $old -Force
            }
            try {
                Move-Item -LiteralPath $tmp -Destination $exe -Force
            } catch {
                $failure = $_
                if ($existed) { Move-Item -LiteralPath $old -Destination $exe -Force }
                Fail "could not install to $exe ($($failure.Exception.Message))."
            }
            if ($existed) { Remove-Item -LiteralPath $old -Force -ErrorAction Ignore }
        } finally {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction Ignore
        }

        $pathAdded = $false
        if ($env:ZETTA_NO_MODIFY_PATH -ne '1') {
            $pathAdded = Add-ToUserPath $dir
            if ($env:GITHUB_PATH) { Add-Content -LiteralPath $env:GITHUB_PATH -Value $dir -ErrorAction Ignore }
            # This window too, so `zetta` works right away.
            if (-not (@($env:Path -split ';') | Where-Object { $_ -and (Test-SamePath $_ $dir) })) { $env:Path = "$dir;$env:Path" }
        }

        Write-Line ''
        $suffix = if ($existed) { ' (updated)' } else { '' }
        Write-Line "zetta $version is installed at $exe$suffix." 'Green'
        if ($pathAdded) {
            Write-Line "Added $dir to your user PATH. Other open terminals need a restart to see it."
        } elseif ($env:ZETTA_NO_MODIFY_PATH -eq '1') {
            Write-Line "$dir was not added to PATH (ZETTA_NO_MODIFY_PATH=1)."
        }
        Write-Line ''
        Write-Line 'Next: zetta auth login' 'Cyan'
    }

    try {
        Install-Zetta
    } catch {
        $msg = $_.Exception.Message
        if ($UseColor) { Write-Host "error: $msg" -ForegroundColor Red } else { [Console]::Error.WriteLine("error: $msg") }
        # Exit non-zero when PowerShell was started just to run this (powershell -Command / -File),
        # so scripts and agents see the failure; never close an interactive window.
        $cmdArgs = [Environment]::GetCommandLineArgs()
        $oneShot = ($cmdArgs | Where-Object { $_ -match '^[-/](c|command|f|file|e|ec|encodedcommand|noninteractive)$' }) -and
            -not ($cmdArgs | Where-Object { $_ -match '^[-/]noexit$' })
        if ($oneShot) { exit 1 }
    }
}
