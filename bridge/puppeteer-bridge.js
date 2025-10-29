#!/usr/bin/env node
/**
 * DevChrome Puppeteer Bridge
 *
 * HTTP сервер-прокси для управления Puppeteer из WSL/удалённых окружений.
 * Запускается как Windows Service и предоставляет REST API для работы с Chrome.
 */

import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// Глобальное состояние
let browser = null;
let browserLaunchPromise = null;
let pageCount = 0;

const PORT = process.env.BRIDGE_PORT || 9224;
const HOST = process.env.BRIDGE_HOST || '0.0.0.0';

// === API Endpoints ===

/**
 * Health check endpoint
 * GET /health
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        browserActive: !!browser && browser.isConnected(),
        version: '1.0.0',
        uptime: process.uptime(),
        pageCount: pageCount
    });
});

/**
 * Launch or get existing browser
 * POST /api/browser/launch
 * Body: { options?: PuppeteerLaunchOptions }
 */
app.post('/api/browser/launch', async (req, res) => {
    try {
        // Проверяем существующий browser
        if (browser && browser.isConnected()) {
            return res.json({
                wsEndpoint: browser.wsEndpoint(),
                browserActive: true,
                reused: true
            });
        }

        // Если уже запускается - ждём
        if (browserLaunchPromise) {
            browser = await browserLaunchPromise;
            return res.json({
                wsEndpoint: browser.wsEndpoint(),
                browserActive: true,
                reused: false
            });
        }

        // Запускаем новый browser
        const launchOptions = req.body?.options || {};
        browserLaunchPromise = puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ],
            ...launchOptions
        });

        browser = await browserLaunchPromise;
        browserLaunchPromise = null;

        // Отслеживание disconnected
        browser.on('disconnected', () => {
            console.log('🔌 Browser disconnected');
            browser = null;
            pageCount = 0;
        });

        res.json({
            wsEndpoint: browser.wsEndpoint(),
            browserActive: true,
            reused: false
        });

        console.log('🚀 Browser launched:', browser.wsEndpoint());
    } catch (error) {
        console.error('❌ Browser launch error:', error);
        browserLaunchPromise = null;
        res.status(500).json({
            error: error.message,
            stack: error.stack
        });
    }
});

/**
 * Close browser
 * POST /api/browser/close
 */
app.post('/api/browser/close', async (req, res) => {
    try {
        if (browser) {
            await browser.close();
            browser = null;
            pageCount = 0;
            console.log('🛑 Browser closed');
        }
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Browser close error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get browser status
 * GET /api/browser/status
 */
app.get('/api/browser/status', (req, res) => {
    res.json({
        isActive: !!browser,
        isConnected: browser ? browser.isConnected() : false,
        wsEndpoint: browser ? browser.wsEndpoint() : null,
        pageCount: pageCount,
        pid: browser ? browser.process()?.pid : null
    });
});

/**
 * Increment page counter (called by clients)
 * POST /api/pages/increment
 */
app.post('/api/pages/increment', (req, res) => {
    pageCount++;
    res.json({ pageCount });
});

/**
 * Decrement page counter (called by clients)
 * POST /api/pages/decrement
 */
app.post('/api/pages/decrement', (req, res) => {
    pageCount = Math.max(0, pageCount - 1);
    res.json({ pageCount });
});

// === Server Startup ===

const server = app.listen(PORT, HOST, () => {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🌉 DevChrome Puppeteer Bridge                            ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`✓ Server listening on http://${HOST}:${PORT}`);
    console.log(`✓ Health check: http://localhost:${PORT}/health`);
    console.log(`✓ WSL access: http://172.25.96.1:${PORT}`);
    console.log('');
    console.log('Press Ctrl+C to stop');
});

// === Graceful Shutdown ===

async function shutdown(signal) {
    console.log(`\n⏸️  Received ${signal}, shutting down gracefully...`);

    // Закрываем HTTP сервер
    server.close(() => {
        console.log('✓ HTTP server closed');
    });

    // Закрываем browser
    if (browser) {
        try {
            await browser.close();
            console.log('✓ Browser closed');
        } catch (e) {
            console.error('Error closing browser:', e.message);
        }
    }

    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Обработка необработанных ошибок
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});
