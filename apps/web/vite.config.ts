import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: process.env.WEB_BASE_PATH ?? '/',
  plugins: [vue()],
  server: {
    host: '0.0.0.0', port: 5173, strictPort: true,
    proxy: {
      '/socket.io': { target: 'http://127.0.0.1:3001', ws: true },
      '/api': { target: 'http://127.0.0.1:3001' },
    },
  },
});
