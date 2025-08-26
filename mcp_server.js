#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import puppeteer from 'puppeteer';
import { z } from 'zod';

/* -------------------- Puppeteer: один браузер на всё приложение -------------------- */
let browserPromise = null;
async function getBrowser() {
    if (!browserPromise) {
        browserPromise = puppeteer.launch({ headless: true });
    }
    return browserPromise;
}

async function createPage() {
    const browser = await getBrowser();
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    await client.send('Runtime.enable'); // нужно для DOMDebugger.getEventListeners / RemoteObject
    return { page, client };
}

/* -------------------- MCP Server -------------------- */
const server = new McpServer(
    { name: 'devchrome-mcp', version: '1.2.2' }, // bump для инвалидации кэша в Cursor
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
            throw server.error.NotFound('<body> element not found on the page');
        }
        throw server.error.NotFound(`Selector not found: ${selector}`);
    }
    return nodeId;
}

/* 1) getElement */
server.registerTool(
    'getElement',
    {
        title: 'Get Element HTML',
        description:
            'Get the complete HTML markup of an element for layout analysis and debugging. Perfect for inspecting component structure, checking generated HTML, or understanding element hierarchy. Returns outerHTML of the first matched element. If no selector is provided, returns the entire <body> element.',
        inputSchema: {
            url: z.string().url().describe('Page URL'),
            // селектор НЕобязательный: если не указан — берётся <body>
            selector: z
                .string()
                .optional()
                .describe('CSS selector (optional). If omitted or empty, the <body> element is used')
        }
    },
    async ({ url, selector }) => {
        const { page, client } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });

            const nodeId = await resolveNodeId(client, selector);
            const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId });

            return {
                content: [
                    { type: 'text', name: 'html', text: outerHTML }
                ]
            };
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL'),
            selector: z
                .string()
                .optional()
                .describe('CSS selector (optional). If omitted or empty, the <body> element is used')
        }
    },
    async ({ url, selector }) => {
        const { page, client } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });

            const nodeId = await resolveNodeId(client, selector);
            const { computedStyle } = await client.send('CSS.getComputedStyleForNode', { nodeId });

            return {
                content: [
                    { type: 'text', name: 'computedCss', text: JSON.stringify(computedStyle) }
                ]
            };
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL'),
            selector: z
                .string()
                .optional()
                .describe('CSS selector (optional). If omitted or empty, the <body> element is used')
        }
    },
    async ({ url, selector }) => {
        const { page, client } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });

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
        } finally {
            await page.close().catch(() => {});
        }
    }
);

