import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',  // served from the custom domain theaibookgenerator.com (see public/CNAME)
  server: {
    port: 3000,
    open: true
  }
})
