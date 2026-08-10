// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import netlify from '@astrojs/netlify';

// Netlify functions read secrets from `process.env`, which is how they arrive in
// production. Locally, Vite only loads .env into `import.meta.env`, so the
// emulated functions would see no EDWARD_WEBHOOK_SECRET and reject every
// delivery as unsigned. Bridge .env into process.env for dev, without ever
// letting it override a real environment variable.
const fileEnv = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '');
for (const [key, value] of Object.entries(fileEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

export default defineConfig({
  site: 'https://verkeersschoolpioneers.nl',
  output: 'static',
  adapter: netlify(),
  vite: {
    plugins: [tailwindcss()],
  },
});
