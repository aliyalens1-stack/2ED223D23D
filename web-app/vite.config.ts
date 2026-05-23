import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Step B.2 — Bundle split: route-level lazy loading + manualChunks.
//
// Pre-split: dist/assets/index-*.js = 939 kB (gzip 270 kB).
// Post-split: per-domain chunks (public / customer / provider / inspector)
// + vendor isolation (react / leaflet / phosphor / radix / etc.).
//
// chunkSizeWarningLimit is intentionally NOT raised — its warning is the
// canary that triggers the next refactor round.
export default defineConfig({
  plugins: [react()],
  base: '/api/web-app/',
  resolve: {
    alias: {
      // Phase 0A — multi-surface architecture: shared behavioral truth
      // lives at /app/shared (no JSX, no React). Imported as @platform/*.
      '@platform': path.resolve(__dirname, '..', 'shared'),
      // Customer-Web-1 — customer-grammar is the shared narrative policy
      // artifact (curated copy tables + projection kernel + lexicon
      // firewall). Mobile and web BOTH import from here; web has no
      // permission to re-implement projection or re-translate copy.
      // See: frontend/src/customer-grammar/POLICY.md
      '@customer-grammar': path.resolve(
        __dirname,
        '..',
        'frontend',
        'src',
        'customer-grammar',
      ),
    },
  },
  server: {
    // Vite needs to pre-scan files outside its root for the alias to work.
    fs: { allow: ['..'] },
    port: 3002,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // 1. Vendor splits — heaviest libs get their own bundles so they
          //    can be cached across navigations.
          if (id.includes('node_modules')) {
            if (id.includes('react-router') || id.includes('@remix-run')) {
              return 'vendor-router';
            }
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/scheduler/')
            ) {
              return 'vendor-react';
            }
            if (id.includes('react-leaflet') || id.includes('/leaflet/')) {
              return 'vendor-leaflet';
            }
            if (id.includes('@phosphor-icons') || id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (id.includes('socket.io-client')) return 'vendor-socket';
            if (id.includes('zustand')) return 'vendor-state';
            if (
              id.includes('i18next') ||
              id.includes('react-i18next')
            ) {
              return 'vendor-i18n';
            }
            return 'vendor-misc';
          }

          // 2. Per-surface page chunks — keep customer / provider / inspector
          //    separate so a customer never downloads inspector workspace code.
          if (id.includes('/src/pages/inspector/')) return 'web-inspector';
          if (id.includes('/src/pages/provider/')) return 'web-provider';
          if (id.includes('/src/pages/customer/')) return 'web-customer';
          if (id.includes('/src/pages/auth/')) return 'web-auth';
          if (id.includes('/src/pages/public/')) return 'web-public';
        },
      },
    },
  },
});
