#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import puppeteer from 'puppeteer';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import Jimp from 'jimp';
import pixelmatch from 'pixelmatch';
import fetch from 'node-fetch';

/* -------------------- Configuration -------------------- */
// Figma token from environment variable (can be set in MCP config)
const FIGMA_TOKEN = process.env.FIGMA_TOKEN || null;

// Chrome Remote Debugging URL (can be set to connect to existing Chrome)
// Example: http://172.25.96.1:9222 or ws://localhost:9222/devtools/browser/xxx
const CHROME_REMOTE_URL = process.env.CHROME_REMOTE_URL || null;

// Puppeteer Bridge URL (for WSL environments)
const BRIDGE_URL = process.env.BRIDGE_URL || null;

/* -------------------- Puppeteer Bridge Detection -------------------- */
async function detectBridge() {
    // Если явно указан BRIDGE_URL - используем его
    if (BRIDGE_URL) {
        try {
            const response = await fetch(`${BRIDGE_URL}/health`, {
                signal: AbortSignal.timeout(1000)
            });
            if (response.ok) {
                console.error('[devchrome-mcp] Using configured Bridge:', BRIDGE_URL);
                return BRIDGE_URL;
            }
        } catch (e) {
            console.error('[devchrome-mcp] Configured Bridge not available:', BRIDGE_URL);
        }
    }

    // Автоопределение bridge
    const potentialBridges = [
        'http://172.25.96.1:9224',  // WSL → Windows (стандартный IP хоста)
        'http://localhost:9224',     // Локальный bridge
        'http://127.0.0.1:9224'      // Альтернативный локальный
    ];

    for (const url of potentialBridges) {
        try {
            const response = await fetch(`${url}/health`, {
                signal: AbortSignal.timeout(1000)
            });
            if (response.ok) {
                console.error('[devchrome-mcp] Detected Puppeteer Bridge:', url);
                return url;
            }
        } catch (e) {
            // Bridge недоступен, пробуем следующий
            continue;
        }
    }

    return null;
}

/* -------------------- Puppeteer: один браузер на всё приложение -------------------- */
let browserPromise = null;
async function getBrowser() {
    if (!browserPromise) {
        // Приоритет 1: Puppeteer Bridge (рекомендуется для WSL)
        const bridgeUrl = await detectBridge();
        if (bridgeUrl) {
            console.error('[devchrome-mcp] 🌉 Using Puppeteer Bridge');
            browserPromise = (async () => {
                try {
                    const response = await fetch(`${bridgeUrl}/api/browser/launch`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({})
                    });
                    const data = await response.json();

                    if (!data.wsEndpoint) {
                        throw new Error('Bridge did not return wsEndpoint');
                    }

                    console.error('[devchrome-mcp] Connected to bridge browser:', data.wsEndpoint);
                    return await puppeteer.connect({
                        browserWSEndpoint: data.wsEndpoint,
                        defaultViewport: null
                    });
                } catch (error) {
                    console.error('[devchrome-mcp] Bridge connection failed:', error.message);
                    console.error('[devchrome-mcp] Falling back to legacy methods...');
                    throw error;
                }
            })();
        }
        // Приоритет 2: CHROME_REMOTE_URL (legacy, для обратной совместимости)
        else if (CHROME_REMOTE_URL) {
            console.error('[devchrome-mcp] 🔗 Using Chrome Remote Debug:', CHROME_REMOTE_URL);

            // Определяем browserWSEndpoint
            let wsEndpoint;
            if (CHROME_REMOTE_URL.startsWith('ws://') || CHROME_REMOTE_URL.startsWith('wss://')) {
                wsEndpoint = CHROME_REMOTE_URL;
            } else {
                const response = await fetch(`${CHROME_REMOTE_URL}/json/version`);
                const data = await response.json();
                wsEndpoint = data.webSocketDebuggerUrl;
            }

            console.error('[devchrome-mcp] Connecting to WebSocket:', wsEndpoint);
            browserPromise = puppeteer.connect({
                browserWSEndpoint: wsEndpoint,
                defaultViewport: null
            });
        }
        // Приоритет 3: Локальный Puppeteer (запуск собственного Chrome)
        else {
            console.error('[devchrome-mcp] 🚀 Launching local headless Chrome');
            browserPromise = puppeteer.launch({ headless: true });
        }
    }
    return browserPromise;
}

/* -------------------- Управление вкладками -------------------- */
// Хранилище открытых страниц по URL
const openPages = new Map();

// Получить или создать страницу для URL
async function getOrCreatePage(url) {
    const browser = await getBrowser();

    // Проверяем, есть ли уже открытая страница для этого URL
    if (openPages.has(url)) {
        const existingPage = openPages.get(url);
        // Проверяем, что страница еще открыта
        if (!existingPage.isClosed()) {
            console.error('[devchrome-mcp] Reusing existing page for:', url);
            return existingPage;
        } else {
            // Страница закрыта, удаляем из кэша
            openPages.delete(url);
        }
    }

    // Создаем новую страницу
    console.error('[devchrome-mcp] Creating new page for:', url);
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    await client.send('Runtime.enable');

    // Сохраняем страницу в кэше
    openPages.set(url, page);

    // Добавляем свойство client к странице для совместимости
    page._cdpClient = client;

    return page;
}

// Старая функция createPage для совместимости с существующим кодом
async function createPage() {
    const browser = await getBrowser();
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    await client.send('Runtime.enable');
    return { page, client };
}

// Получить последнюю открытую страницу
async function getLastOpenPage() {
    if (openPages.size === 0) {
        throw new Error('No pages are currently open. Please provide a URL.');
    }

    // Получаем последнюю страницу из Map
    const pages = Array.from(openPages.values());
    const lastPage = pages[pages.length - 1];

    if (lastPage.isClosed()) {
        throw new Error('Last page was closed. Please provide a URL.');
    }

    console.error('[devchrome-mcp] Using last open page:', lastPage.url());
    return lastPage;
}

// Получить страницу: либо последнюю открытую, либо создать/переиспользовать по URL
async function getPageForOperation(url) {
    if (!url) {
        // Если URL не передан, используем последнюю открытую страницу
        return await getLastOpenPage();
    } else {
        // Если URL передан, получаем или создаем страницу для этого URL
        return await getOrCreatePage(url);
    }
}

// Очистить все открытые вкладки
async function closeAllPages() {
    console.error('[devchrome-mcp] Closing all pages:', openPages.size);
    for (const [url, page] of openPages.entries()) {
        try {
            if (!page.isClosed()) {
                await page.close();
            }
        } catch (error) {
            console.error('[devchrome-mcp] Error closing page:', url, error);
        }
    }
    openPages.clear();
}

/* -------------------- MCP Server -------------------- */
const server = new McpServer(
    {
        name: 'devchrome-mcp',
        version: '1.9.4',
        description: `
🎨 PROFESSIONAL PIXEL-PERFECT DESIGN VALIDATION SYSTEM 🎨

This MCP server provides 37+ specialized tools for comprehensive frontend design validation, 
pixel-perfect comparison, and Figma-to-browser analysis. Designed for AI agents working 
with design systems, CSS modules, and visual regression testing.

📋 DECISION-MAKING GUIDE FOR AI AGENTS:

🔍 WHEN TO USE WHICH TOOL:

1️⃣ BASIC INSPECTION & DEBUGGING:
   • ping - Test server connection and basic functionality
   • getElement - Inspect single element HTML structure 
   • getElements - Find multiple elements (great for lists, grids)
   • getElementReact/getElementsReact - CSS modules (use when class names have hash suffixes)
   • getElementComputedCss - Debug CSS cascading issues
   • getBoxModel - Precise layout measurements and positioning

2️⃣ VISUAL COMPARISON (Choose based on precision needed):
   • compareVisual - Basic pixel comparison (legacy, use for simple checks)
   • compareVisualAdvanced - ⭐ RECOMMENDED: Advanced with SSIM, heat maps, detailed metrics
   • analyzeColorDifferences - Focus on color palette analysis between versions
   • compareFigmaToElement - ⭐ GOLD STANDARD: Direct Figma design vs implementation

3️⃣ DETAILED ANALYSIS (When you need specific aspect validation):
   • compareFonts - Typography inconsistencies (fonts, sizes, weights, spacing)
   • compareSpacing - Margin/padding/positioning precision (pixel-perfect layouts)
   • compareLayout - Flexbox/Grid/positioning differences
   • measureElement - Exact measurements for design system compliance

4️⃣ TOLERANT COMPARISON (When minor differences are acceptable):
   • compareWithTolerance - ⭐ SMART CHOICE: Custom tolerances for production vs design
   • validateDesignSystem - Check adherence to design system tokens/standards

5️⃣ FIGMA INTEGRATION (When working with design files):
   • getFigmaFrame - Export Figma designs for comparison
   • getFigmaSpecs - Extract design tokens (colors, fonts, spacing)
   • compareFigmaToElement - ⭐ THE ULTIMATE TOOL for design-to-code validation

6️⃣ PERFORMANCE & QUALITY:
   • getPerformanceMetrics - Core Web Vitals, loading performance
   • validateHTML - Semantic markup and accessibility issues
   • getAccessibility - WCAG compliance and screen reader compatibility

7️⃣ INTERACTION TESTING:
   • click, hover, scrollTo - User interaction simulation
   • screenshot - Visual documentation and evidence
   • setViewport - Responsive design testing

🎯 TYPICAL WORKFLOWS FOR AI AGENTS:

SCENARIO A: "Design doesn't match Figma"
1. getFigmaFrame(figmaToken, fileKey, nodeId) - Get design reference
2. compareFigmaToElement(figmaToken, fileKey, nodeId, url, selector) - Direct comparison
3. If differences > 5%: Use compareVisualAdvanced() for heat map analysis
4. For specific issues: compareFonts(), compareSpacing(), analyzeColorDifferences()

SCENARIO B: "CSS modules not working" 
1. Try regular getElement() first
2. If fails: getElementReact(url, "className", "ComponentName") - CSS module patterns
3. Use getElementsReact() for multiple matches

SCENARIO C: "95% match but still looks different"
1. compareVisualAdvanced() - Get SSIM structural similarity
2. If SSIM < 0.9: Use analyzeColorDifferences() for palette analysis
3. compareWithTolerance() with strict settings (colorDelta: 5, sizeTolerance: 1)
4. For typography: compareFonts() to catch subtle font rendering differences

SCENARIO D: "Design system compliance check"
1. validateDesignSystem() with your tokens (colors, fontSizes, spacing)
2. If violations > 20%: Use individual tools (compareFonts, compareSpacing)
3. Document with screenshot() for stakeholder review

SCENARIO E: "Responsive design issues"
1. setViewport() to target breakpoint
2. screenshot() for documentation  
3. compareSpacing() to check if spacing adapts correctly
4. getPerformanceMetrics() to ensure performance isn't degraded

⚡ PERFORMANCE TIPS:
- Use getElementReact() instead of complex CSS selectors for React apps
- compareVisualAdvanced() is comprehensive but slower - use for final validation
- Batch similar operations (multiple screenshots, measurements) when possible
- Use tolerant comparison for development, strict for production

🚨 COMMON ANTI-PATTERNS TO AVOID:
- Don't use basic compareVisual() for important validations - use compareVisualAdvanced()
- Don't use regular getElement() for CSS modules - use getElementReact()
- Don't ignore SSIM values < 0.8 - they indicate structural differences
- Don't set tolerances too high - defeats the purpose of pixel-perfect validation

💡 PRO TIPS FOR AI AGENTS:
- Always start with the most specific tool for your use case
- Combine visual tools with detailed analysis for complete picture
- Use Figma integration tools when design source is available
- Document findings with screenshots for human review
- Consider performance impact of your tool choices

This system is designed to catch the subtle 5% differences that basic comparison misses!
        `
    }, 
    { capabilities: {} }
);

/* 0) ping — диагностика */
server.registerTool(
    'ping',
    {
        title: 'Ping',
        description: 'Echo a message',
        inputSchema: {
            message: z.string().describe('Message')
        }
    },
    async ({ message }) => ({
        content: [{ type: 'text', text: `pong: ${message}` }]
    })
);

/* List all Chrome tabs */
server.registerTool(
    'listChromeTabs',
    {
        title: 'List Chrome Tabs',
        description: 'Get a list of all open Chrome tabs. Useful for seeing what tabs are available to work with.',
        inputSchema: {}
    },
    async () => {
        try {
            if (!CHROME_REMOTE_URL) {
                return {
                    content: [{
                        type: 'text',
                        text: 'Chrome Remote Debugging is not configured. Set CHROME_REMOTE_URL environment variable.'
                    }]
                };
            }

            const response = await fetch(`${CHROME_REMOTE_URL}/json/list`);
            const tabs = await response.json();

            const tabList = tabs
                .filter(tab => tab.type === 'page')
                .map((tab, index) => ({
                    index: index + 1,
                    title: tab.title,
                    url: tab.url,
                    id: tab.id
                }));

            return {
                content: [{
                    type: 'text',
                    text: `Found ${tabList.length} open tabs:\n\n` +
                          tabList.map(t => `${t.index}. ${t.title}\n   URL: ${t.url}\n   ID: ${t.id}`).join('\n\n')
                }]
            };
        } catch (error) {
            throw new Error(`Failed to list Chrome tabs: ${error.message}`);
        }
    }
);

/* Use active Chrome tab */
server.registerTool(
    'useActiveTab',
    {
        title: 'Use Active Chrome Tab',
        description: 'Connect to the currently active (foreground) Chrome tab and use it for subsequent operations. This allows you to work with the tab the user is currently viewing without needing to specify a URL.',
        inputSchema: {}
    },
    async () => {
        try {
            if (!CHROME_REMOTE_URL) {
                return {
                    content: [{
                        type: 'text',
                        text: 'Chrome Remote Debugging is not configured. Set CHROME_REMOTE_URL environment variable.'
                    }]
                };
            }

            // Get all tabs
            const response = await fetch(`${CHROME_REMOTE_URL}/json/list`);

/* Navigate to URL */
server.registerTool(
    'navigateTo',
    {
        title: 'Navigate to URL',
        description: 'Navigate the current page to a new URL. Use this tool when you need to open a different page or reload the current page. After navigation, all other tools will work with this new page.',
        inputSchema: {
            url: z.string().url().describe('URL to navigate to'),
            waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).optional().describe('Wait until event (default: networkidle2)')
        }
    },
    async ({ url, waitUntil = 'networkidle2' }) => {
        try {
            // Get or create page for this URL
            const page = await getOrCreatePage(url);

            // Navigate to the URL
            await page.goto(url, { waitUntil });

            return {
                content: [{
                    type: 'text',
                    text: `Successfully navigated to: ${url}\n\nPage title: ${await page.title()}\n\nYou can now use other tools to interact with this page.`
                }]
            };
        } catch (error) {
            throw new Error(`Failed to navigate to ${url}: ${error.message}`);
        }
    }
);
            const tabs = await response.json();

            // Find the active tab (the one that's currently visible)
            const activeTabs = tabs.filter(tab => tab.type === 'page');

            if (activeTabs.length === 0) {
                throw new Error('No active Chrome tabs found');
            }

            // The first page tab is typically the active one
            // Or we can look for the one without 'webSocketDebuggerUrl' already in use
            const activeTab = activeTabs[0];

            // Connect to this tab
            const browser = await getBrowser();
            const pages = await browser.pages();

            // Try to find existing page connection or create new one
            let page = pages.find(p => p.url() === activeTab.url);

            if (!page) {
                // Create new page connection to this tab
                page = await browser.newPage();
                await page.goto(activeTab.url, { waitUntil: 'networkidle2' });
            }

            // Initialize CDP client
            const client = await page.target().createCDPSession();
            await client.send('DOM.enable');
            await client.send('CSS.enable');
            await client.send('Runtime.enable');
            page._cdpClient = client;

            // Store in openPages with the URL
            openPages.set(activeTab.url, page);

            return {
                content: [{
                    type: 'text',
                    text: `Connected to active tab:\n\nTitle: ${activeTab.title}\nURL: ${activeTab.url}\n\nYou can now use other tools without providing a URL parameter.`
                }]
            };
        } catch (error) {
            throw new Error(`Failed to connect to active tab: ${error.message}`);
        }
    }
);

/* Вспомогательная утилита: найти nodeId по селектору, если селектора нет — вернуть <body> */
async function resolveNodeId(client, selector) {
    const { root } = await client.send('DOM.getDocument');
    const useSelector = (selector && String(selector).trim().length > 0) ? selector : 'body';
    const { nodeId } = await client.send('DOM.querySelector', {
        selector: useSelector,
        nodeId: root.nodeId
    });
    if (!nodeId) {
        if (!selector || String(selector).trim().length === 0) {
            // крайне маловероятно, что <body> не найдётся, но на всякий случай:
            throw new Error( '<body> element not found on the page');
        }
        
        // Улучшенная диагностика ошибок
        const suggestions = await findSimilarSelectors(client, selector);
        let errorMessage = `Selector not found: ${selector}\n\nTroubleshooting tips:\n`;
        errorMessage += `- Check if the page is fully loaded\n`;
        errorMessage += `- Verify the selector syntax\n`;
        errorMessage += `- Consider using more specific selectors\n\n`;
        
        if (suggestions.length > 0) {
            errorMessage += `Similar elements found:\n${suggestions.join('\n')}`;
        } else {
            errorMessage += `No similar elements found. The page might not contain the expected content.`;
        }
        
        throw new Error( errorMessage);
    }
    return nodeId;
}

/* Помощник для поиска похожих селекторов */
async function findSimilarSelectors(client, originalSelector) {
    const { root } = await client.send('DOM.getDocument');
    const suggestions = [];
    
    try {
        // Если это CSS модуль селектор, предлагаем более общие варианты
        if (originalSelector.includes('--')) {
            const baseClass = originalSelector.split('--')[0];
            const { nodeIds } = await client.send('DOM.querySelectorAll', {
                selector: `[class*="${baseClass}"]`,
                nodeId: root.nodeId
            });
            if (nodeIds.length > 0) {
                suggestions.push(`[class*="${baseClass}"] (${nodeIds.length} elements found)`);
            }
        }
        
        // Если это селектор с :nth-child, попробуем без него
        if (originalSelector.includes(':nth-child')) {
            const baseSelector = originalSelector.replace(/:nth-child\(\d+\)/g, '');
            const { nodeIds } = await client.send('DOM.querySelectorAll', {
                selector: baseSelector,
                nodeId: root.nodeId
            });
            if (nodeIds.length > 0) {
                suggestions.push(`${baseSelector} (${nodeIds.length} elements found)`);
            }
        }
        
        // Если это селектор по атрибуту, попробуем по тегу
        if (originalSelector.includes('[') && originalSelector.includes(']')) {
            const tagMatch = originalSelector.match(/^(\w+)\[/);
            if (tagMatch) {
                const tag = tagMatch[1];
                const { nodeIds } = await client.send('DOM.querySelectorAll', {
                    selector: tag,
                    nodeId: root.nodeId
                });
                if (nodeIds.length > 0) {
                    suggestions.push(`${tag} (${nodeIds.length} elements found)`);
                }
            }
        }
        
        // Если это селектор класса, попробуем найти частичные совпадения
        const classMatch = originalSelector.match(/\.(\w+)/);
        if (classMatch) {
            const className = classMatch[1];
            const { nodeIds } = await client.send('DOM.querySelectorAll', {
                selector: `[class*="${className}"]`,
                nodeId: root.nodeId
            });
            if (nodeIds.length > 0) {
                suggestions.push(`[class*="${className}"] (${nodeIds.length} elements found)`);
            }
        }
        
    } catch (e) {
        // Игнорируем ошибки при поиске альтернатив
    }
    
    return suggestions;
}

/* Утилита для сравнения изображений */
async function compareImages(image1Path, image2Path) {
    // Простое попиксельное сравнение для начала
    // В будущем можно добавить более сложные алгоритмы
    try {
        const image1 = fs.readFileSync(image1Path);
        const image2 = fs.readFileSync(image2Path);
        
        if (image1.length !== image2.length) {
            return {
                identical: false,
                difference: 'Different file sizes',
                similarity: 0
            };
        }
        
        let differences = 0;
        for (let i = 0; i < image1.length; i++) {
            if (image1[i] !== image2[i]) {
                differences++;
            }
        }
        
        const similarity = ((image1.length - differences) / image1.length) * 100;
        
        return {
            identical: differences === 0,
            difference: `${differences} bytes differ`,
            similarity: Math.round(similarity * 100) / 100
        };
    } catch (error) {
        return {
            identical: false,
            difference: `Error comparing images: ${error.message}`,
            similarity: 0
        };
    }
}

/* 1) getElement */
server.registerTool(
    'getElement',
    {
        title: 'Get Element HTML',
        description:
            'Get the complete HTML markup of an element for layout analysis and debugging. Perfect for inspecting component structure, checking generated HTML, or understanding element hierarchy. Returns outerHTML of the first matched element. If no selector is provided, returns the entire <body> element.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            // селектор НЕобязательный: если не указан — берётся <body>
            selector: z
                .string()
                .optional()
                .describe('CSS selector (optional). If omitted or empty, the <body> element is used')
        }
    },
    async ({ url, selector }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();
            const nodeId = await resolveNodeId(client, selector);
            const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId });

            return {
                content: [
                    { type: 'text', name: 'html', text: outerHTML }
                ]
            };
        } catch (error) {
            // При ошибке не закрываем страницу
            throw error;
        }
    }
);

/* 2) getElementComputedCss */
server.registerTool(
    'getElementComputedCss',
    {
        title: 'Get Element Computed CSS',
        description:
            'Analyze actual computed CSS styles applied to an element. Essential for debugging layout issues, checking responsive design, understanding cascading styles, and verifying CSS properties. Returns all computed CSS properties of the first matched element.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            selector: z
                .string()
                .optional()
                .describe('CSS selector (optional). If omitted or empty, the <body> element is used')
        }
    },
    async ({ url, selector }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();
            const nodeId = await resolveNodeId(client, selector);
            const { computedStyle } = await client.send('CSS.getComputedStyleForNode', { nodeId });

            return {
                content: [
                    { type: 'text', name: 'computedCss', text: JSON.stringify(computedStyle) }
                ]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 3) getElementListeners */
server.registerTool(
    'getElementListeners',
    {
        title: 'Get Element Event Listeners',
        description:
            'Return event listeners attached to the first matched element. If no selector is provided, the <body> element is used.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            selector: z
                .string()
                .optional()
                .describe('CSS selector (optional). If omitted or empty, the <body> element is used')
        }
    },
    async ({ url, selector }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();
            const nodeId = await resolveNodeId(client, selector);
            const { object } = await client.send('DOM.resolveNode', { nodeId });

            let listeners = [];
            try {
                const resp = await client.send('DOMDebugger.getEventListeners', {
                    objectId: object.objectId
                });
                listeners = resp?.listeners ?? [];
            } catch {
                // возможно, cross-origin/нестандартный узел — вернём пустой список
                listeners = [];
            }

            return {
                content: [
                    { type: 'text', name: 'listeners', text: JSON.stringify(listeners) }
                ]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 4) getElements */
server.registerTool(
    'getElements',
    {
        title: 'Get Elements',
        description: 'Find all elements that match the CSS selector; return an array of outerHTML.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector (required for multiple matches)')
        }
    },
    async ({ url, selector }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();
            const { root } = await client.send('DOM.getDocument');
            try {
                const { nodeIds } = await client.send('DOM.querySelectorAll', {
                    selector,
                    nodeId: root.nodeId
                });

                const elements = [];
                for (const nodeId of nodeIds) {
                    const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId });
                    elements.push(outerHTML);
                }

                if (elements.length === 0) {
                    const suggestions = await findSimilarSelectors(client, selector);
                    let errorMessage = `No elements found for selector: "${selector}"`;

                    if (suggestions.length > 0) {
                        errorMessage += `\n\nSimilar elements found:\n${suggestions.map(s => `  - ${s}`).join('\n')}`;
                    }

                    throw new Error( errorMessage);
                }

                return {
                    content: [{
                        type: 'text',
                        name: 'elements',
                        text: JSON.stringify(elements, null, 2)
                    }]
                };
            } catch (error) {
                if (error.message && (error.message.includes('No elements found') || error.message.includes('NotFound'))) {
                    throw error;
                }
                throw new Error( `Invalid CSS selector: "${selector}". Error: ${error.message}`);
            }
        } catch (error) {
            throw error;
        }
    }
);

