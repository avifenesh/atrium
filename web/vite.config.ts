import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // changeOrigin: the server enforces a Host allowlist (CSRF/DNS-rebinding
      // defense), so proxied requests must carry the backend host, not :5173
      '/api': { target: 'http://127.0.0.1:5599', changeOrigin: true },
    },
  },
});
