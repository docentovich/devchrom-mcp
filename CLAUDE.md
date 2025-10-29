# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a comprehensive MCP (Model Context Protocol) server providing 41+ specialized tools for pixel-perfect design validation, visual regression testing, and Figma-to-browser comparison. Built with advanced computer vision techniques (SSIM analysis, heat maps) and supports CSS modules, design systems, and stakeholder reporting.

**Key Files:**
- `mcp_server.js` (6,365 lines) - Main MCP server with all 41 tool implementations
- `build.js` - Build validation and packaging script
- `package.json` - Dependencies and npm scripts

## Development Commands

```bash
# Start the MCP server
npm start              # Runs: node mcp_server.js
npm run dev            # Same as npm start

# Build and validate
npm run validate       # Syntax check: node -c mcp_server.js
npm run build          # Runs: lint + validate
npm run build:full     # Full build with build.js script
npm run lint           # Currently no linting configured

# Testing
npm test               # Currently no tests configured

# Publishing
npm run prepublishOnly # Pre-publish hook (runs build)
```

## Architecture Overview

### Single Browser, Multiple Pages Pattern

The server uses a single shared browser instance with per-URL page caching for efficiency:

```javascript
// Global browser instance (lines 22-54)
let browserPromise = null;

async function getBrowser() {
    // Connects to remote Chrome via CHROME_REMOTE_URL
    // OR launches local headless Chrome
}

// Page cache (lines 57-147)
const openPages = new Map(); // URL → Page

async function getOrCreatePage(url) {
    // Reuses existing page for same URL
    // Each page has attached CDP client for advanced operations
}
```

**Key Architectural Decisions:**
- Single browser instance (memory efficient)
- Per-URL page caching (reuses tabs for same URLs)
- Chrome DevTools Protocol (CDP) for advanced DOM/CSS operations
- Stdio transport for MCP protocol communication
- Error recovery with intelligent selector suggestions

### Browser Connection Modes (Priority Order)

**NEW in v1.9.0:** Three-tier system with automatic fallback:

1. **Puppeteer Bridge Mode** (Recommended for WSL) - PRIORITY 1
   - Automatically detected at `http://172.25.96.1:9224` or `http://localhost:9224`
   - HTTP API for browser management
   - Runs as Windows Service
   - No manual Chrome management needed

2. **Remote Debug Mode** (Legacy) - PRIORITY 2
   - Set `CHROME_REMOTE_URL=http://172.25.96.1:9223`
   - Requires manual Chrome launch with `--remote-debugging-port`
   - For backward compatibility

3. **Local Mode** (Default) - PRIORITY 3
   - Launches Chromium via Puppeteer automatically
   - Works on all platforms
   - No configuration needed

### Puppeteer Bridge Architecture (NEW v1.9.0)

Located in `bridge/` directory:

```
bridge/
├── puppeteer-bridge.js      # HTTP server managing Puppeteer
├── install-bridge.ps1        # Windows Service installer
├── uninstall-bridge.ps1      # Uninstaller
└── package.json              # Bridge dependencies

scripts/
└── setup-bridge.js           # CLI tool for bridge management
```

**Bridge API Endpoints:**
- `GET /health` - Health check
- `POST /api/browser/launch` - Get or create browser instance
- `POST /api/browser/close` - Close browser
- `GET /api/browser/status` - Get browser status

**CLI Commands:**
- `devchrome-bridge setup` - Install and start bridge
- `devchrome-bridge status` - Check bridge status
- `devchrome-bridge uninstall` - Remove bridge

### MCP Server Registration (Lines 150-257)

```javascript
const server = new McpServer({
    name: 'devchrome-mcp',
    version: '1.8.0'
});

// All 41 tools registered with this pattern:
server.registerTool('toolName', {
    title: 'Human-Readable Title',
    description: 'Detailed description with usage guidance',
    inputSchema: { /* Zod validation schema */ }
}, async (params) => {
    // Handler implementation
    return {
        content: [
            { type: 'text', text: 'Result' },
            { type: 'image', data: base64, mimeType: 'image/png' }
        ]
    };
});
```

