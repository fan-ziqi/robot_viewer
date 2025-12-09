import { defineConfig } from 'vite';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read package.json to get version number
const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));
const version = packageJson.version;

// Load .env file to get backend port
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf8');
        const envVars = {};
        envContent.split('\n').forEach(line => {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                const [key, ...valueParts] = line.split('=');
                if (key && valueParts.length > 0) {
                    envVars[key.trim()] = valueParts.join('=').trim();
                }
            }
        });
        return envVars;
    }
    return {};
}

const env = loadEnv();
const backendPort = env.BACKEND_PORT || process.env.BACKEND_PORT || '3002';

// Vite plugin: replace version placeholder in HTML
function versionPlugin() {
  return {
    name: 'version-plugin',
    transformIndexHtml(html) {
      return html.replace(/Robot Viewer v\d+\.\d+\.\d+/g, `Robot Viewer v${version}`);
    }
  };
}

export default defineConfig({
  // Use relative paths, support file:// protocol and arbitrary deployment paths
  base: './',
  // Define global constants
  define: {
    '__APP_VERSION__': JSON.stringify(version),
    '__BACKEND_PORT__': JSON.stringify(backendPort)
  },
  plugins: [
    versionPlugin(),
    // USD iframe headers plugin
    {
      name: 'configure-usd-iframe-headers',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // Set COEP/COOP headers for all USD-related pages and resources
          if (req.url?.includes('usd-iframe.html') ||
              req.url?.includes('usd-viewer/') ||
              req.url?.includes('usd.html')) {
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          }
          next();
        });
      }
    }
  ],
  server: {
    port: 3000,
    open: true,
    hmr: {
      overlay: false
    },
    // SharedArrayBuffer requires these headers (for USD WASM)
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    // Use environment variable configuration, use default values if not set
    allowedHosts: process.env.VITE_ALLOWED_HOSTS?.split(',') || [
      'viewer.robotsfan.com',
      'localhost',
      '127.0.0.1'
    ]
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // Code splitting optimization
    rollupOptions: {
      output: {
        // Manual chunking strategy
        manualChunks: {
          // Bundle Three.js separately
          'three': ['three'],
          // Bundle CodeMirror related packages
          'codemirror': [
            'codemirror',
            '@codemirror/autocomplete',
            '@codemirror/commands',
            '@codemirror/lang-xml',
            '@codemirror/search',
            '@codemirror/state',
            '@codemirror/view'
          ],
          // Bundle CodeMirror themes
          'codemirror-themes': [
            '@uiw/codemirror-theme-dracula',
            '@uiw/codemirror-theme-github',
            '@uiw/codemirror-theme-vscode'
          ],
          // Bundle d3 separately
          'd3': ['d3']
        },
        // File naming rules
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name.split('.');
          const ext = info[info.length - 1];
          if (/\.(mp4|webm|ogg|mp3|wav|flac|aac)(\?.*)?$/i.test(assetInfo.name)) {
            return `assets/media/[name]-[hash].[ext]`;
          }
          if (/\.(png|jpe?g|gif|svg|webp|avif)(\?.*)?$/i.test(assetInfo.name)) {
            return `assets/img/[name]-[hash].[ext]`;
          }
          if (/\.(woff2?|eot|ttf|otf)(\?.*)?$/i.test(assetInfo.name)) {
            return `assets/fonts/[name]-[hash].[ext]`;
          }
          return `assets/${ext}/[name]-[hash].[ext]`;
        }
      }
    },
    // Compression configuration
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true, // Remove console in production
        drop_debugger: true
      }
    },
    // Asset inline limit (assets smaller than 4kb are inlined as base64)
    assetsInlineLimit: 4096,
    // Enable CSS code splitting
    cssCodeSplit: true,
    // Generate source map (can be disabled in production to reduce size)
    sourcemap: false,
    // Enable gzip compressed size report
    reportCompressedSize: true,
    // Chunk size warning limit (500kb)
    chunkSizeWarningLimit: 1000
  },
  optimizeDeps: {
    exclude: ['urdf-loader'],
    force: true
  },
  esbuild: {
    target: 'es2020',
    charset: 'utf8'
  },
  clearScreen: false
});

