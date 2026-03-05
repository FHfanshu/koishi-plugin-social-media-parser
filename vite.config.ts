import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'client/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      external: [
        '@koishijs/client',
        'vue',
      ],
    },
  },
})
