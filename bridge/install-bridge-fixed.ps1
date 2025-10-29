# DevChrome Puppeteer Bridge Installer
# Устанавливает bridge как Windows Service используя NSSM

param(
    [string]$InstallPath = "$env:APPDATA\devchrome-bridge",
    [string]$ServiceName = "DevChromePuppeteerBridge"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  🌉 DevChrome Puppeteer Bridge Installer                 ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Проверка прав администратора
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "⚠️  Требуются права администратора для установки Windows Service" -ForegroundColor Yellow
    Write-Host "   Перезапустите PowerShell от имени администратора" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Шаг 1: Создание директории установки
Write-Host "📁 Создаём директорию установки..." -ForegroundColor Yellow
Write-Host "   $InstallPath" -ForegroundColor Gray
New-Item -ItemType Directory -Force -Path $InstallPath | Out-Null
Write-Host "   ✓ Готово" -ForegroundColor Green
Write-Host ""

# Шаг 2: Копирование файлов
Write-Host "📦 Копируем файлы bridge..." -ForegroundColor Yellow
$BridgeSource = Split-Path -Parent $MyInvocation.MyCommand.Path

$FilesToCopy = @(
    "puppeteer-bridge.js",
    "package.json"
)

foreach ($file in $FilesToCopy) {
    $sourcePath = Join-Path $BridgeSource $file
    if (Test-Path $sourcePath) {
        Copy-Item $sourcePath -Destination $InstallPath -Force
        Write-Host "   ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "   ⚠️  $file не найден: $sourcePath" -ForegroundColor Red
    }
}
Write-Host ""

# Шаг 3: Установка зависимостей
Write-Host "📚 Устанавливаем npm зависимости..." -ForegroundColor Yellow
Push-Location $InstallPath
try {
    & npm install --production 2>&1 | Out-Null
    Write-Host "   ✓ Зависимости установлены" -ForegroundColor Green
} catch {
    Write-Host "   ⚠️  Ошибка установки зависимостей: $_" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location
Write-Host ""

# Шаг 4: Скачивание NSSM
Write-Host "🔧 Настройка NSSM (Non-Sucking Service Manager)..." -ForegroundColor Yellow
$NssmPath = Join-Path $InstallPath "nssm.exe"

if (-not (Test-Path $NssmPath)) {
    Write-Host "   Скачиваем NSSM..." -ForegroundColor Gray
    try {
        $NssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
        $NssmZip = Join-Path $env:TEMP "nssm.zip"

        # Скачиваем
        Invoke-WebRequest -Uri $NssmUrl -OutFile $NssmZip -UseBasicParsing

        # Распаковываем
        $NssmExtract = Join-Path $env:TEMP "nssm"
        Expand-Archive -Path $NssmZip -DestinationPath $NssmExtract -Force

        # Копируем нужную версию
        $NssmExe = Join-Path $NssmExtract "nssm-2.24\win64\nssm.exe"
        Copy-Item $NssmExe -Destination $NssmPath

        # Удаляем временные файлы
        Remove-Item $NssmZip -Force
        Remove-Item $NssmExtract -Recurse -Force

        Write-Host "   ✓ NSSM скачан" -ForegroundColor Green
    } catch {
        Write-Host "   ⚠️  Ошибка скачивания NSSM: $_" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "   ✓ NSSM уже установлен" -ForegroundColor Green
}
Write-Host ""

# Шаг 5: Остановка существующего сервиса
Write-Host "🛑 Проверяем существующий сервис..." -ForegroundColor Yellow
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if ($existingService) {
    Write-Host "   Останавливаем существующий сервис..." -ForegroundColor Gray
    & $NssmPath stop $ServiceName 2>&1 | Out-Null
    Start-Sleep -Seconds 2

    Write-Host "   Удаляем существующий сервис..." -ForegroundColor Gray
    & $NssmPath remove $ServiceName confirm 2>&1 | Out-Null
    Write-Host "   ✓ Старый сервис удалён" -ForegroundColor Green
} else {
    Write-Host "   ✓ Существующий сервис не найден" -ForegroundColor Green
}
Write-Host ""

# Шаг 6: Установка нового сервиса
Write-Host "⚙️  Устанавливаем Windows Service..." -ForegroundColor Yellow

$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
    Write-Host "   ⚠️  Node.js не найден в PATH" -ForegroundColor Red
    Write-Host "   Установите Node.js: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

$BridgeScript = Join-Path $InstallPath "puppeteer-bridge.js"

# Устанавливаем сервис
& $NssmPath install $ServiceName $NodePath $BridgeScript | Out-Null
& $NssmPath set $ServiceName AppDirectory $InstallPath | Out-Null
& $NssmPath set $ServiceName DisplayName "DevChrome Puppeteer Bridge" | Out-Null
& $NssmPath set $ServiceName Description "Puppeteer bridge для DevChrome MCP сервера из WSL" | Out-Null
& $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null

# Настройка логирования
$LogPath = Join-Path $InstallPath "logs"
New-Item -ItemType Directory -Force -Path $LogPath | Out-Null
& $NssmPath set $ServiceName AppStdout (Join-Path $LogPath "bridge.log") | Out-Null
& $NssmPath set $ServiceName AppStderr (Join-Path $LogPath "bridge-error.log") | Out-Null
& $NssmPath set $ServiceName AppRotateFiles 1 | Out-Null
& $NssmPath set $ServiceName AppRotateBytes 1048576 | Out-Null  # 1MB

Write-Host "   ✓ Сервис установлен" -ForegroundColor Green
Write-Host ""

# Шаг 7: Запуск сервиса
Write-Host "🚀 Запускаем сервис..." -ForegroundColor Yellow
& $NssmPath start $ServiceName | Out-Null
Start-Sleep -Seconds 3
Write-Host "   ✓ Сервис запущен" -ForegroundColor Green
Write-Host ""

# Шаг 8: Проверка health
Write-Host "🏥 Проверяем работоспособность..." -ForegroundColor Yellow
$maxAttempts = 5
$attempt = 0
$healthOk = $false

while ($attempt -lt $maxAttempts -and -not $healthOk) {
    $attempt++
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:9224/health" -TimeoutSec 3 -ErrorAction Stop
        if ($response.status -eq "ok") {
            $healthOk = $true
            Write-Host "   ✓ Bridge работает!" -ForegroundColor Green
            Write-Host ""
            Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Green
            Write-Host "║  ✅ Установка завершена успешно!                         ║" -ForegroundColor Green
            Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Green
            Write-Host ""
            Write-Host "📊 Информация:" -ForegroundColor Cyan
            Write-Host "   • URL (локальный): http://localhost:9224" -ForegroundColor Gray
            Write-Host "   • URL (WSL): http://172.25.96.1:9224" -ForegroundColor Gray
            Write-Host "   • Health check: http://localhost:9224/health" -ForegroundColor Gray
            Write-Host "   • Статус: $($response.status)" -ForegroundColor Gray
            Write-Host "   • Версия: $($response.version)" -ForegroundColor Gray
            Write-Host "   • Путь установки: $InstallPath" -ForegroundColor Gray
            Write-Host "   • Логи: $(Join-Path $LogPath 'bridge.log')" -ForegroundColor Gray
            Write-Host ""
            Write-Host "💡 Что дальше:" -ForegroundColor Cyan
            Write-Host "   1. Используйте devchrome-mcp как обычно" -ForegroundColor Gray
            Write-Host "   2. Bridge автоматически запустится при загрузке Windows" -ForegroundColor Gray
            Write-Host "   3. Проверить статус: Get-Service $ServiceName" -ForegroundColor Gray
            Write-Host ""
        }
    } catch {
        if ($attempt -lt $maxAttempts) {
            Write-Host "   Попытка $attempt из $maxAttempts..." -ForegroundColor Gray
            Start-Sleep -Seconds 2
        }
    }
}

if (-not $healthOk) {
    Write-Host ""
    Write-Host "⚠️  Bridge установлен, но не отвечает на health check" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Проверьте логи:" -ForegroundColor Yellow
    Write-Host "   $(Join-Path $LogPath 'bridge.log')" -ForegroundColor Gray
    Write-Host "   $(Join-Path $LogPath 'bridge-error.log')" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Проверьте статус сервиса:" -ForegroundColor Yellow
    Write-Host "   Get-Service $ServiceName" -ForegroundColor Gray
    Write-Host ""
}
