import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('electron/main/index.ts'),
        output: { format: 'cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('electron/preload/index.ts'),
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: 'src/pet',
    publicDir: resolve('resources'),
    plugins: [vue()],
    build: {
      outDir: resolve('out/renderer/pet'),
      emptyOutDir: true,
      // The contents of resources/ will be copied to out/renderer/pet/
      rollupOptions: {
        input: {
          pet: resolve('src/pet/index.html'),
          settings: resolve('src/pet/settings.html'),
        },
      },
    },
    server: {
      fs: {
        // Allow serving files outside the renderer root (for resources/)
        allow: [resolve('src/pet'), resolve('resources')],
      },
    },
  },
})
