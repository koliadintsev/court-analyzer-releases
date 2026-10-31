import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome120',
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173, strictPort: true },
});
