import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sampleListPlugin } from './src/vite-plugins/sampleListPlugin'

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss(), sampleListPlugin()],
  server: {
    proxy: {
      // Proxy R2 CDN requests in dev to avoid CORS issues
      '/samples': {
        target: 'https://pub-217bf16854dc45ab98c3b8c8b015db1b.r2.dev',
        changeOrigin: true,
      },
    },
  },
})
