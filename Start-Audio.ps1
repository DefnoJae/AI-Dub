<#
AI-Dub local episode dubbing companion.
Preserves the existing .ai-dub/pairing-token and uses no cloud AI inference.
-Setup installs the light offline models and ffmpeg.
-SetupHighQuality adds Whisper-small and expressive Kokoro ONNX voices.
#>
param([switch]$Setup, [switch]$SetupHighQuality)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$model = Join-Path $PSScriptRoot '.ai-dub\models\whisper-base'
$voice = Join-Path $PSScriptRoot '.ai-dub\models\piper\en_US-lessac-medium.onnx'
$kokoroModel = Join-Path $PSScriptRoot '.ai-dub\models\kokoro\kokoro-v1.0.onnx'
$kokoroVoices = Join-Path $PSScriptRoot '.ai-dub\models\kokoro\voices-v1.0.bin'
$data = Join-Path $PSScriptRoot '.ai-dub'
$inbox = Join-Path $data 'inbox'
New-Item -ItemType Directory -Force -Path $inbox | Out-Null

if ($Setup -or $SetupHighQuality) {
    if (-not (Test-Path $python)) {
        py -3.12 -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 is required.' }
    }
    & $python -m pip install -r companion/requirements-audio.txt
    if ($LASTEXITCODE -ne 0) { throw 'Offline audio dependencies could not be installed.' }
    & $python companion/prepare_models.py
    if ($LASTEXITCODE -ne 0) { throw 'Default offline models could not be prepared.' }
    if ($SetupHighQuality) {
        & $python -m pip install "kokoro-onnx==0.6.1" "soundfile>=0.13.0"
        if ($LASTEXITCODE -ne 0) { throw 'Natural voice dependencies could not be installed.' }
        & $python companion/prepare_quality_voice.py
        if ($LASTEXITCODE -ne 0) { throw 'Natural voice models could not be prepared.' }
    }
    Write-Host 'AI Dub models prepared. Your companion pairing token was not modified.'
    exit 0
}

foreach ($item in @($python, $model, $voice)) {
    if (-not (Test-Path $item)) {
        throw "Local audio engine not configured ($item). Run .\Start-Audio.ps1 -Setup first."
    }
}

$port = if ($env:AI_DUB_PORT) { [int]$env:AI_DUB_PORT } else { 43123 }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $port is occupied. Stop the existing companion with Ctrl+C before launching this version. No process was terminated."
}

$env:AI_DUB_AUDIO = '1'
$env:AI_DUB_EPISODES = '1'
if ((Test-Path $kokoroModel) -and (Test-Path $kokoroVoices)) {
    & $python -c "import kokoro_onnx"
    if ($LASTEXITCODE -eq 0) {
        $env:AI_DUB_TTS = 'kokoro'
        Write-Host 'Using expressive local Kokoro ONNX voice.'
    } else {
        $env:AI_DUB_TTS = 'piper'
        Write-Host 'Kokoro import failed; using lightweight Piper fallback.'
    }
} else {
    $env:AI_DUB_TTS = 'piper'
    Write-Host 'Using Piper fallback. For more natural voices, run .\Start-Audio.ps1 -SetupHighQuality.'
}
Write-Host "AI Dub local episode engine: http://127.0.0.1:$port"
Write-Host "Prepared clip inbox: $inbox"
Write-Host 'For most Seanime installations, the loopback backend is http://127.0.0.1:43211.'
Write-Host 'Set AI_DUB_SEANIME_URL before launching if your server uses another loopback port.'
Write-Host 'Episode dubbing runs offline and begins only after Prepare Current Episode in Seanime.'
Write-Host 'The current video changes only after Play Dubbed Episode is clicked.'
node companion/server.cjs
