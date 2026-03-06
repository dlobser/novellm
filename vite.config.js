import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/Novel/',  // GitHub repo name — change if your repo is named differently
  server: {
    port: 3000,
    open: true
  }
})
