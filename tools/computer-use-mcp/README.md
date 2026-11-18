# Graviton Computer Use MCP

For the local macOS package, setup, approvals and manual acceptance checklist see [MACOS.md](MACOS.md).

## Build from source

On macOS 14+ with Swift 5.9+, Node 22+ and Bun 1.3+ (packaging only):

```sh
cd tools/computer-use-mcp
npm ci
npm run build
npm test
npm run package:mac
```

The TypeScript MCP server uses the official SDK. Swift owns app selection, the native approval UI, Accessibility, scoped input and ScreenCaptureKit. The two processes communicate using private newline-delimited JSON. No extracted Sky files are used. The local archive contains a standalone MCP executable and a separate ad-hoc-signed helper app. For development, `node dist/index.js` uses `.build/release/graviton-computer-use`; the old `--app-bundle-id` is only an initial preference, not consent. The package uses neither the checkout nor a system Node installation.
