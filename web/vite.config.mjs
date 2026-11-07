// Vite config for RapidRAW Web (the browser build of the RapidRAW frontend).
//
// The React app in ../src is reused unchanged: every Tauri API module it imports
// is aliased to a browser implementation in ./src/shims, and the backend
// commands are served by ./src/backend (WebAssembly core + WebGPU renderer).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// Progressive Web App files: lets phones install RapidRAW Web to the home screen
// and caches the (large) WebAssembly/JS bundles for fast, offline-capable starts.
const manifest = {
  name: 'RapidRAW Web',
  short_name: 'RapidRAW',
  description: 'Non-destructive, GPU-accelerated RAW photo editor in your browser.',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'any',
  background_color: '#121212',
  theme_color: '#121212',
  icons: [
    { src: 'icons/icon-256.png', sizes: '256x256', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
const pwaFiles = () => ({
  'manifest.webmanifest': JSON.stringify(manifest, null, 2),
  'sw.js': readFileSync(here('./src/sw.js'), 'utf8'),
  'icons/icon-512.png': readFileSync(here('../src-tauri/icons/icon.png')),
  'icons/icon-256.png': readFileSync(here('../src-tauri/icons/128x128@2x.png')),
});
function pwa() {
  return {
    name: 'rapidraw-web-pwa',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const files = pwaFiles();
        const key = (req.url || '').split('?')[0].replace(/^\//, '');
        if (!(key in files)) return next();
        const type = key.endsWith('.png')
          ? 'image/png'
          : key.endsWith('.js')
            ? 'text/javascript'
            : 'application/manifest+json';
        res.setHeader('Content-Type', type);
        res.end(files[key]);
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(pwaFiles())) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
// The theme splash images use root-absolute URLs; make them follow `base` so the
// app also works when hosted under a sub-path (e.g. GitHub Pages /RapidRAW/).
function basePublicUrls() {
  return {
    name: 'rapidraw-web-base-public-urls',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/utils/themes.ts')) return null;
      return code.replace(/(['"`])\/(splash-[a-z]+\.jpg)\1/g, "import.meta.env.BASE_URL + '$2'");
    },
  };
}
const shim = (name) => here(`./src/shims/${name}.ts`);

export default defineConfig({
  root: here('.'),
  publicDir: here('../public'),
  base: process.env.RAPIDRAW_WEB_BASE || '/',
  plugins: [tailwindcss(), react(), pwa(), basePublicUrls()],
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: shim('tauri-core') },
      { find: /^@tauri-apps\/api\/event$/, replacement: shim('tauri-event') },
      { find: /^@tauri-apps\/api\/window$/, replacement: shim('tauri-window') },
      { find: /^@tauri-apps\/plugin-dialog$/, replacement: shim('plugin-dialog') },
      {
        find: /^@tauri-apps\/(api\/app|api\/path|plugin-os|plugin-process|plugin-shell|plugin-http)$/,
        replacement: shim('tauri-misc'),
      },
      { find: /^tauri-plugin-clerk$/, replacement: shim('tauri-misc') },
    ],
  },
  define: {
    'import.meta.env.VITE_RAPIDRAW_WEB': JSON.stringify('1'),
  },
  worker: { format: 'es' },
  server: {
    port: 1430,
    fs: { allow: [here('..')] },
  },
  preview: { port: 1431 },
  build: {
    outDir: here('dist'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
});
