<#
AI-Dub local automatic short-clip mode (opt-in).
Never prints, regenerates, deletes, or modifies the pairing token.
The companion has no player audio injection or full episode streaming support.
#>
param([switch]$Setup)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$model = Join-Path $PSScriptRoot '.ai-dub\models\whisper-base'
$voice = Join-Path $PSScriptRoot '.ai-dub\models\piper\en_US-lessac-medium.onnx'
$data = Join-Path $PSScriptRoot '.ai-dub'
$inbox = Join-Path $data 'inbox'
New-Item -ItemType Directory -Force -Path $inbox | Out-Null

if ($Setup) {
    if (-not (Test-Path $python)) {
        py -3.12 -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 is required to create the virtual environment.' }
    }
    & $python -m pip install -r companion/requirements-audio.txt
    if ($LASTEXITCODE -ne 0) { throw 'Audio dependencies could not be installed.' }
    & $python companion/prepare_models.py
    if ($LASTEXITCODE -ne 0) { throw 'Offline models could not be prepared.' }
    Write-Host 'Audio models prepared. The pairing token was not modified.'
    exit 0
}

foreach ($item in @($python, $model, $voice)) {
    if (-not (Test-Path $item)) {
        throw "Local audio engine is not configured ($item). Run .\Start-Audio.ps1 -Setup first."
    }
}
$port = if ($env:AI_DUB_PORT) { [int]$env:AI_DUB_PORT } else { 43123 }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $port is occupied. Stop the existing companion gracefully before starting audio-enabled mode. No process was terminated."
}
$env:AI_DUB_AUDIO = '1'
Write-Host "AI Dub automatic local short-clip mode: http://127.0.0.1:$port"
Write-Host "Place an authorized local MP4/MKV/WebM/MOV file with a simple name in $inbox"
Write-Host 'This mode only generates reviewed English clips and does not change player audio.'
node companion/server.cjs
