# How to Install

Simple installation instructions for Entoder (Ente Photo Loader).

## Easy Install

Just copy and paste one of these commands into your terminal:

### Mac or Linux

```bash
curl -fsSL https://raw.githubusercontent.com/phangle/entoder/main/scripts/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/phangle/entoder/main/scripts/install.ps1 | iex
```

## What the Installer Does

1. Figures out what type of computer you have
2. Downloads the right version
3. Puts it in the right place
4. Makes it ready to use

## Supported Computers

- **Mac**: Both M1/M2 (Apple Silicon) and Intel Macs
- **Windows**: Windows 10 or newer
- **Linux**: Most versions including Ubuntu, Debian, Fedora, etc.

## Where It Installs

### Mac / Linux

- Goes to: `$HOME/.local/bin`
- You can change it by setting `INSTALL_DIR` first

### Windows

- Goes to: `%LOCALAPPDATA%\Programs\entoder`
- You can change it by setting `ENTE_INSTALL_DIR` first

## Having Trouble?

**"Command not found" error:**

- Restart your terminal or command prompt
- On Mac/Linux, you might need to add the install location to your PATH

**"Permission denied" error:**

- On Mac/Linux, you might need to make the installer executable
- On Windows, try running PowerShell as Administrator

**Installer doesn't work:**

- Download the file manually from: https://github.com/phangle/entoder/releases/latest
- Pick the file that matches your computer
- Put it somewhere you can find it

## Want to Check the Script First?

It's always smart to look at scripts before running them!

### Mac/Linux

```bash
curl -fsSL https://raw.githubusercontent.com/phangle/entoder/main/scripts/install.sh -o install.sh
cat install.sh  # Look at what it does
bash install.sh  # Run it
```

### Windows

```powershell
irm https://raw.githubusercontent.com/phangle/entoder/main/scripts/install.ps1 -OutFile install.ps1
notepad install.ps1  # Look at what it does
.\install.ps1  # Run it
```