## Tool Categories (41 Tools Total)

### 1. Basic Inspection & Navigation (8 tools)
- **ping** - Connection test
- **listChromeTabs, useActiveTab** - Tab management (remote mode)
- **getElement, getElements, getParents** - Element inspection
- **getElementReact, getElementsReact** - CSS modules support for React/Vue

### 2. CSS & Layout Analysis (6 tools)
- **getElementComputedCss** - Computed styles analysis
- **getBoxModel** - Box model measurements
- **getElementListeners** - Event handlers
- **setStyles** - Live CSS editing
- **measureElement** - Precise measurements

### 3. Visual Comparison (6 tools)
- **compareVisualAdvanced** ⭐ - SSIM + heat maps (PRIMARY)
- **compareVisual** - Basic pixel comparison
- **analyzeColorDifferences** - Color palette analysis
- **createVisualDiff** - Annotated screenshots
- **screenshot** - Element screenshots
- **compareWithTolerance** - Configurable tolerance

### 4. Figma Integration (7 tools)
- **compareFigmaToElement** ⭐ - Design vs implementation (GOLD STANDARD)
- **getFigmaFrame** - Export frame as PNG
- **getFigmaSpecs** - Extract design tokens
- **extractFigmaTexts** - Get all texts with styles
- **batchCompareFigmaFrames** - Batch comparison
- **exportFigmaFrame, downloadFigmaImage** - Alternative exports

### 5. Detailed Design Analysis (4 tools)
- **compareFonts** - Typography analysis
- **compareSpacing** - Margin/padding validation
- **compareLayout** - Flexbox/Grid analysis
- **validateDesignSystem** - Design system compliance

### 6. Semantic & Structure (4 tools)
- **analyzeStructure** - DOM hierarchy analysis
- **validateHierarchy** - Component composition
- **verifyInteractions** - Interactive element testing
- **validateHTML** - HTML validation

### 7. Performance & Quality (3 tools)
- **getPerformanceMetrics** - Core Web Vitals
- **getAccessibility** - WCAG compliance
- **getViewport, setViewport** - Viewport management

### 8. Interaction (3 tools)
- **click, hover, scrollTo** - User interaction simulation

### 9. AI & Reporting (3 tools)
- **generateAIPrompt** - Context-aware prompts
- **generateComparisonReport** - Stakeholder reports
- **executeScript** - Arbitrary JavaScript execution

## Key Implementation Patterns

### Pattern 1: Error Handling with Suggestions

When selectors fail, the server provides intelligent suggestions:

```javascript
// Lines 600-700: resolveNodeId function
if (!nodeId) {
    const suggestions = await findSimilarSelectors(client, selector);
    throw new Error(`Selector not found: ${selector}\n\n${suggestions}`);
}
```

### Pattern 2: CSS Modules Support

Handles React/Vue CSS modules automatically:

```javascript
// getElementReact tries multiple patterns:
// 1. [class*="ComponentName"][class*="className"]
// 2. [class*="className"]
// 3. Attribute matching with wildcard
```

**Example:**
```javascript
// Instead of failing with: .Button_primary (not found)
// Automatically finds: Button_primary_abc123
getElementReact(url, "primary", "Button")
```

### Pattern 3: SSIM Visual Comparison

Solves the "95% problem" where basic pixel comparison reports "95% match" but differences remain visible:

```javascript
// Lines 2500-2800: calculateSSIM function
function calculateSSIM(img1Data, img2Data, width, height) {
    // Structural Similarity Index Measurement
    // - Divides images into 8x8 windows
    // - Calculates mean, variance, covariance per window
    // - Returns 0.0-1.0 similarity score

    // SSIM > 0.95: Excellent match
    // SSIM 0.85-0.95: Good match, minor differences
    // SSIM 0.70-0.85: Moderate differences
    // SSIM < 0.70: Significant structural differences
}
```

### Pattern 4: Figma API Integration