/* 4.1) getElementReact - для CSS модулей */
server.registerTool(
    'getElementReact',
    {
        title: 'Get React Element with CSS Modules',
        description: `🔍 INTELLIGENT CSS MODULES ELEMENT FINDER 🔍

Essential tool for React applications using CSS modules. Automatically handles class name 
transformations like .someClass → Button_someClass_x7k9p2.

🎯 USE THIS WHEN:
- Regular getElement() fails with "Selector not found" 
- Working with React apps using CSS Modules
- Class names have hash suffixes (e.g., Component_className_abc123)
- Using styled-components with generated class names
- Working with webpack css-loader with modules enabled
- Next.js or Create React App with CSS modules

🧠 HOW IT WORKS:
1. Takes clean class name (without dot): "button" not ".button"
2. Tries multiple CSS module patterns automatically:
   - [class*="ComponentName_className_"] (most common)
   - [class*="ComponentName_className__"] (BEM-style)
   - [class$="ComponentName_className"] (exact suffix match)
   - [class^="ComponentName_className_"] (prefix match)
3. Returns first match with pattern info for debugging

📝 INPUT EXAMPLES:
- className: "primary" (not ".primary")
- componentName: "Button" (optional but recommended)
- Result finds: Button_primary_x7k9p2, ButtonComponent_primary_hash, etc.

🎯 COMPONENT NAME BENEFITS:
- Avoids cross-component collisions (.primary in Button vs Header)
- Faster matching with specific patterns
- Better error messages with context
- Supports component-specific debugging

💡 FALLBACK STRATEGY:
1. Try with componentName for precision
2. If not found, tries generic patterns without component
3. Provides detailed error with suggestions if still not found

🔄 WORKFLOW INTEGRATION:
- Use this FIRST when working with React CSS modules
- Fall back to regular getElement() only for non-module classes
- Combine with getElementsReact() for multiple matches
- Perfect for component libraries and design systems

⚠️ WHEN NOT TO USE:
- Plain CSS without modules (use regular getElement)
- Inline styles or styled-components without CSS modules
- Class names are already fully specified with hashes`,
        inputSchema: {
            url: z.string().url().describe('Page URL'),
            className: z.string().describe('CSS module class name (without dot, e.g. "someClass")'),
            componentName: z.string().optional().describe('Component name for more specific matching (e.g. "Button" for Button_someClass_xyz)')
        }
    },
    async ({ className, componentName }) => {
        const { page, client } = await createPage();
        try {            const cleanClassName = className.replace(/^\./, '');
            let selectors = [];
            
            if (componentName) {
                // Более специфичные паттерны с именем компонента
                selectors = [
                    `[class*="${componentName}_${cleanClassName}_"]`,
                    `[class*="${componentName}_${cleanClassName}__"]`,
                    `[class$="${componentName}_${cleanClassName}"]`,
                    `[class^="${componentName}_${cleanClassName}_"]`
                ];
            } else {
                // Общие паттерны без компонента
                selectors = [
                    `[class*="${cleanClassName}"]`,
                    `[class*="_${cleanClassName}_"]`,
                    `[class*="${cleanClassName}__"]`,
                    `[class$="_${cleanClassName}"]`,
                    `[class^="${cleanClassName}_"]`
                ];
            }
            
            const { root } = await client.send('DOM.getDocument');
            
            for (const selector of selectors) {
                try {
                    const { nodeId } = await client.send('DOM.querySelector', {
                        selector,
                        nodeId: root.nodeId
                    });

                    if (nodeId) {
                        const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId });
                        const matchInfo = componentName 
                            ? `Found using pattern: ${selector} (component: ${componentName})`
                            : `Found using pattern: ${selector}`;
                            
                        return {
                            content: [
                                { type: 'text', name: 'html', text: outerHTML },
                                { type: 'text', name: 'matchInfo', text: matchInfo }
                            ]
                        };
                    }
                } catch (e) {
                    // Пропускаем неудачные паттерны
                    continue;
                }
            }
            
            const searchContext = componentName 
                ? `CSS module class "${className}" in component "${componentName}"`
                : `CSS module class "${className}"`;
            const triedPatterns = selectors.join(', ');
            
            throw new Error( `${searchContext} not found. Tried patterns: ${triedPatterns}`);
            
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* 4.2) getElementsReact - для нескольких элементов с CSS модулями */
server.registerTool(
    'getElementsReact',
    {
        title: 'Get React Elements with CSS Modules',
        description: 'Find all elements by CSS module class name pattern. Supports component-specific search to avoid collisions. Returns array of matched elements with CSS module patterns.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            className: z.string().describe('CSS module class name (without dot, e.g. "someClass")'),
            componentName: z.string().optional().describe('Component name for more specific matching (e.g. "Button" for Button_someClass_xyz)')
        }
    },
    async ({ className, componentName }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const cleanClassName = className.replace(/^\./, '');
            let selectors = [];

            if (componentName) {
                selectors = [
                    `[class*="${componentName}_${cleanClassName}_"]`,
                    `[class*="${componentName}_${cleanClassName}__"]`,
                    `[class$="${componentName}_${cleanClassName}"]`,
                    `[class^="${componentName}_${cleanClassName}_"]`
                ];
            } else {
                selectors = [
                    `[class*="${cleanClassName}"]`,
                    `[class*="_${cleanClassName}_"]`,
                    `[class*="${cleanClassName}__"]`,
                    `[class$="_${cleanClassName}"]`,
                    `[class^="${cleanClassName}_"]`
                ];
            }

            const { root } = await client.send('DOM.getDocument');
            let allNodeIds = [];
            let usedPattern = '';

            for (const selector of selectors) {
                try {
                    const { nodeIds } = await client.send('DOM.querySelectorAll', {
                        selector,
                        nodeId: root.nodeId
                    });

                    if (nodeIds.length > 0) {
                        allNodeIds = nodeIds;
                        usedPattern = selector;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            if (allNodeIds.length === 0) {
                const searchContext = componentName
                    ? `CSS module class "${className}" in component "${componentName}"`
                    : `CSS module class "${className}"`;
                const triedPatterns = selectors.join(', ');

                throw new Error( `${searchContext} not found. Tried patterns: ${triedPatterns}`);
            }

            const elements = [];
            for (const nodeId of allNodeIds) {
                const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId });
                elements.push(outerHTML);
            }

            const matchInfo = componentName
                ? `Found ${elements.length} elements using pattern: ${usedPattern} (component: ${componentName})`
                : `Found ${elements.length} elements using pattern: ${usedPattern}`;

            return {
                content: [
                    {
                        type: 'text',
                        name: 'elements',
                        text: JSON.stringify(elements, null, 2)
                    },
                    {
                        type: 'text',
                        name: 'matchInfo',
                        text: matchInfo
                    }
                ]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 5) getBoxModel (без изменений, селектор обязателен) */
server.registerTool(
    'getBoxModel',
    {
        title: 'Get Box Model & Layout Metrics',
        description: 'Get precise element positioning, dimensions, margins, padding, and borders. Crucial for layout debugging, responsive design validation, and pixel-perfect positioning. Returns complete box model data including content, padding, border, and margin dimensions.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector')
        }
    },
    async ({ url, selector }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const { root } = await client.send('DOM.getDocument');
            const { nodeId } = await client.send('DOM.querySelector', {
                selector,
                nodeId: root.nodeId
            });
            if (!nodeId) {
                throw new Error( `Selector not found: ${selector}`);
            }

            const boxModel = await client.send('DOM.getBoxModel', { nodeId });
            const metrics = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                return {
                    offsetWidth: el.offsetWidth,
                    offsetHeight: el.offsetHeight,
                    scrollWidth: el.scrollWidth,
                    scrollHeight: el.scrollHeight
                };
            }, selector);

            if (!metrics) {
                throw new Error( `Selector not found (render): ${selector}`);
            }

            return {
                content: [
                    { type: 'text', name: 'boxModel', text: JSON.stringify({ boxModel, metrics }) }
                ]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 6) getParents (без изменений) */
