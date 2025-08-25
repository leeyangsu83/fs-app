param(
    [string]$EnvFile = ".env",
    [string]$OutDir = "data/corpcode",
    [string]$ApiKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-EnvValue([string]$filePath, [string]$key) {
    if (-not (Test-Path -LiteralPath $filePath)) {
        throw ".env file not found at '$filePath'. Create it from .env.example and set $key."
    }
    $line = Get-Content -LiteralPath $filePath | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
    if (-not $line) {
        throw "Key '$key' not found in $filePath"
    }
    $value = ($line -replace "^\s*$key\s*=\s*", "").Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"')) {
        $value = $value.Trim('"')
    }
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Key '$key' is empty in $filePath"
    }
    return $value
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    $apiKey = Get-EnvValue -filePath $EnvFile -key "OPEN_DART_API_KEY"
} else {
    $apiKey = $ApiKey
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$zipPath = Join-Path $OutDir "corpCode.zip"
$url = "https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=$apiKey"

Write-Host "Downloading corpCode ZIP from:" $url
Invoke-WebRequest -Uri $url -OutFile $zipPath

# Verify file is a ZIP (starts with 'PK') - compatible with Windows PowerShell 5
$fileStream = [System.IO.File]::OpenRead($zipPath)
try {
    $buffer = New-Object byte[] 2
    $bytesRead = $fileStream.Read($buffer, 0, 2)
    if (-not ($bytesRead -eq 2 -and $buffer[0] -eq 80 -and $buffer[1] -eq 75)) {
        $text = Get-Content -LiteralPath $zipPath -Raw -Encoding UTF8
        Write-Warning "Response does not look like a ZIP. Showing response text (may include error status/message):"
        Write-Output $text
        throw "Download did not return a ZIP file."
    }
}
finally {
    $fileStream.Close()
}

Write-Host "Downloaded to" $zipPath

# Extract ZIP
Expand-Archive -Path $zipPath -DestinationPath $OutDir -Force

$xml = Get-ChildItem -LiteralPath $OutDir -Filter *.xml | Select-Object -First 1
if (-not $xml) {
    throw "No XML file found after extracting ZIP in '$OutDir'"
}

Write-Output ("ZIP saved: {0}" -f $zipPath)
Write-Output ("XML extracted: {0}" -f $xml.FullName)


