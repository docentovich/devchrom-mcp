# devchrome-mcp

MCP (Model Context Protocol) сервер для работы с браузером через Puppeteer. Предоставляет 41 профессиональных инструментов для frontend разработки, включая pixel-perfect тестирование, Figma интеграцию, AI промпт генерацию и комплексный анализ качества. **v1.7.2 включает готовые промпты-шаблоны для принуждения AI агентов к использованию MCP инструментов.**

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

#### Как извлечь параметры из Figma URL

Из ссылки Figma нужно извлечь два параметра:

```
https://www.figma.com/file/ABC123xyz/Project-Name?node-id=1%3A234
                           ↑                              ↑
                        fileKey                        nodeId
```

- **fileKey**: `ABC123xyz` (идентификатор файла)
- **nodeId**: `1:234` (замените %3A на : при декодировании)

#### Получение nodeId для конкретного элемента

1. Откройте файл в Figma
2. Выберите нужный фрейм или компонент
3. Правый клик → **Copy/Paste as** → **Copy link**
4. Из скопированной ссылки извлеките node-id

#### Примеры использования

```javascript
// Извлечь спецификации дизайна (тексты, цвета, шрифты)
mcp__chrome__getFigmaSpecs(null, "ABC123xyz", "1:234")

// Сравнить Figma дизайн с реализацией на сайте
mcp__chrome__compareFigmaToElement(null, "ABC123xyz", "1:234", "https://site.com", ".header")

// Получить изображение фрейма из Figma
mcp__chrome__getFigmaFrame(null, "ABC123xyz", "1:234")
```

#### Что можно получить из Figma

- **getFigmaSpecs**: все тексты, шрифты, цвета, размеры, отступы
- **getFigmaFrame**: PNG изображение фрейма для визуального сравнения
- **compareFigmaToElement**: автоматическое сравнение дизайна с реализацией

#### Пример промпта для AI агента

```
Проанализируй текст из Figma дизайна:
URL: https://www.figma.com/file/ABC123xyz/MyProject?node-id=1%3A234

1. Извлеки fileKey и nodeId из URL
2. Используй getFigmaSpecs для получения всех текстов
3. Проверь тексты на орфографию и грамматику
4. Сравни с реализацией на сайте example.com
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

### Доступные инструменты (41 инструмент)

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
- **extractFigmaTexts** ⭐ - извлечение всех текстов со стилями из Figma
- **batchCompareFigmaFrames** ⭐ - пакетное сравнение множества элементов
- **exportFigmaFrame** - альтернативный рабочий экспорт из Figma
- **downloadFigmaImage** - простое скачивание изображений из Figma

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

## 🤖 MCP Prompt Templates для AI агентов

**ВАЖНО**: AI агенты часто пытаются создавать собственные решения вместо использования готовых MCP инструментов. Используйте эти промпты, чтобы заставить AI применять MCP tools!

### 🔧 Разработка элемента

```
ЗАДАЧА: Создать новый компонент кнопки по Figma дизайну

ОБЯЗАТЕЛЬНО используй только MCP инструменты:
1. mcp__devchrome__getFigmaSpecs - извлеки все стили из Figma
2. mcp__devchrome__extractFigmaTexts - получи все тексты кнопки
3. mcp__devchrome__generateCSSFromFigma - сгенерируй CSS код
4. mcp__devchrome__compareFigmaToElement - сравни с реализацией

НЕ создавай CSS вручную! Используй MCP для генерации.

Figma URL: [вставь ссылку]
Реализация: [URL страницы]
Селектор: .button
```

### 🏗️ Разработка целой страницы или большого компонента

```
ЗАДАЧА: Реализовать страницу dashboard по Figma макету

СТРОГО следуй этапам с MCP инструментами:
1. mcp__devchrome__autoMapFigmaToHTML - автоматически сопоставь все элементы
2. mcp__devchrome__batchCompareFigmaFrames - массово сравни все компоненты
3. mcp__devchrome__runFigmaValidationSuite - запуsti комплексную валидацию
4. mcp__devchrome__generateComparisonReport - создай отчет для команды

НЕ анализируй элементы по одному! Используй batch-обработку.

Figma URL: [ссылка на корневой фрейм]
Dev URL: [ссылка на страницу]
```

### 🔨 Исправление верстки

```
ЗАДАЧА: Исправить проблемы в верстке header компонента