server.registerTool(
    'getParents',
    {
        title: 'Get Parents',
        description:
            'Retrieve N parent elements with HTML & computed CSS (inline snapshot via getComputedStyle).',
        inputSchema: {
            url: z.string().url().describe('Page URL'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector'),
            levels: z.number().int().min(1).describe('How many levels up from the element')
        }
    },
    async ({ selector, levels }) => {
        const page = await getPageForOperation(url);
        try {            const parents = await page.evaluate(
                ({ selector, levels }) => {
                    const el = document.querySelector(selector);
                    if (!el) return null;
                    const result = [];
                    let curr = el;
                    for (let i = 0; i < levels; i++) {
                        if (!curr.parentElement) break;
                        curr = curr.parentElement;
                        const cs = window.getComputedStyle(curr);
                        const styles = {};
                        for (const prop of cs) styles[prop] = cs.getPropertyValue(prop);
                        result.push({ html: curr.outerHTML, styles });
                    }
                    return result;
                },
                { selector, levels }
            );

            if (parents === null) {
                throw new Error( `Selector not found: ${selector}`);
            }

            return {
                content: [{ type: 'text', name: 'parents', text: JSON.stringify(parents) }]
            };
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* 7) setStyles — массив пар {name,value} */
server.registerTool(
    'setStyles',
    {
        title: 'Apply CSS Styles Dynamically',
        description:
            'Live CSS editing and prototyping tool. Apply inline styles to elements for testing design changes, debugging layout issues, or demonstrating visual modifications. Perfect for rapid prototyping and visual debugging without modifying source code.',
        inputSchema: {
            url: z.string().url().describe('Page URL'),
            selector: z
                .string()
                .describe('CSS selector (the first matched element will be modified)'),
            styles: z
                .array(
                    z.object({
                        name: z.string().describe('Property name, e.g. "color"'),
                        value: z.string().describe('Property value, e.g. "red" or "16px"')
                    })
                )
                .nonempty()
                .describe('List of inline CSS styles as {name,value} pairs')
        }
    },
    async ({ selector, styles }) => {
        const page = await getPageForOperation(url);
        try {            const dict = {};
            for (const item of styles) {
                if (!item) continue;
                const { name, value } = item;
                if (typeof name === 'string' && typeof value === 'string') {
                    dict[name] = value;
                }
            }

            const ok = await page.evaluate((sel, map) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                Object.entries(map).forEach(([k, v]) => el.style.setProperty(k, v));
                return true;
            }, selector, dict);

            if (!ok) {
                throw new Error( `Selector not found: ${selector}`);
            }

            return { content: [{ type: 'text', text: 'Styles applied' }] };
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* 8) screenshot */
server.registerTool(
    'screenshot',
    {
        title: 'Visual Element Screenshot',
        description: 'Capture high-quality PNG screenshots of specific elements for visual testing, design reviews, and documentation. Essential for pixel-perfect comparisons, responsive design validation, and visual regression testing. Supports padding for better context.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for the element'),
            padding: z.number().optional().describe('Padding in pixels around the element')
        }
    },
    async ({ selector, padding = 0 }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const el = await page.$(selector);
            if (!el) {
                await client.send('DOM.enable');
                const suggestions = await findSimilarSelectors(client, selector);
                let errorMessage = `Selector not found for screenshot: ${selector}\n\nTroubleshooting tips:\n`;
                errorMessage += `- Ensure the element is visible and not hidden\n`;
                errorMessage += `- Check if the element has non-zero dimensions\n`;
                errorMessage += `- Verify the selector is correct\n\n`;

                if (suggestions.length > 0) {
                    errorMessage += `Similar elements found:\n${suggestions.join('\n')}`;
                }

                throw new Error( errorMessage);
            }

            const box = await el.boundingBox();
            if (!box) {
                throw new Error(
                    `Element is not visible or has no bounding box: ${selector}`
                );
            }

            const clip = {
                x: Math.max(box.x - padding, 0),
                y: Math.max(box.y - padding, 0),
                width: Math.max(box.width + padding * 2, 1),
                height: Math.max(box.height + padding * 2, 1)
            };

            const buf = await page.screenshot({ clip });

            // ---- ВАЖНО: контент именно 'image' ----
            return {
                content: [
                    {
                        type: 'image',
                        data: buf.toString('base64'),
                        mimeType: 'image/png'
                    }
                ]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 9) getViewport - получение размеров viewport */
server.registerTool(
    'getViewport',
    {
        title: 'Get Viewport Dimensions',
        description: 'Get current viewport size and device pixel ratio. Essential for responsive design testing and understanding how content fits on different screen sizes.',
        inputSchema: {
            // url parameter removed - uses active tab by default
        }
    },
    async ({ url }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const viewport = await page.evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio,
                outerWidth: window.outerWidth,
                outerHeight: window.outerHeight
            }));

            return {
                content: [{ type: 'text', name: 'viewport', text: JSON.stringify(viewport) }]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 10) setViewport - изменение размеров viewport */
server.registerTool(
    'setViewport',
    {
        title: 'Set Viewport Size',
        description: 'Change viewport dimensions for responsive design testing. Test how your layout adapts to different screen sizes, mobile devices, tablets, and desktop resolutions.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            width: z.number().min(320).max(4000).describe('Viewport width in pixels (320-4000)'),
            height: z.number().min(200).max(3000).describe('Viewport height in pixels (200-3000)'),
            deviceScaleFactor: z.number().min(0.5).max(3).optional().describe('Device pixel ratio (0.5-3, default: 1)')
        }
    },
    async ({ width, height, deviceScaleFactor = 1 }) => {
        const page = await getPageForOperation(url);
        try {
            await page.setViewport({ width, height, deviceScaleFactor });
const client = page._cdpClient || await page.target().createCDPSession();

            const result = await page.evaluate(() => ({
                actualWidth: window.innerWidth,
                actualHeight: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio
            }));

            return {
                content: [{ type: 'text', text: `Viewport set to ${width}x${height} (actual: ${result.actualWidth}x${result.actualHeight})` }]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 11) hover - наведение мыши для проверки hover-эффектов */
server.registerTool(
    'hover',
    {
        title: 'Hover Element',
        description: 'Simulate mouse hover over an element to test hover effects, tooltips, dropdown menus, and interactive states. Essential for testing CSS :hover pseudo-classes and JavaScript hover events.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for the element to hover')
        }
    },
    async ({ url, selector }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const element = await page.$(selector);
            if (!element) {
                throw new Error( `Selector not found: ${selector}`);
            }

            await element.hover();

            // Небольшая задержка для срабатывания hover эффектов
            await new Promise(resolve => setTimeout(resolve, 100));

            return {
                content: [{ type: 'text', text: `Hovered over element: ${selector}` }]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 12) click - клик по элементу */
server.registerTool(
    'click',
    {
        title: 'Click Element',
        description: 'Simulate mouse click on an element to test buttons, links, form interactions, and JavaScript click handlers. Essential for testing user interactions and form submissions.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for the element to click')
        }
    },
    async ({ url, selector }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const element = await page.$(selector);
            if (!element) {
                throw new Error( `Selector not found: ${selector}`);
            }

            await element.click();

            // Ожидаем возможных изменений после клика (увеличено для модалок)
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Делаем скриншот после клика
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });

            return {
                content: [
                    { type: 'text', text: `Clicked element: ${selector}` },
                    { type: 'image', data: screenshot, mimeType: 'image/png' }
                ]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 13) scrollTo - прокрутка к элементу */
server.registerTool(
    'scrollTo',
    {
        title: 'Scroll to Element',
        description: 'Scroll page to bring an element into view. Perfect for testing sticky elements, lazy loading, scroll animations, and ensuring elements are properly visible on long pages.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for the element to scroll to'),
            behavior: z.enum(['auto', 'smooth']).optional().describe('Scroll behavior (auto or smooth)')
        }
    },
    async ({ selector, behavior = 'auto' }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const element = await page.$(selector);
            if (!element) {
                throw new Error( `Selector not found: ${selector}`);
            }

            await element.scrollIntoView({ behavior });

            // Ожидаем завершения скролла
            await new Promise(resolve => setTimeout(resolve, 300));

            const position = await page.evaluate(() => ({
                x: window.scrollX,
                y: window.scrollY
            }));

            return {
                content: [{ type: 'text', text: `Scrolled to element: ${selector} (position: ${position.x}, ${position.y})` }]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 14) getPerformanceMetrics - Core Web Vitals */
server.registerTool(
    'getPerformanceMetrics',
    {
        title: 'Get Performance Metrics',
        description: 'Measure Core Web Vitals and performance metrics including LCP, CLS, FID, and page load times. Critical for optimizing user experience and SEO performance.',
        inputSchema: {
            // url parameter removed - uses active tab by default
        }
    },
    async ({ url }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const metrics = await page.evaluate(() => {
                return new Promise((resolve) => {
                    // Получаем Navigation Timing API
                    const navigation = performance.getEntriesByType('navigation')[0];
                    const paint = performance.getEntriesByType('paint');

                    const result = {
                        // Navigation timing
                        domContentLoaded: navigation.domContentLoadedEventEnd - navigation.domContentLoadedEventStart,
                        loadComplete: navigation.loadEventEnd - navigation.loadEventStart,
                        domInteractive: navigation.domInteractive - navigation.fetchStart,

                        // Paint timing
                        firstPaint: paint.find(p => p.name === 'first-paint')?.startTime || null,
                        firstContentfulPaint: paint.find(p => p.name === 'first-contentful-paint')?.startTime || null,

                        // Layout metrics
                        layoutShiftScore: 0, // Будет обновлено через PerformanceObserver

                        // Resource timing
                        resourceCount: performance.getEntriesByType('resource').length,

                        timestamp: Date.now()
                    };

                    // Пытаемся получить CLS через PerformanceObserver
                    if ('PerformanceObserver' in window) {
                        try {
                            let cumulativeLayoutShift = 0;
                            const observer = new PerformanceObserver((list) => {
                                for (const entry of list.getEntries()) {
                                    if (!entry.hadRecentInput) {
                                        cumulativeLayoutShift += entry.value;
                                    }
                                }
                            });
                            observer.observe({ entryTypes: ['layout-shift'] });

                            setTimeout(() => {
                                result.layoutShiftScore = cumulativeLayoutShift;
                                observer.disconnect();
                                resolve(result);
                            }, 1000);
                        } catch (e) {
                            resolve(result);
                        }
                    } else {
                        resolve(result);
                    }
                });
            });

            return {
                content: [{ type: 'text', name: 'performance', text: JSON.stringify(metrics, null, 2) }]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 15) validateHTML - валидация разметки */
server.registerTool(
    'validateHTML',
    {
        title: 'Validate HTML',
        description: 'Check HTML markup for syntax errors, accessibility issues, and semantic problems. Identifies missing alt attributes, invalid nesting, unclosed tags, and other markup issues.',
        inputSchema: {
            // url parameter removed - uses active tab by default
        }
    },
    async ({ url }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const validation = await page.evaluate(() => {
                const issues = [];
                
                // Проверка отсутствующих alt атрибутов у изображений
                const imagesWithoutAlt = document.querySelectorAll('img:not([alt])');
                imagesWithoutAlt.forEach((img, index) => {
                    issues.push({
                        type: 'accessibility',
                        severity: 'warning',
                        message: `Image ${index + 1} missing alt attribute`,
                        element: img.outerHTML.substring(0, 100) + (img.outerHTML.length > 100 ? '...' : '')
                    });
                });
                
                // Проверка пустых alt атрибутов (когда должны быть заполнены)
                const imagesWithEmptyAlt = document.querySelectorAll('img[alt=""]');
                imagesWithEmptyAlt.forEach((img, index) => {
                    // Исключаем декоративные изображения
                    if (!img.hasAttribute('role') || img.getAttribute('role') !== 'presentation') {
                        issues.push({
                            type: 'accessibility',
                            severity: 'warning',
                            message: `Image ${index + 1} has empty alt attribute`,
                            element: img.outerHTML.substring(0, 100) + (img.outerHTML.length > 100 ? '...' : '')
                        });
                    }
                });
                
                // Проверка отсутствующих заголовков страницы
                if (!document.title || document.title.trim().length === 0) {
                    issues.push({
                        type: 'seo',
                        severity: 'error',
                        message: 'Missing or empty page title',
                        element: '<title>'
                    });
                }
                
                // Проверка структуры заголовков (h1-h6)
                const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
                let hasH1 = false;
                headings.forEach(heading => {
                    if (heading.tagName === 'H1') {
                        hasH1 = true;
                    }
                    if (!heading.textContent.trim()) {
                        issues.push({
                            type: 'accessibility',
                            severity: 'warning',
                            message: `Empty ${heading.tagName.toLowerCase()} heading`,
                            element: heading.outerHTML
                        });
                    }
                });
                
                if (!hasH1) {
                    issues.push({
                        type: 'seo',
                        severity: 'warning',
                        message: 'Missing H1 heading on page',
                        element: 'page structure'
                    });
                }
                
                // Проверка форм без labels
                const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
                inputs.forEach((input, index) => {
                    const hasLabel = document.querySelector(`label[for="${input.id}"]`) || 
                                   input.closest('label') || 
                                   input.hasAttribute('aria-label') || 
                                   input.hasAttribute('aria-labelledby');
                    
                    if (!hasLabel) {
                        issues.push({
                            type: 'accessibility',
                            severity: 'error',
                            message: `Input field ${index + 1} missing label`,
                            element: input.outerHTML.substring(0, 100) + (input.outerHTML.length > 100 ? '...' : '')
                        });
                    }
                });
                
                return {
                    totalIssues: issues.length,
                    issues: issues,
                    summary: {
                        errors: issues.filter(i => i.severity === 'error').length,
                        warnings: issues.filter(i => i.severity === 'warning').length,
                        accessibilityIssues: issues.filter(i => i.type === 'accessibility').length,
                        seoIssues: issues.filter(i => i.type === 'seo').length
                    }
                };
            });

            return {
                content: [{ type: 'text', name: 'validation', text: JSON.stringify(validation, null, 2) }]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 16) getAccessibility - проверка доступности */
server.registerTool(
    'getAccessibility',
    {
        title: 'Get Accessibility Info',
        description: 'Analyze page accessibility including ARIA attributes, contrast ratios, keyboard navigation, and screen reader compatibility. Essential for WCAG compliance and inclusive design.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().optional().describe('CSS selector to analyze specific element (optional)')
        }
    },
    async ({ url, selector }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const accessibility = await page.evaluate((targetSelector) => {
                const target = targetSelector ? document.querySelector(targetSelector) : document.body;
                if (!target) return null;

                const result = {
                    element: targetSelector || 'body',
                    ariaAttributes: {},
                    roleInfo: null,
                    keyboardFocusable: false,
                    contrastIssues: [],
                    semanticStructure: {}
                };

                // Получаем ARIA атрибуты
                for (const attr of target.attributes) {
                    if (attr.name.startsWith('aria-') || attr.name === 'role') {
                        result.ariaAttributes[attr.name] = attr.value;
                    }
                }

                // Проверяем фокусируемость
                const focusableElements = target.querySelectorAll(
                    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
                );
                result.keyboardFocusable = focusableElements.length > 0;

                // Анализ семантической структуры
                const landmarks = target.querySelectorAll('[role="main"], [role="navigation"], [role="banner"], [role="contentinfo"], main, nav, header, footer');
                result.semanticStructure.landmarks = landmarks.length;

                const headings = target.querySelectorAll('h1, h2, h3, h4, h5, h6');
                result.semanticStructure.headings = headings.length;

                const links = target.querySelectorAll('a[href]');
                result.semanticStructure.links = links.length;

                const images = target.querySelectorAll('img');
                result.semanticStructure.images = images.length;
                result.semanticStructure.imagesWithAlt = target.querySelectorAll('img[alt]').length;

                return result;
            }, selector);

            return {
                content: [{ type: 'text', name: 'accessibility', text: JSON.stringify(accessibility, null, 2) }]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* 17) compareVisual - сравнение скриншотов для pixel-perfect */
server.registerTool(
    'compareVisual',
    {
        title: 'Compare Visual Screenshots',
        description: 'Compare two screenshots pixel-by-pixel for visual regression testing and pixel-perfect layout validation. Essential for detecting unintended visual changes and ensuring design consistency.',
        inputSchema: {
            url1: z.string().url().describe('First page URL'),
            url2: z.string().url().describe('Second page URL'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for the element to compare'),
            threshold: z.number().min(0).max(1).optional().describe('Difference threshold (0-1, default: 0.01)'),
            padding: z.number().optional().describe('Padding around element in pixels')
        }
    },
    async ({ url1, url2, selector, threshold = 0.01, padding = 0 }) => {
        const { page: page1 } = await createPage();
        const { page: page2 } = await createPage();
        
        try {
            // Загружаем обе страницы
            await Promise.all([
                page1.goto(url1, { waitUntil: 'networkidle2' }),
                page2.goto(url2, { waitUntil: 'networkidle2' })
            ]);
            
            // Находим элементы
            const [element1, element2] = await Promise.all([
                page1.$(selector),
                page2.$(selector)
            ]);
            
            if (!element1) throw new Error( `Selector not found on first page: ${selector}`);
            if (!element2) throw new Error( `Selector not found on second page: ${selector}`);
            
            // Получаем размеры
            const [box1, box2] = await Promise.all([
                element1.boundingBox(),
                element2.boundingBox()
            ]);
            
            if (!box1 || !box2) {
                throw new Error( 'Elements are not visible or have no bounding box');
            }
            
            // Создаем одинаковые области для сравнения
            const maxWidth = Math.max(box1.width, box2.width);
            const maxHeight = Math.max(box1.height, box2.height);
            
            const clip = {
                x: Math.max((box1.x || box2.x) - padding, 0),
                y: Math.max((box1.y || box2.y) - padding, 0),
                width: maxWidth + padding * 2,
                height: maxHeight + padding * 2
            };
            
            // Делаем скриншоты
            const [buffer1, buffer2] = await Promise.all([
                page1.screenshot({ clip }),
                page2.screenshot({ clip })
            ]);
            
            // Простое сравнение по размеру
            const sizeDifference = Math.abs(buffer1.length - buffer2.length);
            const maxSize = Math.max(buffer1.length, buffer2.length);
            const differencePercent = maxSize > 0 ? sizeDifference / maxSize : 0;
            
            const isIdentical = buffer1.equals(buffer2);
            const isWithinThreshold = differencePercent <= threshold;
            
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            identical: isIdentical,
                            withinThreshold: isWithinThreshold,
                            differencePercent: Math.round(differencePercent * 10000) / 100, // в процентах с 2 знаками
                            threshold: threshold * 100,
                            dimensions: {
                                page1: { width: box1.width, height: box1.height },
                                page2: { width: box2.width, height: box2.height }
                            },
                            bufferSizes: {
                                page1: buffer1.length,
                                page2: buffer2.length
                            }
                        }, null, 2)
                    },
                    {
                        type: 'image',
                        data: buffer1.toString('base64'),
                        mimeType: 'image/png'
                    },
                    {
                        type: 'image', 
                        data: buffer2.toString('base64'),
                        mimeType: 'image/png'
                    }
                ]
            };
        } finally {
            await Promise.all([
                page1.close().catch(() => {}),
                page2.close().catch(() => {})
            ]);
        }
    }
);

/* 18) measureElement - точные размеры для pixel-perfect */
server.registerTool(
    'measureElement',
    {
        title: 'Measure Element Precisely',
        description: 'Get precise pixel measurements of an element including sub-pixel positioning, computed dimensions, and visual boundaries. Essential for pixel-perfect layout validation and design system compliance.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for the element to measure')
        }
    },
    async ({ url, selector }) => {
        const page = await getPageForOperation(url);
        try {
const client = page._cdpClient || await page.target().createCDPSession();

            const measurements = await page.evaluate((sel) => {
                const element = document.querySelector(sel);
                if (!element) return null;
                
                const rect = element.getBoundingClientRect();
                const computedStyle = window.getComputedStyle(element);
                
                return {
                    // Точные размеры из getBoundingClientRect
                    boundingRect: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        top: rect.top,
                        right: rect.right,
                        bottom: rect.bottom,
                        left: rect.left
                    },
                    
                    // Размеры элемента
                    dimensions: {
                        offsetWidth: element.offsetWidth,
                        offsetHeight: element.offsetHeight,
                        clientWidth: element.clientWidth,
                        clientHeight: element.clientHeight,
                        scrollWidth: element.scrollWidth,
                        scrollHeight: element.scrollHeight
                    },
                    
                    // Вычисленные CSS размеры
                    computedDimensions: {
                        width: computedStyle.width,
                        height: computedStyle.height,
                        minWidth: computedStyle.minWidth,
                        maxWidth: computedStyle.maxWidth,
                        minHeight: computedStyle.minHeight,
                        maxHeight: computedStyle.maxHeight
                    },
                    
                    // Отступы и границы
                    spacing: {
                        marginTop: parseFloat(computedStyle.marginTop),
                        marginRight: parseFloat(computedStyle.marginRight),
                        marginBottom: parseFloat(computedStyle.marginBottom),
                        marginLeft: parseFloat(computedStyle.marginLeft),
                        
                        paddingTop: parseFloat(computedStyle.paddingTop),
                        paddingRight: parseFloat(computedStyle.paddingRight),
                        paddingBottom: parseFloat(computedStyle.paddingBottom),
                        paddingLeft: parseFloat(computedStyle.paddingLeft),
                        
                        borderTopWidth: parseFloat(computedStyle.borderTopWidth),
                        borderRightWidth: parseFloat(computedStyle.borderRightWidth),
                        borderBottomWidth: parseFloat(computedStyle.borderBottomWidth),
                        borderLeftWidth: parseFloat(computedStyle.borderLeftWidth)
                    },
                    
                    // Позиционирование
                    position: {
                        position: computedStyle.position,
                        top: computedStyle.top,
                        right: computedStyle.right,
                        bottom: computedStyle.bottom,
                        left: computedStyle.left,
                        zIndex: computedStyle.zIndex
                    }
                };
            }, selector);
            
            if (!measurements) {
                throw new Error( `Selector not found: ${selector}`);
            }

            return {
                content: [{ type: 'text', name: 'measurements', text: JSON.stringify(measurements, null, 2) }]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* ================== БЛОК 1: ПРОДВИНУТОЕ ВИЗУАЛЬНОЕ СРАВНЕНИЕ ================== */

/* Утилита для вычисления SSIM (Structural Similarity Index) */
function calculateSSIM(img1Data, img2Data, width, height) {
    if (img1Data.length !== img2Data.length) {
        return 0;
    }
    
    const windowSize = 8;
    const k1 = 0.01;
    const k2 = 0.03;
    const c1 = (k1 * 255) ** 2;
    const c2 = (k2 * 255) ** 2;
    
    let ssimSum = 0;
    let validWindows = 0;
    
    for (let y = 0; y <= height - windowSize; y += windowSize) {
        for (let x = 0; x <= width - windowSize; x += windowSize) {
            let sum1 = 0, sum2 = 0, sum1Sq = 0, sum2Sq = 0, sum12 = 0;
            
            for (let dy = 0; dy < windowSize; dy++) {
                for (let dx = 0; dx < windowSize; dx++) {
                    const idx = ((y + dy) * width + (x + dx)) * 4;
                    if (idx + 2 >= img1Data.length) continue;
                    
                    const gray1 = (img1Data[idx] * 0.299 + img1Data[idx + 1] * 0.587 + img1Data[idx + 2] * 0.114);
                    const gray2 = (img2Data[idx] * 0.299 + img2Data[idx + 1] * 0.587 + img2Data[idx + 2] * 0.114);
                    
                    sum1 += gray1;
                    sum2 += gray2;
                    sum1Sq += gray1 * gray1;
                    sum2Sq += gray2 * gray2;
                    sum12 += gray1 * gray2;
                }
            }
            
            const n = windowSize * windowSize;
            const mean1 = sum1 / n;
            const mean2 = sum2 / n;
            const variance1 = (sum1Sq - sum1 * mean1) / n;
            const variance2 = (sum2Sq - sum2 * mean2) / n;
            const covariance = (sum12 - sum1 * mean2) / n;
            
            const ssim = ((2 * mean1 * mean2 + c1) * (2 * covariance + c2)) /
                        ((mean1 * mean1 + mean2 * mean2 + c1) * (variance1 + variance2 + c2));
                        
            ssimSum += ssim;
            validWindows++;
        }
    }
    
    return validWindows > 0 ? ssimSum / validWindows : 0;
}

/* 19) compareVisualAdvanced - продвинутое сравнение с heat map */
server.registerTool(
    'compareVisualAdvanced',
    {
        title: 'Advanced Visual Comparison',
        description: `⭐ PREMIER VISUAL ANALYSIS TOOL ⭐

This is THE tool for detecting subtle visual differences that basic comparison misses. 
Uses advanced computer vision techniques to identify even 1-2% differences in design implementation.

🎯 USE THIS WHEN:
- User reports "looks almost the same but something is off"
- Basic compareVisual() shows high similarity (>95%) but issues persist  
- Need to catch micro-differences in shadows, gradients, font rendering
- Validating pixel-perfect implementations against design
- Creating visual regression test baselines
- Analyzing structural similarity beyond pixel matching

📊 WHAT YOU GET:
- SSIM (Structural Similarity Index): 0.0-1.0 score for structural similarity
- Pixel difference percentage with color-coded heat map
- Advanced color analysis with RGB delta calculations  
- Visual evidence: original images + difference overlay
- Smart recommendations based on difference patterns
- Tolerance breach analysis with actionable insights

🚦 INTERPRETING RESULTS:
- SSIM > 0.95: Excellent structural match
- SSIM 0.85-0.95: Good match with minor differences  
- SSIM 0.70-0.85: Moderate differences - investigate specific aspects
- SSIM < 0.70: Significant structural differences - major issues present

- Pixel Difference < 1%: Pixel-perfect or near-perfect
- Pixel Difference 1-5%: Minor differences, possibly acceptable
- Pixel Difference 5-15%: Moderate differences, needs attention
- Pixel Difference > 15%: Major differences, significant rework needed

💡 PRO TIPS:
- Always enable generateHeatMap for visual debugging
- Use padding parameter to include surrounding context
- Combine with specific tools (compareFonts, compareSpacing) for deep analysis
- Set threshold based on project requirements (strict: 0.01, normal: 0.05, lenient: 0.1)

⚠️ PERFORMANCE NOTE: Computationally intensive - use for final validation, not rapid iteration`,
        inputSchema: {
            url1: z.string().url().describe('First page URL'),
            url2: z.string().url().describe('Second page URL'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for elements to compare'),
            threshold: z.number().min(0).max(1).optional().describe('Difference threshold (0-1, default: 0.01)'),
            padding: z.number().optional().describe('Padding around element in pixels'),
            generateHeatMap: z.boolean().optional().describe('Generate difference heat map (default: true)')
        }
    },
    async ({ url1, url2, selector, threshold = 0.01, padding = 0, generateHeatMap = true }) => {
        const { page: page1 } = await createPage();
        const { page: page2 } = await createPage();
        
        try {
            await Promise.all([
                page1.goto(url1, { waitUntil: 'networkidle2' }),
                page2.goto(url2, { waitUntil: 'networkidle2' })
            ]);
            
            const [element1, element2] = await Promise.all([
                page1.$(selector),
                page2.$(selector)
            ]);
            
            if (!element1) throw new Error( `Selector not found on first page: ${selector}`);
            if (!element2) throw new Error( `Selector not found on second page: ${selector}`);
            
            const [box1, box2] = await Promise.all([
                element1.boundingBox(),
                element2.boundingBox()
            ]);
            
            if (!box1 || !box2) {
                throw new Error( 'Elements are not visible or have no bounding box');
            }
            
            const maxWidth = Math.max(box1.width, box2.width);
            const maxHeight = Math.max(box1.height, box2.height);
            
            const clip = {
                x: Math.max((box1.x || box2.x) - padding, 0),
                y: Math.max((box1.y || box2.y) - padding, 0),
                width: maxWidth + padding * 2,
                height: maxHeight + padding * 2
            };
            
            const [buffer1, buffer2] = await Promise.all([
                page1.screenshot({ clip }),
                page2.screenshot({ clip })
            ]);
            
            // Загружаем изображения через Jimp для детального анализа
            const [img1, img2] = await Promise.all([
                Jimp.read(buffer1),
                Jimp.read(buffer2)
            ]);
            
            // Приводим к одинаковым размерам
            const finalWidth = Math.max(img1.bitmap.width, img2.bitmap.width);
            const finalHeight = Math.max(img1.bitmap.height, img2.bitmap.height);
            
            img1.resize(finalWidth, finalHeight);
            img2.resize(finalWidth, finalHeight);
            
            const img1Data = new Uint8ClampedArray(img1.bitmap.data);
            const img2Data = new Uint8ClampedArray(img2.bitmap.data);
            
            // Создаем изображение различий
            const diffData = new Uint8ClampedArray(finalWidth * finalHeight * 4);
            const diffPixels = pixelmatch(img1Data, img2Data, diffData, finalWidth, finalHeight, {
                threshold: 0.1,
                includeAA: false
            });
            
            // Вычисляем SSIM
            const ssimValue = calculateSSIM(img1Data, img2Data, finalWidth, finalHeight);
            
            // Анализ цветовых различий
            let colorDifferences = 0;
            let maxColorDiff = 0;
            
            for (let i = 0; i < img1Data.length; i += 4) {
                const rDiff = Math.abs(img1Data[i] - img2Data[i]);
                const gDiff = Math.abs(img1Data[i + 1] - img2Data[i + 1]);
                const bDiff = Math.abs(img1Data[i + 2] - img2Data[i + 2]);
                const totalDiff = rDiff + gDiff + bDiff;
                
                if (totalDiff > 30) { // Порог для значимого отличия
                    colorDifferences++;
                }
                maxColorDiff = Math.max(maxColorDiff, totalDiff);
            }
            
            const totalPixels = finalWidth * finalHeight;
            const pixelDifferencePercent = (diffPixels / totalPixels) * 100;
            const colorDifferencePercent = (colorDifferences / totalPixels) * 100;
            
            const result = {
                identical: diffPixels === 0,
                withinThreshold: pixelDifferencePercent <= (threshold * 100),
                metrics: {
                    pixelDifferences: diffPixels,
                    pixelDifferencePercent: Math.round(pixelDifferencePercent * 100) / 100,
                    colorDifferencePercent: Math.round(colorDifferencePercent * 100) / 100,
                    ssim: Math.round(ssimValue * 10000) / 10000,
                    maxColorDifference: maxColorDiff,
                    totalPixels: totalPixels
                },
                dimensions: {
                    width: finalWidth,
                    height: finalHeight
                },
                analysis: {
                    visualSimilarity: ssimValue > 0.95 ? 'Very High' : ssimValue > 0.85 ? 'High' : ssimValue > 0.7 ? 'Medium' : 'Low',
                    recommendation: pixelDifferencePercent < 1 ? 'Acceptable' : pixelDifferencePercent < 5 ? 'Minor Issues' : 'Significant Differences'
                }
            };
            
            const content = [
                {
                    type: 'text',
                    text: JSON.stringify(result, null, 2)
                },
                {
                    type: 'image',
                    data: buffer1.toString('base64'),
                    mimeType: 'image/png'
                },
                {
                    type: 'image',
                    data: buffer2.toString('base64'),
                    mimeType: 'image/png'
                }
            ];
            
            if (generateHeatMap && diffPixels > 0) {
                const diffImg = new Jimp({ data: Buffer.from(diffData), width: finalWidth, height: finalHeight });
                const diffBuffer = await diffImg.getBufferAsync(Jimp.MIME_PNG);
                
                content.push({
                    type: 'image',
                    data: diffBuffer.toString('base64'),
                    mimeType: 'image/png'
                });
            }
            
            return { content };
            
        } finally {
            await Promise.all([
                page1.close().catch(() => {}),
                page2.close().catch(() => {})
            ]);
        }
    }
);

/* 20) analyzeColorDifferences - анализ цветовых различий */
server.registerTool(
    'analyzeColorDifferences',
    {
        title: 'Analyze Color Differences',
        description: 'Detailed color analysis between two elements or pages. Identifies color palette differences, dominant color changes, and color distribution variations.',
        inputSchema: {
            url1: z.string().url().describe('First page URL'),
            url2: z.string().url().describe('Second page URL'), 
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),
 
            selector: z.string().describe('CSS selector for elements to analyze'),
            colorTolerance: z.number().min(0).max(255).optional().describe('Color tolerance (0-255, default: 10)')
        }
    },
    async ({ url1, url2, selector, colorTolerance = 10 }) => {
        const { page: page1 } = await createPage();
        const { page: page2 } = await createPage();
        
        try {
            await Promise.all([
                page1.goto(url1, { waitUntil: 'networkidle2' }),
                page2.goto(url2, { waitUntil: 'networkidle2' })
            ]);
            
            const [element1, element2] = await Promise.all([
                page1.$(selector),
                page2.$(selector)
            ]);
            
            if (!element1) throw new Error( `Selector not found on first page: ${selector}`);
            if (!element2) throw new Error( `Selector not found on second page: ${selector}`);
            
            const [buffer1, buffer2] = await Promise.all([
                element1.screenshot(),
                element2.screenshot()
            ]);
            
            const [img1, img2] = await Promise.all([
                Jimp.read(buffer1),
                Jimp.read(buffer2)
            ]);
            
            // Анализ цветовых палитр
            function analyzeColorPalette(img) {
                const colors = new Map();
                const data = img.bitmap.data;
                
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1]; 
                    const b = data[i + 2];
                    const a = data[i + 3];
                    
                    if (a < 128) continue; // Пропускаем прозрачные пиксели
                    
                    const colorKey = `${r},${g},${b}`;
                    colors.set(colorKey, (colors.get(colorKey) || 0) + 1);
                }
                
                // Сортируем по частоте использования
                const sortedColors = Array.from(colors.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10) // Топ 10 цветов
                    .map(([color, count]) => {
                        const [r, g, b] = color.split(',').map(Number);
                        return {
                            rgb: [r, g, b],
                            hex: `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`,
                            count,
                            percentage: Math.round((count / (img.bitmap.width * img.bitmap.height)) * 10000) / 100
                        };
                    });
                    
                return sortedColors;
            }
            
            const palette1 = analyzeColorPalette(img1);
            const palette2 = analyzeColorPalette(img2);
            
            // Сравнение доминантных цветов
            const colorMatches = [];
            const colorChanges = [];
            
            palette1.forEach(color1 => {
                const match = palette2.find(color2 => {
                    const rDiff = Math.abs(color1.rgb[0] - color2.rgb[0]);
                    const gDiff = Math.abs(color1.rgb[1] - color2.rgb[1]);
                    const bDiff = Math.abs(color1.rgb[2] - color2.rgb[2]);
                    return rDiff <= colorTolerance && gDiff <= colorTolerance && bDiff <= colorTolerance;
                });
                
                if (match) {
                    colorMatches.push({
                        color1: color1.hex,
                        color2: match.hex,
                        percentageChange: Math.round((match.percentage - color1.percentage) * 100) / 100
                    });
                } else {
                    colorChanges.push({
                        action: 'removed',
                        color: color1.hex,
                        percentage: color1.percentage
                    });
                }
            });
            
            palette2.forEach(color2 => {
                const exists = palette1.find(color1 => {
                    const rDiff = Math.abs(color1.rgb[0] - color2.rgb[0]);
                    const gDiff = Math.abs(color1.rgb[1] - color2.rgb[1]);
                    const bDiff = Math.abs(color1.rgb[2] - color2.rgb[2]);
                    return rDiff <= colorTolerance && gDiff <= colorTolerance && bDiff <= colorTolerance;
                });
                
                if (!exists) {
                    colorChanges.push({
                        action: 'added',
                        color: color2.hex,
                        percentage: color2.percentage
                    });
                }
            });
            
            const analysis = {
                palette1: palette1,
                palette2: palette2,
                comparison: {
                    matchingColors: colorMatches.length,
                    totalChanges: colorChanges.length,
                    colorMatches: colorMatches,
                    colorChanges: colorChanges
                },
                summary: {
                    dominantColor1: palette1[0]?.hex || 'N/A',
                    dominantColor2: palette2[0]?.hex || 'N/A',
                    majorChange: colorChanges.length > 3,
                    recommendation: colorChanges.length === 0 ? 'Colors match' : 
                                   colorChanges.length < 3 ? 'Minor color differences' : 
                                   'Significant color changes detected'
                }
            };
            
            return {
                content: [
                    { type: 'text', text: JSON.stringify(analysis, null, 2) },
                    { type: 'image', data: buffer1.toString('base64'), mimeType: 'image/png' },
                    { type: 'image', data: buffer2.toString('base64'), mimeType: 'image/png' }
                ]
            };
            
        } finally {
            await Promise.all([
                page1.close().catch(() => {}),
                page2.close().catch(() => {})
            ]);
        }
    }
);

/* ================== БЛОК 2: FIGMA ИНТЕГРАЦИЯ ================== */

/* Утилита для работы с Figma API */
async function fetchFigmaAPI(endpoint, figmaToken) {
    if (!figmaToken) {
        throw new McpError(ErrorCode.InvalidRequest, 'Figma token is required. Get it from https://www.figma.com/developers/api#access-tokens');
    }
    
    const response = await fetch(`https://api.figma.com/v1/${endpoint}`, {
        headers: {
            'X-Figma-Token': figmaToken
        }
    });
    
    if (!response.ok) {
        const error = await response.text();
        throw new McpError(ErrorCode.InternalError, `Figma API error: ${response.status} - ${error}`);
    }
    
    return response.json();
}

/* 21) getFigmaFrame - получение frame из Figma */
server.registerTool(
    'getFigmaFrame',
    {
        title: 'Get Figma Frame',
        description: 'Export and download a Figma frame as PNG image for comparison. Requires Figma API token and file/node IDs from Figma URLs.',
        inputSchema: {
            figmaToken: z.string().optional().describe('Figma API token (optional if FIGMA_TOKEN env var is set)'),
            fileKey: z.string().describe('Figma file key (from URL: figma.com/file/FILE_KEY/...)'),
            nodeId: z.string().describe('Figma node ID (frame/component ID)'),
            scale: z.number().min(0.1).max(4).optional().describe('Export scale (0.1-4, default: 2)'),
            format: z.enum(['png', 'jpg', 'svg']).optional().describe('Export format (default: png)')
        }
    },
    async ({ figmaToken, fileKey, nodeId, scale = 2, format = 'png' }) => {
        // Use provided token or fall back to environment variable
        const token = figmaToken || FIGMA_TOKEN;
        if (!token) {
            throw new McpError(ErrorCode.InvalidRequest, 'Figma token is required. Pass it as parameter or set FIGMA_TOKEN environment variable in MCP config.');
        }
        try {
            // Получаем URL для экспорта
            const exportData = await fetchFigmaAPI(
                `images/${fileKey}?ids=${nodeId}&scale=${scale}&format=${format}`, 
                token
            );
            
            if (!exportData.images || !exportData.images[nodeId]) {
                throw new McpError(ErrorCode.InvalidRequest, `Failed to export node ${nodeId} from file ${fileKey}`);
            }
            
            const imageUrl = exportData.images[nodeId];
            
            // Скачиваем изображение
            const imageResponse = await fetch(imageUrl);
            if (!imageResponse.ok) {
                throw new McpError(ErrorCode.InternalError, `Failed to download image: ${imageResponse.status}`);
            }
            
            const imageBuffer = await imageResponse.buffer();

            // Получаем информацию о frame через nodes API (избегаем загрузки всего файла)
            const nodesData = await fetchFigmaAPI(`files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`, token);
            const frameInfo = nodesData.nodes?.[nodeId]?.document;
            
            const result = {
                figmaInfo: {
                    fileName: nodesData.name || 'Unknown',
                    frameId: nodeId,
                    frameName: frameInfo?.name || 'Unknown',
                    dimensions: frameInfo ? {
                        width: frameInfo.absoluteBoundingBox?.width,
                        height: frameInfo.absoluteBoundingBox?.height
                    } : null,
                    exportSettings: {
                        scale,
                        format,
                        fileSize: imageBuffer.length
                    }
                }
            };
            
            return {
                content: [
                    { type: 'text', text: JSON.stringify(result, null, 2) },
                    { 
                        type: 'image', 
                        data: imageBuffer.toString('base64'), 
                        mimeType: `image/${format}` 
                    }
                ]
            };
            
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            throw new McpError(ErrorCode.InternalError, `Figma API error: ${error.message}`);
        }
    }
);

/* 22) compareFigmaToElement - сравнение Figma с элементом страницы */
server.registerTool(
    'compareFigmaToElement',
    {
        title: 'Compare Figma to Page Element',
        description: `🏆 THE ULTIMATE DESIGN-TO-CODE VALIDATION TOOL 🏆

This is the GOLD STANDARD for comparing Figma designs directly with browser implementation.
Eliminates guesswork by providing direct, automated design-vs-reality comparison.

🎯 USE THIS WHEN:
- Designer says "this doesn't match the Figma"
- Need authoritative comparison between design source and implementation
- Pixel-perfect validation is required for production release
- Creating design system compliance reports
- Onboarding new developers who need to match designs precisely
- Client approval requires design fidelity documentation

🔄 WHAT THIS TOOL DOES:
1. Fetches high-resolution export directly from Figma API
2. Screenshots the live element from browser
3. Normalizes both images to same dimensions
4. Performs advanced pixel-by-pixel + structural comparison
5. Generates difference heat map showing exact mismatches
6. Provides actionable recommendations with percentage accuracy

📊 RESULTS INTERPRETATION:
- "Pixel-perfect match" (<1% difference): Ready for production
- "Very close to design" (1-3% difference): Minor tweaks needed
- "Minor differences" (3-10% difference): Review spacing/colors  
- "Significant differences" (>10% difference): Major rework required

🔧 FIGMA SETUP REQUIRED:
1. Get Figma API token: https://www.figma.com/developers/api#access-tokens
2. File key from URL: figma.com/file/FILE_KEY/filename
3. Node ID: Right-click element in Figma → Copy/Paste as → Copy link → extract node ID

🎨 FIGMA URL EXAMPLES:
- Full URL: figma.com/file/ABC123/MyDesign?node-id=1%3A234
- File Key: ABC123  
- Node ID: 1:234 (URL decode the %3A to :)

💡 PRO WORKFLOW:
1. Start with this tool for overall comparison
2. If differences detected, use specific tools:
   - compareFonts() for typography issues
   - compareSpacing() for layout problems  
   - analyzeColorDifferences() for color mismatches
3. Document findings with returned images for stakeholder review

⚠️ LIMITATIONS:
- Requires valid Figma API access
- Large complex components may need higher figmaScale (2-4x)
- Interactive states (hover, focus) need separate Figma frames
- Custom fonts must be loaded in browser for accurate comparison

🚀 THIS TOOL ELIMINATES:
- Manual screenshot comparison
- Subjective "looks close enough" decisions  
- Back-and-forth between designers and developers
- Guesswork about design fidelity requirements`,
        inputSchema: {
            figmaToken: z.string().optional().describe('Figma API token (optional if FIGMA_TOKEN env var is set)'),
            fileKey: z.string().describe('Figma file key'),
            nodeId: z.string().describe('Figma frame/component ID'),
            url: z.string().url().describe('Web page URL'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for page element'),
            threshold: z.number().min(0).max(1).optional().describe('Difference threshold (0-1, default: 0.05)'),
            figmaScale: z.number().min(0.1).max(4).optional().describe('Figma export scale (default: 2)')
        }
    },
    async ({ figmaToken, fileKey, nodeId, url, selector, threshold = 0.05, figmaScale = 2 }) => {
        // Use provided token or fall back to environment variable
        const token = figmaToken || FIGMA_TOKEN;
        if (!token) {
            throw new McpError(ErrorCode.InvalidRequest, 'Figma token is required. Pass it as parameter or set FIGMA_TOKEN environment variable in MCP config.');
        }
        const page = await getPageForOperation(url);
        
        try {
            // Получаем Figma изображение
            const exportData = await fetchFigmaAPI(
                `images/${fileKey}?ids=${nodeId}&scale=${figmaScale}&format=png`, 
                token
            );
            
            if (!exportData.images || !exportData.images[nodeId]) {
                throw new Error( `Failed to export Figma node ${nodeId}`);
            }
            
            const figmaImageUrl = exportData.images[nodeId];
            const figmaResponse = await fetch(figmaImageUrl);
            const figmaBuffer = await figmaResponse.buffer();
            
            // Получаем скриншот элемента страницы            const element = await page.$(selector);
            
            if (!element) {
                throw new Error( `Selector not found: ${selector}`);
            }
            
            const pageBuffer = await element.screenshot();
            
            // Загружаем изображения для сравнения
            const [figmaImg, pageImg] = await Promise.all([
                Jimp.read(figmaBuffer),
                Jimp.read(pageBuffer)
            ]);
            
            // Приводим к одинаковым размерам (берем большие размеры)
            const targetWidth = Math.max(figmaImg.bitmap.width, pageImg.bitmap.width);
            const targetHeight = Math.max(figmaImg.bitmap.height, pageImg.bitmap.height);
            
            figmaImg.resize(targetWidth, targetHeight);
            pageImg.resize(targetWidth, targetHeight);
            
            // Сравниваем изображения
            const figmaData = new Uint8ClampedArray(figmaImg.bitmap.data);
            const pageData = new Uint8ClampedArray(pageImg.bitmap.data);
            const diffData = new Uint8ClampedArray(targetWidth * targetHeight * 4);
            
            const diffPixels = pixelmatch(figmaData, pageData, diffData, targetWidth, targetHeight, {
                threshold: 0.1,
                includeAA: false
            });
            
            const ssimValue = calculateSSIM(figmaData, pageData, targetWidth, targetHeight);
            const totalPixels = targetWidth * targetHeight;
            const differencePercent = (diffPixels / totalPixels) * 100;
            
            // Анализ результатов
            const analysis = {
                figmaVsPage: {
                    identical: diffPixels === 0,
                    withinThreshold: differencePercent <= (threshold * 100),
                    pixelDifferences: diffPixels,
                    differencePercent: Math.round(differencePercent * 100) / 100,
                    ssim: Math.round(ssimValue * 10000) / 10000,
                    recommendation: differencePercent < 1 ? 'Pixel-perfect match' :
                                   differencePercent < 3 ? 'Very close to design' :
                                   differencePercent < 10 ? 'Minor differences detected' :
                                   'Significant differences from design'
                },
                dimensions: {
                    figma: { width: figmaImg.bitmap.width, height: figmaImg.bitmap.height },
                    page: { width: pageImg.bitmap.width, height: pageImg.bitmap.height },
                    comparison: { width: targetWidth, height: targetHeight }
                }
            };
            
            const content = [
                { type: 'text', text: JSON.stringify(analysis, null, 2) },
                { type: 'image', data: figmaBuffer.toString('base64'), mimeType: 'image/png' },
                { type: 'image', data: pageBuffer.toString('base64'), mimeType: 'image/png' }
            ];
            
            // Добавляем difference map если есть различия
            if (diffPixels > 0) {
                const diffImg = new Jimp({ data: Buffer.from(diffData), width: targetWidth, height: targetHeight });
                const diffBuffer = await diffImg.getBufferAsync(Jimp.MIME_PNG);
                content.push({
                    type: 'image',
                    data: diffBuffer.toString('base64'),
                    mimeType: 'image/png'
                });
            }
            
            return { content };
            
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* 23) getFigmaSpecs - получение спецификаций из Figma */
server.registerTool(
    'getFigmaSpecs',
    {
        title: 'Get Figma Design Specifications',
        description: 'Extract detailed design specifications from Figma including colors, fonts, dimensions, and spacing. Perfect for design-to-code comparison.',
        inputSchema: {
            figmaToken: z.string().optional().describe('Figma API token (optional if FIGMA_TOKEN env var is set)'),
            fileKey: z.string().describe('Figma file key'),
            nodeId: z.string().describe('Figma frame/component ID')
        }
    },
    async ({ figmaToken, fileKey, nodeId }) => {
        // Use provided token or fall back to environment variable
        const token = figmaToken || FIGMA_TOKEN;
        if (!token) {
            throw new McpError(ErrorCode.InvalidRequest, 'Figma token is required. Pass it as parameter or set FIGMA_TOKEN environment variable in MCP config.');
        }
        try {
            // Получаем конкретный node через nodes API (избегаем загрузки всего файла)
            const nodesData = await fetchFigmaAPI(`files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`, token);

            if (!nodesData.nodes || !nodesData.nodes[nodeId]) {
                throw new Error(`Node ${nodeId} not found in Figma file`);
            }

            const node = nodesData.nodes[nodeId].document;
            
            // Извлекаем спецификации
            const specs = {
                general: {
                    name: node.name,
                    type: node.type,
                    visible: node.visible !== false
                },
                dimensions: node.absoluteBoundingBox ? {
                    width: node.absoluteBoundingBox.width,
                    height: node.absoluteBoundingBox.height,
                    x: node.absoluteBoundingBox.x,
                    y: node.absoluteBoundingBox.y
                } : null,
                styling: {},
                children: []
            };
            
            // Анализируем стили
            if (node.fills && node.fills.length > 0) {
                specs.styling.fills = node.fills.map(fill => {
                    if (fill.type === 'SOLID') {
                        const r = Math.round(fill.color.r * 255);
                        const g = Math.round(fill.color.g * 255);
                        const b = Math.round(fill.color.b * 255);
                        const a = fill.opacity || 1;
                        return {
                            type: fill.type,
                            color: `rgba(${r}, ${g}, ${b}, ${a})`,
                            hex: `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`,
                            opacity: a
                        };
                    }
                    return fill;
                });
            }
            
            if (node.strokes && node.strokes.length > 0) {
                specs.styling.strokes = node.strokes.map(stroke => {
                    if (stroke.type === 'SOLID') {
                        const r = Math.round(stroke.color.r * 255);
                        const g = Math.round(stroke.color.g * 255);
                        const b = Math.round(stroke.color.b * 255);
                        const a = stroke.opacity || 1;
                        return {
                            type: stroke.type,
                            color: `rgba(${r}, ${g}, ${b}, ${a})`,
                            hex: `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`,
                            weight: node.strokeWeight || 1
                        };
                    }
                    return stroke;
                });
            }
            
            // Типографика
            if (node.style) {
                specs.styling.typography = {
                    fontFamily: node.style.fontFamily,
                    fontSize: node.style.fontSize,
                    fontWeight: node.style.fontWeight,
                    lineHeight: node.style.lineHeightPx || node.style.lineHeightPercent,
                    letterSpacing: node.style.letterSpacing,
                    textAlign: node.style.textAlignHorizontal,
                    textCase: node.style.textCase
                };
            }
            
            // Эффекты (тени, размытие)
            if (node.effects && node.effects.length > 0) {
                specs.styling.effects = node.effects.map(effect => ({
                    type: effect.type,
                    visible: effect.visible !== false,
                    radius: effect.radius,
                    offset: effect.offset,
                    color: effect.color ? {
                        rgba: `rgba(${Math.round(effect.color.r * 255)}, ${Math.round(effect.color.g * 255)}, ${Math.round(effect.color.b * 255)}, ${effect.color.a || 1})`
                    } : null
                }));
            }
            
            // Радиусы скругления
            if (node.cornerRadius !== undefined) {
                specs.styling.borderRadius = node.cornerRadius;
            }
            if (node.rectangleCornerRadii) {
                specs.styling.borderRadius = {
                    topLeft: node.rectangleCornerRadii[0],
                    topRight: node.rectangleCornerRadii[1],
                    bottomRight: node.rectangleCornerRadii[2],
                    bottomLeft: node.rectangleCornerRadii[3]
                };
            }
            
            // Анализируем дочерние элементы
            if (node.children && node.children.length > 0) {
                specs.children = node.children.map(child => ({
                    id: child.id,
                    name: child.name,
                    type: child.type,
                    dimensions: child.absoluteBoundingBox,
                    visible: child.visible !== false
                }));
            }
            
            return {
                content: [
                    { type: 'text', text: JSON.stringify(specs, null, 2) }
                ]
            };
            
        } catch (error) {
            throw new Error( `Figma specs error: ${error.message}`);
        }
    }
);

/* ================== БЛОК 3: ДЕТАЛЬНЫЙ АНАЛИЗ РАЗЛИЧИЙ ================== */

/* 24) compareFonts - сравнение типографики */
server.registerTool(
    'compareFonts',
    {
        title: 'Compare Typography',
        description: 'Detailed typography comparison between two elements or pages. Analyzes font families, sizes, weights, line heights, and text styling differences.',
        inputSchema: {
            url1: z.string().url().describe('First page URL'),
            url2: z.string().url().describe('Second page URL'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for text elements to compare')
        }
    },
    async ({ url1, url2, selector }) => {
        const { page: page1 } = await createPage();
        const { page: page2 } = await createPage();
        
        try {
            await Promise.all([
                page1.goto(url1, { waitUntil: 'networkidle2' }),
                page2.goto(url2, { waitUntil: 'networkidle2' })
            ]);
            
            // Получаем типографические свойства с обеих страниц
            async function getTypographyData(page, sel) {
                return await page.evaluate((selector) => {
                    const elements = document.querySelectorAll(selector);
                    const results = [];
                    
                    elements.forEach((element, index) => {
                        const computedStyle = window.getComputedStyle(element);
                        const textMetrics = {
                            element: `${selector}[${index}]`,
                            text: element.textContent?.trim().substring(0, 100) || '',
                            fontFamily: computedStyle.fontFamily,
                            fontSize: computedStyle.fontSize,
                            fontWeight: computedStyle.fontWeight,
                            fontStyle: computedStyle.fontStyle,
                            lineHeight: computedStyle.lineHeight,
                            letterSpacing: computedStyle.letterSpacing,
                            wordSpacing: computedStyle.wordSpacing,
                            textAlign: computedStyle.textAlign,
                            textDecoration: computedStyle.textDecoration,
                            textTransform: computedStyle.textTransform,
                            color: computedStyle.color,
                            textShadow: computedStyle.textShadow
                        };
                        results.push(textMetrics);
                    });
                    
                    return results;
                }, sel);
            }
            
            const [typography1, typography2] = await Promise.all([
                getTypographyData(page1, selector),
                getTypographyData(page2, selector)
            ]);
            
            if (typography1.length === 0) throw new Error( `No text elements found for selector "${selector}" on first page`);
            if (typography2.length === 0) throw new Error( `No text elements found for selector "${selector}" on second page`);
            
            // Сравниваем типографику
            const comparison = {
                summary: {
                    elementsPage1: typography1.length,
                    elementsPage2: typography2.length,
                    totalDifferences: 0
                },
                differences: [],
                detailed: []
            };
            
            const maxElements = Math.max(typography1.length, typography2.length);
            
            for (let i = 0; i < maxElements; i++) {
                const typo1 = typography1[i];
                const typo2 = typography2[i];
                
                const elementComparison = {
                    index: i,
                    exists: { page1: !!typo1, page2: !!typo2 },
                    differences: []
                };
                
                if (typo1 && typo2) {
                    // Сравниваем все свойства
                    const properties = [
                        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
                        'lineHeight', 'letterSpacing', 'textAlign', 'textDecoration',
                        'textTransform', 'color'
                    ];
                    
                    properties.forEach(prop => {
                        if (typo1[prop] !== typo2[prop]) {
                            elementComparison.differences.push({
                                property: prop,
                                page1Value: typo1[prop],
                                page2Value: typo2[prop],
                                critical: ['fontFamily', 'fontSize', 'color'].includes(prop)
                            });
                            comparison.summary.totalDifferences++;
                        }
                    });
                    
                    elementComparison.page1 = typo1;
                    elementComparison.page2 = typo2;
                } else if (typo1) {
                    elementComparison.differences.push({
                        property: 'existence',
                        issue: 'Element exists on page1 but not on page2',
                        critical: true
                    });
                    elementComparison.page1 = typo1;
                    comparison.summary.totalDifferences++;
                } else if (typo2) {
                    elementComparison.differences.push({
                        property: 'existence',
                        issue: 'Element exists on page2 but not on page1',
                        critical: true
                    });
                    elementComparison.page2 = typo2;
                    comparison.summary.totalDifferences++;
                }
                
                if (elementComparison.differences.length > 0) {
                    comparison.differences.push(elementComparison);
                }
                
                comparison.detailed.push(elementComparison);
            }
            
            // Анализ общих паттернов
            const analysis = {
                mostCommonDifferences: {},
                criticalIssues: comparison.differences.filter(d => 
                    d.differences.some(diff => diff.critical)
                ).length,
                recommendation: comparison.summary.totalDifferences === 0 ? 'Typography matches perfectly' :
                               comparison.summary.totalDifferences < 3 ? 'Minor typography differences' :
                               comparison.summary.totalDifferences < 10 ? 'Moderate typography differences' :
                               'Significant typography differences detected'
            };
            
            // Подсчет наиболее частых различий
            comparison.differences.forEach(element => {
                element.differences.forEach(diff => {
                    analysis.mostCommonDifferences[diff.property] = 
                        (analysis.mostCommonDifferences[diff.property] || 0) + 1;
                });
            });
            
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            comparison,
                            analysis
                        }, null, 2)
                    }
                ]
            };
            
        } finally {
            await Promise.all([
                page1.close().catch(() => {}),
                page2.close().catch(() => {})
            ]);
        }
    }
);

/* 25) compareSpacing - анализ отступов и размеров */
server.registerTool(
    'compareSpacing',
    {
        title: 'Compare Spacing and Dimensions',
        description: 'Detailed spacing analysis between elements. Compares margins, padding, dimensions, and positioning for pixel-perfect layout validation.',
        inputSchema: {
            url1: z.string().url().describe('First page URL'),
            url2: z.string().url().describe('Second page URL'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for elements to compare spacing'),
            tolerance: z.number().min(0).optional().describe('Tolerance in pixels for spacing differences (default: 1)')
        }
    },
    async ({ url1, url2, selector, tolerance = 1 }) => {
        const { page: page1 } = await createPage();
        const { page: page2 } = await createPage();
        
        try {
            await Promise.all([
                page1.goto(url1, { waitUntil: 'networkidle2' }),
                page2.goto(url2, { waitUntil: 'networkidle2' })
            ]);
            
            // Получаем данные о spacing
            async function getSpacingData(page, sel) {
                return await page.evaluate((selector) => {
                    const elements = document.querySelectorAll(selector);
                    const results = [];
                    
                    elements.forEach((element, index) => {
                        const computedStyle = window.getComputedStyle(element);
                        const rect = element.getBoundingClientRect();
                        
                        const spacing = {
                            element: `${selector}[${index}]`,
                            dimensions: {
                                width: rect.width,
                                height: rect.height,
                                offsetWidth: element.offsetWidth,
                                offsetHeight: element.offsetHeight
                            },
                            position: {
                                x: rect.x,
                                y: rect.y,
                                top: rect.top,
                                left: rect.left,
                                right: rect.right,
                                bottom: rect.bottom
                            },
                            margins: {
                                top: parseFloat(computedStyle.marginTop),
                                right: parseFloat(computedStyle.marginRight),
                                bottom: parseFloat(computedStyle.marginBottom),
                                left: parseFloat(computedStyle.marginLeft)
                            },
                            padding: {
                                top: parseFloat(computedStyle.paddingTop),
                                right: parseFloat(computedStyle.paddingRight),
                                bottom: parseFloat(computedStyle.paddingBottom),
                                left: parseFloat(computedStyle.paddingLeft)
                            },
                            border: {
                                top: parseFloat(computedStyle.borderTopWidth),
                                right: parseFloat(computedStyle.borderRightWidth),
                                bottom: parseFloat(computedStyle.borderBottomWidth),
                                left: parseFloat(computedStyle.borderLeftWidth)
                            }
                        };
                        
                        results.push(spacing);
                    });
                    
                    return results;
                }, sel);
            }
            
            const [spacing1, spacing2] = await Promise.all([
                getSpacingData(page1, selector),
                getSpacingData(page2, selector)
            ]);
            
            if (spacing1.length === 0) throw new Error( `No elements found for selector "${selector}" on first page`);
            if (spacing2.length === 0) throw new Error( `No elements found for selector "${selector}" on second page`);
            
            // Сравниваем spacing
            const comparison = {
                summary: {
                    elementsPage1: spacing1.length,
                    elementsPage2: spacing2.length,
                    tolerance: tolerance,
                    totalDifferences: 0,
                    significantDifferences: 0
                },
                differences: []
            };
            
            function compareValues(val1, val2, property, category) {
                const diff = Math.abs(val1 - val2);
                if (diff > tolerance) {
                    const isSignificant = diff > tolerance * 3; // Считаем значимым если разница больше чем tolerance * 3
                    
                    if (isSignificant) comparison.summary.significantDifferences++;
                    comparison.summary.totalDifferences++;
                    
                    return {
                        property: `${category}.${property}`,
                        page1Value: val1,
                        page2Value: val2,
                        difference: diff,
                        significant: isSignificant,
                        withinTolerance: false
                    };
                }
                return null;
            }
            
            const maxElements = Math.max(spacing1.length, spacing2.length);
            
            for (let i = 0; i < maxElements; i++) {
                const space1 = spacing1[i];
                const space2 = spacing2[i];
                
                const elementComparison = {
                    index: i,
                    exists: { page1: !!space1, page2: !!space2 },
                    differences: []
                };
                
                if (space1 && space2) {
                    // Сравниваем размеры
                    ['width', 'height'].forEach(dim => {
                        const diff = compareValues(space1.dimensions[dim], space2.dimensions[dim], dim, 'dimensions');
                        if (diff) elementComparison.differences.push(diff);
                    });
                    
                    // Сравниваем отступы
                    ['top', 'right', 'bottom', 'left'].forEach(side => {
                        ['margins', 'padding', 'border'].forEach(category => {
                            const diff = compareValues(space1[category][side], space2[category][side], side, category);
                            if (diff) elementComparison.differences.push(diff);
                        });
                    });
                    
                    elementComparison.page1 = space1;
                    elementComparison.page2 = space2;
                } else {
                    elementComparison.differences.push({
                        property: 'existence',
                        issue: space1 ? 'Element exists on page1 but not on page2' : 'Element exists on page2 but not on page1',
                        significant: true
                    });
                    comparison.summary.totalDifferences++;
                    comparison.summary.significantDifferences++;
                    
                    if (space1) elementComparison.page1 = space1;
                    if (space2) elementComparison.page2 = space2;
                }
                
                if (elementComparison.differences.length > 0) {
                    comparison.differences.push(elementComparison);
                }
            }
            
            // Анализ
            const analysis = {
                pixelPerfect: comparison.summary.totalDifferences === 0,
                toleranceBreaches: comparison.summary.totalDifferences,
                significantIssues: comparison.summary.significantDifferences,
                mostCommonIssues: {},
                recommendation: comparison.summary.totalDifferences === 0 ? 'Spacing is pixel-perfect' :
                               comparison.summary.significantDifferences === 0 ? 'Minor spacing differences within acceptable range' :
                               comparison.summary.significantDifferences < 3 ? 'Some spacing issues detected' :
                               'Significant spacing differences detected'
            };
            
            // Подсчет наиболее частых проблем
            comparison.differences.forEach(element => {
                element.differences.forEach(diff => {
                    if (diff.property) {
                        analysis.mostCommonIssues[diff.property] = 
                            (analysis.mostCommonIssues[diff.property] || 0) + 1;
                    }
                });
            });
            
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            comparison,
                            analysis
                        }, null, 2)
                    }
                ]
            };
            
        } finally {
            await Promise.all([
                page1.close().catch(() => {}),
                page2.close().catch(() => {})
            ]);
        }
    }
);

