# DevChrome Puppeteer Bridge Uninstaller

param(
    [string]$InstallPath = "$env:APPDATA\devchrome-bridge",
    [string]$ServiceName = "DevChromePuppeteerBridge"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  🗑️  DevChrome Puppeteer Bridge Uninstaller              ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Проверка прав администратора
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "⚠️  Требуются права администратора для удаления Windows Service" -ForegroundColor Yellow
    Write-Host "   Перезапустите PowerShell от имени администратора" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

$NssmPath = Join-Path $InstallPath "nssm.exe"

if (-not (Test-Path $NssmPath)) {
    Write-Host "⚠️  NSSM не найден. Возможно, bridge не установлен." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Остановка сервиса
Write-Host "🛑 Останавливаем сервис..." -ForegroundColor Yellow
& $NssmPath stop $ServiceName 2>&1 | Out-Null
Start-Sleep -Seconds 2
Write-Host "   ✓ Сервис остановлен" -ForegroundColor Green
Write-Host ""

# Удаление сервиса
Write-Host "🗑️  Удаляем сервис..." -ForegroundColor Yellow
& $NssmPath remove $ServiceName confirm 2>&1 | Out-Null
Write-Host "   ✓ Сервис удалён" -ForegroundColor Green
Write-Host ""

# Удаление файлов
Write-Host "📁 Удаляем файлы..." -ForegroundColor Yellow
if (Test-Path $InstallPath) {
    Remove-Item -Path $InstallPath -Recurse -Force
    Write-Host "   ✓ Файлы удалены" -ForegroundColor Green
} else {
    Write-Host "   ⚠️  Путь не найден: $InstallPath" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "✅ DevChrome Puppeteer Bridge успешно удалён!" -ForegroundColor Green
Write-Host ""
