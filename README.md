# devchrome-mcp

MCP (Model Context Protocol) сервер для работы с браузером через Puppeteer. Предоставляет 37 профессиональных инструментов для frontend разработки, включая pixel-perfect тестирование, Figma интеграцию, AI промпт генерацию и комплексный анализ качества.

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

### Figma интеграция
```javascript
// С токеном в переменной окружения (рекомендуется)
mcp__chrome__compareFigmaToElement(null, "fileKey", "nodeId", url, ".header")

// С явной передачей токена
mcp__chrome__compareFigmaToElement("figma_token", "fileKey", "nodeId", url, ".header")

// Получить спецификации дизайна
mcp__chrome__getFigmaSpecs(null, "fileKey", "nodeId") // использует FIGMA_TOKEN из env
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

### AI промпт генерация
```javascript
// Генерация промпта для поиска багов
mcp__chrome__generateAIPrompt(url, null, "bug-report", {
  goal: "Найти визуальные и функциональные проблемы",
  focusAreas: ["формы", "адаптивность", "производительность"]
})

// Генерация промпта для code review
mcp__chrome__generateAIPrompt(url, ".header", "code-review", {
  goal: "Проверить качество реализации header компонента",
  outputFormat: "markdown"
})

// Генерация тест-кейсов
mcp__chrome__generateAIPrompt(url, null, "test-generation", {
  focusAreas: ["авторизация", "навигация", "формы оплаты"],
  outputFormat: "json"
})
```

### Доступные инструменты (37 инструментов)

#### 🔍 Диагностика и поиск элементов
- **ping** - диагностический инструмент для проверки соединения
- **getElement** - получить HTML разметку элемента для анализа структуры
- **getElements** - найти все элементы по CSS селектору
- **getParents** - получить родительские элементы с их стилями
- **getElementReact** - поддержка CSS модулей для React/Vue приложений
- **getElementsReact** - множественный поиск с поддержкой CSS модулей

#### 🎨 CSS и стили  
- **getElementComputedCss** - проанализировать примененные CSS стили
- **setStyles** - живое редактирование CSS для прототипирования
- **getBoxModel** - точные размеры, отступы и позиционирование

#### 📱 Viewport и адаптивность
- **getViewport** - получить размеры экрана и pixel ratio
- **setViewport** - изменить размеры для тестирования адаптивности

#### 🖱️ Интерактивность
- **click** - клики по элементам для тестирования интерфейса
- **hover** - проверка hover-эффектов и интерактивных состояний
- **scrollTo** - прокрутка к элементу для тестирования длинных страниц
- **getElementListeners** - список обработчиков событий элемента

#### 🎯 Визуальное тестирование и Pixel-Perfect
- **screenshot** - высококачественные скриншоты элементов
- **compareVisual** - базовое сравнение скриншотов
- **compareVisualAdvanced** - SSIM анализ и тепловые карты различий
- **measureElement** - точные размеры в пикселях для pixel-perfect верстки
- **analyzeColorDifferences** - анализ цветовых палитр и тем
- **createVisualDiff** - аннотированные скриншоты с визуализацией различий

#### 🎨 Figma интеграция
- **getFigmaFrame** - экспорт фреймов из Figma API
- **compareFigmaToElement** - прямое сравнение дизайна с реализацией
- **getFigmaSpecs** - извлечение дизайн-токенов (цвета, шрифты, отступы)

#### 📐 Детальное сравнение дизайна
- **compareFonts** - анализ типографики (размеры, начертания, семейства)
- **compareSpacing** - валидация отступов margin/padding
- **compareLayout** - анализ позиционирования Flexbox/Grid
- **compareWithTolerance** - сравнение с настраиваемой толерантностью

#### ✅ Валидация и качество
- **validateDesignSystem** - проверка соответствия дизайн-системе
- **analyzeStructure** - анализ DOM структуры и семантики
- **validateHierarchy** - проверка композиции компонентов
- **verifyInteractions** - тестирование интерактивных элементов
- **validateHTML** - валидация HTML разметки и выявление ошибок
- **getAccessibility** - анализ доступности и WCAG соответствия

#### 📊 Производительность и метрики
- **getPerformanceMetrics** - Core Web Vitals и метрики производительности

#### 📝 Отчетность
- **generateComparisonReport** - комплексные отчеты для стейкхолдеров

#### 🤖 AI интеграция (NEW!)
- **generateAIPrompt** - генерация контекстных промптов для AI агентов
  - Типы промптов: bug-report, code-review, test-generation, accessibility-audit, performance-analysis, design-review, content-review, seo-analysis, custom
  - Динамический анализ страницы с учетом форм, интерактивных элементов, медиа контента
  - Поддержка вывода в форматах: markdown, json, text

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
   - **Environment Variables** (для Figma интеграции):
     - `FIGMA_TOKEN`: `ваш_figma_токен`
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
      "env": {
        "FIGMA_TOKEN": "ваш_figma_токен_здесь"
      }
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
      "env": {
        "FIGMA_TOKEN": "ваш_figma_токен_здесь"
      }
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

### Переменные окружения

- `PORT` - порт для запуска сервера (по умолчанию: 3058)
- `FIGMA_TOKEN` - токен для Figma API (опционально)

### Настройка Figma интеграции

Для работы с Figma инструментами требуется токен доступа. Есть два способа его настройки:

#### Вариант 1: Через переменную окружения (рекомендуется)

Настройте `FIGMA_TOKEN` в конфигурации MCP сервера (см. примеры выше для Cursor IDE).

**Преимущества:**
- Токен безопасно хранится в конфигурации
- Не нужно передавать токен при каждом вызове
- Легко обновить для всех инструментов сразу

#### Вариант 2: Передача токена в параметрах

Передавайте токен напрямую при вызове инструментов:

```javascript
mcp__chrome__getFigmaFrame("ваш_токен", "fileKey", "nodeId")
```

### Как получить Figma токен

1. Зайдите в Figma → **Settings** → **Account** → **Personal access tokens**
2. Нажмите **Create new token**
3. Введите описание токена (например, "DevChrome MCP")
4. Скопируйте токен (показывается только один раз!)
5. Добавьте токен в конфигурацию MCP или используйте при вызовах

### Безопасность токена

- **Используйте** токены с правами только на чтение (read-only)
- **Не коммитьте** токены в git репозиторий
- **Регулярно обновляйте** токены для безопасности
- **Отзывайте** неиспользуемые токены в настройках Figma

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

### v1.6.0
- 🔐 Добавлена поддержка Figma токена через переменную окружения FIGMA_TOKEN
- 📋 Figma инструменты теперь могут использовать токен из конфигурации MCP
- 📚 Улучшена документация по настройке Figma интеграции
- 🔧 Токен больше не нужно передавать при каждом вызове

### v1.5.0
- 🤖 Добавлен инструмент generateAIPrompt для генерации AI промптов
- 📝 9 типов промптов: bug-report, code-review, test-generation, accessibility-audit и др.
- 🔍 Динамический анализ страницы для контекстной генерации
- 📊 Поддержка вывода в форматах markdown, json, text

### v1.4.1
- 🔗 Обновлены ссылки на GitHub репозиторий
- 📚 Улучшена документация по установке в Cursor IDE

### v1.4.0
- ✨ Добавлено 18 новых инструментов визуального тестирования
- 🎨 Интеграция с Figma API (getFigmaFrame, compareFigmaToElement, getFigmaSpecs)
- 🔬 Продвинутое визуальное сравнение (SSIM анализ, тепловые карты)
- 📐 Детальное сравнение дизайна (шрифты, отступы, layout)
- ✅ Валидация дизайн-системы и структуры компонентов
- 📊 Генерация комплексных отчетов для стейкхолдеров

### v1.2.2
- 📖 Обновлен README с примерами и troubleshooting
- 🧹 Упрощена установка (только через npm)

### v1.2.1
- ✅ Добавлено 19 базовых инструментов
- ✅ Pixel-perfect тестирование (compareVisual, measureElement)  
- ✅ Performance анализ (Core Web Vitals)
- ✅ Accessibility проверки (WCAG compliance)
- ✅ Responsive тестирование (viewport управление)
- ✅ Интерактивное тестирование (click, hover, scroll)

## Лицензия

ISC 