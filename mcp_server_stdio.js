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
    { name: 'devchrome-mcp', version: '1.0.6' }, // bump для инвалидации кэша в Cursor
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
            'Return outerHTML of the first matched element. If no selector is provided, the <body> element is used.',
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
            'Return computed CSS of the first matched element. If no selector is provided, the <body> element is used.',
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
        title: 'Get Box Model',
        description: 'Return box model & layout metrics for the first matched element.',
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
        title: 'Set Styles',
        description:
            'Dynamically apply inline CSS properties to the first matched element (list of {name,value} pairs).',
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
        title: 'Screenshot Element',
        description: 'Capture PNG of the first matched element with optional padding. Returns an inline image.',
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

/* -------------------- STDIO запуск -------------------- */
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}