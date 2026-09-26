import { defineConfig } from 'vite';
// Second dev server for scripted screenshot tests: files are watched (fresh code on each page load)
// but HMR is off, so concurrent edits never reload a page mid-capture.
export default defineConfig({
  server: { port: 8766, strictPort: true, hmr: false },
});
