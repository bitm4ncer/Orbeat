import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sampleListPlugin } from './src/vite-plugins/sampleListPlugin'

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss(), sampleListPlugin()],
})
