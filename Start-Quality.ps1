$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:AI_DUB_QUALITY = '1'
& node companion/server.cjs
exit $LASTEXITCODE
