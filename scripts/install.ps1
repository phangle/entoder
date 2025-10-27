# Entoder (Ente Photo Loader) - Installation Script for Windows
# Usage: irm https://raw.githubusercontent.com/phangle/entoder/main/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"

# Configuration
$Repo = "phangle/entoder"
$BinaryName = "entoder"
$InstallDir = if ($env:ENTE_INSTALL_DIR) { $env:ENTE_INSTALL_DIR } else { "$env:LOCALAPPDATA\Programs\entoder" }

# Colors for output
function Write-ColorOutput {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host $Message -ForegroundColor $Color
}

# Detect architecture
function Get-Architecture {
    $arch = $env:PROCESSOR_ARCHITECTURE
    switch ($arch) {
        "AMD64" { return "x64" }
        "ARM64" { return "arm64" }
        default {
            Write-ColorOutput "❌ Unsupported architecture: $arch" -Color Red
            exit 1
        }
    }
}

# Get latest release from GitHub
function Get-LatestRelease {
    $releaseUrl = "https://api.github.com/repos/$Repo/releases/latest"

    try {
        $response = Invoke-RestMethod -Uri $releaseUrl -ErrorAction Stop
        return $response
    }
    catch {
        Write-ColorOutput "❌ Failed to fetch release information: $_" -Color Red
        exit 1
    }
}

# Download binary
function Download-Binary {
    param(
        [string]$Url,
        [string]$OutputPath
    )

    Write-ColorOutput "📥 Downloading $BinaryName..." -Color Yellow

    try {
        # Use TLS 1.2
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

        # Use Invoke-WebRequest with progress bar (default in PS)
        $ProgressPreference = 'Continue'  # Ensure progress is shown
        Invoke-WebRequest -Uri $Url -OutFile $OutputPath -UseBasicParsing

        Write-ColorOutput "✅ Download complete!" -Color Green
        return $true
    }
    catch {
        Write-ColorOutput "❌ Download failed: $_" -Color Red
        return $false
    }
}

# Add to PATH
function Add-ToPath {
    param([string]$Directory)

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")

    if ($userPath -notlike "*$Directory*") {
        Write-ColorOutput "📝 Adding $Directory to PATH..." -Color Yellow
        $newPath = "$Directory;$userPath"
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")

        # Update current session PATH
        $env:Path = "$Directory;$env:Path"

        Write-ColorOutput "✅ Added to PATH. Restart your terminal to use '$BinaryName' from anywhere." -Color Green
        return $true
    }

    return $false
}

# Main installation
function Install-EnteLoader {
    Write-ColorOutput "🚀 Installing Entoder (Ente Photo Loader)..." -Color Green
    Write-Host ""

    # Detect architecture
    $arch = Get-Architecture
    Write-ColorOutput "📍 Detected architecture: $arch" -Color Yellow

    # Get latest release
    Write-ColorOutput "🔍 Fetching latest release..." -Color Yellow
    $release = Get-LatestRelease

    if (-not $release) {
        Write-ColorOutput "❌ Failed to fetch release information" -Color Red
        exit 1
    }

    # Find the Windows binary
    $binaryFileName = "entoder-windows-$arch.exe"
    $asset = $release.assets | Where-Object { $_.name -eq $binaryFileName } | Select-Object -First 1

    if (-not $asset) {
        Write-ColorOutput "❌ No binary found for Windows $arch" -Color Red
        Write-ColorOutput "Available platforms: Windows (x64)" -Color Yellow
        exit 1
    }

    $downloadUrl = $asset.browser_download_url

    # Create install directory
    if (-not (Test-Path $InstallDir)) {
        Write-ColorOutput "📁 Creating installation directory: $InstallDir" -Color Yellow
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    # Download binary
    $tempFile = "$env:TEMP\$binaryFileName"
    $success = Download-Binary -Url $downloadUrl -OutputPath $tempFile

    if (-not $success) {
        exit 1
    }

    # Install binary
    $installPath = Join-Path $InstallDir "$BinaryName.exe"
    Write-ColorOutput "📦 Installing to $installPath..." -Color Yellow

    # Remove existing binary if it exists
    if (Test-Path $installPath) {
        Remove-Item $installPath -Force
    }

    Move-Item $tempFile $installPath -Force

    # Add to PATH
    $pathAdded = Add-To-Path -Directory $InstallDir

    # Verify installation
    if (Test-Path $installPath) {
        Write-Host ""
        Write-ColorOutput "✅ Successfully installed Entoder (Ente Photo Loader)!" -Color Green
        Write-Host ""
        Write-ColorOutput "📍 Installed at: $installPath" -Color Green
        Write-Host ""

        if ($pathAdded) {
            Write-ColorOutput "⚠️  Please restart your terminal or PowerShell session" -Color Yellow
            Write-ColorOutput "   Then you can run: $BinaryName upload C:\path\to\photos" -Color Yellow
        }
        else {
            Write-ColorOutput "🎉 Get started:" -Color Yellow
            Write-Host "  $BinaryName upload C:\path\to\photos"
        }

        Write-Host ""
        Write-ColorOutput "📚 For more information:" -Color Yellow
        Write-Host "  $BinaryName --help"
        Write-Host "  https://github.com/$Repo"
    }
    else {
        Write-ColorOutput "❌ Installation failed" -Color Red
        exit 1
    }
}

# Run installation
try {
    Install-EnteLoader
}
catch {
    Write-ColorOutput "❌ Installation failed: $_" -Color Red
    exit 1
}
