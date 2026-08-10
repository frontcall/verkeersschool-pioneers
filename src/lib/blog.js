// Shared read helpers for the blog listing.
//
// Posts are published at runtime by the Edward webhook (see
// netlify/lib/posts.js), so the listing pages are server-rendered rather than
// prerendered — the post set simply does not exist at build time.

import { getStore } from '@netlify/blobs';

export const PER_PAGE = 9;

/** Published posts, newest first. Returns [] when the store is unavailable. */
export async function getPublishedPosts() {
  try {
    // Strong consistency: a post must be listed immediately after publishing.
    const store = getStore({ name: 'posts', consistency: 'strong' });
    const raw = await store.get('_index', { type: 'json' });
    return Array.isArray(raw) ? raw.filter((post) => post?.status === 'published') : [];
  } catch {
    // Blobs not configured or empty — render the empty state.
    return [];
  }
}

/** Slice `posts` for a 1-based page number. */
export function paginate(posts, page) {
  const totalPages = Math.max(1, Math.ceil(posts.length / PER_PAGE));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * PER_PAGE;
  return {
    items: posts.slice(start, start + PER_PAGE),
    current,
    totalPages,
    total: posts.length,
  };
}

/** Page 1 lives at /blog so the canonical listing URL stays clean. */
export function pageHref(page) {
  return page <= 1 ? '/blog' : `/blog/page/${page}`;
}

/** Parse a route param into a page number, or null when it isn't a clean integer. */
export function parsePageParam(value) {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) return null;
  return Number(value);
}

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('nl-NL', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}
