// Shared blog-post storage layer, backed by Netlify Blobs.
//
// Every write path (the Edward webhook and the legacy key-auth publish
// endpoint) goes through `upsertPost` so that concurrent publishes can never
// duplicate a post, steal a slug, or lose an entry from the listing index.
//
// Key layout in the `posts` store:
//   post:<uuid>            → the full post document (source of truth)
//   slug:<slug>            → uuid, so /blog/<slug> can resolve a post
//   ext:<edward_id>        → uuid, so re-publishing an article upserts it
//   _index                 → array of post summaries for the /blog listing
//                            (a derived cache — rebuildable from post:* )

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const STORE_NAME = 'posts';
const INDEX_KEY = '_index';
const INDEX_MAX_ATTEMPTS = 6;
const REBUILD_CONCURRENCY = 8;

/**
 * Strong consistency matters here: Edward fetches `post_url` right after the
 * webhook returns, so an eventually-consistent read could 302 it back to /blog.
 */
export function getPostsStore() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function slugify(str) {
  return String(str ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents: "café" -> "cafe"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');
}

function toSummary(post) {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt || post.meta_description || '',
    featured_image_url: post.featured_image_url || '',
    published_at: post.published_at,
    status: post.status,
  };
}

function sortNewestFirst(entries) {
  entries.sort((a, b) => {
    const ta = Date.parse(a?.published_at ?? '') || 0;
    const tb = Date.parse(b?.published_at ?? '') || 0;
    return tb - ta;
  });
}

/**
 * Claim `ext:<externalId>` atomically so two concurrent deliveries of the same
 * article agree on one post id instead of each minting their own.
 */
async function claimPostId(store, externalId) {
  const key = `ext:${externalId}`;

  const existing = await store.get(key, { type: 'text' }).catch(() => null);
  if (existing) return { postId: existing, isUpdate: true };

  const candidate = crypto.randomUUID();
  const { modified } = await store.set(key, candidate, { onlyIfNew: true });
  if (modified) return { postId: candidate, isUpdate: false };

  // A concurrent request won the race — adopt its id so both requests
  // converge on a single post.
  const winner = await store.get(key, { type: 'text' }).catch(() => null);
  if (winner) return { postId: winner, isUpdate: true };

  // The key disappeared between the two attempts; take it unconditionally.
  await store.set(key, candidate);
  return { postId: candidate, isUpdate: false };
}

async function resolveIdentity(store, { externalId, incomingSlug, title }) {
  if (externalId) return claimPostId(store, externalId);

  // No edward_article_id — fall back to the slug so a re-publish still
  // updates the existing post rather than duplicating it.
  const fallbackSlug = slugify(incomingSlug) || slugify(title);
  if (fallbackSlug) {
    const owner = await store.get(`slug:${fallbackSlug}`, { type: 'text' }).catch(() => null);
    if (owner) return { postId: owner, isUpdate: true };
  }

  return { postId: crypto.randomUUID(), isUpdate: false };
}

/**
 * Claim a slug for `postId`, falling back to a suffixed variant when another
 * post already owns it. `onlyIfNew` makes the claim atomic, so two different
 * articles publishing the same slug concurrently cannot both win.
 */
async function claimSlug(store, desired, postId, previousSlug) {
  if (desired === previousSlug) return desired; // already ours

  const tryClaim = async (slug) => {
    const { modified } = await store.set(`slug:${slug}`, postId, { onlyIfNew: true });
    if (modified) return true;
    const owner = await store.get(`slug:${slug}`, { type: 'text' }).catch(() => null);
    return owner === postId; // we already hold it from an earlier publish
  };

  if (await tryClaim(desired)) return desired;

  const suffixed = `${desired}-${postId.slice(0, 6)}`;
  if (await tryClaim(suffixed)) return suffixed;

  const unique = `${desired}-${postId.slice(0, 18)}`;
  await store.set(`slug:${unique}`, postId);
  return unique;
}

/**
 * Compare-and-swap the listing index. A plain read-modify-write would drop
 * entries when two articles publish at once, so each attempt is conditioned on
 * the ETag we read; a losing attempt re-reads and retries.
 */
