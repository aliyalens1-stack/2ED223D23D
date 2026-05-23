import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Step B.1 — Bundle split: route-level lazy loading + manualChunks.
//
// The admin Vite output used to be a single ~1.41 MB index-*.js. After this
// config every page-level chunk lands in a domain-specific bundle so that
// Operations admins don't ship Automation/Forecast/Revenue code they never
// open. The chunkSizeWarningLimit is intentionally NOT raised — a warning
// in `yarn build` is the canary for the next refactor round.
export default defineConfig({
  plugins: [react()],
  base: '/api/admin-panel/',
  resolve: {
    alias: {
      // Phase 0A — multi-surface architecture: shared behavioral truth
      // lives at /app/shared (no JSX, no React). Imported as @platform/*.
      // Mirrors web-app/vite.config.ts and frontend/metro.config.js.
      '@platform': path.resolve(__dirname, '..', 'shared'),
    },
  },
  server: {
    // Vite needs to pre-scan files outside its root for the alias to work.
    fs: { allow: ['..'] },
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
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
          // 1. Vendor splits (only for node_modules) — give heavy libs their own bundle.
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
            if (id.includes('@radix-ui')) return 'vendor-radix';
            if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts';
            if (id.includes('lucide-react')) return 'vendor-icons';
            if (id.includes('socket.io-client')) return 'vendor-socket';
            if (
              id.includes('react-hook-form') ||
              id.includes('@hookform') ||
              id.includes('zod')
            ) {
              return 'vendor-forms';
            }
            if (id.includes('zustand')) return 'vendor-state';
            if (id.includes('date-fns')) return 'vendor-date';
            return 'vendor-misc';
          }

          // 2. Per-domain page chunks — route the lazy `pages/*` imports into a
          //    handful of cohesive bundles instead of one chunk per page.
          if (id.includes('/src/pages/')) {
            // Automation suite (15 pages — the heaviest cluster)
            if (
              id.includes('Automation') ||
              id.includes('AutoActions') ||
              id.includes('AutoRulePerformance') ||
              id.includes('ActionChains') ||
              id.includes('ExecutionMonitor') ||
              id.includes('ExecutionReplay') ||
              id.includes('ShadowMode') ||
              id.includes('Idempotency') ||
              id.includes('ROITracking') ||
              id.includes('UnifiedState') ||
              id.includes('Failsafe') ||
              id.includes('FeedbackLoop') ||
              id.includes('DryRun')
            ) {
              return 'admin-automation';
            }
            // Governance / market / zone / demand
            if (
              id.includes('Governance') ||
              id.includes('ProviderBehavior') ||
              id.includes('MarketControl') ||
              id.includes('ZoneControl') ||
              id.includes('EconomyControl') ||
              id.includes('DistributionControl') ||
              id.includes('IncidentControl') ||
              id.includes('DemandControl') ||
              id.includes('DemandActions') ||
              id.includes('GeoOps') ||
              id.includes('Reputation') ||
              id.includes('SupplyQuality') ||
              id.includes('RequestFlow')
            ) {
              return 'admin-governance';
            }
            // Revenue / billing / monetization (Stripe + charts heavy)
            if (
              id.includes('Revenue') ||
              id.includes('Monetization') ||
              id.includes('Stripe') ||
              id.includes('SupportChat')
            ) {
              return 'admin-revenue';
            }
            // Forecast / simulation / rules visualizer (data-viz heavy)
            if (
              id.includes('Forecast') ||
              id.includes('Simulation') ||
              id.includes('Playbooks') ||
              id.includes('RuleVisualizer')
            ) {
              return 'admin-forecast';
            }
            // Default: operations pages (dashboard, bookings, providers, …)
            return 'admin-ops';
          }
        },
      },
    },
  },
});
