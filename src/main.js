const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { execFile, spawnSync } = require('child_process');
const fs = require('fs');

// ── Paths ─────────────────────────────────────────────────────────────────────
function getScriptsPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, '..', 'scripts');
}
function getLogPath() {
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'VSCELicense', 'renew.log');
}

// ── PowerShell runner ─────────────────────────────────────────────────────────
function runPowerShell(command) {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => {
        resolve({ success: !err || err.code === 0, stdout: stdout || '', stderr: stderr || '', code: err?.code ?? 0 });
      }
    );
  });
}

// ── UAC self-elevation ────────────────────────────────────────────────────────
function isAdminSync() {
  try {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    ], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    return r.stdout.trim().toLowerCase() === 'true';
  } catch { return false; }
}

function relaunchAsAdmin() {
  if (app.isPackaged) {
    // Packaged: relaunch the exe itself with runas
    spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Start-Process '${process.execPath.replace(/'/g, "''")}' -Verb RunAs`
    ], { windowsHide: true, timeout: 8000 });
  } else {
    // Dev: relaunch electron with the app path
    const appPath = app.getAppPath().replace(/'/g, "''");
    const exePath = process.execPath.replace(/'/g, "''");
    spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Start-Process '${exePath}' -ArgumentList '"${appPath}"' -Verb RunAs`
    ], { windowsHide: true, timeout: 8000 });
  }
}

// ── License status ────────────────────────────────────────────────────────────
async function getLicenseStatus() {
  const ps = `
Add-Type -AssemblyName 'System.Security' -ErrorAction SilentlyContinue
$vsPaths = @{
  '2013' = 'Licenses\\E79B3F9C-6543-4897-BBA5-5BFB0A02BB5C\\06177'
  '2015' = 'Licenses\\4D8CFBCB-2F6A-4AD2-BABF-10E28F6F2C8F\\07078'
  '2017' = 'Licenses\\5C505A59-E312-4B89-9508-E162F8150517\\08878'
  '2019' = 'Licenses\\41717607-F34E-432C-A138-A3CFD7E25CDA\\09278'
}
$results = @()
foreach ($version in $vsPaths.Keys | Sort-Object) {
  $regPath = $vsPaths[$version]
  try {
    $HKCR = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot, [Microsoft.Win32.RegistryView]::Default)
    $key = $HKCR.OpenSubKey($regPath, $false)
    if (-not $key) { $results += [PSCustomObject]@{ Version=$version; Status='not_installed'; DaysLeft=$null; ExpiryDate=$null }; continue }
    $blob = $key.GetValue($null); $key.Dispose()
    if (-not $blob) { $results += [PSCustomObject]@{ Version=$version; Status='no_data'; DaysLeft=$null; ExpiryDate=$null }; continue }
    $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    $eb = $dec[-16..-11]
    $year = [System.BitConverter]::ToUInt16($eb[0..1], 0)
    $month = [System.BitConverter]::ToUInt16($eb[2..3], 0)
    $day = [System.BitConverter]::ToUInt16($eb[4..5], 0)
    $expiry = [datetime]::new($year, $month, $day)
    $daysLeft = ($expiry - (Get-Date).Date).Days
    $status = if ($daysLeft -lt 0) { 'expired' } elseif ($daysLeft -le 3) { 'expiring' } else { 'valid' }
    $results += [PSCustomObject]@{ Version=$version; Status=$status; DaysLeft=$daysLeft; ExpiryDate=$expiry.ToString('yyyy-MM-dd') }
  } catch {
    $results += [PSCustomObject]@{ Version=$version; Status='error'; DaysLeft=$null; ExpiryDate=$null }
  }
}
$results | ConvertTo-Json -Depth 3`;

  const r = await runPowerShell(ps);
  try {
    const data = JSON.parse(r.stdout.trim());
    return { licenses: Array.isArray(data) ? data : [data] };
  } catch { return { error: 'Parse failed: ' + r.stdout }; }
}

// ── Renew license ─────────────────────────────────────────────────────────────
async function renewLicense(version) {
  const scriptPath = path.join(getScriptsPath(), 'AutoRenew-VS.ps1').replace(/'/g, "''");
  // -ThresholdDays 999 forces renewal of everything regardless of days left
  const threshold = version === 'all' ? 999 : 999;
  let ps;

  if (version === 'all') {
    ps = `& '${scriptPath}' -ThresholdDays 999`;
  } else {
    ps = `
Add-Type -AssemblyName 'System.Security' -ErrorAction SilentlyContinue
$vsPaths = @{
  '2013' = 'Licenses\\E79B3F9C-6543-4897-BBA5-5BFB0A02BB5C\\06177'
  '2015' = 'Licenses\\4D8CFBCB-2F6A-4AD2-BABF-10E28F6F2C8F\\07078'
  '2017' = 'Licenses\\5C505A59-E312-4B89-9508-E162F8150517\\08878'
  '2019' = 'Licenses\\41717607-F34E-432C-A138-A3CFD7E25CDA\\09278'
}
$regPath = $vsPaths['${version}']
$HKCR = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot, [Microsoft.Win32.RegistryView]::Default)
$key = $HKCR.OpenSubKey($regPath, $false)
if (-not $key) { Write-Output 'NOT_FOUND'; exit 1 }
$blob = $key.GetValue($null); $key.Dispose()
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
$nd = (Get-Date).Date.AddDays(31)
$nb = @(); $nb += [System.BitConverter]::GetBytes([uint16]$nd.Year); $nb += [System.BitConverter]::GetBytes([uint16]$nd.Month); $nb += [System.BitConverter]::GetBytes([uint16]$nd.Day)
$newDec = @($dec[-$dec.Count..-17]; $nb; $dec[-10..-1])
$newEnc = [System.Security.Cryptography.ProtectedData]::Protect($newDec, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
$wk = $HKCR.OpenSubKey($regPath, $true); $wk.SetValue($null, $newEnc, [Microsoft.Win32.RegistryValueKind]::Binary); $wk.Dispose()
Write-Output "RENEWED:$($nd.ToString('yyyy-MM-dd'))"`;
  }
  return runPowerShell(ps);
}

// ── Scheduled task ────────────────────────────────────────────────────────────
async function getTaskStatus() {
  const ps = `$t = Get-ScheduledTask -TaskName 'VSCELicenseAutoRenew' -ErrorAction SilentlyContinue
if ($t) {
  $i = $t | Get-ScheduledTaskInfo
  [PSCustomObject]@{ Exists=$true; State=$t.State.ToString(); LastRun=if($i.LastRunTime -and $i.LastRunTime.Year -gt 2000){$i.LastRunTime.ToString('yyyy-MM-dd HH:mm')}else{'Never'}; NextRun=if($i.NextRunTime -and $i.NextRunTime.Year -gt 2000){$i.NextRunTime.ToString('yyyy-MM-dd HH:mm')}else{'N/A'} }
} else { [PSCustomObject]@{ Exists=$false; State='None'; LastRun='N/A'; NextRun='N/A' } } | ConvertTo-Json`;
  const r = await runPowerShell(ps);
  try { return JSON.parse(r.stdout.trim()); }
  catch { return { Exists: false, State: 'Unknown', LastRun: 'N/A', NextRun: 'N/A' }; }
}

async function installTask(thresholdDays, runTime) {
  const scriptPath = path.join(getScriptsPath(), 'AutoRenew-VS.ps1').replace(/'/g, "''");
  const ps = `
$taskName = 'VSCELicenseAutoRenew'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-ExecutionPolicy Bypass -File "${scriptPath}" -ThresholdDays ${thresholdDays}'
$trigger = New-ScheduledTaskTrigger -Daily -At '${runTime}'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Auto-renews VS Community license' -Force
Write-Output 'OK'`;
  return runPowerShell(ps);
}

async function uninstallTask() {
  return runPowerShell(`Unregister-ScheduledTask -TaskName 'VSCELicenseAutoRenew' -Confirm:$false -ErrorAction SilentlyContinue; Write-Output 'OK'`);
}

// ── Log ───────────────────────────────────────────────────────────────────────
function readLog() {
  try {
    const p = getLogPath();
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } catch { return null; }
}
function clearLog() {
  try { fs.writeFileSync(getLogPath(), '', 'utf8'); return true; } catch { return false; }
}

// ── Admin check (async, for renderer badge) ───────────────────────────────────
async function checkAdmin() {
  const r = await runPowerShell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
  return r.stdout.trim().toLowerCase() === 'true';
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 680, minWidth: 760, minHeight: 560,
    title: 'VS License Manager',
    backgroundColor: '#0f1117',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// On Windows: check admin synchronously before the app is ready.
// If not elevated, trigger UAC relaunch and exit this instance.
if (process.platform === 'win32' && !isAdminSync()) {
  app.whenReady().then(() => {
    relaunchAsAdmin();
    app.quit();
  });
} else {
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());

  // IPC
  ipcMain.handle('get-license-status', () => getLicenseStatus());
  ipcMain.handle('renew-license', (_, v) => renewLicense(v));
  ipcMain.handle('get-task-status', () => getTaskStatus());
  ipcMain.handle('install-task', (_, { thresholdDays, runTime }) => installTask(thresholdDays, runTime));
  ipcMain.handle('uninstall-task', () => uninstallTask());
  ipcMain.handle('read-log', () => readLog());
  ipcMain.handle('clear-log', () => clearLog());
  ipcMain.handle('check-admin', () => checkAdmin());
  ipcMain.handle('open-log-file', () => shell.openPath(getLogPath()));

  ipcMain.on('window-minimize', () => mainWindow?.minimize());
  ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
  ipcMain.on('window-close', () => mainWindow?.close());
}