async function writeIndexEntry(store, summary) {
  for (let attempt = 0; attempt < INDEX_MAX_ATTEMPTS; attempt++) {
    const current = await store
      .getWithMetadata(INDEX_KEY, { type: 'json' })
      .catch(() => null);

    const entries = Array.isArray(current?.data) ? current.data.slice() : [];
    const at = entries.findIndex((entry) => entry?.id === summary.id);
    if (at >= 0) entries[at] = summary;
    else entries.push(summary);
    sortNewestFirst(entries);

    const conditions = current?.etag
      ? { onlyIfMatch: current.etag }
      : { onlyIfNew: true };

    const { modified } = await store.set(INDEX_KEY, JSON.stringify(entries), conditions);
    if (modified) return;

    await sleep(25 * (attempt + 1));
  }

  // Lost every attempt under sustained contention. Rebuilding from post:*
  // cannot lose anything, since those blobs are the source of truth.
  await rebuildIndex(store);
}

/** Recreate `_index` from the stored posts. Safe to call at any time. */
export async function rebuildIndex(store = getPostsStore()) {
  const { blobs } = await store.list({ prefix: 'post:' });
  const entries = [];

  for (let i = 0; i < blobs.length; i += REBUILD_CONCURRENCY) {
    const batch = blobs.slice(i, i + REBUILD_CONCURRENCY);
    const posts = await Promise.all(
      batch.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null)),
    );
    for (const post of posts) {
      if (post?.id) entries.push(toSummary(post));
    }
  }

  sortNewestFirst(entries);
  await store.set(INDEX_KEY, JSON.stringify(entries));
  return entries;
}

/**
 * Create or update a post from an Edward `article.published` payload.
 * Idempotent on `edward_article_id`.
 *
 * @param {object} data Edward's `article.published` payload.
 * @param {object} [store] Store override; defaults to the live Blobs store.
 * @returns {Promise<{postId: string, slug: string, isUpdate: boolean}>}
 */
export async function upsertPost(data = {}, store = getPostsStore()) {
  const {
    edward_article_id = '',
    title = '',
    slug: incomingSlug = '',
    content = '',
    status = 'published',
    meta_description = '',
    focus_keyword = '',
    tags = [],
    featured_image_url = '',
    featured_image_alt = '',
    og_title = '',
    og_description = '',
    og_image_url = '',
    twitter_title = '',
    twitter_description = '',
  } = data;

  const now = new Date().toISOString();

  const { postId, isUpdate } = await resolveIdentity(store, {
    externalId: edward_article_id,
    incomingSlug,
    title,
  });

  const existing = isUpdate
    ? await store.get(`post:${postId}`, { type: 'json' }).catch(() => null)
    : null;

  const desiredSlug =
    slugify(incomingSlug) || existing?.slug || slugify(title) || postId;
  const finalSlug = await claimSlug(store, desiredSlug, postId, existing?.slug);

  const post = {
    id: postId,
    external_id: edward_article_id,
    title,
    slug: finalSlug,
    body_html: content,
    excerpt: meta_description,
    meta_description,
    focus_keyword,
    tags: Array.isArray(tags)
      ? tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [],
    featured_image_url,
    featured_image_alt,
    og_title: og_title || title,
    og_description: og_description || meta_description,
    og_image_url: og_image_url || featured_image_url,
    twitter_title: twitter_title || og_title || title,
    twitter_description: twitter_description || og_description || meta_description,
    status,
    published_at: existing?.published_at || now,
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  await store.set(`post:${postId}`, JSON.stringify(post));

  // Retire the previous slug pointer only after the post is readable under the
  // new one, and only if we still own it.
  if (existing?.slug && existing.slug !== finalSlug) {
    const owner = await store.get(`slug:${existing.slug}`, { type: 'text' }).catch(() => null);
    if (owner === postId) {
      await store.delete(`slug:${existing.slug}`).catch(() => {});
    }
  }

  await writeIndexEntry(store, toSummary(post));

  return { postId, slug: finalSlug, isUpdate };
}
