#!/bin/bash
# Entoder (Ente Photo Loader) - Installation Script for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/phangle/entoder/main/scripts/install.sh | bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
REPO="phangle/entoder"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="entoder"

# Print colored message to stderr (so it doesn't interfere with function return values)
print_message() {
    local color=$1
    shift
    echo -e "${color}$@${NC}" >&2
}

# Detect OS and architecture
detect_platform() {
    local os=""
    local arch=""

    # Detect OS
    case "$(uname -s)" in
        Darwin*)
            os="macos"
            ;;
        Linux*)
            os="linux"
            ;;
        *)
            print_message "$RED" "❌ Unsupported operating system: $(uname -s)"
            exit 1
            ;;
    esac

    # Detect architecture
    case "$(uname -m)" in
        x86_64|amd64)
            arch="x64"
            ;;
        arm64|aarch64)
            arch="arm64"
            ;;
        *)
            print_message "$RED" "❌ Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac

    echo "${os}-${arch}"
}

# Get latest release info from GitHub
get_latest_release() {
    local release_url="https://api.github.com/repos/$REPO/releases/latest"

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$release_url"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- "$release_url"
    else
        print_message "$RED" "❌ Neither curl nor wget found. Please install one of them."
        exit 1
    fi
}

# Download binary
download_binary() {
    local platform=$1
    local download_url=$2
    local temp_file="/tmp/${BINARY_NAME}-${platform}"

    print_message "$YELLOW" "📥 Downloading ${BINARY_NAME} for ${platform}..."

    if command -v curl >/dev/null 2>&1; then
        # Use curl with progress bar (-#) instead of silent mode
        curl -fL --progress-bar -o "$temp_file" "$download_url" || {
            print_message "$RED" "❌ Download failed"
            exit 1
        }
    elif command -v wget >/dev/null 2>&1; then
        # Use wget with progress bar
        wget --show-progress -O "$temp_file" "$download_url" || {
            print_message "$RED" "❌ Download failed"
            exit 1
        }
    fi

    echo "$temp_file"
}

# Main installation
main() {
    print_message "$GREEN" "🚀 Installing Entoder (Ente Photo Loader)..."
    echo

    # Detect platform
    platform=$(detect_platform)
    print_message "$YELLOW" "📍 Detected platform: $platform"

    # Get latest release
    print_message "$YELLOW" "🔍 Fetching latest release..."
    release_data=$(get_latest_release)

    if [ -z "$release_data" ]; then
        print_message "$RED" "❌ Failed to fetch release information"
        exit 1
    fi

    # Extract download URL for the platform
    binary_name="${BINARY_NAME}-${platform}"
    download_url=$(echo "$release_data" | grep -o "\"browser_download_url\": *\"[^\"]*${binary_name}[^\"]*\"" | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')

    if [ -z "$download_url" ]; then
        print_message "$RED" "❌ No binary found for platform: $platform"
        print_message "$YELLOW" "Available platforms: macOS (x64, arm64), Linux (x64, arm64)"
        exit 1
    fi

    # Download binary
    temp_file=$(download_binary "$platform" "$download_url")

    # Create install directory if it doesn't exist
    if [ ! -d "$INSTALL_DIR" ]; then
        print_message "$YELLOW" "📁 Creating installation directory: $INSTALL_DIR"
        mkdir -p "$INSTALL_DIR"
    fi

    # Install binary
    install_path="$INSTALL_DIR/$BINARY_NAME"
    print_message "$YELLOW" "📦 Installing to $install_path..."
    mv "$temp_file" "$install_path"
    chmod +x "$install_path"

    # Check if install directory is in PATH
    if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        print_message "$YELLOW" "⚠️  $INSTALL_DIR is not in your PATH"
        echo
        print_message "$YELLOW" "Add it by running:"

        # Detect shell and provide appropriate instructions
        if [ -n "$BASH_VERSION" ]; then
            echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
            echo "  source ~/.bashrc"
        elif [ -n "$ZSH_VERSION" ]; then
            echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
            echo "  source ~/.zshrc"
        else
            echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        fi
        echo
    fi

    # Verify installation
    if [ -x "$install_path" ]; then
        version=$("$install_path" --version 2>/dev/null || echo "unknown")
        print_message "$GREEN" "✅ Successfully installed Entoder (Ente Photo Loader)!"
        echo
        print_message "$GREEN" "📍 Installed at: $install_path"
        echo
        print_message "$YELLOW" "🎉 Get started:"
        echo "  $BINARY_NAME upload /path/to/photos"
        echo
        print_message "$YELLOW" "📚 For more information:"
        echo "  $BINARY_NAME --help"
        echo "  https://github.com/$REPO"
    else
        print_message "$RED" "❌ Installation failed"
        exit 1
    fi
}

# Run main function
main "$@"
