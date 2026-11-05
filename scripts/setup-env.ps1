# Cria o arquivo .env do autoflow com segredos gerados automaticamente.
# Uso (na pasta do projeto):  powershell -ExecutionPolicy Bypass -File scripts\setup-env.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"

function New-Secret([int]$bytes, [switch]$Base64) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  if ($Base64) { return [Convert]::ToBase64String($b) }
  return -join ($b | ForEach-Object { $_.ToString("x2") })
}

if (Test-Path $envFile) {
  $ans = Read-Host ".env já existe. Sobrescrever? (s/N)"
  if ($ans -ne "s") { Write-Host "Cancelado."; exit 0 }
}

$db = Read-Host "Cole a DATABASE_URL (Supabase > Connect > Session pooler, porta 5432)"
$redis = Read-Host "Cole a REDIS_URL (Enter para usar redis://localhost:6379)"
if ([string]::IsNullOrWhiteSpace($redis)) { $redis = "redis://localhost:6379" }

$content = @"
NODE_ENV=development
PORT=3000
# Troque pela URL do túnel (ngrok) quando for conectar o Instagram
PUBLIC_BASE_URL=http://localhost:3000

DATABASE_URL=$db
REDIS_URL=$redis

# App da Meta (provisório até criar o app)
IG_APP_ID=123
IG_APP_SECRET=troque-pelo-app-secret
IG_WEBHOOK_VERIFY_TOKEN=$(New-Secret 12)
IG_GRAPH_VERSION=v21.0

ENCRYPTION_KEY=$(New-Secret 32 -Base64)
STATE_SECRET=$(New-Secret 24)
ADMIN_API_KEY=$(New-Secret 24)

WORKER_CONCURRENCY=10
LOG_LEVEL=info
"@

[System.IO.File]::WriteAllText($envFile, $content, (New-Object System.Text.UTF8Encoding $false))
Write-Host "✓ .env criado em $envFile"
Write-Host "  Próximo passo: npm run db:migrate"
