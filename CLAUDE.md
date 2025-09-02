# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a comprehensive MCP (Model Context Protocol) server providing 33+ specialized tools for pixel-perfect design validation, visual regression testing, and Figma-to-browser comparison. Built with advanced computer vision techniques (SSIM analysis, heat maps) and supports CSS modules, design systems, and stakeholder reporting.

## Development Commands

```bash
# Start the MCP server
npm start
npm run dev

# Build and validate
npm run build          # Runs lint and validate
npm run build:full     # Full build with build.js script
npm run validate       # Syntax validation only
npm run lint           # Currently no linting configured

# Testing
npm test               # Currently no tests configured

# Publishing
npm run prepublishOnly # Runs build before publishing
```

## Architecture

### Core Components

- **mcp_server.js** - Main MCP server implementation with 18 tools
- **mcp_server_stdio.js** - Alternative stdio transport (if exists)
- **build.js** - Build script for packaging

### Browser Management
- Single shared browser instance using `getBrowser()` and `createPage()`
- Chrome DevTools Protocol integration for advanced DOM/CSS operations
- Graceful error handling with detailed selector suggestions

### Tool Categories

#### Core Diagnostics & Element Finding
- **ping, getElement, getElements, getParents** - Basic element inspection
- **getElementReact, getElementsReact** - CSS modules support for React/Vue apps
- **getElementComputedCss, setStyles, getBoxModel** - CSS analysis and debugging

#### Advanced Visual Comparison
- **compareVisualAdvanced** ⭐ - SSIM analysis, heat maps, pixel-perfect detection
- **analyzeColorDifferences** - Color palette and theme analysis
- **compareVisual** - Legacy basic comparison (use Advanced instead)

#### Figma Integration
- **getFigmaFrame** - Export frames from Figma API
- **compareFigmaToElement** ⭐ - Direct design-vs-implementation comparison
- **getFigmaSpecs** - Extract design tokens (colors, fonts, spacing)

#### Detailed Design Analysis  
- **compareFonts** - Typography analysis (sizes, weights, families)
- **compareSpacing** - Margin/padding pixel-perfect validation
- **compareLayout** - Flexbox/Grid positioning analysis
- **measureElement** - Precise element measurements

#### Tolerant & Smart Comparison
- **compareWithTolerance** - Configurable tolerance for real-world scenarios
- **validateDesignSystem** - Design system tokens compliance

#### Semantic & Structure Analysis
- **analyzeStructure** - DOM hierarchy and semantic HTML validation
- **validateHierarchy** - Component composition validation
- **verifyInteractions** - Interactive elements and accessibility testing

#### Comprehensive Reporting
- **generateComparisonReport** - Executive/stakeholder-ready reports
- **createVisualDiff** - Annotated screenshots for feedback

#### Legacy Tools (Still Available)
- **Viewport**: getViewport, setViewport
- **Interactions**: hover, click, scrollTo, getElementListeners
- **Performance**: getPerformanceMetrics
- **Quality Assurance**: validateHTML, getAccessibility

### Key Features

- **Advanced Computer Vision**: SSIM structural similarity, pixel-level heat maps
- **CSS Modules Intelligence**: Automatic pattern matching for React/Vue apps
- **Design System Integration**: Figma API, design tokens validation
- **Tolerance-Based Validation**: Smart comparison for real-world development
- **Comprehensive Reporting**: Stakeholder-ready analysis with visual evidence
- **Semantic Analysis**: DOM structure and accessibility compliance
- **Performance Monitoring**: Core Web Vitals and optimization insights

## MCP Integration

The server registers tools with descriptive schemas and implements the MCP protocol for communication with AI agents like Claude Code. Tools return structured content including text, JSON, and images.

## Dependencies

- **@modelcontextprotocol/sdk**: MCP protocol implementation
- **puppeteer**: Browser automation and Chrome DevTools Protocol
- **zod**: Schema validation
- **jimp**: Advanced image processing and manipulation
- **pixelmatch**: Pixel-level image comparison
- **node-fetch**: Figma API integration
- **express**: Web server capabilities  
- **cors**: Cross-origin resource sharing

## Advanced Capabilities

### The "95% Problem" Solution
This system specifically addresses the common issue where basic visual comparison reports "95% match" but significant differences remain visible. Using SSIM structural analysis and tolerance-based comparison, it catches subtle differences in:
- Font rendering variations across systems
- Sub-pixel positioning differences  
- Color space and gradient inconsistencies
- CSS module class name transformations
- Design system token compliance

### CSS Modules Support  
Intelligent pattern matching for modern React/Vue applications:
```javascript
// Instead of failing with: .someClass (not found)
// Automatically finds: Component_someClass_abc123
getElementReact(url, "someClass", "Component")
```

### Figma Integration
Direct design-to-implementation validation:
```javascript
// Compare Figma frame directly with browser element
compareFigmaToElement(figmaToken, fileKey, nodeId, url, selector)
```

### Tolerance-Based Validation
Real-world flexibility for production environments:
- Browser rendering differences (Chrome vs Firefox vs Safari)
- Font rendering variations (Mac vs Windows vs Linux)  
- Development vs production environment differences
- CI/CD automated validation gates

## Error Handling

Comprehensive error handling with intelligent suggestions:
- CSS module pattern suggestions when selectors fail
- Alternative element recommendations
- Figma API error recovery and fallbacks
- Resource cleanup and memory management
- Graceful degradation for missing dependencies