```javascript
async function fetchFigmaAPI(endpoint, figmaToken) {
    const token = figmaToken || process.env.FIGMA_TOKEN;
    const response = await fetch(`https://api.figma.com/v1/${endpoint}`, {
        headers: { 'X-Figma-Token': token }
    });
    return response.json();
}

// Usage patterns:
// 1. Get frame data: fetchFigmaAPI(`files/${fileKey}`, token)
// 2. Export images: fetchFigmaAPI(`images/${fileKey}?ids=${nodeId}&scale=2`, token)
// 3. Get styles: fetchFigmaAPI(`files/${fileKey}/nodes?ids=${nodeId}`, token)
```

### Pattern 5: Page Evaluation vs CDP

Two approaches to interact with browser:

```javascript
// Method 1: JavaScript evaluation (browser context)
const result = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    return el.getBoundingClientRect();
}, selector);

// Method 2: Chrome DevTools Protocol (inspector context)
const client = page._cdpClient;
const { computedStyle } = await client.send('CSS.getComputedStyleForNode', {
    nodeId
});
```

**When to use each:**
- **page.evaluate()**: Simple browser operations, fast
- **CDP**: Complex DOM/CSS inspection, more powerful

## Dependencies and Their Purposes

- **@modelcontextprotocol/sdk** (^1.17.1) - MCP protocol (McpServer, StdioServerTransport)
- **puppeteer** (^24.15.0) - Browser automation and CDP access
- **zod** (^3.25.76) - Input parameter validation
- **jimp** (^0.22.12) - Image processing and manipulation
- **pixelmatch** (^5.3.0) - Pixel-level image comparison
- **node-fetch** (^3.3.2) - Figma API HTTP client
- **express** (^5.1.0) - Web server capabilities (if needed)
- **cors** (^2.8.5) - CORS support

## Configuration & Environment Variables

### Environment Variables

```bash
# Figma API integration
FIGMA_TOKEN=your_figma_api_token

