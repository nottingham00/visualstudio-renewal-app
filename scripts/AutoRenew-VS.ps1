<#
.SYNOPSIS
    Automatically renews Visual Studio Community Edition license when expiry is near or already expired.
.DESCRIPTION
    Uses ProtectedData decryption/encryption (same as original VSCELicense module).
    Checks VS 2013-2019. If license expires within $ThresholdDays days OR is already expired,
    resets expiration date to +31 days from today.
.NOTES
    Must be run as Administrator.
    Logs to: $env:ProgramData\VSCELicense\renew.log
#>

param(
    [int]$ThresholdDays = 3,
    [string]$LogPath = "$env:ProgramData\VSCELicense\renew.log"
)

# Create log directory if needed
$logDir = Split-Path $LogPath -Parent
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $LogEntry = "$Timestamp [$Level] $Message"
    Add-Content -Path $LogPath -Value $LogEntry
    Write-Host $LogEntry
}

# Check admin
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Log "ERROR: Must be run as Administrator" "ERROR"
    exit 1
}

# Load required assembly
try {
    Add-Type -AssemblyName 'System.Security' -ErrorAction Stop
} catch {
    Write-Log "ERROR: Failed to load System.Security assembly: $_" "ERROR"
    exit 1
}

# Registry paths (same as original VSCELicense module)
$vsPaths = @{
    "2013" = "Licenses\E79B3F9C-6543-4897-BBA5-5BFB0A02BB5C\06177"
    "2015" = "Licenses\4D8CFBCB-2F6A-4AD2-BABF-10E28F6F2C8F\07078"
    "2017" = "Licenses\5C505A59-E312-4B89-9508-E162F8150517\08878"
    "2019" = "Licenses\41717607-F34E-432C-A138-A3CFD7E25CDA\09278"
}

function ConvertFrom-BinaryDate {
    param([byte[]]$Bytes)
    $year = [System.BitConverter]::ToUInt16($Bytes[0..1], 0)
    $month = [System.BitConverter]::ToUInt16($Bytes[2..3], 0)
    $day = [System.BitConverter]::ToUInt16($Bytes[4..5], 0)
    return [datetime]::new($year, $month, $day)
}

function ConvertTo-BinaryDate {
    param([datetime]$Date)
    $bytes = @()
    $bytes += [System.BitConverter]::GetBytes([uint16]$Date.Year)
    $bytes += [System.BitConverter]::GetBytes([uint16]$Date.Month)
    $bytes += [System.BitConverter]::GetBytes([uint16]$Date.Day)
    return $bytes
}

function Open-RegistryKey {
    param([string]$SubKey, [switch]$ReadWrite)
    $HKCR = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot, [Microsoft.Win32.RegistryView]::Default)
    return $HKCR.OpenSubKey($SubKey, $ReadWrite)
}

Write-Log "========== VS License Auto-Renew Started =========="

$renewedAny = $false
$foundAny = $false

foreach ($version in $vsPaths.Keys | Sort-Object) {
    $regPath = $vsPaths[$version]
    
    $licenseKey = Open-RegistryKey -SubKey $regPath
    if (-not $licenseKey) {
        continue
    }
    $foundAny = $true
    
    try {
        $encryptedBlob = $licenseKey.GetValue($null)
        if (-not $encryptedBlob) {
            Write-Log "VS $version : No license data found." "DEBUG"
            continue
        }
        
        $decryptedBlob = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encryptedBlob,
            $null,
            [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        )
        
        $expiryBytes = $decryptedBlob[-16..-11]
        $expirationDate = ConvertFrom-BinaryDate $expiryBytes
        $daysLeft = ($expirationDate - (Get-Date).Date).Days
        
        # Enhanced logging for expired licenses
        if ($daysLeft -lt 0) {
            Write-Log "VS $version : ⚠️ EXPIRED on $($expirationDate.ToString('yyyy-MM-dd')) (Expired $(-$daysLeft) days ago)" "WARN"
        } else {
            Write-Log "VS $version : Expires $($expirationDate.ToString('yyyy-MM-dd')) (Days left: $daysLeft)" "INFO"
        }
        
        # Check if renewal is needed (expired OR within threshold)
        if ($daysLeft -le $ThresholdDays) {
            if ($daysLeft -lt 0) {
                Write-Log "VS $version : License is EXPIRED. Renewing immediately..." "WARN"
            } else {
                Write-Log "VS $version : Expiry within $ThresholdDays days. Renewing..." "WARN"
            }
            
            $newExpirationDate = (Get-Date).Date.AddDays(31)
            $newExpiryBytes = ConvertTo-BinaryDate $newExpirationDate
            
            $newDecryptedBlob = @(
                $decryptedBlob[-$decryptedBlob.Count..-17]
                $newExpiryBytes
                $decryptedBlob[-10..-1]
            )
            
            $newEncryptedBlob = [System.Security.Cryptography.ProtectedData]::Protect(
                $newDecryptedBlob,
                $null,
                [System.Security.Cryptography.DataProtectionScope]::LocalMachine
            )
            
            $licenseKey.Dispose()
            $licenseKey = Open-RegistryKey -SubKey $regPath -ReadWrite
            $licenseKey.SetValue($null, $newEncryptedBlob, [Microsoft.Win32.RegistryValueKind]::Binary)
            
            Write-Log "VS $version : ✅ RENEWED until $($newExpirationDate.ToString('yyyy-MM-dd'))" "INFO"
            $renewedAny = $true
        } else {
            Write-Log "VS $version : OK - No renewal needed" "INFO"
        }
    }
    catch {
        Write-Log "VS $version : ERROR - $_" "ERROR"
    }
    finally {
        if ($licenseKey) { $licenseKey.Dispose() }
    }
}

if (-not $foundAny) {
    Write-Log "No Visual Studio Community editions found (2013-2019)" "INFO"
} elseif (-not $renewedAny) {
    Write-Log "All licenses are valid - no renewal performed" "INFO"
} else {
    Write-Log "License renewal completed successfully" "INFO"
}

Write-Log "========== VS License Auto-Renew Finished =========="