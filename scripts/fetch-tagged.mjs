#!/usr/bin/env node
/**
 * Fetches posts that tag your Instagram account, mirrors their images into
 * ./media, and writes ./feed.json for the Shopify section to read.
 *
 * Two things this handles that a naive version wouldn't:
 *
 * 1. Instagram's media_url values are signed CDN links that expire, so we keep
 *    our own copy of every image rather than caching a link that will 404.
 * 2. The feed is CUMULATIVE. Instagram's /tags edge only returns a recent
 *    window, but a post you approved a year ago must keep working. Once a post
 *    is known it stays in feed.json and keeps its mirrored image forever.
 *
 * Env:
 *   IG_TOKEN       (required) long-lived Instagram access token
 *   IG_USER_ID     (required) your Instagram user id
 *   GRAPH_HOST     graph.instagram.com (default) | graph.facebook.com
 *   GRAPH_VERSION  default v21.0
 *   IG_FULL_SYNC   "1" to walk the entire history instead of stopping early
 */

import { writeFile, readFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.IG_TOKEN;
const USER_ID = process.env.IG_USER_ID;
const HOST = process.env.GRAPH_HOST || 'graph.instagram.com';
const VERSION = process.env.GRAPH_VERSION || 'v21.0';
const FULL_SYNC = process.env.IG_FULL_SYNC === '1';

const PAGE_SIZE = 3;
const MAX_PAGES = 700;

const ROOT = path.resolve(process.cwd());
const MEDIA_DIR = path.join(ROOT, 'media');
const FEED_PATH = path.join(ROOT, 'feed.json');

const FIELDS = [
  'id',
  'media_type',
  'media_url',
  'permalink',
  'thumbnail_url',
  'caption',
  'username',
  'timestamp',
  'children{media_url,thumbnail_url,media_type}',
].join(',');

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!TOKEN) die('IG_TOKEN is not set. Add it as a repository secret.');
if (!USER_ID) die('IG_USER_ID is not set. Add it as a repository secret.');

/** Pull the shortcode out of a permalink: .../p/ABC123/ -> ABC123 */
function shortcode(permalink, fallback) {
  const m = String(permalink || '').match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : String(fallback);
}

/** Best available still image, accounting for videos and carousel albums. */
function pickImage(post) {
  if (post.media_type === 'VIDEO') return post.thumbnail_url || post.media_url;
  if (post.media_url) return post.media_url;
  const child = post.children?.data?.[0];
  if (child) return child.media_type === 'VIDEO' ? child.thumbnail_url : child.media_url;
  return null;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extends the token's 60-day life. Only the Instagram-login flow supports this;
 * Facebook page tokens don't expire the same way, so failure here isn't fatal.
 */
async function refreshToken() {
  if (HOST !== 'graph.instagram.com') {
    console.log('· Skipping token refresh (not an Instagram-login token).');
    return;
  }
  try {
    const url = new URL(`https://${HOST}/refresh_access_token`);
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', TOKEN);
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok || !body.access_token) {
      console.log(`· Token refresh skipped: ${body?.error?.message || res.status}`);
      return;
    }
    console.log(`· Token refreshed, valid ~${Math.round((body.expires_in || 0) / 86400)} more days.`);
  } catch (e) {
    console.log(`· Token refresh failed (non-fatal): ${e.message}`);
  }
}

/**
 * Walks the /tags edge. Stops early once a whole page is already known, since
 * routine runs only need the new arrivals — unless IG_FULL_SYNC forces a full
 * walk (used for the initial backlog import).
 */
async function fetchTagged(known) {
  const first = new URL(`https://${HOST}/${VERSION}/${USER_ID}/tags`);
  first.searchParams.set('fields', FIELDS);
  first.searchParams.set('limit', String(PAGE_SIZE));
  first.searchParams.set('access_token', TOKEN);

  let next = first;
  let pages = 0;
  const out = [];

  while (next && pages < MAX_PAGES) {
    const res = await fetch(next);
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      const err = body?.error || {};
      throw new Error(
        `Graph API ${res.status} on /tags: ${err.message || 'unknown error'}` +
          (err.code ? ` (code ${err.code})` : '')
      );
    }

    const batch = body.data || [];
    out.push(...batch);
    pages++;
    console.log(`  · page ${pages}: ${batch.length} post(s)`);

    if (!batch.length) break;

    if (!FULL_SYNC) {
      const allKnown = batch.every((p) => known.has(shortcode(p.permalink, p.id)));
      if (allKnown) {
        console.log('  · reached already-known posts, stopping early');
        break;
      }
    }

    next = body.paging?.next ? new URL(body.paging.next) : null;
  }

  return out;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('suspiciously small file');
  await writeFile(dest, buf);
  return buf.length;
}

async function readFeed() {
  try {
    const parsed = JSON.parse(await readFile(FEED_PATH, 'utf8'));
    return Array.isArray(parsed.posts) ? parsed.posts : [];
  } catch {
    return [];
  }
}

async function main() {
  console.log(`→ Fetching tagged posts from ${HOST}${FULL_SYNC ? ' (full sync)' : ''}`);

  await refreshToken();
  await mkdir(MEDIA_DIR, { recursive: true });

  // Start from what we already have so nothing previously approved disappears.
  const previous = await readFeed();
  const byCode = new Map(previous.map((p) => [p.code, p]));
  console.log(`→ ${byCode.size} post(s) already in feed.json`);

  const raw = await fetchTagged(new Set(byCode.keys()));
  console.log(`→ ${raw.length} post(s) returned from API`);

  let added = 0;
  for (const post of raw) {
    const code = shortcode(post.permalink, post.id);
    const file = `${code}.jpg`;
    const dest = path.join(MEDIA_DIR, file);

    // Known and still mirrored — nothing to do.
    if (byCode.has(code) && (await exists(dest))) continue;

    const src = pickImage(post);
    if (!src) {
      console.log(`  · skip ${code}: no usable image`);
      continue;
    }

    try {
      const bytes = await download(src, dest);
      console.log(`  ✓ ${file} (${Math.round(bytes / 1024)} KB)`);
    } catch (e) {
      // One bad image shouldn't sink the whole run.
      console.log(`  · skip ${code}: image download failed (${e.message})`);
      continue;
    }

    byCode.set(code, {
      code,
      permalink: post.permalink,
      username: post.username || '',
      caption: (post.caption || '').slice(0, 300),
      timestamp: post.timestamp || '',
      type: post.media_type || 'IMAGE',
      image: `media/${file}`,
    });
    added++;
  }

  // Drop entries whose mirrored image went missing, so the storefront never
  // renders a broken tile.
  const posts = [];
  for (const p of byCode.values()) {
    if (await exists(path.join(ROOT, p.image))) posts.push(p);
    else console.log(`  · dropping ${p.code}: mirrored image missing`);
  }

  posts.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

  // Prune only files no post references. Everything in the feed is kept
  // forever — an approved post must never lose its image.
  const referenced = new Set(posts.map((p) => path.basename(p.image)));
  let pruned = 0;
  for (const file of await readdir(MEDIA_DIR)) {
    if (file.endsWith('.jpg') && !referenced.has(file)) {
      await unlink(path.join(MEDIA_DIR, file));
      pruned++;
    }
  }
  if (pruned) console.log(`→ Pruned ${pruned} unreferenced image(s)`);

  await writeFile(
    FEED_PATH,
    JSON.stringify({ updated: new Date().toISOString(), count: posts.length, posts }, null, 2)
  );
  console.log(`✓ feed.json: ${posts.length} post(s) total, ${added} new`);
}

main().catch((e) => die(e.message));
