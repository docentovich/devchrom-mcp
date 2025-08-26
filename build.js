#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔨 Сборка проекта devchrome-mcp...\n');

// Проверяем наличие необходимых файлов
const requiredFiles = [
    'package.json',
    'mcp_server.js',
    'README.md',
    'LICENSE',
    '.npmignore',
    '.gitignore'
];

console.log('📁 Проверка файлов...');
for (const file of requiredFiles) {
    if (existsSync(join(__dirname, file))) {
        console.log(`✅ ${file}`);
    } else {
        console.error(`❌ ${file} - отсутствует!`);
        process.exit(1);
    }
}

// Проверяем package.json
console.log('\n📦 Проверка package.json...');
try {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    
    const requiredFields = ['name', 'version', 'description', 'main', 'bin'];
    for (const field of requiredFields) {
        if (packageJson[field]) {
            console.log(`✅ ${field}: ${packageJson[field]}`);
        } else {
            console.error(`❌ ${field} - отсутствует!`);
            process.exit(1);
        }
    }
} catch (error) {
    console.error('❌ Ошибка чтения package.json:', error.message);
    process.exit(1);
}

// Проверяем синтаксис
console.log('\n🔍 Проверка синтаксиса...');
try {
    execSync('node -c mcp_server.js', { stdio: 'inherit' });
    console.log('✅ Синтаксис корректен');
} catch (error) {
    console.error('❌ Ошибка синтаксиса в mcp_server.js');
    process.exit(1);
}

// Собираем пакет
console.log('\n📦 Сборка npm пакета...');
try {
    execSync('npm pack', { stdio: 'inherit' });
    console.log('✅ Пакет собран успешно');
} catch (error) {
    console.error('❌ Ошибка сборки пакета');
    process.exit(1);
}

// Проверяем размер пакета
console.log('\n📊 Информация о пакете...');
try {
    const result = execSync('npm pack --dry-run', { encoding: 'utf8' });
    console.log(result);
} catch (error) {
    console.error('❌ Ошибка получения информации о пакете');
}

console.log('\n🎉 Сборка завершена успешно!');
console.log('\n📋 Следующие шаги:');
console.log('1. Обновите информацию в package.json (автор, репозиторий)');
console.log('2. Выполните: npm login');
console.log('3. Выполните: npm publish');
console.log('\n📖 Подробности в файле PUBLISH.md'); 