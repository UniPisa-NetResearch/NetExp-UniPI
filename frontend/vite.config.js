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
      },
      '/api/validator': {
        target: 'http://localhost:5003',
        changeOrigin: true,
        secure: false,
      },
      '/api/experimenter': {
        target: 'http://localhost:5004',
        changeOrigin: true,
        secure: false,
      },
      '/api/evaluator': {
        target: 'http://localhost:5005',
        changeOrigin: true,
        secure: false,
      },
      '/api/agent_server': {
        target: 'http://localhost:5006',
        changeOrigin: true,
        secure: false,
      }
    },
  },
})
