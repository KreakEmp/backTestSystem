import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // All requests to /kite/* are forwarded to api.kite.trade/*
      // This bypasses CORS — Kite sees the request as coming from a server, not a browser.
      '/kite': {
        target:      'https://api.kite.trade',
        changeOrigin: true,
        rewrite:     path => path.replace(/^\/kite/, ''),
      },
    },
  },
})
