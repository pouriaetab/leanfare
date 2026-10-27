# Leanfare's installer for Windows. It downloads leanfare.exe from the latest GitHub release, checks
# it against the release's checksums, puts it in %LOCALAPPDATA%\Leanfare\bin and adds that folder to
# your PATH. Nothing else is installed or changed. Windows builds are new: tell us what breaks.
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/pouriaetab/leanfare/main/install.ps1 | iex"
#
# $env:LEANFARE_VERSION = "v0.4.0" installs that release; $env:LEANFARE_INSTALL_DIR another folder.
# (No "exit" anywhere: run through iex, it would close your PowerShell window.)
function Install-Leanfare {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  $Repo = "pouriaetab/leanfare"
  $Version = if ($env:LEANFARE_VERSION) { $env:LEANFARE_VERSION } else { "latest" }
  $Dir = if ($env:LEANFARE_INSTALL_DIR) { $env:LEANFARE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Leanfare\bin" }
  if (-not [Environment]::Is64BitOperatingSystem) { throw "Leanfare needs 64-bit Windows." }
  $Name = "leanfare-windows-x64" # also runs on Windows on Arm, through Windows' own x64 emulation
  $Base = if ($env:LEANFARE_DOWNLOAD_BASE) { $env:LEANFARE_DOWNLOAD_BASE } elseif ($Version -eq "latest") { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("leanfare-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $Tmp | Out-Null
  $Exe = Join-Path $Dir "leanfare.exe"
  try {
    Write-Host "Downloading $Name ($Version)..."
    Invoke-WebRequest "$Base/$Name.zip" -OutFile (Join-Path $Tmp "$Name.zip") -UseBasicParsing
    Invoke-WebRequest "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS") -UseBasicParsing
    $Line = Get-Content (Join-Path $Tmp "SHA256SUMS") | Where-Object { $_ -match " $([regex]::Escape("$Name.zip"))$" } | Select-Object -First 1
    if (-not $Line) { throw "the release's checksums do not list $Name.zip." }
    $Want = ($Line -split " ")[0].ToLower()
    $Got = (Get-FileHash (Join-Path $Tmp "$Name.zip") -Algorithm SHA256).Hash.ToLower()
    if ($Got -ne $Want) { throw "the download does not match the release's checksum, so nothing was changed." }
    Expand-Archive (Join-Path $Tmp "$Name.zip") -DestinationPath (Join-Path $Tmp "x") -Force
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    if (Test-Path $Exe) { & $Exe stop *> $null } # a running Leanfare holds its file open
    Copy-Item (Join-Path $Tmp "x\leanfare.exe") $Exe -Force
  } finally {
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  $Installed = & $Exe --version
  if (-not $Installed) { throw "the downloaded Leanfare did not start on this computer." }
  Write-Host "Installed Leanfare $Installed in $Dir."
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (($UserPath -split ";") -contains $Dir)) {
    [Environment]::SetEnvironmentVariable("Path", (@($Dir) + ($UserPath -split ";" | Where-Object { $_ })) -join ";", "User")
    Write-Host "Added $Dir to your PATH. Open a new terminal window for the leanfare command to work there."
  }
  Write-Host ""
  Write-Host "Start it:            leanfare        (it opens http://127.0.0.1:4747 in your browser)"
  Write-Host "In your AI apps:     Leanfare, Settings, ""In your apps"": one press adds its tools to Claude Desktop, Cursor and others"
  Write-Host "Measure it first:    leanfare trial  (how well the models you tick answer, before Claude relies on them)"
}

try { Install-Leanfare } catch { Write-Host "Leanfare was not installed: $($_.Exception.Message)" -ForegroundColor Red }
