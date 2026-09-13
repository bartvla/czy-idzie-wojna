import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages bez własnej domeny serwuje stronę pod /<repo>/; workflow ustawia VITE_BASE.
  base: process.env.VITE_BASE ?? '/',
  build: {
    chunkSizeWarningLimit: 900,
  },
})