ОБЯЗАТЕЛЬНЫЙ порядок действий:
1. mcp__devchrome__compareFigmaToElement - найди отличия от дизайна
2. mcp__devchrome__compareFonts - проверь типографику
3. mcp__devchrome__compareSpacing - проверь отступы
4. mcp__devchrome__compareColors - проверь цвета
5. mcp__devchrome__generateCSSFromFigma - получи правильный CSS

НЕ пиши CSS код руками! Генерируй через MCP.

Figma: [ссылка]
Сайт: [URL]
Проблемный элемент: [селектор]
```

### 🐛 Исправление консольных JS ошибок

```
ЗАДАЧА: Исправить JavaScript ошибки на странице

Используй MCP для диагностики:
1. mcp__devchrome__generateAIPrompt - создай prompt для анализа ошибок
2. mcp__devchrome__getElementListeners - проверь event handlers
3. mcp__devchrome__verifyInteractions - протестируй интерактивность
4. mcp__devchrome__validateHTML - проверь HTML структуру

НЕ гадай что сломано! Используй MCP для точной диагностики.

URL страницы: [ссылка]
Ошибка: [текст ошибки из консоли]
```

### ✨ Доведение до pixel perfect

```
ЗАДАЧА: Добиться 100% соответствия дизайну

Обязательная последовательность MCP инструментов:
1. mcp__devchrome__compareVisualAdvanced - получи heat map различий
2. mcp__devchrome__measureElement - точные размеры элементов
3. mcp__devchrome__compareWithTolerance - настрой допуски
4. mcp__devchrome__createVisualDiff - создай аннотированные скриншоты

НЕ проверяй "на глаз"! Используй только инструменты измерения.

Figma: [ссылка]
Реализация: [URL]
Элемент: [селектор]
Требуемая точность: 98%
```

### 🖼️ Экспорт и вставка картинок

```
ЗАДАЧА: Экспортировать изображения из Figma и оптимизировать

Используй MCP инструменты:
1. mcp__devchrome__getFigmaFrame - экспорт в высоком качестве
2. mcp__devchrome__exportFigmaFrame - альтернативный экспорт
3. mcp__devchrome__downloadFigmaImage - простой экспорт
4. mcp__devchrome__getPerformanceMetrics - проверь влияние на производительность

НЕ скачивай изображения вручную! Используй Figma API через MCP.

Figma элементы: [список node ID]
Формат: PNG/JPG/SVG
Масштаб: 1x/2x/4x
```

### 🌐 Responsive дизайн валидация

```
ЗАДАЧА: Проверить адаптивность на всех устройствах

Обязательный workflow с MCP:
1. mcp__devchrome__setViewport - мобильный (375x667)
2. mcp__devchrome__screenshot - скриншот мобильной версии
3. mcp__devchrome__setViewport - планшет (768x1024)
4. mcp__devchrome__screenshot - скриншот планшета
5. mcp__devchrome__setViewport - десктоп (1920x1080)
6. mcp__devchrome__compareVisualAdvanced - сравни все версии

НЕ меняй размеры браузера руками! Используй setViewport.

URL: [ссылка]
Компонент: [селектор]
```

### ♿ Аудит доступности (a11y)

```
ЗАДАЧА: Проверить WCAG 2.1 соответствие

Используй специальные MCP инструменты:
1. mcp__devchrome__getAccessibility - полный аудит доступности
2. mcp__devchrome__generateAIPrompt с типом "accessibility-audit"
3. mcp__devchrome__validateHTML - проверь семантическую разметку
4. mcp__devchrome__analyzeStructure - проверь иерархию заголовков

НЕ проверяй доступность вручную! Используй автоматические проверки MCP.

URL: [ссылка]
Уровень: AA/AAA
Фокус: [конкретные проблемы]
```

### 🚀 Performance аудит

```
ЗАДАЧА: Оптимизировать производительность страницы

Обязательные MCP инструменты:
1. mcp__devchrome__getPerformanceMetrics - Core Web Vitals
2. mcp__devchrome__generateAIPrompt с типом "performance-analysis"
3. mcp__devchrome__measureElement - проверь размеры тяжелых элементов
4. mcp__devchrome__validateHTML - найди неоптимальную разметку

НЕ используй внешние сервисы! MCP предоставляет все метрики.

URL: [ссылка]
Цель: LCP < 2.5s, FID < 100ms, CLS < 0.1
```

### 📚 Component library создание

```
ЗАДАЧА: Создать библиотеку компонентов из Figma