/* 26) compareLayout - анализ позиционирования элементов */
server.registerTool(
    'compareLayout',
    {
        title: 'Compare Layout Positioning',
        description: 'Analyze positioning and layout differences between pages. Checks element alignment, flex/grid properties, z-index, and relative positioning.',
        inputSchema: {
            url1: z.string().url().describe('First page URL'),
            url2: z.string().url().describe('Second page URL'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for layout elements to compare'),
            includeChildren: z.boolean().optional().describe('Include child elements in analysis (default: false)')
        }
    },
    async ({ url1, url2, selector, includeChildren = false }) => {
        const { page: page1 } = await createPage();
        const { page: page2 } = await createPage();
        
        try {
            await Promise.all([
                page1.goto(url1, { waitUntil: 'networkidle2' }),
                page2.goto(url2, { waitUntil: 'networkidle2' })
            ]);
            
            // Получаем данные о layout
            async function getLayoutData(page, sel, includeChilds) {
                return await page.evaluate((selector, includeChildren) => {
                    const elements = document.querySelectorAll(selector);
                    const results = [];
                    
                    elements.forEach((element, index) => {
                        const computedStyle = window.getComputedStyle(element);
                        const rect = element.getBoundingClientRect();
                        
                        const layout = {
                            element: `${selector}[${index}]`,
                            tagName: element.tagName,
                            className: element.className,
                            positioning: {
                                position: computedStyle.position,
                                top: computedStyle.top,
                                right: computedStyle.right,
                                bottom: computedStyle.bottom,
                                left: computedStyle.left,
                                zIndex: computedStyle.zIndex
                            },
                            display: {
                                display: computedStyle.display,
                                visibility: computedStyle.visibility,
                                opacity: computedStyle.opacity
                            },
                            flexbox: {
                                flexDirection: computedStyle.flexDirection,
                                flexWrap: computedStyle.flexWrap,
                                justifyContent: computedStyle.justifyContent,
                                alignItems: computedStyle.alignItems,
                                alignContent: computedStyle.alignContent,
                                flex: computedStyle.flex,
                                flexGrow: computedStyle.flexGrow,
                                flexShrink: computedStyle.flexShrink,
                                flexBasis: computedStyle.flexBasis
                            },
                            grid: {
                                gridTemplateColumns: computedStyle.gridTemplateColumns,
                                gridTemplateRows: computedStyle.gridTemplateRows,
                                gridGap: computedStyle.gridGap,
                                gridColumn: computedStyle.gridColumn,
                                gridRow: computedStyle.gridRow
                            },
                            transform: {
                                transform: computedStyle.transform,
                                transformOrigin: computedStyle.transformOrigin
                            },
                            absolutePosition: {
                                x: rect.x,
                                y: rect.y,
                                width: rect.width,
                                height: rect.height
                            }
                        };
                        
                        // Добавляем дочерние элементы если нужно
                        if (includeChildren && element.children.length > 0) {
                            layout.children = Array.from(element.children).map((child, childIndex) => {
                                const childStyle = window.getComputedStyle(child);
                                const childRect = child.getBoundingClientRect();
                                return {
                                    index: childIndex,
                                    tagName: child.tagName,
                                    className: child.className,
                                    position: childStyle.position,
                                    display: childStyle.display,
                                    absolutePosition: {
                                        x: childRect.x,
                                        y: childRect.y,
                                        width: childRect.width,
                                        height: childRect.height
                                    }
                                };
                            });
                        }
                        
                        results.push(layout);
                    });
                    
                    return results;
                }, sel, includeChilds);
            }
            
            const [layout1, layout2] = await Promise.all([
                getLayoutData(page1, selector, includeChildren),
                getLayoutData(page2, selector, includeChildren)
            ]);
            
            if (layout1.length === 0) throw new Error( `No elements found for selector "${selector}" on first page`);
            if (layout2.length === 0) throw new Error( `No elements found for selector "${selector}" on second page`);
            
            // Сравниваем layout
            const comparison = {
                summary: {
                    elementsPage1: layout1.length,
                    elementsPage2: layout2.length,
                    totalDifferences: 0,
                    criticalDifferences: 0
                },
                differences: []
            };
            
            function compareLayoutProperty(obj1, obj2, category, property) {
                const val1 = obj1[category][property];
                const val2 = obj2[category][property];
                
                if (val1 !== val2) {
                    const critical = [
                        'position', 'display', 'flexDirection', 'justifyContent', 
                        'alignItems', 'gridTemplateColumns', 'gridTemplateRows'
                    ].includes(property);
                    
                    if (critical) comparison.summary.criticalDifferences++;
                    comparison.summary.totalDifferences++;
                    
                    return {
                        category,
                        property,
                        page1Value: val1,
                        page2Value: val2,
                        critical
                    };
                }
                return null;
            }
            
            const maxElements = Math.max(layout1.length, layout2.length);
            
            for (let i = 0; i < maxElements; i++) {
                const lay1 = layout1[i];
                const lay2 = layout2[i];
                
                const elementComparison = {
                    index: i,
                    exists: { page1: !!lay1, page2: !!lay2 },
                    differences: []
                };
                
                if (lay1 && lay2) {
                    // Проверяем все категории свойств
                    const categories = ['positioning', 'display', 'flexbox', 'grid', 'transform'];
                    
                    categories.forEach(category => {
                        Object.keys(lay1[category]).forEach(property => {
                            const diff = compareLayoutProperty(lay1, lay2, category, property);
                            if (diff) elementComparison.differences.push(diff);
                        });
                    });
                    
                    // Проверяем абсолютное позиционирование
                    const positionThreshold = 2; // 2px tolerance for positioning
                    ['x', 'y', 'width', 'height'].forEach(prop => {
                        const diff = Math.abs(lay1.absolutePosition[prop] - lay2.absolutePosition[prop]);
                        if (diff > positionThreshold) {
                            elementComparison.differences.push({
                                category: 'absolutePosition',
                                property: prop,
                                page1Value: lay1.absolutePosition[prop],
                                page2Value: lay2.absolutePosition[prop],
                                difference: diff,
                                critical: ['x', 'y'].includes(prop) && diff > 10
                            });
                            comparison.summary.totalDifferences++;
                            if (diff > 10) comparison.summary.criticalDifferences++;
                        }
                    });
                    
                    elementComparison.page1 = lay1;
                    elementComparison.page2 = lay2;
                } else {
                    elementComparison.differences.push({
                        property: 'existence',
                        issue: lay1 ? 'Element exists on page1 but not on page2' : 'Element exists on page2 but not on page1',
                        critical: true
                    });
                    comparison.summary.totalDifferences++;
                    comparison.summary.criticalDifferences++;
                    
                    if (lay1) elementComparison.page1 = lay1;
                    if (lay2) elementComparison.page2 = lay2;
                }
                
                if (elementComparison.differences.length > 0) {
                    comparison.differences.push(elementComparison);
                }
            }
            
            // Анализ
            const analysis = {
                layoutMatches: comparison.summary.totalDifferences === 0,
                criticalIssues: comparison.summary.criticalDifferences,
                minorIssues: comparison.summary.totalDifferences - comparison.summary.criticalDifferences,
                recommendation: comparison.summary.totalDifferences === 0 ? 'Layout positioning is identical' :
                               comparison.summary.criticalDifferences === 0 ? 'Minor layout differences detected' :
                               comparison.summary.criticalDifferences < 3 ? 'Some critical layout differences' :
                               'Significant layout differences detected'
            };
            
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            comparison,
                            analysis
                        }, null, 2)
                    }
                ]
            };
            
        } finally {
            await Promise.all([
                page1.close().catch(() => {}),
                page2.close().catch(() => {})
            ]);
        }
    }
);

