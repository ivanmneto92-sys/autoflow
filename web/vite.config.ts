import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// O painel roda em http://localhost:5173 e repassa /app para a API (porta 3000)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/app': 'http://127.0.0.1:3000',
    },
  },
});
