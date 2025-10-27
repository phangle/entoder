# Entoder - Entoder (Ente Photo Loader)

Upload your photos and videos to [Ente Photos](https://ente.io) quickly and easily. Works on Mac, Windows, and Linux.

## What It Does

- 📸 Uploads your photos and videos to Ente Photos
- 📁 Creates albums automatically from your folder names
- ⚡ Handles large photo collections efficiently
- 🔄 Resumes if interrupted
- 💾 Skips photos you've already uploaded
- 🔐 Keeps your files secure and encrypted

## Installation

**Easy Install (Copy and paste one command):**

**Mac or Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/phangle/entoder/main/scripts/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/phangle/entoder/main/scripts/install.ps1 | iex
```

That's it! The installer will:

- Download the right version for your computer
- Put it in the right place
- Make it ready to use

**Or Download Manually:**

Get the file for your system from [here](https://github.com/phangle/entoder/releases/latest):

- **Mac (Apple Silicon/M1/M2)**: Download `entoder-macos-arm64`
- **Mac (Intel)**: Download `entoder-macos-x64`
- **Windows**: Download `entoder-windows-x64.exe`
- **Linux (most common)**: Download `entoder-linux-x64`
- **Linux (Raspberry Pi/ARM)**: Download `entoder-linux-arm64`

## How to Use

### First Time Setup

1. Open your terminal (Mac/Linux) or PowerShell (Windows)

2. Run this command with your Ente email and password:

```bash
entoder upload /path/to/your/photos --email your@email.com --password yourpassword
```

Replace `/path/to/your/photos` with where your photos are stored, like:

- Mac: `~/Pictures`
- Windows: `C:\Users\YourName\Pictures`
- Linux: `~/Pictures`

### After First Time

Just run:

```bash
entoder upload /path/to/your/photos
```

It remembers your login for 7 days!

## Common Commands

**Upload photos from one folder:**

```bash
entoder upload ~/Pictures
```

**Upload from multiple folders:**

```bash
entoder upload ~/Pictures ~/Videos ~/Downloads
```

**See what would be uploaded (without actually uploading):**

```bash
entoder upload ~/Pictures --dry-run
```

**Upload faster (uses more of your computer):**

```bash
entoder upload ~/Pictures --concurrency 8
```

**Remove duplicate photos from Ente:**

```bash
entoder verify --fix --yes
```

[Learn more about removing duplicates →](docs/VERIFY-QUICK-START.md)

## What You'll See

While uploading, you'll see a progress line like:

```
📊 Unique: 500 | Total: 750/1000 | +25 | Dups: 250 | Failed: 0
```

This means:

- **Unique: 500** - You have 500 photos uploaded to Ente
- **Total: 750/1000** - Processing 750 out of 1,000 photos found
- **+25** - Just uploaded 25 photos
- **Dups: 250** - Skipped 250 duplicates
- **Failed: 0** - No errors

## Need Help?

**Photos not uploading?**

- Check your email and password are correct
- Make sure you have internet connection
- Try running with `--log-level debug` to see what's happening

**Taking too long?**

- Use `--concurrency 8` to speed up
- Close other programs using internet

**Using too much memory?**

- Use `--concurrency 2` to use less memory
- Use `--max-memory-mb 500` to limit memory use

**Want to start fresh?**
Delete the settings file:

- Mac/Linux: `rm -rf ~/.entoder/state.db`
- Windows: Delete `%USERPROFILE%\.entoder\state.db`

## Where to Get Help

- [Report bugs or ask questions](https://github.com/phangle/entoder/issues)
- [Ente Help Center](https://ente.io/help)

## Tips

💡 **Start small**: Try uploading one small folder first to make sure everything works

💡 **Organize first**: Organize your photos into folders before uploading - each folder becomes an album

💡 **Be patient**: Large photo libraries can take hours to upload (I've uploaded 1TB of files to local ente within 10 days), but you can close the terminal and restart later - it remembers what's been uploaded

💡 **Check Ente**: Open Ente Photos on your phone or computer to see your uploaded photos

---

Made with ❤️ for Ente Photos users