/* ================== БЛОК 4: ТОЛЕРАНТНОЕ СРАВНЕНИЕ ================== */

/* 27) compareWithTolerance - гибкое сравнение с допусками */
server.registerTool(
    'compareWithTolerance',
    {
        title: 'Compare with Custom Tolerances',
        description: `⚖️ INTELLIGENT TOLERANCE-BASED COMPARISON ⚖️

Smart comparison tool that accepts minor, acceptable differences while flagging genuine issues.
Perfect for real-world development where 100% pixel-perfect isn't always achievable or necessary.

🎯 USE THIS WHEN:
- Working with different browsers (Chrome vs Firefox vs Safari)
- Comparing development vs production environments
- Font rendering differs between systems (Mac vs Windows vs Linux)
- Minor variations are acceptable but major differences aren't
- Need to set specific thresholds for automated CI/CD validation
- Balancing perfectionism with practical development timelines

🎛️ TOLERANCE CATEGORIES:
• colorDelta (0-255): RGB color difference tolerance
  - 5: Very strict (only slight font antialiasing differences)
  - 10: Strict (minor color variations accepted)  
  - 20: Normal (noticeable but acceptable color differences)
  - 50: Lenient (allows significant color variations)

• sizeTolerance (pixels): Size and spacing differences
  - 1px: Pixel-perfect (sub-pixel rendering differences only)
  - 2px: Very strict (minor spacing variations)
  - 5px: Normal (reasonable spacing flexibility)
  - 10px: Lenient (significant spacing variations allowed)

• positionTolerance (pixels): Element positioning differences
  - 2px: Strict positioning
  - 5px: Normal (allows minor alignment variations)
  - 10px: Lenient (significant positioning flexibility)

• fontSizeTolerance (pixels): Typography size variations
  - 0.5px: Very strict (sub-pixel font differences)
  - 1px: Strict (minor font rendering differences)
  - 2px: Normal (noticeable but acceptable variations)

• opacityTolerance (0-1): Transparency/alpha differences
  - 0.05: Very strict (5% opacity difference max)
  - 0.1: Normal (10% opacity difference)
  - 0.2: Lenient (20% opacity variation allowed)

📊 RESULTS INTERPRETATION:
- Success Rate ≥95%: Excellent match within your tolerances
- Success Rate 85-95%: Good match, minor issues detected
- Success Rate 70-85%: Acceptable, some differences noted
- Success Rate 50-70%: Significant differences detected
- Success Rate <50%: Major differences, review tolerances or design

💡 TOLERANCE RECOMMENDATION SYSTEM:
The tool suggests tolerance adjustments based on failure patterns:
- High color failures → Increase colorDelta
- High spacing failures → Increase sizeTolerance  
- High positioning failures → Increase positionTolerance

🔄 TYPICAL WORKFLOWS:
1. Start with strict tolerances for baseline measurement
2. Adjust based on realistic project constraints  
3. Use for CI/CD automated validation gates
4. Document acceptable tolerances in project standards

⚠️ AVOIDING TOLERANCE TRAP:
- Don't set tolerances too high to "pass" poor implementations
- Use strict tolerances for critical UI components (buttons, forms)
- Use lenient tolerances for decorative elements (illustrations, backgrounds)
- Regular review ensures tolerances remain appropriate

🎯 ENVIRONMENT-SPECIFIC SETTINGS:
- Development: Lenient (focus on functionality)
- Staging: Normal (balance quality with speed)  
- Production: Strict (ensure quality standards)`,
        inputSchema: {
            url1: z.string().url().describe('First page URL'),
            url2: z.string().url().describe('Second page URL'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for elements to compare'),
            tolerances: z.object({
                colorDelta: z.number().min(0).max(255).optional().describe('RGB color difference tolerance (0-255, default: 10)'),
                sizeTolerance: z.number().min(0).optional().describe('Size difference tolerance in pixels (default: 2)'),
                positionTolerance: z.number().min(0).optional().describe('Position difference tolerance in pixels (default: 5)'),
                fontSizeTolerance: z.number().min(0).optional().describe('Font size difference tolerance in pixels (default: 1)'),
                opacityTolerance: z.number().min(0).max(1).optional().describe('Opacity difference tolerance (0-1, default: 0.1)')
            }).optional().describe('Tolerance settings for different properties'),
            generateReport: z.boolean().optional().describe('Generate detailed tolerance report (default: true)')
        }
    },
    async ({ url1, url2, selector, tolerances = {}, generateReport = true }) => {
        const { page: page1 } = await createPage();
        const { page: page2 } = await createPage();
        
        // Установка значений по умолчанию
        const config = {
            colorDelta: tolerances.colorDelta || 10,
            sizeTolerance: tolerances.sizeTolerance || 2,
            positionTolerance: tolerances.positionTolerance || 5,
            fontSizeTolerance: tolerances.fontSizeTolerance || 1,
            opacityTolerance: tolerances.opacityTolerance || 0.1
        };
        
        try {
            await Promise.all([
                page1.goto(url1, { waitUntil: 'networkidle2' }),
                page2.goto(url2, { waitUntil: 'networkidle2' })
            ]);
            
            // Получаем данные для сравнения
            async function getComparisonData(page, sel) {
                return await page.evaluate((selector) => {
                    const elements = document.querySelectorAll(selector);
                    const results = [];
                    
                    elements.forEach((element, index) => {
                        const computedStyle = window.getComputedStyle(element);
                        const rect = element.getBoundingClientRect();
                        
                        // Парсим цвета
                        function parseColor(colorStr) {
                            const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d*\.?\d+))?\)/);
                            if (match) {
                                return {
                                    r: parseInt(match[1]),
                                    g: parseInt(match[2]),
                                    b: parseInt(match[3]),
                                    a: parseFloat(match[4]) || 1
                                };
                            }
                            return { r: 0, g: 0, b: 0, a: 1 };
                        }
                        
                        const data = {
                            element: `${selector}[${index}]`,
                            position: {
                                x: rect.x,
                                y: rect.y,
                                width: rect.width,
                                height: rect.height
                            },
                            colors: {
                                color: parseColor(computedStyle.color),
                                backgroundColor: parseColor(computedStyle.backgroundColor),
                                borderColor: parseColor(computedStyle.borderTopColor)
                            },
                            typography: {
                                fontSize: parseFloat(computedStyle.fontSize),
                                fontWeight: computedStyle.fontWeight,
                                fontFamily: computedStyle.fontFamily,
                                lineHeight: parseFloat(computedStyle.lineHeight) || 0
                            },
                            styling: {
                                opacity: parseFloat(computedStyle.opacity),
                                borderWidth: parseFloat(computedStyle.borderTopWidth),
                                borderRadius: parseFloat(computedStyle.borderRadius) || 0,
                                padding: {
                                    top: parseFloat(computedStyle.paddingTop),
                                    right: parseFloat(computedStyle.paddingRight),
                                    bottom: parseFloat(computedStyle.paddingBottom),
                                    left: parseFloat(computedStyle.paddingLeft)
                                },
                                margin: {
                                    top: parseFloat(computedStyle.marginTop),
                                    right: parseFloat(computedStyle.marginRight),
                                    bottom: parseFloat(computedStyle.marginBottom),
                                    left: parseFloat(computedStyle.marginLeft)
                                }
                            }
                        };
                        
                        results.push(data);
                    });
                    
                    return results;
                }, sel);
            }
            
            const [data1, data2] = await Promise.all([
                getComparisonData(page1, selector),
                getComparisonData(page2, selector)
            ]);
            
            if (data1.length === 0) throw new Error( `No elements found for selector "${selector}" on first page`);
            if (data2.length === 0) throw new Error( `No elements found for selector "${selector}" on second page`);
            
            // Функции сравнения с допусками
            function compareColor(color1, color2, tolerance) {
                const deltaR = Math.abs(color1.r - color2.r);
                const deltaG = Math.abs(color1.g - color2.g);
                const deltaB = Math.abs(color1.b - color2.b);
                const deltaA = Math.abs(color1.a - color2.a) * 255;
                
                const totalDelta = deltaR + deltaG + deltaB + deltaA;
                return {
                    withinTolerance: totalDelta <= tolerance,
                    delta: totalDelta,
                    details: { deltaR, deltaG, deltaB, deltaA }
                };
            }
            
            function compareSize(size1, size2, tolerance) {
                const diff = Math.abs(size1 - size2);
                return {
                    withinTolerance: diff <= tolerance,
                    difference: diff
                };
            }
            
            function compareOpacity(op1, op2, tolerance) {
                const diff = Math.abs(op1 - op2);
                return {
                    withinTolerance: diff <= tolerance,
                    difference: diff
                };
            }
            
            // Выполняем сравнение
            const comparison = {
                config,
                summary: {
                    elementsCompared: Math.min(data1.length, data2.length),
                    totalChecks: 0,
                    passedChecks: 0,
                    failedChecks: 0
                },
                elements: []
            };
            
            const maxElements = Math.max(data1.length, data2.length);
            
            for (let i = 0; i < maxElements; i++) {
                const elem1 = data1[i];
                const elem2 = data2[i];
                
                const elementResult = {
                    index: i,
                    exists: { page1: !!elem1, page2: !!elem2 },
                    checks: {},
                    summary: { total: 0, passed: 0, failed: 0 }
                };
                
                if (elem1 && elem2) {
                    // Сравнение позиции
                    const posChecks = {
                        x: compareSize(elem1.position.x, elem2.position.x, config.positionTolerance),
                        y: compareSize(elem1.position.y, elem2.position.y, config.positionTolerance),
                        width: compareSize(elem1.position.width, elem2.position.width, config.sizeTolerance),
                        height: compareSize(elem1.position.height, elem2.position.height, config.sizeTolerance)
                    };
                    elementResult.checks.position = posChecks;
                    
                    // Сравнение цветов
                    const colorChecks = {
                        color: compareColor(elem1.colors.color, elem2.colors.color, config.colorDelta),
                        backgroundColor: compareColor(elem1.colors.backgroundColor, elem2.colors.backgroundColor, config.colorDelta),
                        borderColor: compareColor(elem1.colors.borderColor, elem2.colors.borderColor, config.colorDelta)
                    };
                    elementResult.checks.colors = colorChecks;
                    
                    // Сравнение типографики
                    const typoChecks = {
                        fontSize: compareSize(elem1.typography.fontSize, elem2.typography.fontSize, config.fontSizeTolerance),
                        fontWeight: { withinTolerance: elem1.typography.fontWeight === elem2.typography.fontWeight },
                        fontFamily: { withinTolerance: elem1.typography.fontFamily === elem2.typography.fontFamily }
                    };
                    elementResult.checks.typography = typoChecks;
                    
                    // Сравнение стилей
                    const styleChecks = {
                        opacity: compareOpacity(elem1.styling.opacity, elem2.styling.opacity, config.opacityTolerance),
                        borderWidth: compareSize(elem1.styling.borderWidth, elem2.styling.borderWidth, config.sizeTolerance),
                        borderRadius: compareSize(elem1.styling.borderRadius, elem2.styling.borderRadius, config.sizeTolerance)
                    };
                    elementResult.checks.styling = styleChecks;
                    
                    // Подсчет результатов
                    Object.values(elementResult.checks).forEach(category => {
                        Object.values(category).forEach(check => {
                            elementResult.summary.total++;
                            comparison.summary.totalChecks++;
                            
                            if (check.withinTolerance) {
                                elementResult.summary.passed++;
                                comparison.summary.passedChecks++;
                            } else {
                                elementResult.summary.failed++;
                                comparison.summary.failedChecks++;
                            }
                        });
                    });
                    
                } else {
                    elementResult.checks.existence = {
                        withinTolerance: false,
                        issue: elem1 ? 'Missing on page 2' : 'Missing on page 1'
                    };
                    elementResult.summary.total = 1;
                    elementResult.summary.failed = 1;
                    comparison.summary.totalChecks++;
                    comparison.summary.failedChecks++;
                }
                
                comparison.elements.push(elementResult);
            }
            
            // Финальный анализ
            const successRate = (comparison.summary.passedChecks / comparison.summary.totalChecks) * 100;
            const analysis = {
                successRate: Math.round(successRate * 100) / 100,
                recommendation: successRate >= 95 ? 'Excellent match within tolerances' :
                               successRate >= 85 ? 'Good match with minor differences' :
                               successRate >= 70 ? 'Acceptable with some differences' :
                               successRate >= 50 ? 'Significant differences detected' :
                               'Major differences - review tolerances or design',
                toleranceEffectiveness: {
                    veryStrict: successRate < 50,
                    appropriate: successRate >= 70 && successRate < 95,
                    tooLenient: successRate >= 99
                }
            };
            
            const result = {
                comparison,
                analysis
            };
            
            if (generateReport) {
                // Дополнительные детали для отчета
                result.toleranceReport = {
                    appliedTolerances: config,
                    mostCommonFailures: {},
                    suggestedAdjustments: {}
                };
                
                // Анализ наиболее частых проблем
                comparison.elements.forEach(elem => {
                    Object.entries(elem.checks).forEach(([category, checks]) => {
                        Object.entries(checks).forEach(([property, check]) => {
                            if (!check.withinTolerance) {
                                const key = `${category}.${property}`;
                                result.toleranceReport.mostCommonFailures[key] = 
                                    (result.toleranceReport.mostCommonFailures[key] || 0) + 1;
                            }
                        });
                    });
                });
                
                // Предложения по корректировке толеранса
                Object.entries(result.toleranceReport.mostCommonFailures).forEach(([key, count]) => {
                    if (count >= comparison.elements.length * 0.5) {
                        const [category, property] = key.split('.');
                        result.toleranceReport.suggestedAdjustments[key] = 
                            `Consider increasing ${property} tolerance in ${category}`;
                    }
                });
            }
            
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            };
            
        } finally {
            await Promise.all([
                page1.close().catch(() => {}),
                page2.close().catch(() => {})
            ]);
        }
    }
);

