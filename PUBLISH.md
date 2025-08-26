# Инструкция по публикации в npm

## Подготовка к публикации

1. **Обновите информацию в package.json:**
   - Замените `"Your Name <your.email@example.com>"` на ваши реальные данные
   - Обновите `repository.url` на реальный URL вашего GitHub репозитория
   - Обновите `bugs.url` и `homepage` соответственно

2. **Проверьте, что вы залогинены в npm:**
   ```bash
   npm whoami
   ```

3. **Если не залогинены, выполните вход:**
   ```bash
   npm login
   ```

## Публикация

### Первая публикация
```bash
npm publish
```

### Обновление версии и публикация
```bash
# Увеличить версию (patch, minor, major)
npm version patch
npm version minor
npm version major

# Или установить конкретную версию
npm version 1.1.0

# Опубликовать
npm publish
```

### Публикация с тегом
```bash
npm publish --tag beta
npm publish --tag latest
```

## Проверка перед публикацией

1. **Проверьте содержимое пакета:**
   ```bash
   npm pack --dry-run
   ```

2. **Проверьте, что все файлы включены:**
   ```bash
   npm pack
   tar -tf devchrome-mcp-*.tgz
   ```

3. **Тестируйте локально:**
   ```bash
   npm link
   devchrome-mcp
   ```

## Важные замечания

- Убедитесь, что имя пакета `devchrome-mcp` доступно в npm реестре
- Проверьте, что все зависимости указаны правильно
- Убедитесь, что файл `mcp_server.js` имеет shebang `#!/usr/bin/env node`
- Проверьте, что все необходимые файлы не исключены в `.npmignore`

## Отмена публикации

Если нужно отменить публикацию (в течение 72 часов):
```bash
npm unpublish devchrome-mcp@1.0.0
``` 