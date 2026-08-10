## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

### Working on the blog / Edward webhook

`astro dev` cannot exercise these. Its Netlify emulation supplies a Blobs
context without `siteID`/`token`, so every `getStore()` call throws and `/blog`
silently falls back to its empty state. Use the built output instead:

```
npm run build && npx netlify serve --offline --port 8888
```

That runs the real Netlify routing engine (so `/api/edward-webhook` resolves)
and a working local Blobs store. Note the local Blobs emulator does not
implement conditional writes (`onlyIfNew` / `onlyIfMatch`) atomically, so
concurrent-publish deduplication only behaves correctly in production.

## Blog architecture

Posts arrive from Edward, an external SEO content tool, and live in Netlify
Blobs — there is no CMS or database.

- `netlify/functions/edward-webhook.mjs` — HMAC-signed receiver, Netlify
  Functions v2 with an explicit `path: '/api/edward-webhook'`. The path must
  stay explicit: the Astro SSR function claims `/*`, so a netlify.toml rewrite
  would be swallowed by that catch-all before reaching this function.
- `netlify/lib/posts.js` — shared storage layer. All writes go through
  `upsertPost` so concurrent publishes cannot duplicate a post, steal a slug,
  or drop an entry from the listing index.
- `src/pages/blog/` — SSR pages (`prerender = false`) reading the same store
  with `consistency: 'strong'`.

Required environment variables (see `.env.example`): `EDWARD_WEBHOOK_SECRET`,
`EDWARD_SITE_URL`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
