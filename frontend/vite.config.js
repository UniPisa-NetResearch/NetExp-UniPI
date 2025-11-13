import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/auth': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
      '/api/orchestrator': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        secure: false,
      },
      '/api/controller': {
        target: 'http://localhost:5002',
        changeOrigin: true,
        secure: false,
      }
    },
  },
})