# Chrome remote debugging (for WSL/Docker scenarios)
CHROME_REMOTE_URL=http://172.25.96.1:9223
# OR WebSocket endpoint:
CHROME_REMOTE_URL=ws://localhost:9222/devtools/browser/abc123
```

### Claude Code Permissions

Defined in `.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run validate:*)",
      "mcp__devchrome__ping",
      "mcp__devchrome__getFigmaSpecs",
      // ... more specific permissions
    ]
  }
}
```

## Advanced Capabilities

### The "95% Problem" Solution

This system specifically addresses the common issue where basic visual comparison reports "95% match" but significant differences remain visible. Using SSIM structural analysis and tolerance-based comparison, it catches subtle differences in:
- Font rendering variations across systems
- Sub-pixel positioning differences
- Color space and gradient inconsistencies
- CSS module class name transformations
- Design system token compliance

### Tolerance-Based Validation

Real-world flexibility for production environments:
- Browser rendering differences (Chrome vs Firefox vs Safari)
- Font rendering variations (Mac vs Windows vs Linux)
- Development vs production environment differences
- CI/CD automated validation gates

### AI-Driven Workflow

The `generateAIPrompt` tool creates context-aware prompts based on page analysis:
- Analyzes DOM structure, forms, interactive elements, media
- Generates different prompt types (bug-report, code-review, test-generation, accessibility-audit, performance-analysis, design-review, content-review, seo-analysis, custom)
- Supports markdown/JSON/text output

## Decision-Making Guide for AI Agents

**Scenario A: "Design doesn't match Figma"**
1. `getFigmaFrame()` - Get design reference
2. `compareFigmaToElement()` - Direct comparison
3. If differences > 5%: `compareVisualAdvanced()` - Heat map analysis
4. For specific issues: `compareFonts()`, `compareSpacing()`, `analyzeColorDifferences()`

**Scenario B: "CSS modules not working"**
1. Try `getElement()` first
2. If fails: `getElementReact()` - CSS module patterns
3. Use `getElementsReact()` for multiple matches

**Scenario C: "95% match but still looks different"**
1. `compareVisualAdvanced()` - Get SSIM structural similarity
2. If SSIM < 0.9: `analyzeColorDifferences()` - Palette analysis
3. `compareWithTolerance()` - Strict settings (colorDelta: 5)
4. `compareFonts()` - Catch subtle font rendering differences

**Scenario D: "Responsive design issues"**
1. `setViewport()` - Target breakpoint
2. `screenshot()` - Documentation
3. `compareSpacing()` - Check spacing adaptation
4. `getPerformanceMetrics()` - Ensure performance

## Adding New Tools (Development Guide)

When adding new tools, follow this template:

```javascript
server.registerTool(
    'newToolName',
    {
        title: 'Human-Readable Title',
        description: 'Detailed description with use cases',
        inputSchema: {
            url: z.string().url().optional().describe('URL (optional)'),
            selector: z.string().describe('CSS selector'),
            // ... other parameters
        }
    },
    async ({ url, selector, ...params }) => {
        const page = await getPageForOperation(url);
        try {
            const client = page._cdpClient || await page.target().createCDPSession();

            // Implement tool logic
            const result = await performAnalysis(page, selector);

            return {
                content: [
                    { type: 'text', text: JSON.stringify(result, null, 2) },
                    { type: 'image', data: base64Image, mimeType: 'image/png' }
                ]
            };
        } catch (error) {
            throw new McpError(ErrorCode.InvalidRequest, error.message);
        }
    }
);
```

**Checklist:**
1. Define Zod schema for input validation
2. Use `getPageForOperation()` for URL handling
3. Attach CDP client if using DOM/CSS inspection
4. Return structured content with text and images
5. Implement error handling with helpful messages
6. Clean up resources in finally blocks if creating temp pages

## Performance Considerations

### Optimization Patterns

1. **Page Caching**: Reuses pages for same URL instead of creating new ones
2. **Selective CDP Usage**: Only enables CDP protocols when needed
3. **Batch Operations**: Multiple comparisons on same page avoid navigation overhead
4. **Image Processing**: Uses Jimp for efficient image manipulation
5. **Lazy Evaluation**: page.evaluate() for simple operations vs CDP for complex DOM

### Performance Tips

- `compareVisualAdvanced` is slower but more accurate (use for final validation)
- `getElementReact` is faster than CSS module pattern matching
- Batch similar operations (multiple screenshots on same page)
- Use tolerant comparison for development, strict for production

## WSL-Specific Considerations

When running in WSL environment:

1. **Chrome must run on Windows host** (not in WSL)
2. **Use remote debugging**: Set `CHROME_REMOTE_URL=http://172.25.96.1:9223`
3. **Port forwarding required**: Use helper scripts from `~/.claude/scripts/`
4. **Access dev servers via Windows IP**: `http://172.25.96.1:<PORT>`

See `WSL_SETUP_GUIDE.md` for detailed setup instructions.

## Troubleshooting

### "Failed to connect" error

```bash
# Solution for local development:
cd /path/to/devchrome-mcp
npm install
npm link
claude mcp add devchrome npx devchrome-mcp
claude mcp list  # Should show ✓ Connected
```

### New tools not visible

```bash
# Reinstall package and update MCP
npm uninstall -g devchrome-mcp
npm install -g devchrome-mcp
npm link
claude mcp remove devchrome
claude mcp add devchrome npx devchrome-mcp
```

### Puppeteer issues

```bash
# Reinstall with forced Chrome download
npm uninstall -g devchrome-mcp
npm install -g devchrome-mcp --force
npm link
```

## Key Innovation

This MCP server solves three critical problems:

1. **The "95% Problem"**: Using SSIM structural analysis to catch differences that basic pixel comparison misses
2. **CSS Modules Challenge**: Automatic pattern matching for React/Vue apps with hashed class names
3. **Designer-Developer Disconnect**: Direct Figma-to-browser comparison eliminating manual verification

**Best for:**
- Design system validation
- Pixel-perfect layout testing
- Figma design-to-code verification
- Visual regression testing
- AI-driven web page analysis and testing
