import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 静态站点；/health 由 public/health 提供（dev/preview/构建产物均生效）
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173
  },
  preview: {
    host: true,
    port: 4173
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