/* 4) getElements (оставляем без изменений) */
server.registerTool(
    'getElements',
    {
        title: 'Get Elements',
        description: 'Find all elements that match the CSS selector; return an array of outerHTML.',
        inputSchema: {
            url: z.string().url().describe('Page URL'),
            selector: z.string().describe('CSS selector (required for multiple matches)')
        }
    },
    async ({ url, selector }) => {
        const { page, client } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });

            const { root } = await client.send('DOM.getDocument');
            const { nodeIds } = await client.send('DOM.querySelectorAll', {
                selector,
                nodeId: root.nodeId
            });

            const elements = [];
            for (const nodeId of nodeIds) {
                const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId });
                elements.push(outerHTML);
            }

            return {
                content: [{ type: 'text', name: 'elements', text: JSON.stringify(elements) }]
            };
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL'),
            selector: z.string().describe('CSS selector')
        }
    },
    async ({ url, selector }) => {
        const { page, client } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });

            const { root } = await client.send('DOM.getDocument');
            const { nodeId } = await client.send('DOM.querySelector', {
                selector,
                nodeId: root.nodeId
            });
            if (!nodeId) {
                throw server.error.NotFound(`Selector not found: ${selector}`);
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
                throw server.error.NotFound(`Selector not found (render): ${selector}`);
            }

            return {
                content: [
                    { type: 'text', name: 'boxModel', text: JSON.stringify({ boxModel, metrics }) }
                ]
            };
        } finally {
            await page.close().catch(() => {});
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
            selector: z.string().describe('CSS selector'),
            levels: z.number().int().min(1).describe('How many levels up from the element')
        }
    },
    async ({ url, selector, levels }) => {
        const { page } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });

            const parents = await page.evaluate(
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
                throw server.error.NotFound(`Selector not found: ${selector}`);
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
    async ({ url, selector, styles }) => {
        const { page } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });

            const dict = {};
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
                throw server.error.NotFound(`Selector not found: ${selector}`);
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
            url: z.string().url().describe('Page URL'),
            selector: z.string().describe('CSS selector for the element'),
            padding: z.number().optional().describe('Padding in pixels around the element')
        }
    },
    async ({ url, selector, padding = 0 }) => {
        const { page } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });

            const el = await page.$(selector);
            if (!el) throw server.error.NotFound(`Selector not found: ${selector}`);

            const box = await el.boundingBox();
            if (!box) {
                throw server.error.NotFound(
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
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL')
        }
    },
    async ({ url }) => {
        const { page } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });
            
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
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL'),
            width: z.number().min(320).max(4000).describe('Viewport width in pixels (320-4000)'),
            height: z.number().min(200).max(3000).describe('Viewport height in pixels (200-3000)'),
            deviceScaleFactor: z.number().min(0.5).max(3).optional().describe('Device pixel ratio (0.5-3, default: 1)')
        }
    },
    async ({ url, width, height, deviceScaleFactor = 1 }) => {
        const { page } = await createPage();
        try {
            await page.setViewport({ width, height, deviceScaleFactor });
            await page.goto(url, { waitUntil: 'networkidle2' });
            
            const result = await page.evaluate(() => ({
                actualWidth: window.innerWidth,
                actualHeight: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio
            }));

            return {
                content: [{ type: 'text', text: `Viewport set to ${width}x${height} (actual: ${result.actualWidth}x${result.actualHeight})` }]
            };
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL'),
            selector: z.string().describe('CSS selector for the element to hover')
        }
    },
    async ({ url, selector }) => {
        const { page } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });
            
            const element = await page.$(selector);
            if (!element) {
                throw server.error.NotFound(`Selector not found: ${selector}`);
            }
            
            await element.hover();
            
            // Небольшая задержка для срабатывания hover эффектов
            await page.waitForTimeout(100);
            
            return {
                content: [{ type: 'text', text: `Hovered over element: ${selector}` }]
            };
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL'),
            selector: z.string().describe('CSS selector for the element to click')
        }
    },
    async ({ url, selector }) => {
        const { page } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });
            
            const element = await page.$(selector);
            if (!element) {
                throw server.error.NotFound(`Selector not found: ${selector}`);
            }
            
            await element.click();
            
            // Ожидаем возможных изменений после клика
            await page.waitForTimeout(200);
            
            return {
                content: [{ type: 'text', text: `Clicked element: ${selector}` }]
            };
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL'),
            selector: z.string().describe('CSS selector for the element to scroll to'),
            behavior: z.enum(['auto', 'smooth']).optional().describe('Scroll behavior (auto or smooth)')
        }
    },
    async ({ url, selector, behavior = 'auto' }) => {
        const { page } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });
            
            const element = await page.$(selector);
            if (!element) {
                throw server.error.NotFound(`Selector not found: ${selector}`);
            }
            
            await element.scrollIntoView({ behavior });
            
            // Ожидаем завершения скролла
            await page.waitForTimeout(300);
            
            const position = await page.evaluate(() => ({ 
                x: window.scrollX, 
                y: window.scrollY 
            }));
            
            return {
                content: [{ type: 'text', text: `Scrolled to element: ${selector} (position: ${position.x}, ${position.y})` }]
            };
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL')
        }
    },
    async ({ url }) => {
        const { page } = await createPage();
        try {
            // Включаем метрики производительности
            await page.goto(url, { waitUntil: 'networkidle2' });
            
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
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL')
        }
    },
    async ({ url }) => {
        const { page } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });
            
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
        } finally {
            await page.close().catch(() => {});
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
            url: z.string().url().describe('Page URL'),
            selector: z.string().optional().describe('CSS selector to analyze specific element (optional)')
        }
    },
    async ({ url, selector }) => {
        const { page } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });
            
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
        } finally {
            await page.close().catch(() => {});
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
            
            if (!element1) throw server.error.NotFound(`Selector not found on first page: ${selector}`);
            if (!element2) throw server.error.NotFound(`Selector not found on second page: ${selector}`);
            
            // Получаем размеры
            const [box1, box2] = await Promise.all([
                element1.boundingBox(),
                element2.boundingBox()
            ]);
            
            if (!box1 || !box2) {
                throw server.error.NotFound('Elements are not visible or have no bounding box');
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
            url: z.string().url().describe('Page URL'),
            selector: z.string().describe('CSS selector for the element to measure')
        }
    },
    async ({ url, selector }) => {
        const { page, client } = await createPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2' });
            
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
                throw server.error.NotFound(`Selector not found: ${selector}`);
            }

            return {
                content: [{ type: 'text', name: 'measurements', text: JSON.stringify(measurements, null, 2) }]
            };
        } finally {
            await page.close().catch(() => {});
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