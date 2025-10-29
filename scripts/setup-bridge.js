#!/usr/bin/env node
/**
 * DevChrome Bridge Setup CLI
 *
 * Автоматически определяет окружение и устанавливает Puppeteer Bridge
 * для Windows/WSL окружений.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { platform } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ACTION = process.argv[2] || 'setup';

async function main() {
    if (ACTION === 'setup' || ACTION === 'install') {
        await setupBridge();
    } else if (ACTION === 'uninstall' || ACTION === 'remove') {
        await uninstallBridge();
    } else if (ACTION === 'status') {
        await checkStatus();
    } else {
        showHelp();
    }
}

async function setupBridge() {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🌉 DevChrome Puppeteer Bridge Setup                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');

    // Определяем окружение
    const isWindows = platform() === 'win32';
    const isWSL = await detectWSL();

    if (!isWindows && !isWSL) {
        console.log('ℹ️  Bridge не требуется на этой платформе');
        console.log('   (используется локальный Puppeteer)');
        console.log('');
        return;
    }

    if (isWSL) {
        console.log('✓ Обнаружено WSL окружение');
        console.log('');
        await setupBridgeFromWSL();
    } else if (isWindows) {
        console.log('✓ Обнаружена Windows');
        console.log('');
        await setupBridgeNative();
    }
}

async function setupBridgeFromWSL() {
    console.log('📦 Устанавливаем bridge в Windows host через PowerShell...');
    console.log('');

    const bridgeInstallScript = join(__dirname, '../bridge/install-bridge.ps1');

    // Конвертируем WSL path в Windows path
    const winPath = await wslToWindowsPath(bridgeInstallScript);

    if (!winPath) {
        console.error('❌ Не удалось конвертировать путь WSL в Windows path');
        process.exit(1);
    }

    console.log('Запускаем установщик...');
    console.log('(Требуются права администратора в Windows)');
    console.log('');

    const result = await runPowerShell(`powershell.exe -ExecutionPolicy Bypass -File "${winPath}"`);

    if (result.success) {
        console.log('');
        console.log('✅ Bridge установлен и запущен!');
        console.log('');
        console.log('🔗 Bridge доступен по адресу:');
        console.log('   http://172.25.96.1:9224');
        console.log('');
        console.log('💡 Теперь используйте devchrome-mcp как обычно:');
        console.log('   npx devchrome-mcp');
        console.log('');
    } else {
        console.error('');
        console.error('❌ Ошибка установки bridge');
        console.error('   Код выхода:', result.code);
        console.error('');
        console.error('Попробуйте запустить установщик вручную:');
        console.error(`   powershell.exe -ExecutionPolicy Bypass -File "${winPath}"`);
        console.error('');
        process.exit(1);
    }
}

async function setupBridgeNative() {
    console.log('📦 Устанавливаем bridge...');
    console.log('');

    const bridgeInstallScript = join(__dirname, '../bridge/install-bridge.ps1');

    console.log('Запускаем установщик...');
    console.log('(Требуются права администратора)');
    console.log('');

    const result = await runPowerShell(`powershell.exe -ExecutionPolicy Bypass -File "${bridgeInstallScript}"`);

    if (result.success) {
        console.log('');
        console.log('✅ Bridge установлен и запущен!');
        console.log('');
    } else {
        console.error('');
        console.error('❌ Ошибка установки bridge');
        process.exit(1);
    }
}

async function uninstallBridge() {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🗑️  DevChrome Puppeteer Bridge Uninstall                ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');

    const isWSL = await detectWSL();
    const bridgeUninstallScript = join(__dirname, '../bridge/uninstall-bridge.ps1');

    let winPath = bridgeUninstallScript;
    if (isWSL) {
        winPath = await wslToWindowsPath(bridgeUninstallScript);
    }

    console.log('Запускаем деинсталлятор...');
    console.log('');

    const result = await runPowerShell(`powershell.exe -ExecutionPolicy Bypass -File "${winPath}"`);

    if (result.success) {
        console.log('');
        console.log('✅ Bridge успешно удалён!');
        console.log('');
    } else {
        console.error('');
        console.error('❌ Ошибка удаления bridge');
        process.exit(1);
    }
}

async function checkStatus() {
    console.log('');
    console.log('🔍 Проверка статуса DevChrome Puppeteer Bridge...');
    console.log('');

    const bridgeUrls = [
        'http://localhost:9224',
        'http://172.25.96.1:9224'
    ];

    for (const url of bridgeUrls) {
        try {
            const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
            const data = await response.json();

            console.log(`✅ Bridge работает: ${url}`);
            console.log(`   Статус: ${data.status}`);
            console.log(`   Версия: ${data.version}`);
            console.log(`   Browser активен: ${data.browserActive ? 'Да' : 'Нет'}`);
            console.log(`   Uptime: ${Math.floor(data.uptime)}s`);
            console.log('');
            return;
        } catch (e) {
            console.log(`⚠️  Bridge не доступен: ${url}`);
        }
    }

    console.log('');
    console.log('❌ Bridge не запущен или не доступен');
    console.log('');
    console.log('Для установки выполните:');
    console.log('   devchrome-bridge setup');
    console.log('');
}

function showHelp() {
    console.log('');
    console.log('DevChrome Puppeteer Bridge CLI');
    console.log('');
    console.log('Использование:');
    console.log('  devchrome-bridge <команда>');
    console.log('');
    console.log('Команды:');
    console.log('  setup, install    Установить и запустить bridge');
    console.log('  uninstall, remove Удалить bridge');
    console.log('  status            Проверить статус bridge');
    console.log('  help              Показать эту справку');
    console.log('');
    console.log('Примеры:');
    console.log('  devchrome-bridge setup');
    console.log('  devchrome-bridge status');
    console.log('  devchrome-bridge uninstall');
    console.log('');
}

// === Утилиты ===

async function detectWSL() {
    try {
        const osRelease = fs.readFileSync('/proc/version', 'utf8');
        return osRelease.includes('Microsoft') || osRelease.includes('WSL');
    } catch {
        return false;
    }
}

async function wslToWindowsPath(wslPath) {
    return new Promise((resolve) => {
        const proc = spawn('wslpath', ['-w', wslPath]);
        let output = '';

        proc.stdout.on('data', (data) => {
            output += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(output.trim());
            } else {
                resolve(null);
            }
        });
    });
}

async function runPowerShell(command) {
    return new Promise((resolve) => {
        const proc = spawn('sh', ['-c', command], { stdio: 'inherit' });

        proc.on('close', (code) => {
            resolve({ success: code === 0, code });
        });
    });
}

// Запуск
main().catch((err) => {
    console.error('');
    console.error('❌ Ошибка:', err.message);
    console.error('');
    process.exit(1);
});
