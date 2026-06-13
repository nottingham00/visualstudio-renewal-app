# VS License Manager

A desktop GUI for automatically managing Visual Studio Community Edition licenses (2013–2019).

## Features
- View expiry status for all installed VS Community editions
- Renew individual or all licenses (resets to today + 31 days)
- Install/uninstall a Windows Scheduled Task for automatic daily renewal
- View and clear the renewal activity log
- Custom frameless dark UI with admin detection

---

## Build (Windows required for the .exe)

### Prerequisites
- Node.js 18+ (https://nodejs.org)
- Windows 10/11 (for building the Windows installer)
- Run terminal **as Administrator** (required for license registry access)

### Steps

```bash
# 1. Install dependencies
npm install

# 2a. Build installer (.exe NSIS installer)
npm run build

# 2b. Or just build the unpacked app folder (faster, no installer)
npm run build:dir
```

Output will be in the `dist/` folder.

---

## Run in dev mode (no build needed)

```bash
npm install
npm start
```

> **Note:** Must be run as Administrator for registry access.

---

## How it works

VS Community stores an encrypted license blob in the Windows registry under `HKCR\Licenses\<GUID>`.  
The app decrypts this blob using Windows DPAPI (`LocalMachine` scope), reads/writes the 6-byte expiry date at offset `[-16..-11]`, then re-encrypts and writes back.

Max extension is **31 days** — that's the limit VS Community enforces.

---

## Files

```
vs-license-manager/
├── src/
│   ├── main.js       ← Electron main process + PowerShell bridge
│   ├── preload.js    ← Secure IPC bridge (contextBridge)
│   └── index.html    ← Full UI (single HTML file)
├── scripts/
│   ├── AutoRenew-VS.ps1    ← Renewal worker (used by scheduler)
│   └── VSCELicense.psm1    ← Original PowerShell module
├── assets/
│   └── icon.png
└── package.json
```
