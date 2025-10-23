# DevChrome MCP + Claude Code в WSL - Полный гайд

> **Комплексное руководство по настройке и использованию DevChrome MCP с Claude Code в WSL окружении**

---

## 📋 Содержание

1. [Архитектура и принцип работы](#архитектура-и-принцип-работы)
2. [Helper Scripts - Готовые утилиты](#helper-scripts---готовые-утилиты)
3. [WSL ↔ Windows взаимодействие](#wsl--windows-взаимодействие)
4. [Получение IP адреса хоста](#получение-ip-адреса-хоста)
5. [Проброс портов (Port Forwarding)](#проброс-портов-port-forwarding)
6. [Настройка Firewall](#настройка-firewall)
7. [Настройка Dev-серверов](#настройка-dev-серверов)
8. [Настройка Chrome DevTools](#настройка-chrome-devtools)
9. [Конфигурация DevChrome MCP](#конфигурация-devchrome-mcp)
10. [Типичные проблемы и решения](#типичные-проблемы-и-решения)
11. [Чек-лист для нового проекта](#чек-лист-для-нового-проекта)

---

## 🏗️ Архитектура и принцип работы

### Схема взаимодействия

```
┌─────────────────────────────────────────────────────────┐
│                    Windows Host                         │
│                                                          │
│  ┌──────────────┐        ┌────────────────┐            │
│  │   Chrome     │◄───────┤  Vite Server   │            │
│  │ (localhost)  │  HTTP  │  (localhost)   │            │
│  │              │        │  Port: 5173    │            │
│  │ DevTools:    │        └────────────────┘            │
│  │ Port 9223    │                                       │
│  └──────┬───────┘        ┌────────────────┐            │
│         │                │ Django Server  │            │
│         │ CDP            │ (localhost)    │            │
│         │ Protocol       │ Port: 8000     │            │
│         │                └────────────────┘            │
│         │                                               │
│         │  Port Forwarding (netsh)                     │
│         │  172.25.96.1:9223 → 127.0.0.1:9223          │
└─────────┼───────────────────────────────────────────────┘
          │
          │ Network via WSL Bridge (172.25.96.1)
          │
┌─────────▼───────────────────────────────────────────────┐
│                      WSL2 (Linux)                        │
│                                                          │
│  ┌──────────────────────────────────────┐               │
│  │        Claude Code                   │               │
│  │                                       │               │
│  │  ┌─────────────────────────────┐    │               │
│  │  │   DevChrome MCP Server      │    │               │
│  │  │                              │    │               │
│  │  │  Connects to:                │    │               │
│  │  │  http://172.25.96.1:9223    │    │               │
│  │  │                              │    │               │
│  │  │  Controls Chrome via CDP     │    │               │
│  │  └─────────────────────────────┘    │               │
│  │                                       │               │
│  │  Your code: /mnt/c/prj/...          │               │
│  └──────────────────────────────────────┘               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Ключевые моменты:

1. **WSL работает в отдельной виртуальной сети** - имеет свой IP диапазон
2. **Windows доступен по IP 172.25.96.1** из WSL (обычно, может отличаться)
3. **Сервисы на Windows слушают 127.0.0.1** (localhost)
4. **Нужен проброс портов** для доступа из WSL к Windows сервисам
5. **DevChrome MCP работает в WSL**, но управляет Chrome на Windows

---

## 🛠️ Helper Scripts - Готовые утилиты

**ВАЖНО:** Мы создали набор готовых скриптов для автоматизации всех операций!

### Быстрый обзор скриптов

```bash
~/.claude/scripts/
├── chrome-debug.sh              # 🌐 Управление Chrome в debug режиме
├── setup-port-forwarding.sh     # 🔌 Проброс портов Windows ↔ WSL
├── win-ip.sh                    # 📍 Получение IP Windows хоста
├── pwsh.sh                      # 💻 Wrapper для PowerShell команд
└── helpers.sh                   # 🔧 Вспомогательные функции
```

### Быстрые команды

```bash
# Запустить Chrome в debug режиме
~/.claude/scripts/chrome-debug.sh start

# Проверить статус Chrome и DevTools
~/.claude/scripts/chrome-debug.sh status

# Настроить проброс портов для проекта
~/.claude/scripts/setup-port-forwarding.sh setup my-project

# Показать все пробросы
~/.claude/scripts/setup-port-forwarding.sh list

# Восстановить после перезагрузки
~/.claude/scripts/setup-port-forwarding.sh restore

# Получить Windows IP
~/.claude/scripts/win-ip.sh

# Выполнить PowerShell команду
~/.claude/scripts/pwsh.sh "Get-Process chrome"
```

### Рекомендуемые алиасы

Добавьте в `~/.bashrc` или `~/.zshrc`:

```bash
# Windows Host IP
export WIN_HOST_IP=$(~/.claude/scripts/win-ip.sh)

# Shortcuts
alias pwsh='~/.claude/scripts/pwsh.sh'
alias win-ip='~/.claude/scripts/win-ip.sh'
alias ports='~/.claude/scripts/setup-port-forwarding.sh'
alias chrome='~/.claude/scripts/chrome-debug.sh'

# Quick operations
alias chrome-start='~/.claude/scripts/chrome-debug.sh start'
alias chrome-stop='~/.claude/scripts/chrome-debug.sh stop'
alias chrome-status='~/.claude/scripts/chrome-debug.sh status'
alias ports-list='~/.claude/scripts/setup-port-forwarding.sh list'
alias ports-restore='~/.claude/scripts/setup-port-forwarding.sh restore'

# Check services
alias check-chrome='curl -s http://$WIN_HOST_IP:9223/json/version | jq'
alias check-vite='curl -I http://$WIN_HOST_IP:5173'
alias check-django='curl -s http://$WIN_HOST_IP:8000/api/'
```

После добавления:
```bash
source ~/.bashrc  # или source ~/.zshrc
```

### Типичный workflow с алиасами

```bash
# Начало работы (после перезагрузки Windows)
ports-restore        # Восстановить пробросы портов
chrome-start         # Запустить Chrome

# Проверка окружения
chrome-status        # Статус Chrome и DevTools
ports-list          # Список пробросов
check-chrome        # Проверить доступность DevTools

# В процессе работы
chrome-restart      # Если Chrome глючит
ports add 5174      # Добавить новый порт на лету
```

### 📚 Полная документация скриптов

Детальное описание всех скриптов, примеры использования и troubleshooting:

👉 **[HELPER_SCRIPTS.md](~/.claude/docs/HELPER_SCRIPTS.md)** - полная документация по всем helper скриптам

---

## 🔄 WSL ↔ Windows взаимодействие

### PowerShell из WSL

Для выполнения команд Windows из WSL используется `powershell.exe`:

```bash
# Базовый синтаксис
powershell.exe -Command "команда PowerShell"

# Примеры
powershell.exe -Command "Get-Process chrome"
powershell.exe -Command "netstat -ano | Select-String ':9223'"
powershell.exe -Command "Set-Location 'C:\prj\my-app'; npm run dev"
```

### Helper-скрипт для PowerShell

Создайте файл `~/.claude/scripts/pwsh.sh`:

```bash
#!/bin/bash
# Helper для запуска PowerShell команд из WSL

if [ -z "$1" ]; then
    echo "Usage: pwsh.sh 'PowerShell command'"
    exit 1
fi

powershell.exe -Command "$1"
```

Сделайте исполняемым:
```bash
chmod +x ~/.claude/scripts/pwsh.sh
```

Использование:
```bash
~/.claude/scripts/pwsh.sh "Get-ChildItem C:\prj"
~/.claude/scripts/pwsh.sh "python --version"
```

### Доступ к файлам

```bash
# Windows диски монтируются в /mnt/
# C:\ → /mnt/c/
# D:\ → /mnt/d/

# Навигация
cd /mnt/c/prj/my-app
ls /mnt/c/Users/YourName/

# Редактирование файлов
vim /mnt/c/prj/my-app/package.json
code /mnt/c/prj/my-app  # VS Code
```

---

## 🌐 Получение IP адреса хоста

### Метод 1: Через default gateway

```bash
ip route show | grep -i default | awk '{ print $3}'
```

Обычно выдаёт: `172.25.96.1`

### Метод 2: Через /etc/resolv.conf

```bash
grep nameserver /etc/resolv.conf | awk '{print $2}'
```

### Метод 3: Через hostname

```bash
cat /etc/resolv.conf | grep nameserver | awk '{print $2}' | head -1
```

### Helper-скрипт

Создайте `~/.claude/scripts/win-ip.sh`:

```bash
#!/bin/bash
# Получить IP адрес Windows хоста из WSL

ip route show | grep -i default | awk '{ print $3}'
```

Использование:
```bash
chmod +x ~/.claude/scripts/win-ip.sh

# Получить IP
WIN_IP=$(~/.claude/scripts/win-ip.sh)
echo "Windows IP: $WIN_IP"

# Использовать в curl
curl http://$WIN_IP:8000/api/
```

### Добавить в .bashrc/.zshrc

```bash
# Добавьте в ~/.bashrc или ~/.zshrc
export WIN_HOST_IP=$(ip route show | grep -i default | awk '{ print $3}')

# Теперь можно использовать переменную
curl http://$WIN_HOST_IP:5173
```

---

## 🔌 Проброс портов (Port Forwarding)

### Почему это нужно?

WSL2 работает в отдельной виртуальной сети. Сервисы на Windows слушают `127.0.0.1`, который **недоступен** из WSL. Нужно пробросить порты через `netsh`.

### Базовая команда netsh

```bash
# Синтаксис
netsh interface portproxy add v4tov4 listenport=<PORT> listenaddress=<WSL_IP> connectport=<PORT> connectaddress=127.0.0.1

# Пример для порта 9223 (Chrome DevTools)
powershell.exe -Command "Start-Process powershell -ArgumentList '-Command netsh interface portproxy add v4tov4 listenport=9223 listenaddress=172.25.96.1 connectport=9223 connectaddress=127.0.0.1' -Verb RunAs"
```

**ВАЖНО:** Требуются права администратора Windows!

### Helper-скрипт для портов

Используйте готовый скрипт (если есть) или создайте свой `~/.claude/scripts/setup-port-forwarding.sh`:

```bash
#!/bin/bash
# Управление пробросом портов Windows ↔ WSL

add_port() {
    local PORT=$1
    local WIN_IP=$(ip route show | grep -i default | awk '{ print $3}')

    echo "Adding port forwarding: $WIN_IP:$PORT → 127.0.0.1:$PORT"

    powershell.exe -Command "Start-Process powershell -ArgumentList '-Command netsh interface portproxy add v4tov4 listenport=$PORT listenaddress=$WIN_IP connectport=$PORT connectaddress=127.0.0.1' -Verb RunAs -WindowStyle Hidden"

    sleep 2
    echo "Port $PORT forwarding added!"
}

remove_port() {
    local PORT=$1
    local WIN_IP=$(ip route show | grep -i default | awk '{ print $3}')

    powershell.exe -Command "Start-Process powershell -ArgumentList '-Command netsh interface portproxy delete v4tov4 listenport=$PORT listenaddress=$WIN_IP' -Verb RunAs -WindowStyle Hidden"

    echo "Port $PORT forwarding removed!"
}

list_ports() {
    echo "Current port forwarding rules:"
    powershell.exe -Command "netsh interface portproxy show all"
}

case "$1" in
    add)
        add_port "$2"
        ;;
    remove)
        remove_port "$2"
        ;;
    list)
        list_ports
        ;;
    *)
        echo "Usage: $0 {add|remove|list} [PORT]"
        exit 1
        ;;
esac
```

Сделайте исполняемым:
```bash
chmod +x ~/.claude/scripts/setup-port-forwarding.sh
```

### Использование

```bash
# Добавить проброс для Chrome DevTools
~/.claude/scripts/setup-port-forwarding.sh add 9223

# Добавить проброс для Vite
~/.claude/scripts/setup-port-forwarding.sh add 5173

# Добавить проброс для Django
~/.claude/scripts/setup-port-forwarding.sh add 8000

# Показать все пробросы
~/.claude/scripts/setup-port-forwarding.sh list

# Удалить проброс
~/.claude/scripts/setup-port-forwarding.sh remove 9223
```

### Типичные порты для проброса

```bash
# Frontend
5173    # Vite dev server
5174    # Vite secondary
3000    # Create React App, Next.js
8080    # Alternative frontend

# Backend
8000    # Django
8080    # Flask, FastAPI
3001    # Node.js API

# DevTools
9222    # Chrome DevTools (default)
9223    # Chrome DevTools (alternative)

# Databases
5432    # PostgreSQL
3306    # MySQL
6379    # Redis
27017   # MongoDB
```

### Проверка проброса

```bash
# Проверить, что проброс настроен
powershell.exe -Command "netsh interface portproxy show all"

# Проверить доступность из WSL
WIN_IP=$(ip route show | grep -i default | awk '{ print $3}')
curl -I http://$WIN_IP:9223/json/version  # Chrome DevTools
curl -I http://$WIN_IP:5173               # Vite
curl http://$WIN_IP:8000/api/             # Django
```

### ⚠️ После перезагрузки Windows

Пробросы портов **НЕ сохраняются** после перезагрузки Windows!

**Решение 1:** Пересоздавать вручную после каждой перезагрузки

**Решение 2:** Создать `.bat` файл для автозапуска в Windows

`C:\scripts\setup-ports.bat`:
```batch
@echo off
netsh interface portproxy add v4tov4 listenport=9223 listenaddress=172.25.96.1 connectport=9223 connectaddress=127.0.0.1
netsh interface portproxy add v4tov4 listenport=5173 listenaddress=172.25.96.1 connectport=5173 connectaddress=127.0.0.1
netsh interface portproxy add v4tov4 listenport=8000 listenaddress=172.25.96.1 connectport=8000 connectaddress=127.0.0.1
echo Port forwarding configured!
pause
```

Добавьте в автозапуск Windows (через Task Scheduler с правами администратора).

---

## 🛡️ Настройка Firewall

Windows Firewall может блокировать подключения из WSL. Нужно добавить правила.

### Проверка блокировки

```bash
# Из WSL
WIN_IP=$(ip route show | grep -i default | awk '{ print $3}')

# Если timeout - блокирует firewall
curl -v --max-time 5 http://$WIN_IP:9223/json/version
```

### Добавление правил Firewall

#### Метод 1: Через PowerShell (рекомендуется)

```powershell
# От имени администратора в PowerShell на Windows

# Chrome DevTools
New-NetFirewallRule -DisplayName "WSL Chrome DevTools" -Direction Inbound -LocalPort 9223 -Protocol TCP -Action Allow

# Vite Dev Server
New-NetFirewallRule -DisplayName "WSL Vite Dev Server" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow

# Django API
New-NetFirewallRule -DisplayName "WSL Django API" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
```

#### Метод 2: Через GUI

1. Откройте **Windows Defender Firewall** → **Advanced Settings**
2. **Inbound Rules** → **New Rule...**
3. **Port** → **TCP** → Specific local ports: `9223` (или нужный порт)
4. **Allow the connection**
5. Все профили (Domain, Private, Public)
6. Name: `WSL Chrome DevTools`

#### Helper-скрипт для Firewall

Из WSL:
```bash
# Добавить правило для порта
powershell.exe -Command "Start-Process powershell -ArgumentList '-Command New-NetFirewallRule -DisplayName \"WSL Port 9223\" -Direction Inbound -LocalPort 9223 -Protocol TCP -Action Allow' -Verb RunAs"
```

### Проверка правил Firewall

```powershell
# В PowerShell на Windows
Get-NetFirewallRule | Where-Object {$_.DisplayName -like "*WSL*"}
```

---

## ⚙️ Настройка Dev-серверов

Dev-серверы должны быть настроены для приёма подключений извне.

### Vite (React, Vue, Svelte)

**Проблема:** По умолчанию Vite слушает только `localhost` (127.0.0.1)

**Решение:** Настроить `host: '0.0.0.0'` или `host: true`

`vite.config.ts`:
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',  // ← КРИТИЧНО! Слушать на всех интерфейсах
    port: 5173,
    strictPort: true,  // Не переключаться на другой порт при занятости
  }
})
```

**Альтернатива:**
```typescript
server: {
  host: true,  // Автоматически 0.0.0.0
  port: 5173
}
```

**Запуск через CLI:**
```bash
npm run dev -- --host 0.0.0.0
vite --host 0.0.0.0
```

### Django

**Проблема:** `runserver` по умолчанию слушает `127.0.0.1:8000`

**Решение:** Запускать с `0.0.0.0`

```bash
# Правильно
python manage.py runserver 0.0.0.0:8000

# Неправильно
python manage.py runserver  # Слушает только localhost
```

**Helper-скрипт** `scripts/runserver.sh`:
```bash
#!/bin/bash
cd "$(dirname "$0")/.."
python manage.py runserver 0.0.0.0:8000
```

**ВАЖНО:** Добавьте в `settings.py`:
```python
ALLOWED_HOSTS = ['localhost', '127.0.0.1', '172.25.96.1']
```

### Flask

```python
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
```

### FastAPI

```python
import uvicorn

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
```

### Node.js / Express

```javascript
const express = require('express');
const app = express();

app.listen(3000, '0.0.0.0', () => {
  console.log('Server listening on 0.0.0.0:3000');
});
```

### Проверка, что сервер слушает правильно

В PowerShell на Windows:
```powershell
# Должно показывать 0.0.0.0:PORT или *:PORT
netstat -ano | Select-String ':5173' | Select-String 'LISTENING'
netstat -ano | Select-String ':8000' | Select-String 'LISTENING'

# Пример правильного вывода:
# TCP    0.0.0.0:5173          0.0.0.0:0              LISTENING       12345

# Неправильно (только localhost):
# TCP    127.0.0.1:5173        0.0.0.0:0              LISTENING       12345
```

---

## 🌐 Настройка Chrome DevTools

Chrome должен быть запущен с флагом `--remote-debugging-port` и слушать на `127.0.0.1`.

### Метод 1: Батник для запуска (рекомендуется)

Создайте `C:\chrome-debug.bat`:

```batch
@echo off
REM Закрыть все экземпляры Chrome
taskkill /F /IM chrome.exe 2>nul

REM Подождать
timeout /t 2 /nobreak >nul

REM Запустить Chrome в debug режиме
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9223 ^
  --remote-debugging-address=127.0.0.1 ^
  --user-data-dir="C:\chrome-debug-profile" ^
  --no-first-run ^
  --no-default-browser-check

echo Chrome started with DevTools on port 9223
```

**Настройки:**
- `--remote-debugging-port=9223` - порт для DevTools Protocol
- `--remote-debugging-address=127.0.0.1` - слушать на localhost (безопасность)
- `--user-data-dir` - отдельный профиль для debug режима
- `--no-first-run` - пропустить welcome screen
- `--no-default-browser-check` - не проверять дефолтный браузер

**Запуск:**
```bash
# Из WSL
powershell.exe -Command "Start-Process 'C:\chrome-debug.bat'"

# Или двойной клик в Windows Explorer
```

### Метод 2: Ярлык на рабочем столе

1. Создайте ярлык Chrome на рабочем столе
2. ПКМ → Свойства → Ярлык
3. В поле "Объект" добавьте флаги:
```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1 --user-data-dir="C:\chrome-debug-profile"
```

### Метод 3: PowerShell скрипт

`C:\scripts\start-chrome-debug.ps1`:
```powershell
# Закрыть Chrome
Get-Process -Name chrome -ErrorAction SilentlyContinue | Stop-Process -Force

Start-Sleep -Seconds 2

# Запустить с DevTools
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  -ArgumentList "--remote-debugging-port=9223", `
                "--remote-debugging-address=127.0.0.1", `
                "--user-data-dir=C:\chrome-debug-profile"

Write-Host "Chrome started on port 9223"
```

Запуск из WSL:
```bash
powershell.exe -ExecutionPolicy Bypass -File "C:\scripts\start-chrome-debug.ps1"
```

### Проверка работы Chrome DevTools

```bash
# Из WSL (после настройки проброса портов)
WIN_IP=$(ip route show | grep -i default | awk '{ print $3}')

# Должен вернуть JSON с версией Chrome
curl http://$WIN_IP:9223/json/version

# Список открытых вкладок
curl http://$WIN_IP:9223/json/list

# Должно вернуть:
# {
#   "Browser": "Chrome/131.0.6778.86",
#   "Protocol-Version": "1.3",
#   "User-Agent": "Mozilla/5.0 ...",
#   "webSocketDebuggerUrl": "ws://127.0.0.1:9223/devtools/browser/..."
# }
```

### Автозапуск Chrome при старте Windows

**Task Scheduler:**
1. Откройте **Task Scheduler**
2. **Create Task** → **General**:
   - Name: `Chrome Debug Mode`
   - Run whether user is logged on or not
3. **Triggers** → **New**:
   - Begin the task: At startup
4. **Actions** → **New**:
   - Action: Start a program
   - Program: `C:\chrome-debug.bat`
5. **OK** → Введите пароль администратора

Теперь Chrome будет запускаться в debug режиме при каждой загрузке Windows.

---

## 🔧 Конфигурация DevChrome MCP

### Структура проекта

```
devchrome-mcp/
├── mcp_server.js          # MCP сервер
├── package.json
├── .env                   # Конфигурация (НЕ коммитить!)
├── WSL_SETUP_GUIDE.md     # Этот файл
└── README.md
```

### Настройка .env

Создайте `.env` в корне проекта:

```bash
# Chrome Remote Debugging URL
# Должен указывать на Windows IP с пробросом порта
CHROME_REMOTE_URL=http://172.25.96.1:9223

# Опционально: Figma API token
FIGMA_TOKEN=your-figma-token-here
```

**ВАЖНО:**
- Используйте IP адрес Windows хоста (обычно `172.25.96.1`)
- НЕ используйте `localhost` или `127.0.0.1` - это не сработает из WSL!
- Убедитесь, что порт 9223 пробросен через `netsh`

### Динамическое определение IP

Для автоматического определения Windows IP можно использовать:

`mcp_server.js`:
```javascript
import { execSync } from 'child_process';

// Получить Windows IP автоматически
function getWindowsHostIP() {
  try {
    const output = execSync("ip route show | grep -i default | awk '{ print $3}'", {
      encoding: 'utf-8'
    }).trim();
    return output || '172.25.96.1'; // fallback
  } catch (error) {
    return '172.25.96.1'; // default fallback
  }
}

const WIN_IP = getWindowsHostIP();
const CHROME_REMOTE_URL = process.env.CHROME_REMOTE_URL || `http://${WIN_IP}:9223`;

console.log(`Using Chrome at: ${CHROME_REMOTE_URL}`);
```

### Установка зависимостей

```bash
cd /mnt/c/prj/devchrome-mcp

# Установка через npm (в WSL)
npm install

# Или через PowerShell на Windows (если нужно)
powershell.exe -Command "Set-Location 'C:\prj\devchrome-mcp'; npm install"
```

### Запуск MCP сервера

```bash
# Из WSL
cd /mnt/c/prj/devchrome-mcp
node mcp_server.js

# Сервер должен запуститься и показать:
# DevChrome MCP Server starting...
# Using Chrome at: http://172.25.96.1:9223
# MCP Server running on stdio
```

### Конфигурация Claude Code

Claude Code автоматически подключает MCP серверы из `~/.config/claude/claude_desktop_config.json` (или аналог для CLI).

Пример конфигурации (если нужно вручную):
```json
{
  "mcpServers": {
    "devchrome": {
      "command": "node",
      "args": ["/mnt/c/prj/devchrome-mcp/mcp_server.js"],
      "env": {
        "CHROME_REMOTE_URL": "http://172.25.96.1:9223"
      }
    }
  }
}
```

### Проверка подключения

В Claude Code:
```bash
# Список доступных MCP инструментов
# Должны появиться инструменты с префиксом mcp__devchrome__

# Проверка подключения
mcp__devchrome__ping({ message: "test" })

# Получить версию Chrome
curl http://172.25.96.1:9223/json/version
```

---

## 🐛 Типичные проблемы и решения

### 1. Connection Refused при обращении к Chrome

**Симптомы:**
```bash
curl http://172.25.96.1:9223/json/version
# curl: (7) Failed to connect to 172.25.96.1 port 9223: Connection refused
```

**Причины и решения:**

✅ **Проверка 1: Chrome запущен в debug режиме?**
```bash
powershell.exe -Command "Get-Process chrome"
```
Если нет - запустите через батник `C:\chrome-debug.bat`

✅ **Проверка 2: Проброс порта настроен?**
```bash
powershell.exe -Command "netsh interface portproxy show all"
```
Должна быть строка с `9223`. Если нет:
```bash
~/.claude/scripts/setup-port-forwarding.sh add 9223
```

✅ **Проверка 3: Firewall не блокирует?**
```powershell
# В PowerShell на Windows
Get-NetFirewallRule | Where-Object {$_.LocalPort -eq 9223}
```
Если правила нет - добавьте (см. раздел Firewall)

✅ **Проверка 4: Chrome слушает на правильном порту?**
```powershell
# В PowerShell на Windows
netstat -ano | Select-String ':9223'
```
Должно показывать `LISTENING`. Если нет - перезапустите Chrome с правильными флагами.

### 2. Vite dev server недоступен из WSL

**Симптомы:**
```bash
curl http://172.25.96.1:5173
# curl: (7) Failed to connect...
```

**Решения:**

✅ **Vite слушает на 0.0.0.0?**

Проверьте `vite.config.ts`:
```typescript
server: {
  host: '0.0.0.0',  // ← Должно быть!
  port: 5173
}
```

Или запускайте:
```bash
npm run dev -- --host 0.0.0.0
```

✅ **Проброс порта 5173?**
```bash
~/.claude/scripts/setup-port-forwarding.sh add 5173
```

✅ **Firewall правило?**
```powershell
New-NetFirewallRule -DisplayName "WSL Vite" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow
```

### 3. Windows IP изменился

**Симптомы:**
После перезагрузки Windows/WSL IP адрес изменился с `172.25.96.1` на другой.

**Решение:**

```bash
# Узнать актуальный IP
ip route show | grep -i default | awk '{ print $3}'

# Обновить пробросы портов с новым IP
powershell.exe -Command "netsh interface portproxy reset"
~/.claude/scripts/setup-port-forwarding.sh add 9223
~/.claude/scripts/setup-port-forwarding.sh add 5173
~/.claude/scripts/setup-port-forwarding.sh add 8000
```

**Автоматизация:**

Добавьте в `.bashrc` / `.zshrc`:
```bash
export WIN_HOST_IP=$(ip route show | grep -i default | awk '{ print $3}')
```

Используйте переменную в `.env`:
```bash
CHROME_REMOTE_URL=http://$WIN_HOST_IP:9223
```

### 4. DevChrome MCP не видит инструменты

**Симптомы:**
Claude Code не показывает MCP инструменты с префиксом `mcp__devchrome__`

**Решения:**

✅ **MCP сервер запущен?**
```bash
ps aux | grep mcp_server
```

✅ **Проверить логи Claude Code**

✅ **Переподключить MCP:**
В Claude Code перезапустите сессию или перезапустите сам Claude Code.

✅ **Проверить конфигурацию MCP:**
Убедитесь, что `claude_desktop_config.json` (или аналог) правильно указывает на MCP сервер.

### 5. Порты заняты другим процессом

**Симптомы:**
```
Port 9223 is already in use
```

**Решение:**

Узнать, кто занял порт:
```powershell
# Windows PowerShell
netstat -ano | Select-String ':9223'
# Последняя колонка - PID процесса

# Убить процесс
taskkill /PID <PID> /F
```

Или через WSL:
```bash
powershell.exe -Command "Get-Process -Id (Get-NetTCPConnection -LocalPort 9223).OwningProcess | Stop-Process -Force"
```

### 6. После перезагрузки всё перестало работать

**Причина:** Пробросы портов НЕ сохраняются после перезагрузки Windows

**Решение:**

```bash
# Пересоздать пробросы
~/.claude/scripts/setup-port-forwarding.sh add 9223
~/.claude/scripts/setup-port-forwarding.sh add 5173
~/.claude/scripts/setup-port-forwarding.sh add 8000

# Перезапустить Chrome
powershell.exe -Command "Start-Process 'C:\chrome-debug.bat'"
```

**Автоматизация:**

Создайте скрипт для быстрого восстановления `~/restore-wsl-env.sh`:
```bash
#!/bin/bash

echo "Restoring WSL development environment..."

# Port forwarding
~/.claude/scripts/setup-port-forwarding.sh add 9223
~/.claude/scripts/setup-port-forwarding.sh add 5173
~/.claude/scripts/setup-port-forwarding.sh add 8000

# Start Chrome
powershell.exe -Command "Start-Process 'C:\chrome-debug.bat'" 2>/dev/null

echo "Environment restored!"
echo "Chrome DevTools: http://172.25.96.1:9223"
echo "Vite: http://172.25.96.1:5173"
echo "Django: http://172.25.96.1:8000"
```

### 7. CORS ошибки при работе с frontend

**Симптомы:**
```
Access to fetch at 'http://172.25.96.1:8000/api/' from origin 'http://localhost:5173'
has been blocked by CORS policy
```

**Решение для Django:**

`settings.py`:
```python
CORS_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://172.25.96.1:5173",
]

# Или для разработки:
CORS_ALLOW_ALL_ORIGINS = True  # ⚠️ Только для dev!
```

---

## ✅ Чек-лист для нового проекта

### Первичная настройка (один раз)

- [ ] Установить WSL2
- [ ] Создать helper скрипты:
  - [ ] `~/.claude/scripts/pwsh.sh`
  - [ ] `~/.claude/scripts/win-ip.sh`
  - [ ] `~/.claude/scripts/setup-port-forwarding.sh`
- [ ] Добавить в `.bashrc` / `.zshrc`:
  ```bash
  export WIN_HOST_IP=$(ip route show | grep -i default | awk '{ print $3}')
  ```
- [ ] Создать `C:\chrome-debug.bat`
- [ ] Настроить Task Scheduler для автозапуска Chrome (опционально)

### Для каждого нового проекта

- [ ] Определить порты проекта (frontend, backend, etc.)
- [ ] Настроить dev-серверы на `host: 0.0.0.0`:
  - [ ] Vite: `vite.config.ts` → `server.host: '0.0.0.0'`
  - [ ] Django: `runserver 0.0.0.0:8000`
  - [ ] Другие: аналогично
- [ ] Добавить `ALLOWED_HOSTS` в Django (если используется)
- [ ] Настроить проброс портов:
  ```bash
  ~/.claude/scripts/setup-port-forwarding.sh add 5173  # Frontend
  ~/.claude/scripts/setup-port-forwarding.sh add 8000  # Backend
  ~/.claude/scripts/setup-port-forwarding.sh add 9223  # Chrome DevTools
  ```
- [ ] Добавить Firewall правила для портов
- [ ] Создать `.env` для DevChrome MCP:
  ```bash
  CHROME_REMOTE_URL=http://172.25.96.1:9223
  ```
- [ ] Запустить Chrome в debug режиме
- [ ] Проверить подключение:
  ```bash
  curl http://172.25.96.1:9223/json/version  # Chrome
  curl http://172.25.96.1:5173               # Frontend
  curl http://172.25.96.1:8000/api/          # Backend
  ```

### Перед началом работы (каждый раз)

- [ ] Проверить Windows IP:
  ```bash
  echo $WIN_HOST_IP
  ```
- [ ] Проверить пробросы портов:
  ```bash
  ~/.claude/scripts/setup-port-forwarding.sh list
  ```
- [ ] Запустить Chrome (если не автозапуск):
  ```bash
  powershell.exe -Command "Start-Process 'C:\chrome-debug.bat'"
  ```
- [ ] Запустить dev-серверы:
  ```bash
  # Frontend (Windows)
  cd /mnt/c/prj/my-project/frontend
  npm run dev

  # Backend (Windows)
  cd /mnt/c/prj/my-project/backend
  python manage.py runserver 0.0.0.0:8000
  ```
- [ ] Проверить доступность в браузере:
  - [ ] Frontend: `http://localhost:5173`
  - [ ] Backend: `http://172.25.96.1:8000`
  - [ ] Chrome DevTools: `http://172.25.96.1:9223/json/version`

---

## 📚 Полезные алиасы для .bashrc / .zshrc

```bash
# Добавьте в ~/.bashrc или ~/.zshrc

# Windows Host IP
export WIN_HOST_IP=$(ip route show | grep -i default | awk '{ print $3}')

# Shortcuts
alias pwsh='~/.claude/scripts/pwsh.sh'
alias win-ip='echo $WIN_HOST_IP'
alias ports='~/.claude/scripts/setup-port-forwarding.sh'

# Project navigation
alias cdprj='cd /mnt/c/prj'
alias cddh='cd /mnt/c/prj/digital-heir'
alias cddhf='cd /mnt/c/prj/digital-heir-front'

# Quick checks
alias check-chrome='curl -s http://$WIN_HOST_IP:9223/json/version | jq'
alias check-vite='curl -I http://$WIN_HOST_IP:5173'
alias check-django='curl -s http://$WIN_HOST_IP:8000/api/'

# Port forwarding shortcuts
alias ports-setup='ports add 9223 && ports add 5173 && ports add 8000'
alias ports-list='ports list'
alias ports-reset='powershell.exe -Command "netsh interface portproxy reset"'

# Chrome
alias chrome-start='powershell.exe -Command "Start-Process \"C:\\chrome-debug.bat\""'
alias chrome-kill='powershell.exe -Command "taskkill /F /IM chrome.exe"'
alias chrome-restart='chrome-kill && sleep 2 && chrome-start'

# Show all WSL env
alias wsl-status='echo "Windows IP: $WIN_HOST_IP" && echo "" && echo "Port Forwarding:" && ports list && echo "" && echo "Chrome DevTools:" && curl -s http://$WIN_HOST_IP:9223/json/version | jq -r ".Browser" 2>/dev/null || echo "Not available"'
```

**Использование:**
```bash
# Получить Windows IP
win-ip

# Настроить все порты
ports-setup

# Проверить Chrome
check-chrome

# Показать статус окружения
wsl-status

# Перезапустить Chrome
chrome-restart
```

---

## 🎯 Быстрый старт для нового разработчика

```bash
# 1. Клонируйте репозиторий
git clone https://github.com/your-org/devchrome-mcp.git /mnt/c/prj/devchrome-mcp
cd /mnt/c/prj/devchrome-mcp

# 2. Установите зависимости
npm install

# 3. Создайте .env
cat > .env << EOF
CHROME_REMOTE_URL=http://172.25.96.1:9223
EOF

# 4. Настройте helper скрипты (см. разделы выше)

# 5. Настройте проброс портов
~/.claude/scripts/setup-port-forwarding.sh add 9223

# 6. Создайте батник для Chrome (C:\chrome-debug.bat)

# 7. Запустите Chrome
powershell.exe -Command "Start-Process 'C:\chrome-debug.bat'"

# 8. Проверьте подключение
curl http://172.25.96.1:9223/json/version

# 9. Готово! Запускайте MCP сервер
node mcp_server.js
```

---

## 📖 Дополнительные ресурсы

### Документация
- [WSL Documentation](https://docs.microsoft.com/en-us/windows/wsl/)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Vite Server Options](https://vitejs.dev/config/server-options.html)
- [Django ALLOWED_HOSTS](https://docs.djangoproject.com/en/stable/ref/settings/#allowed-hosts)

### Troubleshooting
- [WSL Networking](https://docs.microsoft.com/en-us/windows/wsl/networking)
- [Port Forwarding in WSL2](https://learn.microsoft.com/en-us/windows/wsl/networking#accessing-windows-networking-apps-from-linux-host-ip)

---

**Версия:** 1.0
**Дата:** 2025-10-23
**Автор:** Claude Code Team
**Для:** WSL2 + Windows 11

---

## 💡 Советы и лучшие практики

1. **Всегда используйте переменную окружения** для Windows IP вместо хардкода
2. **Создавайте батники** для частых операций (запуск Chrome, настройка портов)
3. **Документируйте порты проекта** в README.md
4. **Используйте Task Scheduler** для автоматизации после перезагрузки
5. **Храните .env в .gitignore** - он может содержать токены
6. **Тестируйте доступность** перед началом работы (`curl` проверки)
7. **Используйте алиасы** для ускорения работы

---

Если что-то не работает - проверяйте по чек-листу в разделе "Типичные проблемы"! 🚀
