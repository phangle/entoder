# Changelog

All notable changes to Entoder will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2025-10-27

### Added
- Download progress indicators in installation scripts
  - Unix/Linux/macOS: Shows progress bar during binary download (curl/wget)
  - Windows: Shows PowerShell progress bar during download
  - Better user feedback during installation process
  - Added error handling for failed downloads

### Fixed
- **Critical**: Replaced native `sharp` module with ffmpeg for image processing
  - Fixes "Could not load the sharp module using the win32-x64 runtime" error on Windows
  - Uses ffmpeg for both image and video thumbnail generation
  - Compiled binaries now work on Windows without native module errors
  - Pure JPEG header parsing for thumbnail dimensions (no dependencies)

### Changed
- Installation scripts now display download progress in real-time
- Improved user experience with visual feedback during binary downloads
- Removed `sharp` dependency (replaced with ffmpeg)

## [0.1.2] - 2025-10-27

### Fixed
- **Critical**: Replaced native `argon2` module with pure JavaScript implementation (`@noble/hashes/argon2.js`)
  - Fixes "No native build was found" error when running compiled binaries
  - Compiled binaries now work properly on all platforms
- Fixed installation script output redirection
  - `print_message` now outputs to stderr to prevent pollution of function return values
  - Fixes "mv: rename ...📥 Downloading... No such file or directory" error
- Removed debug echo statements from install.sh

### Changed
- Removed `argon2` dependency (replaced with `@noble/hashes/argon2.js`)
- GitHub Actions workflow now reads version from `package.json` and attaches binaries to correct semantic version releases

## [0.1.1] - 2025-10-27

### Fixed
- Updated all repository URLs from `ente_loader` to `entoder` for consistency
- Fixed installation script URLs in README and documentation
- Fixed release download URLs to point to correct repository
- Fixed issue tracker links in documentation

## [0.1.0] - 2025-10-27

### Added
- Initial public release of Entoder
- Photo and video upload functionality to Ente Photos server
- Automatic album creation based on folder structure
- Smart duplicate detection and skipping
- Resume capability for interrupted uploads
- Efficient handling of large photo collections with concurrent uploads
- End-to-end encryption support
- Progress tracking with detailed statistics
- Verify command to detect and remove duplicate photos
- Cross-platform support (macOS, Windows, Linux, ARM)
- One-line installation scripts for all platforms
- Pre-built binaries for major platforms
- Comprehensive documentation and quick-start guides
- GitHub Actions workflow for automated releases
- Local state management with SQLite database
- Memory management controls
- Dry-run mode for upload preview
- Debug logging support

### Features
- **Upload Command**: Upload photos from single or multiple directories
- **Verify Command**: Detect and optionally remove duplicate photos
- **Authentication**: Secure login with session management (7-day persistence)
- **Metadata Preservation**: EXIF data extraction and preservation
- **Thumbnail Generation**: Automatic thumbnail creation for uploads
- **S3 Upload**: Multi-part upload support for large files
- **Progress Tracking**: Real-time statistics on uploads, duplicates, and failures
- **Concurrency Control**: Configurable parallel upload streams
- **Collection Management**: Automatic album organization

[0.1.3]: https://github.com/phangle/entoder/releases/tag/v0.1.3
[0.1.2]: https://github.com/phangle/entoder/releases/tag/v0.1.2
[0.1.1]: https://github.com/phangle/entoder/releases/tag/v0.1.1
[0.1.0]: https://github.com/phangle/entoder/releases/tag/v0.1.0