Пошаговый процесс с MCP:
1. mcp__devchrome__extractFigmaTexts - все тексты компонентов
2. mcp__devchrome__getFigmaSpecs - все стили и токены
3. mcp__devchrome__generateCSSFromFigma - CSS для каждого компонента
4. mcp__devchrome__autoMapFigmaToHTML - сопоставление с HTML
5. mcp__devchrome__runFigmaValidationSuite - валидация качества

НЕ создавай компоненты вручную! Автоматизируй через MCP.

Figma Design System: [ссылка]
Целевой фреймворк: React/Vue/Angular
```

### 🔄 Design system sync

```
ЗАДАЧА: Синхронизировать дизайн-токены из Figma

Обязательные MCP действия:
1. mcp__devchrome__getFigmaSpecs - извлеки все токены
2. mcp__devchrome__extractFigmaTexts - типографические стили
3. mcp__devchrome__generateCSSFromFigma - CSS переменные
4. mcp__devchrome__validateDesignSystem - проверь соответствие

НЕ копируй значения вручную! Используй автоматическое извлечение.

Figma Design System: [ссылка]
Формат вывода: CSS custom properties / SCSS / CSS-in-JS
```

### 🧪 Visual regression тестирование

```
ЗАДАЧА: Создать тесты для предотвращения визуальных регрессий

Автоматизация через MCP:
1. mcp__devchrome__batchCompareFigmaFrames - массовое тестирование
2. mcp__devchrome__compareVisualAdvanced - эталонные снимки
3. mcp__devchrome__compareWithTolerance - настройка допусков
4. mcp__devchrome__generateComparisonReport - отчеты для CI/CD

НЕ создавай тесты вручную! Используй batch-обработку MCP.

Эталон: Figma [ссылка]
Тестируемые URL: [список страниц]
Tolerance: 5% для layout, 1% для pixel-perfect
```

### 🎯 Общие правила для ALL промптов

```
КРИТИЧЕСКИ ВАЖНО:
❌ НЕ создавай CSS код вручную
❌ НЕ пиши собственные функции сравнения
❌ НЕ используй внешние инструменты
❌ НЕ анализируй элементы без MCP

✅ ВСЕГДА используй mcp__devchrome__ префикс
✅ СНАЧАЛА извлекай данные через MCP
✅ ИСПОЛЬЗУЙ batch-обработку для множественных задач
✅ ГЕНЕРИРУЙ код через MCP инструменты
✅ СОЗДАВАЙ отчеты через MCP

Если MCP инструмент существует - ИСПОЛЬЗУЙ ЕГО!
```

---

## 📋 Общие правила (для копирования)

```
КРИТИЧЕСКИ ВАЖНО для AI агентов:

❌ ЗАПРЕЩЕНО:
- Создавать CSS код вручную
- Писать собственные функции сравнения
- Использовать внешние инструменты
- Анализировать элементы без MCP
- Игнорировать доступные MCP инструменты
- Создавать обходные решения

✅ ОБЯЗАТЕЛЬНО:
- Использовать префикс mcp__devchrome__ для всех инструментов
- Извлекать данные только через MCP API
- Применять batch-обработку для множественных задач
- Генерировать код через MCP инструменты (не писать руками)
- Создавать отчеты через MCP generateComparisonReport
- Проверять доступность MCP инструмента перед любым действием

🔥 ЗОЛОТОЕ ПРАВИЛО: Если MCP инструмент существует - ИСПОЛЬЗУЙ ТОЛЬКО ЕГО!
```

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

### v1.8.0
- 📋 Продублированы "Общие правила" для удобного копирования
- 🎯 Расширенный раздел с запретами и обязательными действиями для AI
- 📚 Добавлено "Золотое правило" принуждения к использованию MCP
- 🔄 Минорные улучшения документации

### v1.7.0
- 🚀 Добавлены 2 новых инструмента автоматизации Figma
- ⭐ **extractFigmaTexts** - автоматическое извлечение всех текстов со стилями
- ⭐ **batchCompareFigmaFrames** - массовое сравнение множества элементов
- 📋 Добавлены MCP Prompt Templates для принуждения AI использовать MCP инструменты
- 🎯 11 готовых промптов для типовых сценариев разработки
- 📚 Детальные инструкции по автоматизации Figma-to-code workflow
- 🔧 Исправлены все ошибки обработки исключений в Figma инструментах

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