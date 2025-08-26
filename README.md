# devchrome-mcp

MCP (Model Context Protocol) сервер для работы с браузером через Puppeteer. Предоставляет инструменты для взаимодействия с веб-страницами через Chrome DevTools Protocol.

## Установка

### Через NPM (глобальная установка)

```bash
# Установить пакет глобально
npm install -g devchrome-mcp

# Добавить MCP сервер в Claude Code
claude mcp add chrome "npx devchrome-mcp"

# Проверить подключение
claude mcp list
```

### Локальная установка

```bash
# Клонировать репозиторий
git clone https://github.com/your-username/devchrome-mcp.git
cd devchrome-mcp

# Установить зависимости
npm install

# Добавить в Claude Code (Windows)
claude mcp add chrome "node" "C:\\path\\to\\devchrome-mcp\\mcp_server.js"

# Добавить в Claude Code (Linux/Mac)  
claude mcp add chrome "node" "/path/to/devchrome-mcp/mcp_server.js"
```

### Через пакет .tgz

```bash
# Создать пакет
npm pack

# На другом ПК установить
npm install -g ./devchrome-mcp-1.1.0.tgz

# Добавить в Claude Code
claude mcp add chrome "npx devchrome-mcp"
```

## Использование

### Как MCP сервер для Claude Code

После установки сервер автоматически подключается к Claude Code через stdio протокол.

### Доступные инструменты

#### ping
Диагностический инструмент для проверки соединения.

#### getElement
Получить HTML первого найденного элемента по CSS селектору.

#### getElementComputedCss
Получить вычисленные CSS стили элемента.

#### getElementListeners
Получить список обработчиков событий элемента.

#### getElements
Найти все элементы по CSS селектору.

#### getBoxModel
Получить метрики блочной модели элемента.

#### getParents
Получить родительские элементы.

#### setStyles
Применить CSS стили к элементу.

#### screenshot
Сделать скриншот элемента.

## Конфигурация

Переменные окружения:
- `PORT` - порт для запуска сервера (по умолчанию: 3058)

## Лицензия

ISC 