import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  output: 'static',
  compressHTML: true,
  integrations: [
    tailwind({ applyBaseStyles: false })
  ],
  build: {
    inlineStylesheets: 'auto'
  },
  vite: {
    optimizeDeps: {
      exclude: ['@huggingface/transformers']
    }
  }
});
