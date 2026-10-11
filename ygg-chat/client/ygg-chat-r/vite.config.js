import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { defineConfig } from 'vite';
// Module ids an entry reaches through static imports only. Built once per bundle on the
// first manualChunks call (the module graph is complete by then) and reset per build.
var staticallyReachable = null;
function isStaticallyReachable(id, graph) {
    var _a, _b;
    if (!staticallyReachable) {
        var reached = new Set();
        var queue = [];
        for (var _i = 0, _c = Array.from(graph.getModuleIds()); _i < _c.length; _i++) {
            var moduleId = _c[_i];
            if ((_a = graph.getModuleInfo(moduleId)) === null || _a === void 0 ? void 0 : _a.isEntry) {
                reached.add(moduleId);
                queue.push(moduleId);
            }
        }
        while (queue.length > 0) {
            var info = graph.getModuleInfo(queue.pop());
            for (var _d = 0, _e = (_b = info === null || info === void 0 ? void 0 : info.importedIds) !== null && _b !== void 0 ? _b : []; _d < _e.length; _d++) {
                var importedId = _e[_d];
                if (!reached.has(importedId)) {
                    reached.add(importedId);
                    queue.push(importedId);
                }
            }
        }
        staticallyReachable = reached;
    }
    return staticallyReachable.has(id);
}
// https://vite.dev/config/
export default defineConfig(function () {
    var buildTarget = process.env.BUILD_TARGET || 'local';
    var isElectron = buildTarget === 'electron';
    var isWeb = buildTarget === 'web';
    var isStandalone = buildTarget === 'standalone';
    // Standalone browser target: the dev proxy forwards /api and the WebSocket
    // paths to the standalone Ygg server (start it with `npm run start:server`).
    var standaloneServerTarget = process.env.YGG_SERVER_PROXY_TARGET || 'http://127.0.0.1:3002';
    var devProxy = isStandalone
        ? {
            '/api': {
                target: standaloneServerTarget,
                changeOrigin: true,
                secure: false,
            },
            '/lsp': {
                target: standaloneServerTarget,
                changeOrigin: true,
                secure: false,
                ws: true,
            },
            '/ide-context': {
                target: standaloneServerTarget,
                changeOrigin: true,
                secure: false,
                ws: true,
            },
        }
        : {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
                secure: false,
            },
        };
    return {
        // Use relative paths for Electron (file:// protocol requires ./ instead of /)
        base: isElectron ? './' : '/',
        plugins: [
            react(),
            tailwindcss(),
            {
                name: 'ygg-reset-static-reach',
                buildStart: function () {
                    staticallyReachable = null;
                },
            },
        ],
        // Define compile-time constants for conditional code
        define: {
            __BUILD_TARGET__: JSON.stringify(buildTarget),
            __IS_ELECTRON__: JSON.stringify(isElectron),
            __IS_WEB__: JSON.stringify(isWeb),
            __IS_LOCAL__: JSON.stringify(buildTarget === 'local'),
            __YGG_CODEX_DEV_LOGS__: JSON.stringify(/^(1|true|yes|on)$/i.test(process.env.YGG_CODEX_DEV_LOGS || '')),
        },
        // Resolve aliases for cleaner imports
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
                '@shared': path.resolve(__dirname, '../../shared'),
            },
        },
        // Build configuration
        build: {
            outDir: isElectron ? 'dist-electron' : 'dist',
            sourcemap: false,
            rollupOptions: {
                output: {
                    // Code-split by feature for tree-shaking
                    manualChunks: function (id, graph) {
                        // Separate Stripe code (tree-shaken in electron build)
                        if (id.includes('@stripe/stripe-js') || id.includes('stripe')) {
                            return 'stripe';
                        }
                        if (!id.includes('node_modules')) {
                            return undefined;
                        }
                        // A dependency that only an import() reaches (Mermaid, Monaco, ...) must not
                        // be forced into the eager vendor chunk. Left to Rollup, it lands in a chunk
                        // that loads with that import().
                        if (!isStaticallyReachable(id, graph)) {
                            return undefined;
                        }
                        // Don't separate Supabase - it causes circular dependency issues
                        // when loaded via file:// protocol in Electron
                        // Vendor chunk for common deps (includes Supabase)
                        return 'vendor';
                    },
                },
            },
        },
        // Server config
        server: {
            port: 5173,
            proxy: devProxy,
        },
    };
});
