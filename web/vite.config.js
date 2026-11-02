import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base './' — сайт работает из любой папки (GitHub Pages публикует в /<репозиторий>/)
export default defineConfig({
  plugins: [react()],
  base: './',
})
