# devchrome-mcp

MCP (Model Context Protocol) сервер для работы с браузером через Puppeteer. Предоставляет 19 профессиональных инструментов для frontend разработки, включая pixel-perfect тестирование, performance анализ и accessibility проверки.

## Системные требования

- **Node.js** >= 18.0.0
- **Claude Code** (для MCP интеграции)
- **Chrome/Chromium** (автоматически устанавливается через Puppeteer)

## Установка

### Через NPM (глобальная установка)

```bash
# Установить пакет глобально
npm install -g devchrome-mcp

# Добавить MCP сервер в Claude Code
claude mcp add chrome "npx devchrome-mcp"

# Проверить подключение
claude mcp list

# Тестирование
claude mcp test chrome ping "Hello World"
```

### Локальная установка

```bash
# Клонировать репозиторий
git clone https://github.com/yourusername/devchrome-mcp.git
cd devchrome-mcp

# Установить зависимости
npm install

# Добавить в Claude Code (Windows)
claude mcp add chrome "node" "C:\\path\\to\\devchrome-mcp\\mcp_server.js"

# Добавить в Claude Code (Linux/Mac)  
claude mcp add chrome "node" "/path/to/devchrome-mcp/mcp_server.js"
```


## Использование

### Как MCP сервер для Claude Code

После установки сервер автоматически подключается к Claude Code через stdio протокол.

## Быстрый старт

```bash
# 1. Установка и настройка
npm install -g devchrome-mcp
claude mcp add chrome "npx devchrome-mcp"

# 2. Проверка работы
claude mcp test chrome ping "Test message"

# 3. Готово! Теперь доступны все инструменты через префикс mcp__chrome__
```

## Примеры использования

### Pixel-Perfect тестирование
```javascript
// Сравнить дизайн с реализацией
mcp__chrome__compareVisual(designUrl, devUrl, ".header")

// Точные размеры элемента
mcp__chrome__measureElement(url, ".button")
```

### Responsive тестирование
```javascript
// Мобильный viewport
mcp__chrome__setViewport(url, 375, 667)
mcp__chrome__screenshot(url, ".component")

// Desktop viewport  
mcp__chrome__setViewport(url, 1920, 1080)
mcp__chrome__screenshot(url, ".component")
```

### Performance анализ
```javascript
// Core Web Vitals
mcp__chrome__getPerformanceMetrics(url)

// Accessibility проверка
mcp__chrome__getAccessibility(url)
```

### Доступные инструменты

#### Диагностика и отладка
- **ping** - диагностический инструмент для проверки соединения
- **getElement** - получить HTML разметку элемента для анализа структуры
- **getElements** - найти все элементы по CSS селектору
- **getParents** - получить родительские элементы с их стилями

#### CSS и стили  
- **getElementComputedCss** - проанализировать примененные CSS стили
- **setStyles** - живое редактирование CSS для прототипирования
- **getBoxModel** - точные размеры, отступы и позиционирование

#### Viewport и адаптивность
- **getViewport** - получить размеры экрана и pixel ratio
- **setViewport** - изменить размеры для тестирования адаптивности

#### Интерактивность
- **click** - клики по элементам для тестирования интерфейса
- **hover** - проверка hover-эффектов и интерактивных состояний
- **scrollTo** - прокрутка к элементу для тестирования длинных страниц
- **getElementListeners** - список обработчиков событий элемента

#### Визуальное тестирование и Pixel-Perfect
- **screenshot** - высококачественные скриншоты элементов
- **compareVisual** - сравнение скриншотов для visual regression testing
- **measureElement** - точные размеры в пикселях для pixel-perfect верстки

#### Производительность и качество
- **getPerformanceMetrics** - Core Web Vitals и метрики производительности
- **validateHTML** - валидация HTML разметки и выявление ошибок
- **getAccessibility** - анализ доступности и WCAG соответствия

## Настройка для других AI агентов

### Cursor IDE

#### Способ 1: Через настройки интерфейса (рекомендуется)

1. Откройте Cursor IDE
2. Перейдите в **Settings** → **Features** → **MCP**
3. Нажмите **Add Server** и заполните поля:
   - **Name**: `devchrome`
   - **Command**: `npx`
   - **Arguments**: `devchrome-mcp`
   - **Protocol**: `stdio` (по умолчанию)
4. Нажмите **Save** и перезапустите Cursor

#### Способ 2: Через конфигурационный файл

Добавьте в файл настроек Cursor:
- **Windows**: `%APPDATA%\Cursor\User\mcp.json`
- **macOS**: `~/Library/Application Support/Cursor/User/mcp.json`
- **Linux**: `~/.config/Cursor/User/mcp.json`

```json
{
  "mcpServers": {
    "devchrome": {
      "command": "npx",
      "args": ["devchrome-mcp"],
      "env": {}
    }
  }
}
```

#### Способ 3: Локальная установка для разработки

```json
{
  "mcpServers": {
    "devchrome": {
      "command": "node",
      "args": ["C:/path/to/devchrome-mcp/mcp_server.js"],
      "env": {}
    }
  }
}
```

#### Проверка подключения в Cursor

1. Откройте новый чат в Cursor
2. В правом нижнем углу должна появиться иконка MCP
3. Нажмите на нее и убедитесь, что `devchrome` в списке активных серверов
4. Попробуйте использовать команду: спросите у ассистента "Use devchrome to ping test"

### Другие MCP-совместимые агенты

Используйте стандартную конфигурацию MCP:
- **command**: `npx`
- **args**: `["devchrome-mcp"]`
- **protocol**: `stdio`

## Конфигурация

Переменные окружения:
- `PORT` - порт для запуска сервера (по умолчанию: 3058)

## Troubleshooting

### Новые инструменты не видны
```bash
# Переустановите пакет и обновите MCP
npm uninstall -g devchrome-mcp
npm install -g devchrome-mcp
claude mcp remove chrome
claude mcp add chrome "npx devchrome-mcp"
```

### Проблемы с Puppeteer
```bash
# Переустановка с принудительной загрузкой Chrome
npm uninstall -g devchrome-mcp
npm install -g devchrome-mcp --force
```

### Проверка версии
```bash
npm list -g devchrome-mcp
claude mcp test chrome ping "version check"
```

## Changelog

### v1.2.2
- 📖 Обновлен README с примерами и troubleshooting
- 🧹 Упрощена установка (только через npm)

### v1.2.1
- ✅ Добавлено 19 профессиональных инструментов
- ✅ Pixel-perfect тестирование (compareVisual, measureElement)  
- ✅ Performance анализ (Core Web Vitals)
- ✅ Accessibility проверки (WCAG compliance)
- ✅ Responsive тестирование (viewport управление)
- ✅ Интерактивное тестирование (click, hover, scroll)

## Лицензия

ISC 