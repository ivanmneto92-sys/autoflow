<#
  Envia o autoflow para a VPS e (re)liga os containers. Rode na pasta do projeto:

    powershell -ExecutionPolicy Bypass -File scripts\deploy-vps.ps1

  Primeira vez (leva também as mídias da pasta uploads):

    powershell -ExecutionPolicy Bypass -File scripts\deploy-vps.ps1 -ComMidias

  Vai junto: código, templates, migrations e o .env deste PC.
  Não vai: node_modules, web (o painel fica na Vercel), .git, chaves *.pub.
#>
param([switch]$ComMidias, [string]$Vps = 'root@187.41.123.199')

Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path '.env')) { Write-Host 'Não achei o .env nesta pasta.' -ForegroundColor Red; exit 1 }

$pacote = 'autoflow-deploy.tgz'
$excluir = @('--exclude=node_modules', '--exclude=./web', '--exclude=./.git', '--exclude=./dist', '--exclude=./.scratch',
  '--exclude=./.vercel', '--exclude=*.log', '--exclude=*.pub', '--exclude=*.tgz')
if (-not $ComMidias) { $excluir += '--exclude=./uploads' }

Write-Host '1/3 Empacotando...' -ForegroundColor Cyan
tar -czf $pacote @excluir .
if ($LASTEXITCODE -ne 0) { Write-Host 'Falhou ao empacotar.' -ForegroundColor Red; exit 1 }

Write-Host '2/3 Enviando para a VPS...' -ForegroundColor Cyan
scp $pacote "${Vps}:/tmp/autoflow-deploy.tgz"
$ok = $LASTEXITCODE
Remove-Item $pacote
if ($ok -ne 0) { Write-Host 'Falhou ao enviar.' -ForegroundColor Red; exit 1 }

Write-Host '3/3 Atualizando os containers (na primeira vez leva uns 2 minutos)...' -ForegroundColor Cyan
$remoto = 'set -e; mkdir -p /opt/autoflow/uploads; cd /opt/autoflow; rm -rf src scripts templates supabase; ' +
  'tar -xzf /tmp/autoflow-deploy.tgz; rm -f /tmp/autoflow-deploy.tgz; touch tunnel.env; ' +
  'docker compose -f docker-compose.vps.yml up -d --build --remove-orphans; docker image prune -f > /dev/null; ' +
  'docker compose -f docker-compose.vps.yml ps'
ssh $Vps $remoto
if ($LASTEXITCODE -ne 0) { Write-Host 'Algo falhou na VPS (veja as mensagens acima).' -ForegroundColor Red; exit 1 }
Write-Host 'Pronto! autoflow atualizado na VPS.' -ForegroundColor Green
