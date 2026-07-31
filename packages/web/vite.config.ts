import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    // The dev server proxies the API so the PWA runs same-origin in development,
    // which keeps the share-target and service-worker paths identical to prod.
    proxy: {
      '/v1': { target: 'http://localhost:4000', changeOrigin: true },
      '/health': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep the service worker at a stable top-level path so its scope covers
    // the whole origin.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