/* 28) validateDesignSystem - проверка соответствия дизайн-системе */
server.registerTool(
    'validateDesignSystem',
    {
        title: 'Validate Design System Compliance',
        description: 'Check if page elements comply with design system standards including colors, typography, spacing, and component variations with defined tolerances.',
        inputSchema: {
            url: z.string().url().describe('Page URL to validate'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('CSS selector for elements to validate'),
            designSystem: z.object({
                colors: z.array(z.string()).optional().describe('Allowed colors in hex format (e.g., ["#FF0000", "#00FF00"])'),
                fontSizes: z.array(z.number()).optional().describe('Allowed font sizes in pixels (e.g., [12, 14, 16, 18, 24])'),
                spacing: z.array(z.number()).optional().describe('Allowed spacing values in pixels (e.g., [4, 8, 16, 24, 32])'),
                borderRadius: z.array(z.number()).optional().describe('Allowed border radius values in pixels (e.g., [0, 4, 8, 16])')
            }).describe('Design system specifications'),
            tolerance: z.object({
                color: z.number().min(0).max(255).optional().describe('Color tolerance in RGB delta (default: 15)'),
                size: z.number().min(0).optional().describe('Size tolerance in pixels (default: 2)')
            }).optional().describe('Tolerance settings')
        }
    },
    async ({ selector, designSystem, tolerance = {} }) => {
        const page = await getPageForOperation(url);
        
        const config = {
            colorTolerance: tolerance.color || 15,
            sizeTolerance: tolerance.size || 2
        };
        
        try {            // Получаем данные элементов
            const elementData = await page.evaluate((sel) => {
                const elements = document.querySelectorAll(sel);
                const results = [];
                
                elements.forEach((element, index) => {
                    const computedStyle = window.getComputedStyle(element);
                    
                    // Парсим цвета
                    function parseColor(colorStr) {
                        const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d*\.?\d+))?\)/);
                        if (match) {
                            const r = parseInt(match[1]);
                            const g = parseInt(match[2]);
                            const b = parseInt(match[3]);
                            return {
                                rgb: { r, g, b },
                                hex: `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
                            };
                        }
                        return null;
                    }
                    
                    const data = {
                        element: `${sel}[${index}]`,
                        colors: {
                            color: parseColor(computedStyle.color),
                            backgroundColor: parseColor(computedStyle.backgroundColor),
                            borderColor: parseColor(computedStyle.borderTopColor)
                        },
                        typography: {
                            fontSize: parseFloat(computedStyle.fontSize),
                            fontFamily: computedStyle.fontFamily,
                            fontWeight: computedStyle.fontWeight
                        },
                        spacing: {
                            paddingTop: parseFloat(computedStyle.paddingTop),
                            paddingRight: parseFloat(computedStyle.paddingRight),
                            paddingBottom: parseFloat(computedStyle.paddingBottom),
                            paddingLeft: parseFloat(computedStyle.paddingLeft),
                            marginTop: parseFloat(computedStyle.marginTop),
                            marginRight: parseFloat(computedStyle.marginRight),
                            marginBottom: parseFloat(computedStyle.marginBottom),
                            marginLeft: parseFloat(computedStyle.marginLeft)
                        },
                        styling: {
                            borderRadius: parseFloat(computedStyle.borderRadius) || 0,
                            borderWidth: parseFloat(computedStyle.borderTopWidth) || 0
                        }
                    };
                    
                    results.push(data);
                });
                
                return results;
            }, selector);
            
            if (elementData.length === 0) {
                throw new Error( `No elements found for selector "${selector}"`);
            }
            
            // Функции валидации
            function validateColor(actualColor, allowedColors, tolerance) {
                if (!actualColor || !allowedColors || allowedColors.length === 0) {
                    return { valid: true, reason: 'No color constraints defined' };
                }
                
                const actualRgb = actualColor.rgb;
                
                for (const allowedHex of allowedColors) {
                    const allowedRgb = {
                        r: parseInt(allowedHex.slice(1, 3), 16),
                        g: parseInt(allowedHex.slice(3, 5), 16),
                        b: parseInt(allowedHex.slice(5, 7), 16)
                    };
                    
                    const deltaR = Math.abs(actualRgb.r - allowedRgb.r);
                    const deltaG = Math.abs(actualRgb.g - allowedRgb.g);
                    const deltaB = Math.abs(actualRgb.b - allowedRgb.b);
                    const totalDelta = deltaR + deltaG + deltaB;
                    
                    if (totalDelta <= tolerance) {
                        return { 
                            valid: true, 
                            matchedColor: allowedHex,
                            delta: totalDelta 
                        };
                    }
                }
                
                return { 
                    valid: false, 
                    actualColor: actualColor.hex, 
                    allowedColors,
                    reason: 'Color not found in design system' 
                };
            }
            
            function validateSize(actualSize, allowedSizes, tolerance) {
                if (!allowedSizes || allowedSizes.length === 0) {
                    return { valid: true, reason: 'No size constraints defined' };
                }
                
                for (const allowedSize of allowedSizes) {
                    if (Math.abs(actualSize - allowedSize) <= tolerance) {
                        return { valid: true, matchedSize: allowedSize };
                    }
                }
                
                return { 
                    valid: false, 
                    actualSize, 
                    allowedSizes,
                    reason: 'Size not found in design system' 
                };
            }
            
            // Выполняем валидацию
            const validation = {
                designSystem,
                config,
                summary: {
                    totalElements: elementData.length,
                    totalChecks: 0,
                    passedChecks: 0,
                    failedChecks: 0,
                    complianceRate: 0
                },
                violations: [],
                elements: []
            };
            
            elementData.forEach((element, index) => {
                const elementValidation = {
                    element: element.element,
                    checks: {},
                    violations: []
                };
                
                // Валидация цветов
                if (designSystem.colors) {
                    ['color', 'backgroundColor', 'borderColor'].forEach(colorType => {
                        const colorCheck = validateColor(element.colors[colorType], designSystem.colors, config.colorTolerance);
                        elementValidation.checks[colorType] = colorCheck;
                        validation.summary.totalChecks++;
                        
                        if (colorCheck.valid) {
                            validation.summary.passedChecks++;
                        } else {
                            validation.summary.failedChecks++;
                            elementValidation.violations.push({
                                type: 'color',
                                property: colorType,
                                ...colorCheck
                            });
                        }
                    });
                }
                
                // Валидация размеров шрифтов
                if (designSystem.fontSizes) {
                    const fontSizeCheck = validateSize(element.typography.fontSize, designSystem.fontSizes, config.sizeTolerance);
                    elementValidation.checks.fontSize = fontSizeCheck;
                    validation.summary.totalChecks++;
                    
                    if (fontSizeCheck.valid) {
                        validation.summary.passedChecks++;
                    } else {
                        validation.summary.failedChecks++;
                        elementValidation.violations.push({
                            type: 'typography',
                            property: 'fontSize',
                            ...fontSizeCheck
                        });
                    }
                }
                
                // Валидация spacing
                if (designSystem.spacing) {
                    Object.entries(element.spacing).forEach(([spacingType, value]) => {
                        if (value > 0) { // Проверяем только ненулевые значения
                            const spacingCheck = validateSize(value, designSystem.spacing, config.sizeTolerance);
                            elementValidation.checks[spacingType] = spacingCheck;
                            validation.summary.totalChecks++;
                            
                            if (spacingCheck.valid) {
                                validation.summary.passedChecks++;
                            } else {
                                validation.summary.failedChecks++;
                                elementValidation.violations.push({
                                    type: 'spacing',
                                    property: spacingType,
                                    ...spacingCheck
                                });
                            }
                        }
                    });
                }
                
                // Валидация border radius
                if (designSystem.borderRadius && element.styling.borderRadius > 0) {
                    const radiusCheck = validateSize(element.styling.borderRadius, designSystem.borderRadius, config.sizeTolerance);
                    elementValidation.checks.borderRadius = radiusCheck;
                    validation.summary.totalChecks++;
                    
                    if (radiusCheck.valid) {
                        validation.summary.passedChecks++;
                    } else {
                        validation.summary.failedChecks++;
                        elementValidation.violations.push({
                            type: 'styling',
                            property: 'borderRadius',
                            ...radiusCheck
                        });
                    }
                }
                
                // Добавляем нарушения к общему списку
                elementValidation.violations.forEach(violation => {
                    validation.violations.push({
                        element: element.element,
                        ...violation
                    });
                });
                
                validation.elements.push(elementValidation);
            });
            
            // Подсчет compliance rate
            validation.summary.complianceRate = validation.summary.totalChecks > 0 ?
                Math.round((validation.summary.passedChecks / validation.summary.totalChecks) * 10000) / 100 : 100;
            
            // Анализ и рекомендации
            const analysis = {
                complianceLevel: validation.summary.complianceRate >= 95 ? 'Excellent' :
                                validation.summary.complianceRate >= 85 ? 'Good' :
                                validation.summary.complianceRate >= 70 ? 'Acceptable' :
                                validation.summary.complianceRate >= 50 ? 'Poor' : 'Critical',
                mostCommonViolations: {},
                recommendations: []
            };
            
            // Анализ наиболее частых нарушений
            validation.violations.forEach(violation => {
                const key = `${violation.type}.${violation.property}`;
                analysis.mostCommonViolations[key] = (analysis.mostCommonViolations[key] || 0) + 1;
            });
            
            // Генерация рекомендаций
            Object.entries(analysis.mostCommonViolations).forEach(([violation, count]) => {
                if (count >= elementData.length * 0.3) {
                    analysis.recommendations.push(`High frequency of ${violation} violations (${count} occurrences) - consider reviewing design system constraints or implementation`);
                }
            });
            
            if (validation.summary.complianceRate < 70) {
                analysis.recommendations.push('Consider increasing tolerances or updating design system specifications');
            }
            
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            validation,
                            analysis
                        }, null, 2)
                    }
                ]
            };
            
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* ================== БЛОК 5: СЕМАНТИЧЕСКОЕ СРАВНЕНИЕ ================== */

/* 29) analyzeStructure - анализ DOM структуры и иерархии */
server.registerTool(
    'analyzeStructure',
    {
        title: 'Analyze DOM Structure',
        description: `🏗️ SEMANTIC STRUCTURE ANALYZER 🏗️

Analyzes DOM structure, hierarchy, and semantic meaning rather than visual appearance.
Perfect for ensuring proper HTML semantics, accessibility structure, and component organization.

🎯 USE THIS WHEN:
- Visual comparison passes but functionality is broken
- Need to verify proper semantic HTML structure
- Checking accessibility hierarchy (headings, landmarks, ARIA)
- Validating component composition and nesting
- Ensuring proper form structure and labeling
- Comparing React component trees between versions

🧠 WHAT IT ANALYZES:
- Element hierarchy and nesting depth
- Semantic HTML tags usage (header, nav, main, article, section)
- ARIA roles, labels, and accessibility attributes
- Form structure (fieldset, legend, label associations)
- Heading hierarchy (h1-h6 proper nesting)
- Interactive elements (buttons, links, inputs)
- Data attributes and component markers

📊 STRUCTURE METRICS:
- Total elements count and types distribution
- Nesting depth analysis (overly deep = maintenance issues)
- Semantic completeness score
- Accessibility structure rating
- Interactive elements inventory
- ARIA implementation assessment`,
        inputSchema: {
            url: z.string().url().describe('Page URL to analyze'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().optional().describe('Root selector to analyze (default: body)'),
            includeAttributes: z.boolean().optional().describe('Include detailed attribute analysis (default: true)'),
            maxDepth: z.number().min(1).max(20).optional().describe('Maximum nesting depth to analyze (default: 10)')
        }
    },
    async ({ selector = 'body', includeAttributes = true, maxDepth = 10 }) => {
        const page = await getPageForOperation(url);
        
        try {            const structure = await page.evaluate((rootSelector, includeAttrs, maxD) => {
                const rootElement = document.querySelector(rootSelector);
                if (!rootElement) return null;
                
                function analyzeElement(element, depth = 0) {
                    if (depth > maxD) return null;
                    
                    const tagName = element.tagName.toLowerCase();
                    const classList = Array.from(element.classList);
                    const id = element.id || null;
                    
                    // Семантический анализ
                    const semantic = {
                        isSemanticTag: ['header', 'nav', 'main', 'article', 'section', 'aside', 'footer', 'figure', 'figcaption'].includes(tagName),
                        isHeading: /^h[1-6]$/.test(tagName),
                        isInteractive: ['button', 'a', 'input', 'select', 'textarea', 'details'].includes(tagName) || element.hasAttribute('tabindex'),
                        isForm: ['form', 'fieldset', 'legend', 'label', 'input', 'select', 'textarea', 'button'].includes(tagName),
                        isMedia: ['img', 'video', 'audio', 'canvas', 'svg'].includes(tagName)
                    };
                    
                    // ARIA анализ
                    const aria = {
                        role: element.getAttribute('role'),
                        labelledBy: element.getAttribute('aria-labelledby'),
                        describedBy: element.getAttribute('aria-describedby'),
                        label: element.getAttribute('aria-label'),
                        hidden: element.getAttribute('aria-hidden'),
                        expanded: element.getAttribute('aria-expanded'),
                        live: element.getAttribute('aria-live')
                    };
                    
                    // Фильтруем null значения
                    Object.keys(aria).forEach(key => {
                        if (aria[key] === null) delete aria[key];
                    });
                    
                    const elementData = {
                        tagName,
                        id,
                        classes: classList,
                        depth,
                        semantic,
                        aria: Object.keys(aria).length > 0 ? aria : null,
                        childrenCount: element.children.length,
                        textContent: element.childNodes.length > 0 ? 
                            Array.from(element.childNodes)
                                .filter(n => n.nodeType === 3)
                                .map(n => n.textContent.trim())
                                .filter(t => t.length > 0)
                                .join(' ').substring(0, 100) : null
                    };
                    
                    if (includeAttrs) {
                        elementData.attributes = {};
                        for (const attr of element.attributes) {
                            if (!['class', 'id'].includes(attr.name)) {
                                elementData.attributes[attr.name] = attr.value;
                            }
                        }
                        if (Object.keys(elementData.attributes).length === 0) {
                            delete elementData.attributes;
                        }
                    }
                    
                    // Рекурсивно анализируем дочерние элементы
                    if (element.children.length > 0 && depth < maxD) {
                        elementData.children = [];
                        for (const child of element.children) {
                            const childData = analyzeElement(child, depth + 1);
                            if (childData) elementData.children.push(childData);
                        }
                    }
                    
                    return elementData;
                }
                
                return analyzeElement(rootElement);
            }, selector, includeAttributes, maxDepth);
            
            if (!structure) {
                throw new Error( `Selector "${selector}" not found or analysis failed`);
            }
            
            // Анализ структуры
            function analyzeStructureMetrics(element, metrics = {
                totalElements: 0,
                maxDepth: 0,
                tagDistribution: {},
                semanticElements: 0,
                interactiveElements: 0,
                ariaElements: 0,
                headingStructure: [],
                formElements: 0,
                mediaElements: 0
            }) {
                
                metrics.totalElements++;
                metrics.maxDepth = Math.max(metrics.maxDepth, element.depth);
                
                // Распределение по тегам
                metrics.tagDistribution[element.tagName] = (metrics.tagDistribution[element.tagName] || 0) + 1;
                
                // Семантические элементы
                if (element.semantic.isSemanticTag) metrics.semanticElements++;
                if (element.semantic.isInteractive) metrics.interactiveElements++;
                if (element.semantic.isForm) metrics.formElements++;
                if (element.semantic.isMedia) metrics.mediaElements++;
                
                // ARIA элементы
                if (element.aria) metrics.ariaElements++;
                
                // Структура заголовков
                if (element.semantic.isHeading) {
                    const level = parseInt(element.tagName.charAt(1));
                    metrics.headingStructure.push({
                        level,
                        text: element.textContent || '',
                        depth: element.depth
                    });
                }
                
                // Рекурсивно для детей
                if (element.children) {
                    element.children.forEach(child => analyzeStructureMetrics(child, metrics));
                }
                
                return metrics;
            }
            
            const metrics = analyzeStructureMetrics(structure);
            
            // Качественная оценка
            const quality = {
                semanticRatio: metrics.totalElements > 0 ? Math.round((metrics.semanticElements / metrics.totalElements) * 100) : 0,
                ariaUsage: metrics.totalElements > 0 ? Math.round((metrics.ariaElements / metrics.totalElements) * 100) : 0,
                nestingComplexity: metrics.maxDepth > 10 ? 'High' : metrics.maxDepth > 6 ? 'Medium' : 'Low',
                headingHierarchy: validateHeadingHierarchy(metrics.headingStructure)
            };
            
            function validateHeadingHierarchy(headings) {
                if (headings.length === 0) return { valid: true, issues: [] };
                
                const issues = [];
                let hasH1 = false;
                
                for (let i = 0; i < headings.length; i++) {
                    const heading = headings[i];
                    if (heading.level === 1) hasH1 = true;
                    
                    if (i > 0) {
                        const prevHeading = headings[i - 1];
                        const levelJump = heading.level - prevHeading.level;
                        
                        if (levelJump > 1) {
                            issues.push(`Level jump from h${prevHeading.level} to h${heading.level} (skipped levels)`);
                        }
                    }
                }
                
                if (!hasH1 && headings.length > 0) {
                    issues.push('Missing h1 element - should be present for proper hierarchy');
                }
                
                return {
                    valid: issues.length === 0 && hasH1,
                    issues,
                    hasH1
                };
            }
            
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            structure,
                            metrics,
                            quality,
                            analysis: {
                                recommendation: quality.semanticRatio > 20 && quality.headingHierarchy.valid ? 
                                              'Well-structured semantic HTML' :
                                              quality.semanticRatio < 10 ? 
                                              'Consider adding more semantic HTML elements' :
                                              'Good structure with minor improvements needed',
                                priorities: [
                                    ...(quality.headingHierarchy.issues.length > 0 ? ['Fix heading hierarchy'] : []),
                                    ...(quality.semanticRatio < 15 ? ['Add semantic HTML elements'] : []),
                                    ...(quality.ariaUsage < 5 && metrics.interactiveElements > 0 ? ['Improve ARIA labeling'] : []),
                                    ...(metrics.maxDepth > 12 ? ['Reduce nesting complexity'] : [])
                                ]
                            }
                        }, null, 2)
                    }
                ]
            };
            
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* 30) validateHierarchy - проверка иерархии элементов */
server.registerTool(
    'validateHierarchy',
    {
        title: 'Validate Element Hierarchy',
        description: `🔍 HIERARCHICAL STRUCTURE VALIDATOR 🔍

Validates proper nesting, parent-child relationships, and structural integrity.
Ensures components are properly composed and follow best practices.

🎯 USE THIS WHEN:
- Components aren't rendering correctly despite matching visuals
- Need to verify proper React/Vue component composition
- Checking CSS Grid/Flexbox container-item relationships
- Validating form structure and input grouping
- Ensuring accessibility landmark hierarchy
- Comparing component trees between implementations`,
        inputSchema: {
            url1: z.string().url().describe('First page URL'),
            url2: z.string().url().describe('Second page URL'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('Root selector to compare hierarchy'),
            ignoreOrder: z.boolean().optional().describe('Ignore child element order (default: false)'),
            compareAttributes: z.boolean().optional().describe('Compare element attributes (default: true)')
        }
    },
    async ({ url1, url2, selector, ignoreOrder = false, compareAttributes = true }) => {
        const { page: page1 } = await createPage();
        const { page: page2 } = await createPage();
        
        try {
            await Promise.all([
                page1.goto(url1, { waitUntil: 'networkidle2' }),
                page2.goto(url2, { waitUntil: 'networkidle2' })
            ]);
            
            // Получаем иерархию с обеих страниц
            async function getHierarchy(page, sel) {
                return await page.evaluate((selector, compareAttrs, ignoreOrd) => {
                    function buildHierarchy(element) {
                        const node = {
                            tagName: element.tagName.toLowerCase(),
                            id: element.id || null,
                            classes: Array.from(element.classList).sort(),
                            childrenCount: element.children.length
                        };
                        
                        if (compareAttrs) {
                            node.attributes = {};
                            for (const attr of element.attributes) {
                                if (!['class', 'id'].includes(attr.name)) {
                                    node.attributes[attr.name] = attr.value;
                                }
                            }
                        }
                        
                        if (element.children.length > 0) {
                            node.children = Array.from(element.children).map(buildHierarchy);
                            if (ignoreOrd) {
                                node.children.sort((a, b) => {
                                    if (a.tagName !== b.tagName) return a.tagName.localeCompare(b.tagName);
                                    if (a.id !== b.id) return (a.id || '').localeCompare(b.id || '');
                                    return a.classes.join(' ').localeCompare(b.classes.join(' '));
                                });
                            }
                        }
                        
                        return node;
                    }
                    
                    const element = document.querySelector(selector);
                    return element ? buildHierarchy(element) : null;
                }, sel, compareAttributes, ignoreOrder);
            }
            
            const [hierarchy1, hierarchy2] = await Promise.all([
                getHierarchy(page1, selector),
                getHierarchy(page2, selector)
            ]);
            
            if (!hierarchy1) throw new Error( `Selector "${selector}" not found on first page`);
            if (!hierarchy2) throw new Error( `Selector "${selector}" not found on second page`);
            
            // Сравниваем иерархии
            function compareHierarchies(node1, node2, path = '') {
                const differences = [];
                const currentPath = path ? `${path} > ${node1.tagName || 'unknown'}` : node1.tagName || 'root';
                
                // Сравнение основных свойств
                if (node1.tagName !== node2.tagName) {
                    differences.push({
                        type: 'tagName',
                        path: currentPath,
                        page1: node1.tagName,
                        page2: node2.tagName,
                        severity: 'critical'
                    });
                }
                
                if (node1.id !== node2.id) {
                    differences.push({
                        type: 'id',
                        path: currentPath,
                        page1: node1.id,
                        page2: node2.id,
                        severity: 'high'
                    });
                }
                
                // Сравнение классов
                const classes1 = new Set(node1.classes || []);
                const classes2 = new Set(node2.classes || []);
                
                const missingIn2 = [...classes1].filter(cls => !classes2.has(cls));
                const missingIn1 = [...classes2].filter(cls => !classes1.has(cls));
                
                if (missingIn2.length > 0 || missingIn1.length > 0) {
                    differences.push({
                        type: 'classes',
                        path: currentPath,
                        missingInPage2: missingIn2,
                        missingInPage1: missingIn1,
                        severity: 'medium'
                    });
                }
                
                // Сравнение атрибутов
                if (compareAttributes && node1.attributes && node2.attributes) {
                    const attrs1Keys = new Set(Object.keys(node1.attributes));
                    const attrs2Keys = new Set(Object.keys(node2.attributes));
                    
                    const allKeys = new Set([...attrs1Keys, ...attrs2Keys]);
                    
                    for (const key of allKeys) {
                        const val1 = node1.attributes[key];
                        const val2 = node2.attributes[key];
                        
                        if (val1 !== val2) {
                            differences.push({
                                type: 'attribute',
                                path: currentPath,
                                attribute: key,
                                page1: val1,
                                page2: val2,
                                severity: 'low'
                            });
                        }
                    }
                }
                
                // Сравнение количества детей
                const children1 = node1.children || [];
                const children2 = node2.children || [];
                
                if (children1.length !== children2.length) {
                    differences.push({
                        type: 'childrenCount',
                        path: currentPath,
                        page1Count: children1.length,
                        page2Count: children2.length,
                        severity: 'high'
                    });
                }
                
                // Рекурсивное сравнение детей
                const minChildren = Math.min(children1.length, children2.length);
                for (let i = 0; i < minChildren; i++) {
                    const childDiffs = compareHierarchies(children1[i], children2[i], currentPath);
                    differences.push(...childDiffs);
                }
                
                return differences;
            }
            
            const differences = compareHierarchies(hierarchy1, hierarchy2);
            
            // Анализ различий
            const severityCounts = {
                critical: differences.filter(d => d.severity === 'critical').length,
                high: differences.filter(d => d.severity === 'high').length,
                medium: differences.filter(d => d.severity === 'medium').length,
                low: differences.filter(d => d.severity === 'low').length
            };
            
            const analysis = {
                identical: differences.length === 0,
                totalDifferences: differences.length,
                severityBreakdown: severityCounts,
                mostCommonIssues: {},
                recommendation: differences.length === 0 ? 'Hierarchies are identical' :
                               severityCounts.critical > 0 ? 'Critical structural differences detected' :
                               severityCounts.high > 0 ? 'Significant hierarchy differences' :
                               'Minor structural differences detected'
            };
            
            // Подсчет наиболее частых проблем
            differences.forEach(diff => {
                analysis.mostCommonIssues[diff.type] = (analysis.mostCommonIssues[diff.type] || 0) + 1;
            });
            
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            comparison: {
                                hierarchy1,
                                hierarchy2,
                                differences,
                                analysis
                            }
                        }, null, 2)
                    }
                ]
            };
            
        } finally {
            await Promise.all([
                page1.close().catch(() => {}),
                page2.close().catch(() => {})
            ]);
        }
    }
);

/* 31) verifyInteractions - проверка интерактивных элементов */
server.registerTool(
    'verifyInteractions',
    {
        title: 'Verify Interactive Elements',
        description: `⚡ INTERACTIVE ELEMENTS VALIDATOR ⚡

Analyzes and validates interactive elements, event handlers, and user interaction patterns.
Ensures buttons work, forms submit, links navigate, and accessibility is maintained.

🎯 USE THIS WHEN:
- Visual layout matches but interactions don't work
- Need to verify all buttons/links are properly functional
- Checking form validation and submission behavior
- Ensuring keyboard navigation works correctly
- Validating ARIA states and properties for screen readers
- Testing focus management and tab order`,
        inputSchema: {
            url: z.string().url().describe('Page URL to analyze'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().optional().describe('Container selector (default: body)'),
            testInteractions: z.boolean().optional().describe('Actually test interactions (default: false)'),
            includeKeyboard: z.boolean().optional().describe('Test keyboard accessibility (default: true)')
        }
    },
    async ({ url, selector = 'body', testInteractions = false, includeKeyboard = true }) => {
        const page = await getPageForOperation(url);
        
        try {            const analysis = await page.evaluate(async (containerSel, testInter, testKeyboard) => {
                const container = document.querySelector(containerSel);
                if (!container) return null;
                
                // Находим все интерактивные элементы
                const interactiveSelectors = [
                    'button', 'a[href]', 'input', 'select', 'textarea',
                    '[tabindex]', '[role="button"]', '[role="link"]',
                    '[onclick]', '[onkeydown]', '[onkeyup]'
                ];
                
                const elements = container.querySelectorAll(interactiveSelectors.join(', '));
                const results = [];
                
                for (const element of elements) {
                    const rect = element.getBoundingClientRect();
                    const computedStyle = window.getComputedStyle(element);
                    
                    const elementData = {
                        tagName: element.tagName.toLowerCase(),
                        type: element.type || null,
                        id: element.id || null,
                        classes: Array.from(element.classList),
                        text: element.textContent?.trim().substring(0, 50) || '',
                        
                        // Доступность
                        accessibility: {
                            tabIndex: element.tabIndex,
                            role: element.getAttribute('role'),
                            ariaLabel: element.getAttribute('aria-label'),
                            ariaLabelledBy: element.getAttribute('aria-labelledby'),
                            ariaDescribedBy: element.getAttribute('aria-describedby'),
                            ariaDisabled: element.getAttribute('aria-disabled'),
                            ariaExpanded: element.getAttribute('aria-expanded'),
                            ariaPressed: element.getAttribute('aria-pressed'),
                            ariaChecked: element.getAttribute('aria-checked')
                        },
                        
                        // Состояние
                        state: {
                            disabled: element.disabled || element.hasAttribute('disabled'),
                            hidden: element.hidden || computedStyle.display === 'none' || computedStyle.visibility === 'hidden',
                            focused: document.activeElement === element,
                            visible: rect.width > 0 && rect.height > 0,
                            clickable: rect.width > 0 && rect.height > 0 && computedStyle.pointerEvents !== 'none'
                        },
                        
                        // События
                        events: {
                            hasClickHandler: element.onclick !== null || element.hasAttribute('onclick'),
                            hasKeyHandler: element.onkeydown !== null || element.onkeyup !== null,
                            hasMouseHandlers: element.onmouseover !== null || element.onmouseout !== null,
                            hasFocusHandlers: element.onfocus !== null || element.onblur !== null
                        }
                    };
                    
                    // Фильтруем null значения в accessibility
                    Object.keys(elementData.accessibility).forEach(key => {
                        if (elementData.accessibility[key] === null) {
                            delete elementData.accessibility[key];
                        }
                    });
                    
                    // Тестируем взаимодействия если включено
                    if (testInter && elementData.state.clickable && !elementData.state.disabled) {
                        try {
                            // Simulate hover
                            element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                            elementData.hoverTested = true;
                            
                            // Test focus if keyboard testing enabled
                            if (testKeyboard && element.tabIndex >= 0) {
                                element.focus();
                                elementData.focusTested = document.activeElement === element;
                                element.blur();
                            }
                        } catch (e) {
                            elementData.testError = e.message;
                        }
                    }
                    
                    results.push(elementData);
                }
                
                return results;
            }, selector, testInteractions, includeKeyboard);
            
            if (!analysis) {
                throw new Error( `Selector "${selector}" not found`);
            }
            
            // Анализ результатов
            const metrics = {
                total: analysis.length,
                byType: {},
                accessibility: {
                    withAriaLabels: 0,
                    withTabIndex: 0,
                    withRoles: 0,
                    keyboardAccessible: 0
                },
                issues: {
                    notVisible: 0,
                    noEventHandlers: 0,
                    missingLabels: 0,
                    notKeyboardAccessible: 0
                }
            };
            
            const issues = [];
            
            analysis.forEach((element, index) => {
                // Подсчет по типам
                const key = element.type ? `${element.tagName}[${element.type}]` : element.tagName;
                metrics.byType[key] = (metrics.byType[key] || 0) + 1;
                
                // Анализ доступности
                if (Object.keys(element.accessibility).length > 0) {
                    if (element.accessibility.ariaLabel || element.accessibility.ariaLabelledBy) {
                        metrics.accessibility.withAriaLabels++;
                    }
                    if (element.accessibility.tabIndex !== undefined) {
                        metrics.accessibility.withTabIndex++;
                    }
                    if (element.accessibility.role) {
                        metrics.accessibility.withRoles++;
                    }
                }
                
                // Keyboard accessibility
                if (element.state.clickable && !element.state.disabled && 
                    (element.tabIndex >= 0 || ['button', 'a', 'input', 'select', 'textarea'].includes(element.tagName))) {
                    metrics.accessibility.keyboardAccessible++;
                }
                
                // Выявление проблем
                if (!element.state.visible && !element.state.hidden) {
                    metrics.issues.notVisible++;
                    issues.push({
                        element: `${element.tagName}[${index}]`,
                        issue: 'Element not visible (zero dimensions)',
                        severity: 'medium'
                    });
                }
                
                if (element.state.clickable && !element.events.hasClickHandler && 
                    !['a', 'button', 'input', 'select', 'textarea'].includes(element.tagName)) {
                    metrics.issues.noEventHandlers++;
                    issues.push({
                        element: `${element.tagName}[${index}]`,
                        issue: 'Interactive element missing event handlers',
                        severity: 'high'
                    });
                }
                
                if (['button', 'a'].includes(element.tagName) && !element.text && 
                    !element.accessibility.ariaLabel && !element.accessibility.ariaLabelledBy) {
                    metrics.issues.missingLabels++;
                    issues.push({
                        element: `${element.tagName}[${index}]`,
                        issue: 'Interactive element missing accessible name',
                        severity: 'high'
                    });
                }
                
                if (element.state.clickable && !element.state.disabled && element.tabIndex < 0) {
                    metrics.issues.notKeyboardAccessible++;
                    issues.push({
                        element: `${element.tagName}[${index}]`,
                        issue: 'Interactive element not keyboard accessible',
                        severity: 'high'
                    });
                }
            });
            
            const qualityScore = metrics.total > 0 ? 
                Math.round(((metrics.total - metrics.issues.missingLabels - metrics.issues.noEventHandlers - metrics.issues.notKeyboardAccessible) / metrics.total) * 100) : 100;
            
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            elements: analysis,
                            metrics,
                            issues,
                            assessment: {
                                qualityScore,
                                recommendation: qualityScore >= 90 ? 'Excellent interactive element implementation' :
                                               qualityScore >= 75 ? 'Good with minor accessibility improvements needed' :
                                               qualityScore >= 50 ? 'Moderate issues - review accessibility and event handling' :
                                               'Significant issues - major improvements needed',
                                priorities: [
                                    ...(metrics.issues.missingLabels > 0 ? [`Fix ${metrics.issues.missingLabels} missing accessible names`] : []),
                                    ...(metrics.issues.noEventHandlers > 0 ? [`Add event handlers to ${metrics.issues.noEventHandlers} elements`] : []),
                                    ...(metrics.issues.notKeyboardAccessible > 0 ? [`Fix keyboard accessibility for ${metrics.issues.notKeyboardAccessible} elements`] : []),
                                    ...(metrics.issues.notVisible > 0 ? [`Review ${metrics.issues.notVisible} invisible interactive elements`] : [])
                                ]
                            }
                        }, null, 2)
                    }
                ]
            };
            
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* ================== БЛОК 6: КОМПЛЕКСНЫЕ ОТЧЕТЫ И ДОКУМЕНТАЦИЯ ================== */

/* 32) generateComparisonReport - всеобъемлющий отчет сравнения */
server.registerTool(
    'generateComparisonReport',
    {
        title: 'Generate Comprehensive Comparison Report',
        description: `📊 ULTIMATE DESIGN VALIDATION REPORT GENERATOR 📊

Creates a comprehensive, stakeholder-ready report combining multiple analysis methods.
Perfect for design review meetings, client presentations, and development documentation.

🎯 USE THIS WHEN:
- Need comprehensive analysis for stakeholder presentation
- Client requires detailed design compliance report
- Documentation for design system adherence
- Final validation before production release
- Onboarding documentation for new team members
- Design-to-development handoff documentation

🔍 REPORT INCLUDES:
- Visual comparison with heat maps and SSIM analysis
- Typography, spacing, and layout detailed breakdowns  
- Color palette analysis and design system compliance
- Accessibility and semantic structure assessment
- Interactive elements validation
- Performance impact analysis
- Recommended actions with priority levels

📈 OUTPUT FORMATS:
- Structured JSON for further processing
- Human-readable summaries for non-technical stakeholders
- Visual evidence with annotated screenshots
- Priority matrix for development planning`,
        inputSchema: {
            url1: z.string().url().describe('Reference URL (design/expected version)'),
            url2: z.string().url().describe('Implementation URL (actual version)'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('Main container selector to analyze'),
            figmaConfig: z.object({
                token: z.string().optional(),
                fileKey: z.string(),
                nodeId: z.string()
            }).optional().describe('Figma integration for design source comparison (token optional if FIGMA_TOKEN env var is set)'),
            reportOptions: z.object({
                includeVisuals: z.boolean().optional().describe('Include visual comparison and heat maps (default: true)'),
                includeSemantics: z.boolean().optional().describe('Include DOM structure and accessibility analysis (default: true)'),
                includePerformance: z.boolean().optional().describe('Include performance metrics (default: false)'),
                toleranceLevel: z.enum(['strict', 'normal', 'lenient']).optional().describe('Overall tolerance level (default: normal)')
            }).optional().describe('Report configuration options'),
            stakeholderLevel: z.enum(['technical', 'design', 'executive']).optional().describe('Report audience level (default: technical)')
        }
    },
    async ({ url1, url2, selector, figmaConfig, reportOptions = {}, stakeholderLevel = 'technical' }) => {
        const options = {
            includeVisuals: reportOptions.includeVisuals ?? true,
            includeSemantics: reportOptions.includeSemantics ?? true,
            includePerformance: reportOptions.includePerformance ?? false,
            toleranceLevel: reportOptions.toleranceLevel || 'normal'
        };
        
        const toleranceSettings = {
            strict: { colorDelta: 5, sizeTolerance: 1, positionTolerance: 2 },
            normal: { colorDelta: 15, sizeTolerance: 3, positionTolerance: 5 },
            lenient: { colorDelta: 25, sizeTolerance: 5, positionTolerance: 10 }
        };
        
        const tolerance = toleranceSettings[options.toleranceLevel];
        
        const report = {
            metadata: {
                reportGenerated: new Date().toISOString(),
                urls: { reference: url1, implementation: url2 },
                selector,
                toleranceLevel: options.toleranceLevel,
                stakeholderLevel,
                figmaIntegration: !!figmaConfig
            },
            executiveSummary: {
                overallScore: 0,
                recommendation: '',
                criticalIssues: 0,
                timeEstimate: '',
                readyForProduction: false
            },
            sections: {}
        };
        
        let aggregateScores = [];
        let criticalIssues = [];
        let allRecommendations = [];
        
        try {
            // 1. Visual Comparison Analysis
            if (options.includeVisuals) {
                const { page: page1 } = await createPage();
                const { page: page2 } = await createPage();
                
                try {
                    await Promise.all([
                        page1.goto(url1, { waitUntil: 'networkidle2' }),
                        page2.goto(url2, { waitUntil: 'networkidle2' })
                    ]);
                    
                    const [element1, element2] = await Promise.all([
                        page1.$(selector),
                        page2.$(selector)
                    ]);
                    
                    if (element1 && element2) {
                        const [buffer1, buffer2] = await Promise.all([
                            element1.screenshot(),
                            element2.screenshot()
                        ]);
                        
                        const [img1, img2] = await Promise.all([
                            Jimp.read(buffer1),
                            Jimp.read(buffer2)
                        ]);
                        
                        const targetWidth = Math.max(img1.bitmap.width, img2.bitmap.width);
                        const targetHeight = Math.max(img1.bitmap.height, img2.bitmap.height);
                        
                        img1.resize(targetWidth, targetHeight);
                        img2.resize(targetWidth, targetHeight);
                        
                        const img1Data = new Uint8ClampedArray(img1.bitmap.data);
                        const img2Data = new Uint8ClampedArray(img2.bitmap.data);
                        const diffData = new Uint8ClampedArray(targetWidth * targetHeight * 4);
                        
                        const diffPixels = pixelmatch(img1Data, img2Data, diffData, targetWidth, targetHeight, {
                            threshold: 0.1,
                            includeAA: false
                        });
                        
                        const ssimValue = calculateSSIM(img1Data, img2Data, targetWidth, targetHeight);
                        const totalPixels = targetWidth * targetHeight;
                        const differencePercent = (diffPixels / totalPixels) * 100;
                        
                        const visualScore = Math.max(0, 100 - differencePercent * 10);
                        aggregateScores.push({ category: 'visual', score: visualScore, weight: 0.4 });
                        
                        if (differencePercent > 10) {
                            criticalIssues.push('Significant visual differences detected (>10%)');
                        }
                        
                        report.sections.visualComparison = {
                            score: Math.round(visualScore),
                            ssim: Math.round(ssimValue * 10000) / 10000,
                            pixelDifference: Math.round(differencePercent * 100) / 100,
                            status: differencePercent < 1 ? 'excellent' : differencePercent < 5 ? 'good' : differencePercent < 15 ? 'acceptable' : 'poor',
                            images: {
                                reference: buffer1.toString('base64'),
                                implementation: buffer2.toString('base64'),
                                difference: options.includeVisuals ? (await new Jimp({ data: Buffer.from(diffData), width: targetWidth, height: targetHeight }).getBufferAsync(Jimp.MIME_PNG)).toString('base64') : null
                            }
                        };
                        
                        allRecommendations.push({
                            priority: differencePercent > 10 ? 'high' : differencePercent > 5 ? 'medium' : 'low',
                            category: 'visual',
                            action: differencePercent > 10 ? 'Major visual corrections needed' : 
                                   differencePercent > 5 ? 'Minor visual adjustments recommended' : 
                                   'Visual implementation acceptable'
                        });
                    }
                } finally {
                    await Promise.all([
                        page1.close().catch(() => {}),
                        page2.close().catch(() => {})
                    ]);
                }
            }
            
            // 2. Figma Comparison (if configured)
            if (figmaConfig) {
                try {
                    const page = await getPageForOperation(url);
                    
                    try {
                        // Use provided token or fall back to environment variable
                        const figmaToken = figmaConfig.token || FIGMA_TOKEN;
                        if (!figmaToken) {
                            throw new Error('Figma token is required in figmaConfig.token or FIGMA_TOKEN env var');
                        }
                        
                        const exportData = await fetchFigmaAPI(
                            `images/${figmaConfig.fileKey}?ids=${figmaConfig.nodeId}&scale=2&format=png`, 
                            figmaToken
                        );
                        
                        if (exportData.images && exportData.images[figmaConfig.nodeId]) {
                            const figmaImageUrl = exportData.images[figmaConfig.nodeId];
                            const figmaResponse = await fetch(figmaImageUrl);
                            const figmaBuffer = await figmaResponse.buffer();
                            
                            await page.goto(url2, { waitUntil: 'networkidle2' });
                            const element = await page.$(selector);
                            
                            if (element) {
                                const pageBuffer = await element.screenshot();
                                
                                const [figmaImg, pageImg] = await Promise.all([
                                    Jimp.read(figmaBuffer),
                                    Jimp.read(pageBuffer)
                                ]);
                                
                                const targetWidth = Math.max(figmaImg.bitmap.width, pageImg.bitmap.width);
                                const targetHeight = Math.max(figmaImg.bitmap.height, pageImg.bitmap.height);
                                
                                figmaImg.resize(targetWidth, targetHeight);
                                pageImg.resize(targetWidth, targetHeight);
                                
                                const figmaData = new Uint8ClampedArray(figmaImg.bitmap.data);
                                const pageData = new Uint8ClampedArray(pageImg.bitmap.data);
                                
                                const diffPixels = pixelmatch(figmaData, pageData, null, targetWidth, targetHeight, {
                                    threshold: 0.1,
                                    includeAA: false
                                });
                                
                                const totalPixels = targetWidth * targetHeight;
                                const differencePercent = (diffPixels / totalPixels) * 100;
                                
                                const figmaScore = Math.max(0, 100 - differencePercent * 8);
                                aggregateScores.push({ category: 'figma', score: figmaScore, weight: 0.3 });
                                
                                report.sections.figmaComparison = {
                                    score: Math.round(figmaScore),
                                    pixelDifference: Math.round(differencePercent * 100) / 100,
                                    status: differencePercent < 1 ? 'pixel-perfect' : 
                                           differencePercent < 3 ? 'very-close' : 
                                           differencePercent < 10 ? 'minor-differences' : 'significant-differences',
                                    designFidelity: Math.max(0, 100 - differencePercent)
                                };
                                
                                allRecommendations.push({
                                    priority: differencePercent > 10 ? 'high' : differencePercent > 3 ? 'medium' : 'low',
                                    category: 'design-fidelity',
                                    action: differencePercent > 10 ? 'Design implementation needs major revision' : 
                                           differencePercent > 3 ? 'Minor adjustments needed to match design' : 
                                           'Implementation matches design well'
                                });
                            }
                        }
                    } finally {
                        await page.close().catch(() => {});
                    }
                } catch (error) {
                    report.sections.figmaComparison = {
                        error: `Figma integration failed: ${error.message}`,
                        score: 0
                    };
                }
            }
            
            // 3. Tolerance-based Comparison
            const { page: page1 } = await createPage();
            const { page: page2 } = await createPage();
            
            try {
                await Promise.all([
                    page1.goto(url1, { waitUntil: 'networkidle2' }),
                    page2.goto(url2, { waitUntil: 'networkidle2' })
                ]);
                
                // Упрощенная версия compareWithTolerance для отчета
                async function getComparisonData(page, sel) {
                    return await page.evaluate((selector) => {
                        const elements = document.querySelectorAll(selector);
                        return elements.length;
                    }, sel);
                }
                
                const [count1, count2] = await Promise.all([
                    getComparisonData(page1, selector),
                    getComparisonData(page2, selector)
                ]);
                
                const structuralScore = count1 === count2 ? 100 : Math.max(0, 100 - Math.abs(count1 - count2) * 10);
                aggregateScores.push({ category: 'structure', score: structuralScore, weight: 0.2 });
                
                report.sections.structuralComparison = {
                    score: Math.round(structuralScore),
                    elementsReference: count1,
                    elementsImplementation: count2,
                    status: count1 === count2 ? 'identical' : Math.abs(count1 - count2) < 3 ? 'similar' : 'different'
                };
                
            } finally {
                await Promise.all([
                    page1.close().catch(() => {}),
                    page2.close().catch(() => {})
                ]);
            }
            
            // 4. Semantic Analysis (if enabled)
            if (options.includeSemantics) {
                const page = await getPageForOperation(url);
                
                try {
                    await page.goto(url2, { waitUntil: 'networkidle2' });
                    
                    const semanticAnalysis = await page.evaluate((sel) => {
                        const container = document.querySelector(sel);
                        if (!container) return null;
                        
                        const semanticTags = ['header', 'nav', 'main', 'article', 'section', 'aside', 'footer'];
                        const interactiveTags = ['button', 'a', 'input', 'select', 'textarea'];
                        const headingTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
                        
                        const allElements = container.querySelectorAll('*');
                        const semanticCount = Array.from(allElements).filter(el => semanticTags.includes(el.tagName.toLowerCase())).length;
                        const interactiveCount = Array.from(allElements).filter(el => interactiveTags.includes(el.tagName.toLowerCase())).length;
                        const headingCount = Array.from(allElements).filter(el => headingTags.includes(el.tagName.toLowerCase())).length;
                        const ariaCount = Array.from(allElements).filter(el => el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')).length;
                        
                        return {
                            totalElements: allElements.length,
                            semanticElements: semanticCount,
                            interactiveElements: interactiveCount,
                            headingElements: headingCount,
                            ariaElements: ariaCount,
                            semanticRatio: allElements.length > 0 ? (semanticCount / allElements.length) * 100 : 0,
                            accessibilityRatio: interactiveCount > 0 ? (ariaCount / interactiveCount) * 100 : 100
                        };
                    }, selector);
                    
                    if (semanticAnalysis) {
                        const semanticScore = (semanticAnalysis.semanticRatio * 0.6) + (semanticAnalysis.accessibilityRatio * 0.4);
                        aggregateScores.push({ category: 'semantic', score: semanticScore, weight: 0.1 });
                        
                        if (semanticAnalysis.semanticRatio < 10) {
                            criticalIssues.push('Low semantic HTML usage detected');
                        }
                        
                        report.sections.semanticAnalysis = {
                            score: Math.round(semanticScore),
                            semanticRatio: Math.round(semanticAnalysis.semanticRatio * 100) / 100,
                            accessibilityRatio: Math.round(semanticAnalysis.accessibilityRatio * 100) / 100,
                            elements: {
                                total: semanticAnalysis.totalElements,
                                semantic: semanticAnalysis.semanticElements,
                                interactive: semanticAnalysis.interactiveElements,
                                headings: semanticAnalysis.headingElements,
                                aria: semanticAnalysis.ariaElements
                            },
                            status: semanticScore >= 80 ? 'excellent' : semanticScore >= 60 ? 'good' : semanticScore >= 40 ? 'acceptable' : 'poor'
                        };
                        
                        allRecommendations.push({
                            priority: semanticAnalysis.semanticRatio < 15 ? 'medium' : 'low',
                            category: 'accessibility',
                            action: semanticAnalysis.semanticRatio < 15 ? 'Improve semantic HTML structure' : 'Semantic structure is adequate'
                        });
                    }
                } finally {
                    await page.close().catch(() => {});
                }
            }
            
            // 5. Calculate Overall Score and Executive Summary
            const weightedScore = aggregateScores.reduce((total, item) => total + (item.score * item.weight), 0) / 
                                aggregateScores.reduce((total, item) => total + item.weight, 0);
            
            report.executiveSummary.overallScore = Math.round(weightedScore);
            report.executiveSummary.criticalIssues = criticalIssues.length;
            report.executiveSummary.readyForProduction = weightedScore >= 85 && criticalIssues.length === 0;
            
            if (weightedScore >= 90) {
                report.executiveSummary.recommendation = 'Excellent implementation - ready for production';
                report.executiveSummary.timeEstimate = 'No additional development time needed';
            } else if (weightedScore >= 75) {
                report.executiveSummary.recommendation = 'Good implementation with minor improvements needed';
                report.executiveSummary.timeEstimate = '1-2 days for minor adjustments';
            } else if (weightedScore >= 50) {
                report.executiveSummary.recommendation = 'Moderate issues requiring attention';
                report.executiveSummary.timeEstimate = '3-5 days for corrections';
            } else {
                report.executiveSummary.recommendation = 'Significant issues requiring major revision';
                report.executiveSummary.timeEstimate = '1-2 weeks for major corrections';
            }
            
            // 6. Prioritize Recommendations
            const highPriorityRecs = allRecommendations.filter(r => r.priority === 'high');
            const mediumPriorityRecs = allRecommendations.filter(r => r.priority === 'medium');
            const lowPriorityRecs = allRecommendations.filter(r => r.priority === 'low');
            
            report.recommendations = {
                high: highPriorityRecs,
                medium: mediumPriorityRecs,
                low: lowPriorityRecs,
                nextSteps: [
                    ...(highPriorityRecs.length > 0 ? ['Address high priority visual and structural issues'] : []),
                    ...(mediumPriorityRecs.length > 0 ? ['Implement medium priority improvements'] : []),
                    ...(criticalIssues.length > 0 ? ['Resolve critical issues before production'] : []),
                    ...(report.executiveSummary.readyForProduction ? ['Proceed with production deployment'] : ['Complete recommended fixes before deployment'])
                ]
            };
            
            // 7. Stakeholder-specific Summary
            if (stakeholderLevel === 'executive') {
                report.executiveBrief = {
                    readyForLaunch: report.executiveSummary.readyForProduction,
                    developmentTime: report.executiveSummary.timeEstimate,
                    riskLevel: criticalIssues.length > 2 ? 'high' : criticalIssues.length > 0 ? 'medium' : 'low',
                    budgetImpact: weightedScore < 50 ? 'significant' : weightedScore < 75 ? 'moderate' : 'minimal',
                    keyMetrics: {
                        designCompliance: `${report.executiveSummary.overallScore}%`,
                        criticalIssues: criticalIssues.length,
                        recommendedAction: report.executiveSummary.recommendation
                    }
                };
            }
            
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(report, null, 2)
                    }
                ]
            };
            
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            error: 'Report generation failed',
                            message: error.message,
                            partialReport: report
                        }, null, 2)
                    }
                ]
            };
        }
    }
);

/* 33) createVisualDiff - создание визуальных аннотаций различий */
server.registerTool(
    'createVisualDiff',
    {
        title: 'Create Annotated Visual Diff',
        description: `🎨 ANNOTATED VISUAL DIFFERENCE CREATOR 🎨

Creates annotated screenshots highlighting specific differences for stakeholder communication.
Perfect for design reviews, client feedback, and developer guidance.

🎯 USE THIS WHEN:
- Need to show exactly what needs to be fixed
- Client/designer feedback requires visual documentation  
- Creating developer task specifications with visual context
- Generating before/after comparisons for progress tracking
- Documentation for design system compliance issues

📊 ANNOTATION TYPES:
- Color difference highlights with RGB values
- Spacing measurement annotations with pixel values
- Font difference callouts with typography details
- Missing/extra element markers
- Alignment guides and measurement tools`,
        inputSchema: {
            url: z.string().url().describe('Page URL to annotate'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().describe('Element selector to focus on'),
            annotationTypes: z.array(z.enum(['spacing', 'colors', 'typography', 'alignment', 'elements'])).optional().describe('Types of annotations to include'),
            outputFormat: z.enum(['base64', 'measurements']).optional().describe('Output format (default: base64)')
        }
    },
    async ({ url, selector, annotationTypes = ['spacing', 'colors', 'alignment'], outputFormat = 'base64' }) => {
        const page = await getPageForOperation(url);
        
        try {            const element = await page.$(selector);
            if (!element) {
                throw new Error( `Selector "${selector}" not found`);
            }
            
            // Получаем детальную информацию об элементе
            const elementInfo = await page.evaluate((sel, annotations) => {
                const element = document.querySelector(sel);
                if (!element) return null;
                
                const rect = element.getBoundingClientRect();
                const computedStyle = window.getComputedStyle(element);
                
                const info = {
                    bounds: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        top: rect.top,
                        left: rect.left,
                        right: rect.right,
                        bottom: rect.bottom
                    },
                    annotations: []
                };
                
                if (annotations.includes('spacing')) {
                    info.spacing = {
                        margin: {
                            top: parseFloat(computedStyle.marginTop),
                            right: parseFloat(computedStyle.marginRight),
                            bottom: parseFloat(computedStyle.marginBottom),
                            left: parseFloat(computedStyle.marginLeft)
                        },
                        padding: {
                            top: parseFloat(computedStyle.paddingTop),
                            right: parseFloat(computedStyle.paddingRight),
                            bottom: parseFloat(computedStyle.paddingBottom),
                            left: parseFloat(computedStyle.paddingLeft)
                        }
                    };
                    
                    info.annotations.push({
                        type: 'spacing',
                        measurements: info.spacing,
                        position: { x: rect.x, y: rect.y - 30 }
                    });
                }
                
                if (annotations.includes('colors')) {
                    info.colors = {
                        color: computedStyle.color,
                        backgroundColor: computedStyle.backgroundColor,
                        borderColor: computedStyle.borderTopColor
                    };
                    
                    info.annotations.push({
                        type: 'colors',
                        colors: info.colors,
                        position: { x: rect.right + 10, y: rect.y }
                    });
                }
                
                if (annotations.includes('typography')) {
                    info.typography = {
                        fontSize: computedStyle.fontSize,
                        fontFamily: computedStyle.fontFamily,
                        fontWeight: computedStyle.fontWeight,
                        lineHeight: computedStyle.lineHeight,
                        letterSpacing: computedStyle.letterSpacing
                    };
                    
                    info.annotations.push({
                        type: 'typography',
                        typography: info.typography,
                        position: { x: rect.x, y: rect.bottom + 10 }
                    });
                }
                
                if (annotations.includes('alignment')) {
                    // Находим соседние элементы для анализа выравнивания
                    const parent = element.parentElement;
                    if (parent) {
                        const siblings = Array.from(parent.children);
                        const elementIndex = siblings.indexOf(element);
                        
                        const alignmentData = {
                            parentBounds: parent.getBoundingClientRect(),
                            position: computedStyle.position,
                            display: computedStyle.display,
                            alignSelf: computedStyle.alignSelf,
                            justifySelf: computedStyle.justifySelf
                        };
                        
                        info.annotations.push({
                            type: 'alignment',
                            alignment: alignmentData,
                            position: { x: rect.x - 20, y: rect.y }
                        });
                    }
                }
                
                if (annotations.includes('elements')) {
                    const children = element.children.length;
                    const hasText = element.textContent && element.textContent.trim().length > 0;
                    
                    info.annotations.push({
                        type: 'elements',
                        structure: {
                            tagName: element.tagName.toLowerCase(),
                            childrenCount: children,
                            hasTextContent: hasText,
                            classes: Array.from(element.classList),
                            id: element.id || null
                        },
                        position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
                    });
                }
                
                return info;
            }, selector, annotationTypes);
            
            if (!elementInfo) {
                throw new Error( 'Element analysis failed');
            }
            
            // Делаем скриншот элемента
            const screenshot = await element.screenshot();
            
            if (outputFormat === 'base64') {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                elementInfo,
                                screenshot: screenshot.toString('base64'),
                                annotationGuide: {
                                    instructions: 'Use elementInfo.annotations to overlay measurements and details on the screenshot',
                                    visualization: 'Each annotation includes type, data, and position for overlay rendering'
                                }
                            }, null, 2)
                        },
                        {
                            type: 'image',
                            data: screenshot.toString('base64'),
                            mimeType: 'image/png'
                        }
                    ]
                };
            } else {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                measurements: elementInfo,
                                summary: {
                                    dimensions: `${Math.round(elementInfo.bounds.width)}×${Math.round(elementInfo.bounds.height)}px`,
                                    position: `(${Math.round(elementInfo.bounds.x)}, ${Math.round(elementInfo.bounds.y)})`,
                                    annotationsGenerated: elementInfo.annotations.length
                                }
                            }, null, 2)
                        }
                    ]
                };
            }
            
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* 37) generateAIPrompt - генерация промптов для AI агентов */
server.registerTool(
    'generateAIPrompt',
    {
        title: 'Generate AI Agent Prompt',
        description: `🤖 AI PROMPT GENERATOR 🤖

Dynamically generates context-aware prompts for AI agents based on page analysis.
Creates detailed, structured prompts that help AI understand and work with web pages.

🎯 USE THIS WHEN:
- Need to create tasks for AI agents to analyze pages
- Want to generate test scenarios from page structure
- Creating documentation prompts from live pages
- Building context-aware debugging instructions
- Generating code review prompts from implementation
- Creating accessibility audit prompts`,
        inputSchema: {
            url: z.string().url().describe('Page URL to analyze'),
            url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

            selector: z.string().optional().describe('Optional selector to focus analysis'),
            promptType: z.enum([
                'bug-report',
                'code-review', 
                'test-generation',
                'accessibility-audit',
                'performance-analysis',
                'design-review',
                'content-review',
                'seo-analysis',
                'custom'
            ]).describe('Type of prompt to generate'),
            context: z.object({
                goal: z.string().optional().describe('What you want to achieve'),
                constraints: z.array(z.string()).optional().describe('Any constraints or requirements'),
                focusAreas: z.array(z.string()).optional().describe('Specific areas to focus on'),
                outputFormat: z.enum(['markdown', 'json', 'text']).optional().default('markdown')
            }).optional().describe('Additional context for prompt generation'),
            includePageData: z.boolean().optional().default(true).describe('Include page analysis in prompt')
        }
    },
    async ({ url, selector, promptType, context = {}, includePageData = true }) => {
        const { page, client } = await createPage();
        
        try {            let pageAnalysis = {};
            
            if (includePageData) {
                // Сбор данных о странице
                pageAnalysis = await page.evaluate((sel) => {
                    const targetElement = sel ? document.querySelector(sel) : document.body;
                    if (!targetElement) return null;
                    
                    // Анализ структуры
                    const structure = {
                        tagName: targetElement.tagName.toLowerCase(),
                        classes: Array.from(targetElement.classList),
                        id: targetElement.id || null,
                        childrenCount: targetElement.children.length,
                        textLength: targetElement.textContent?.length || 0
                    };
                    
                    // Поиск форм
                    const forms = Array.from(targetElement.querySelectorAll('form')).map(form => ({
                        id: form.id,
                        action: form.action,
                        method: form.method,
                        fields: Array.from(form.elements).map(el => ({
                            type: el.type,
                            name: el.name,
                            id: el.id,
                            required: el.required
                        })).filter(f => f.type && f.type !== 'submit')
                    }));
                    
                    // Поиск интерактивных элементов
                    const interactive = {
                        buttons: targetElement.querySelectorAll('button').length,
                        links: targetElement.querySelectorAll('a[href]').length,
                        inputs: targetElement.querySelectorAll('input, textarea, select').length
                    };
                    
                    // Медиа контент
                    const media = {
                        images: targetElement.querySelectorAll('img').length,
                        videos: targetElement.querySelectorAll('video').length,
                        iframes: targetElement.querySelectorAll('iframe').length
                    };
                    
                    // Семантические элементы
                    const semantic = {
                        headers: targetElement.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
                        sections: targetElement.querySelectorAll('section, article, aside, nav').length,
                        lists: targetElement.querySelectorAll('ul, ol').length
                    };
                    
                    // Meta информация (если анализируем всю страницу)
                    const meta = !sel ? {
                        title: document.title,
                        description: document.querySelector('meta[name="description"]')?.content,
                        viewport: document.querySelector('meta[name="viewport"]')?.content,
                        charset: document.characterSet
                    } : null;
                    
                    return {
                        url: window.location.href,
                        structure,
                        forms,
                        interactive,
                        media,
                        semantic,
                        meta
                    };
                }, selector);
                
                if (!pageAnalysis) {
                    throw new Error( 'Element not found or analysis failed');
                }
            }
            
            // Шаблоны промптов для разных типов
            const promptTemplates = {
                'bug-report': {
                    template: `# Bug Report Analysis Request

## Page Context
URL: ${url}
${selector ? `Focus Element: ${selector}` : 'Scope: Entire page'}

## Page Structure Analysis
${JSON.stringify(pageAnalysis, null, 2)}

## Investigation Task
Please analyze the ${selector || 'page'} for the following potential issues:

1. **Visual Bugs**: Layout breaks, overlapping elements, incorrect alignments
2. **Functional Issues**: Broken interactions, non-responsive elements, JavaScript errors
3. **Cross-browser Compatibility**: Issues that might appear in different browsers
4. **Responsive Design**: Problems at different viewport sizes
5. **Accessibility Violations**: WCAG compliance issues

${context.goal ? `\n### Specific Goal\n${context.goal}` : ''}
${context.focusAreas?.length ? `\n### Focus Areas\n${context.focusAreas.map(a => `- ${a}`).join('\n')}` : ''}

## Expected Output
Provide a detailed bug report including:
- Issue description and severity
- Steps to reproduce
- Expected vs actual behavior
- Suggested fixes
- Screenshots or specific selectors of problematic elements`
                },
                
                'code-review': {
                    template: `# Frontend Code Review Request

## Implementation Context
URL: ${url}
${selector ? `Component Selector: ${selector}` : 'Full Page Review'}

## Current Implementation Analysis
${JSON.stringify(pageAnalysis, null, 2)}

## Review Checklist
Please review the implementation for:

1. **Code Quality**
   - Semantic HTML usage
   - CSS best practices
   - JavaScript performance

2. **Accessibility**
   - ARIA attributes
   - Keyboard navigation
   - Screen reader compatibility

3. **Performance**
   - Resource optimization
   - Render blocking resources
   - Bundle size concerns

4. **Security**
   - XSS vulnerabilities
   - Input validation
   - Secure data handling

${context.goal ? `\n## Review Goal\n${context.goal}` : ''}
${context.constraints?.length ? `\n## Constraints\n${context.constraints.map(c => `- ${c}`).join('\n')}` : ''}

## Deliverables
- Code quality score (1-10)
- Critical issues that must be fixed
- Recommendations for improvement
- Best practices violations`
                },
                
                'test-generation': {
                    template: `# Test Scenario Generation

## Application Under Test
URL: ${url}
${selector ? `Test Focus: ${selector}` : 'Full Page Testing'}

## Page Analysis
${JSON.stringify(pageAnalysis, null, 2)}

## Test Generation Requirements

Generate comprehensive test scenarios for:

1. **Functional Tests**
   - Form submissions: ${pageAnalysis.forms?.length || 0} forms found
   - Button interactions: ${pageAnalysis.interactive?.buttons || 0} buttons found
   - Navigation flows: ${pageAnalysis.interactive?.links || 0} links found

2. **Visual Regression Tests**
   - Component rendering
   - Responsive breakpoints
   - Theme variations

3. **Integration Tests**
   - API interactions
   - State management
   - Data flow

4. **Edge Cases**
   - Error states
   - Empty states
   - Loading states
   - Boundary conditions

${context.goal ? `\n## Testing Goal\n${context.goal}` : ''}
${context.focusAreas?.length ? `\n## Priority Areas\n${context.focusAreas.map(a => `- ${a}`).join('\n')}` : ''}

## Expected Output
Generate test cases in the following format:
- Test name and description
- Prerequisites and setup
- Test steps
- Expected results
- Test data requirements`
                },
                
                'accessibility-audit': {
                    template: `# Accessibility Audit Request

## Target Page
URL: ${url}
${selector ? `Audit Focus: ${selector}` : 'Full Page Audit'}

## Page Structure
${JSON.stringify(pageAnalysis, null, 2)}

## WCAG 2.1 Compliance Audit

Please conduct a comprehensive accessibility audit covering:

1. **Perceivable**
   - Text alternatives for images
   - Color contrast ratios
   - Responsive text sizing
   - Media alternatives

2. **Operable**
   - Keyboard accessibility
   - Focus indicators
   - Skip navigation links
   - Timing adjustments

3. **Understandable**
   - Label clarity
   - Error identification
   - Consistent navigation
   - Input assistance

4. **Robust**
   - Valid HTML
   - ARIA implementation
   - Compatibility with assistive technologies

## Interactive Elements Found
- Buttons: ${pageAnalysis.interactive?.buttons || 0}
- Links: ${pageAnalysis.interactive?.links || 0}
- Form inputs: ${pageAnalysis.interactive?.inputs || 0}

${context.goal ? `\n## Audit Focus\n${context.goal}` : ''}

## Deliverables
- WCAG compliance level (A, AA, AAA)
- Critical violations with severity
- Remediation recommendations
- Priority fix order`
                },
                
                'performance-analysis': {
                    template: `# Performance Analysis Request

## Page Details
URL: ${url}
${selector ? `Component Focus: ${selector}` : 'Full Page Analysis'}

## Initial Page Metrics
${JSON.stringify(pageAnalysis, null, 2)}

## Performance Investigation Areas

1. **Loading Performance**
   - Initial load time
   - Time to Interactive (TTI)
   - First Contentful Paint (FCP)
   - Largest Contentful Paint (LCP)

2. **Runtime Performance**
   - JavaScript execution time
   - Render performance
   - Memory usage
   - Animation smoothness

3. **Resource Optimization**
   - Images: ${pageAnalysis.media?.images || 0} found
   - Videos: ${pageAnalysis.media?.videos || 0} found
   - Third-party scripts
   - Bundle sizes

4. **Network Analysis**
   - Request waterfall
   - Cache utilization
   - CDN effectiveness
   - API response times

${context.goal ? `\n## Analysis Goal\n${context.goal}` : ''}
${context.constraints?.length ? `\n## Performance Constraints\n${context.constraints.map(c => `- ${c}`).join('\n')}` : ''}

## Expected Analysis Output
- Core Web Vitals scores
- Performance bottlenecks identified
- Optimization recommendations with impact estimates
- Implementation priority matrix`
                },
                
                'design-review': {
                    template: `# Design Implementation Review

## Implementation URL
${url}
${selector ? `Component: ${selector}` : 'Full Page Design'}

## Current Implementation
${JSON.stringify(pageAnalysis, null, 2)}

## Design Review Criteria

1. **Visual Consistency**
   - Typography hierarchy
   - Color scheme adherence
   - Spacing and alignment
   - Component consistency

2. **Responsive Design**
   - Mobile optimization
   - Tablet layouts
   - Desktop experience
   - Breakpoint handling

3. **Interaction Design**
   - Hover states
   - Active states
   - Transitions and animations
   - Feedback mechanisms

4. **Brand Alignment**
   - Style guide compliance
   - Design system usage
   - Brand personality expression
   - Visual hierarchy

${context.goal ? `\n## Review Focus\n${context.goal}` : ''}
${context.focusAreas?.length ? `\n## Key Areas\n${context.focusAreas.map(a => `- ${a}`).join('\n')}` : ''}

## Deliverables
- Design fidelity score (1-100)
- Deviation list from design specs
- Improvement recommendations
- Priority fixes for design consistency`
                },
                
                'content-review': {
                    template: `# Content Quality Review

## Page URL
${url}
${selector ? `Content Section: ${selector}` : 'Full Page Content'}

## Content Structure
${JSON.stringify(pageAnalysis, null, 2)}

## Content Analysis Requirements

1. **Content Quality**
   - Clarity and readability
   - Grammar and spelling
   - Tone consistency
   - Message effectiveness

2. **SEO Optimization**
   - Keyword usage
   - Meta descriptions
   - Header hierarchy
   - Internal linking

3. **User Experience**
   - Content organization
   - Scanability
   - Call-to-action effectiveness
   - Information architecture

4. **Accessibility**
   - Alt text quality
   - Link text descriptiveness
   - Content structure
   - Language clarity

## Content Metrics
- Headers found: ${pageAnalysis.semantic?.headers || 0}
- Sections: ${pageAnalysis.semantic?.sections || 0}
- Lists: ${pageAnalysis.semantic?.lists || 0}
- Total text length: ${pageAnalysis.structure?.textLength || 0} characters

${context.goal ? `\n## Review Goal\n${context.goal}` : ''}

## Expected Output
- Content quality score
- Improvement recommendations
- SEO optimization suggestions
- Accessibility enhancements`
                },
                
                'seo-analysis': {
                    template: `# SEO Analysis Request

## Target URL
${url}

## Page Metadata
${JSON.stringify(pageAnalysis.meta, null, 2)}

## SEO Audit Checklist

1. **Technical SEO**
   - Page load speed
   - Mobile responsiveness
   - SSL certificate
   - XML sitemap presence
   - Robots.txt configuration

2. **On-Page SEO**
   - Title tag optimization
   - Meta descriptions
   - Header tags usage (${pageAnalysis.semantic?.headers || 0} found)
   - Image alt attributes
   - Internal linking structure

3. **Content SEO**
   - Keyword density
   - Content length and quality
   - Semantic HTML usage
   - Schema markup implementation

4. **User Experience Signals**
   - Core Web Vitals
   - Mobile usability
   - Safe browsing
   - HTTPS security

${context.goal ? `\n## SEO Goal\n${context.goal}` : ''}
${context.focusAreas?.length ? `\n## Focus Keywords\n${context.focusAreas.map(k => `- ${k}`).join('\n')}` : ''}

## Deliverables
- SEO score (1-100)
- Critical issues affecting ranking
- Optimization opportunities
- Competitor comparison insights`
                },
                
                'custom': {
                    template: `# Custom Analysis Request

## Target
URL: ${url}
${selector ? `Element: ${selector}` : 'Full Page'}

## Page Data
${JSON.stringify(pageAnalysis, null, 2)}

${context.goal ? `## Analysis Goal\n${context.goal}` : '## Goal\nPlease analyze this page and provide insights.'}

${context.constraints?.length ? `\n## Constraints\n${context.constraints.map(c => `- ${c}`).join('\n')}` : ''}

${context.focusAreas?.length ? `\n## Focus Areas\n${context.focusAreas.map(a => `- ${a}`).join('\n')}` : ''}

## Analysis Requirements
Based on the page structure and provided context, please:
1. Identify key patterns and issues
2. Provide actionable recommendations
3. Prioritize findings by impact
4. Suggest implementation approaches`
                }
            };
            
            const selectedTemplate = promptTemplates[promptType];
            const generatedPrompt = selectedTemplate.template;
            
            // Форматирование вывода
            let output;
            if (context.outputFormat === 'json') {
                output = {
                    prompt: generatedPrompt,
                    metadata: {
                        url,
                        selector,
                        promptType,
                        timestamp: new Date().toISOString(),
                        pageAnalysis: includePageData ? pageAnalysis : null
                    }
                };
            } else {
                output = generatedPrompt;
            }
            
            return {
                content: [
                    {
                        type: 'text',
                        text: context.outputFormat === 'json' ? 
                              JSON.stringify(output, null, 2) : 
                              output
                    }
                ]
            };
            
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* ================== NEW WORKING FIGMA TOOLS ================== */
/* These tools use the proven working pattern from get_figma_image.js */

/* exportFigmaFrame - working Figma frame export */
server.registerTool(
    'exportFigmaFrame',
    {
        title: 'Export Figma Frame (Working)',
        description: 'Export and download a Figma frame as PNG image using proven working API pattern. Requires Figma API token and file/node IDs from Figma URLs.',
        inputSchema: {
            figmaToken: z.string().optional().describe('Figma API token (optional if FIGMA_TOKEN env var is set)'),
            fileKey: z.string().describe('Figma file key (from URL: figma.com/file/FILE_KEY/...)'),
            nodeId: z.string().describe('Figma node ID (frame/component ID)'),
            scale: z.number().min(0.1).max(4).optional().describe('Export scale (0.1-4, default: 2)'),
            format: z.enum(['png', 'jpg', 'svg']).optional().describe('Export format (default: png)')
        }
    },
    async ({ figmaToken, fileKey, nodeId, scale = 2, format = 'png' }) => {
        const token = figmaToken || FIGMA_TOKEN;
        if (!token) {
            throw new McpError(ErrorCode.InvalidRequest, 'Figma token is required. Pass it as parameter or set FIGMA_TOKEN environment variable in MCP config.');
        }

        try {
            console.log('Getting image export URL from Figma...');
            
            // Use the proven working pattern from get_figma_image.js
            const exportResponse = await fetch(`https://api.figma.com/v1/images/${fileKey}?ids=${nodeId}&scale=${scale}&format=${format}`, {
                headers: {
                    'X-Figma-Token': token
                }
            });
            
            if (!exportResponse.ok) {
                const error = await exportResponse.text();
                throw new McpError(ErrorCode.InternalError, `Figma API error: ${exportResponse.status} - ${error}`);
            }
            
            const exportData = await exportResponse.json();
            
            if (!exportData.images || !exportData.images[nodeId]) {
                throw new McpError(ErrorCode.InvalidRequest, `Failed to get export URL for node ${nodeId}`);
            }
            
            const imageUrl = exportData.images[nodeId];
            console.log('Got image URL:', imageUrl);
            
            // Download the image
            console.log('Downloading image...');
            const imageResponse = await fetch(imageUrl);
            
            if (!imageResponse.ok) {
                throw new McpError(ErrorCode.InternalError, `Failed to download image: ${imageResponse.status}`);
            }
            
            const imageBuffer = await imageResponse.buffer();
            
            // Save to project root like the working example
            const filename = `figma_frame_${nodeId.replace(':', '-')}.png`;
            fs.writeFileSync(filename, imageBuffer);
            
            const result = {
                success: true,
                filename: filename,
                fileSize: imageBuffer.length,
                nodeId: nodeId,
                imageUrl: imageUrl,
                message: `✅ Image saved as: ${filename}`,
                sizeInfo: `📏 Image size: ${imageBuffer.length} bytes`
            };
            
            return {
                content: [
                    { type: 'text', text: JSON.stringify(result, null, 2) },
                    { 
                        type: 'image', 
                        data: imageBuffer.toString('base64'), 
                        mimeType: `image/${format}` 
                    }
                ]
            };
            
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            throw new McpError(ErrorCode.InternalError, `❌ Error: ${error.message}`);
        }
    }
);

/* downloadFigmaImage - minimal working Figma tool */
server.registerTool(
    'downloadFigmaImage',
    {
        title: 'Download Figma Image (Simple)',
        description: 'Simple Figma image download using proven working pattern. Gets PNG export of specified frame.',
        inputSchema: {
            figmaToken: z.string().optional().describe('Figma API token (optional if FIGMA_TOKEN env var is set)'),
            fileKey: z.string().describe('Figma file key from URL'),
            nodeId: z.string().describe('Figma frame/component ID')
        }
    },
    async ({ figmaToken, fileKey, nodeId }) => {
        const FIGMA_TOKEN_TO_USE = figmaToken || FIGMA_TOKEN;
        
        try {
            // Exactly like get_figma_image.js
            const exportResponse = await fetch(`https://api.figma.com/v1/images/${fileKey}?ids=${nodeId}&scale=2&format=png`, {
                headers: {
                    'X-Figma-Token': FIGMA_TOKEN_TO_USE
                }
            });
            
            if (!exportResponse.ok) {
                const error = await exportResponse.text();
                return {
                    content: [{ type: 'text', text: `Figma API error: ${exportResponse.status} - ${error}` }]
                };
            }
            
            const exportData = await exportResponse.json();
            
            if (!exportData.images || !exportData.images[nodeId]) {
                return {
                    content: [{ type: 'text', text: `Failed to get export URL for node ${nodeId}` }]
                };
            }
            
            const imageUrl = exportData.images[nodeId];
            
            const imageResponse = await fetch(imageUrl);
            
            if (!imageResponse.ok) {
                return {
                    content: [{ type: 'text', text: `Failed to download image: ${imageResponse.status}` }]
                };
            }
            
            const imageBuffer = await imageResponse.buffer();
            
            return {
                content: [
                    { 
                        type: 'text', 
                        text: `✅ Successfully downloaded Figma image\n📏 Size: ${imageBuffer.length} bytes\n🔗 URL: ${imageUrl}` 
                    },
                    { 
                        type: 'image', 
                        data: imageBuffer.toString('base64'), 
                        mimeType: 'image/png' 
                    }
                ]
            };
            
        } catch (error) {
            return {
                content: [{ type: 'text', text: `❌ Error: ${error.message}` }]
            };
        }
    }
);

/* ================== ADVANCED FIGMA AUTOMATION TOOLS ================== */

/* extractFigmaTexts - извлечение всех текстов с их стилями */
server.registerTool(
    'extractFigmaTexts',
    {
        title: 'Extract All Texts from Figma',
        description: 'Extract all text content with styles from Figma design. Returns structured text data with typography settings.',
        inputSchema: {
            figmaToken: z.string().optional().describe('Figma API token (optional if FIGMA_TOKEN env var is set)'),
            fileKey: z.string().describe('Figma file key'),
            nodeId: z.string().describe('Figma node ID to extract texts from')
        }
    },
    async ({ figmaToken, fileKey, nodeId }) => {
        const token = figmaToken || FIGMA_TOKEN;
        if (!token) {
            throw new McpError(ErrorCode.InvalidRequest, 'Figma token is required');
        }

        try {
            // Get file data
            const fileResponse = await fetch(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${nodeId}`, {
                headers: { 'X-Figma-Token': token }
            });

            if (!fileResponse.ok) {
                const error = await fileResponse.text();
                throw new McpError(ErrorCode.InternalError, `Figma API error: ${fileResponse.status} - ${error}`);
            }

            const fileData = await fileResponse.json();
            const nodes = fileData.nodes;
            
            // Extract text recursively
            const texts = [];
            
            function extractTexts(node, path = '') {
                if (node.type === 'TEXT' && node.characters) {
                    const style = node.style || {};
                    texts.push({
                        id: node.id,
                        content: node.characters,
                        path: path || node.name,
                        style: {
                            fontFamily: style.fontFamily || node.style?.fontFamily,
                            fontSize: style.fontSize || node.style?.fontSize,
                            fontWeight: style.fontWeight || node.style?.fontWeight,
                            lineHeight: style.lineHeightPx || node.style?.lineHeightPx,
                            letterSpacing: style.letterSpacing || node.style?.letterSpacing,
                            textAlign: style.textAlignHorizontal || node.style?.textAlignHorizontal,
                            color: node.fills?.[0]?.color ? {
                                r: Math.round(node.fills[0].color.r * 255),
                                g: Math.round(node.fills[0].color.g * 255),
                                b: Math.round(node.fills[0].color.b * 255),
                                a: node.fills[0].color.a || 1
                            } : null
                        },
                        position: node.absoluteBoundingBox || null
                    });
                }
                
                if (node.children) {
                    for (const child of node.children) {
                        const childPath = path ? `${path} > ${child.name}` : child.name;
                        extractTexts(child, childPath);
                    }
                }
            }
            
            // Process all nodes
            for (const nodeId in nodes) {
                const nodeData = nodes[nodeId];
                if (nodeData.document) {
                    extractTexts(nodeData.document);
                }
            }
            
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        summary: {
                            totalTexts: texts.length,
                            uniqueFonts: [...new Set(texts.map(t => t.style.fontFamily).filter(Boolean))],
                            uniqueFontSizes: [...new Set(texts.map(t => t.style.fontSize).filter(Boolean))].sort((a, b) => a - b),
                            uniqueColors: [...new Set(texts.map(t => t.style.color ? `rgb(${t.style.color.r},${t.style.color.g},${t.style.color.b})` : null).filter(Boolean))]
                        },
                        texts: texts
                    }, null, 2)
                }]
            };
            
        } catch (error) {
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, `Failed to extract texts: ${error.message}`);
        }
    }
);

/* batchCompareFigmaFrames - пакетное сравнение множества элементов */
server.registerTool(
    'batchCompareFigmaFrames',
    {
        title: 'Batch Compare Figma Frames',
        description: 'Compare multiple Figma frames with corresponding HTML elements in one operation.',
        inputSchema: {
            figmaToken: z.string().optional().describe('Figma API token'),
            fileKey: z.string().describe('Figma file key'),
            url: z.string().describe('Web page URL to compare'),
            comparisons: z.array(z.object({
                figmaNodeId: z.string().describe('Figma node ID'),
                url: z.string().optional().describe('Page URL (optional, uses last opened page if not provided)'),

                selector: z.string().describe('CSS selector for HTML element'),
                tolerance: z.number().min(0).max(1).optional().describe('Tolerance threshold (0-1)')
            })).describe('Array of comparison pairs')
        }
    },
    async ({ figmaToken, fileKey, url, comparisons }) => {
        const token = figmaToken || FIGMA_TOKEN;
        if (!token) {
            throw new McpError(ErrorCode.InvalidRequest, 'Figma token is required');
        }

        const { page, client } = await createPage();
        
        try {            const results = [];
            let passedCount = 0;
            
            for (const comparison of comparisons) {
                try {
                    // Get Figma image
                    const exportResponse = await fetch(
                        `https://api.figma.com/v1/images/${fileKey}?ids=${comparison.figmaNodeId}&scale=2&format=png`,
                        { headers: { 'X-Figma-Token': token } }
                    );
                    
                    if (!exportResponse.ok) {
                        results.push({
                            figmaNodeId: comparison.figmaNodeId,
                            selector: comparison.selector,
                            error: 'Failed to export Figma frame',
                            passed: false
                        });
                        continue;
                    }
                    
                    const exportData = await exportResponse.json();
                    const imageUrl = exportData.images?.[comparison.figmaNodeId];
                    
                    if (!imageUrl) {
                        results.push({
                            figmaNodeId: comparison.figmaNodeId,
                            selector: comparison.selector,
                            error: 'No image URL from Figma',
                            passed: false
                        });
                        continue;
                    }
                    
                    // Download Figma image
                    const figmaImageResponse = await fetch(imageUrl);
                    const figmaBuffer = await figmaImageResponse.buffer();
                    
                    // Screenshot HTML element
                    const element = await page.$(comparison.selector);
                    if (!element) {
                        results.push({
                            figmaNodeId: comparison.figmaNodeId,
                            selector: comparison.selector,
                            error: `Element not found: ${comparison.selector}`,
                            passed: false
                        });
                        continue;
                    }
                    
                    const elementBuffer = await element.screenshot();
                    
                    // Compare images
                    const [figmaImg, elementImg] = await Promise.all([
                        Jimp.read(figmaBuffer),
                        Jimp.read(elementBuffer)
                    ]);
                    
                    // Resize to same dimensions
                    const width = Math.max(figmaImg.bitmap.width, elementImg.bitmap.width);
                    const height = Math.max(figmaImg.bitmap.height, elementImg.bitmap.height);
                    
                    figmaImg.resize(width, height);
                    elementImg.resize(width, height);
                    
                    // Calculate difference
                    const figmaData = new Uint8ClampedArray(figmaImg.bitmap.data);
                    const elementData = new Uint8ClampedArray(elementImg.bitmap.data);
                    const diffData = new Uint8ClampedArray(width * height * 4);
                    
                    const diffPixels = pixelmatch(figmaData, elementData, diffData, width, height, {
                        threshold: comparison.tolerance || 0.1
                    });
                    
                    const matchScore = 1 - (diffPixels / (width * height));
                    const passed = matchScore >= (1 - (comparison.tolerance || 0.05));
                    
                    if (passed) passedCount++;
                    
                    results.push({
                        figmaNodeId: comparison.figmaNodeId,
                        selector: comparison.selector,
                        matchScore: Math.round(matchScore * 1000) / 10,
                        differencePixels: diffPixels,
                        dimensions: { width, height },
                        passed: passed
                    });
                    
                } catch (error) {
                    results.push({
                        figmaNodeId: comparison.figmaNodeId,
                        selector: comparison.selector,
                        error: error.message,
                        passed: false
                    });
                }
            }
            
            const summary = {
                total: comparisons.length,
                passed: passedCount,
                failed: comparisons.length - passedCount,
                passRate: Math.round((passedCount / comparisons.length) * 100),
                averageScore: results.filter(r => r.matchScore).length > 0 ?
                    Math.round(
                        results.filter(r => r.matchScore).reduce((sum, r) => sum + r.matchScore, 0) / 
                        results.filter(r => r.matchScore).length * 10
                    ) / 10 : 0
            };
            
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ results, summary }, null, 2)
                }]
            };
            
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* -------------------- Execute JavaScript -------------------- */
server.registerTool(
    'executeScript',
    {
        title: 'Execute JavaScript',
        description: 'Execute arbitrary JavaScript code in the page context. Perfect for complex interactions, setting values, triggering events, or any custom page manipulation that other tools cannot handle.',
        inputSchema: {
            // url parameter removed - uses active tab by default,
            script: z.string().describe('JavaScript code to execute in page context'),
            waitAfter: z.number().optional().describe('Milliseconds to wait after execution (default: 500)')
        }
    },
    async ({ url, script, waitAfter = 500 }) => {
        const page = await getPageForOperation(url);
        try {
// Выполняем скрипт
            const result = await page.evaluate((code) => {
                try {
                    // eslint-disable-next-line no-eval
                    const evalResult = eval(code);
                    return { success: true, result: evalResult };
                } catch (error) {
                    return { success: false, error: error.message };
                }
            }, script);

            // Ждем после выполнения
            await new Promise(resolve => setTimeout(resolve, waitAfter));

            // Делаем скриншот после выполнения
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });

            return {
                content: [
                    {
                        type: 'text',
                        text: result.success
                            ? `Script executed successfully. Result: ${JSON.stringify(result.result)}`
                            : `Script execution failed: ${result.error}`
                    },
                    { type: 'image', data: screenshot, mimeType: 'image/png' }
                ]
            };
        } catch (error) {
            throw error;
        }
    }
);

/* -------------------- STDIO запуск -------------------- */
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

// Запускаем сервер
main().catch(console.error);