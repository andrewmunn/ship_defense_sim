import { defineConfig } from 'vite';
import { resolve } from 'path';
export default defineConfig({
  server: { port: 8765, strictPort: true },
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), viewer: resolve(__dirname, 'viewer.html') },
    },
  },
});
