/**
 * Minimal Suno studio-api client.
 *
 * Contract is unofficial and has drifted. This module isolates that volatility.
 * Auth is injected; this file never stores tokens.
 */

import { lineageFromRaw } from "./lineage.js";

export const API_HOSTS = [
  "https://studio-api.prod.suno.com",
  "https://studio-api-prod.suno.com",
];

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

export class RateLimitError extends Error {
  /**
   * @param {number} retryAfterMs
   */
  constructor(retryAfterMs) {
    super("rate limited");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * @typedef {object} AuthContext
 * @property {string | null} bearer
 * @property {string | null} cookieHeader
 */

/**
 * @param {AuthContext} auth
 * @param {string} path
 * @param {RequestInit} [init]
 */
export async function studioFetch(auth, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (auth.bearer) headers.set("Authorization", `Bearer ${auth.bearer}`);
  if (auth.cookieHeader) headers.set("Cookie", auth.cookieHeader);

  let lastError = null;
  for (const host of API_HOSTS) {
    const res = await fetch(`${host}${path}`, {
      ...init,
      headers,
      credentials: "omit",
    });

    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`studio-api ${res.status}`);
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("Retry-After") || 5);
      throw new RateLimitError(Math.max(1, retry) * 1000);
    }
    if (res.status >= 500) {
      lastError = new Error(`studio-api ${res.status} at ${host}`);
      continue;
    }
    if (!res.ok) {
      throw new Error(`studio-api ${res.status} ${path}`);
    }
    return res.json();
  }
  throw lastError || new Error("all studio-api hosts failed");
}

/**
 * Normalize a clip record from whatever feed shape is current.
 * Unknown fields are preserved under `raw`.
 */
export function normalizeClip(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id || raw.clip_id;
  if (!id) return null;

  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
  const lineage = lineageFromRaw(raw);

  return {
    id: String(id),
    title: raw.title || "",
    status: raw.status || "",
    model_name: raw.model_name || raw.major_model_version || "",
    audio_url: raw.audio_url || null,
    image_url: raw.image_url || raw.image_large_url || null,
    video_url: raw.video_url || null,
    created_at: raw.created_at || raw.created_at_iso || null,
    play_count: raw.play_count ?? null,
    upvote_count: raw.upvote_count ?? null,
    prompt: metadata.prompt || raw.prompt || raw.lyric || "",
    tags: metadata.tags || raw.tags || "",
    duration: metadata.duration ?? raw.duration ?? null,
    parent_id: lineage.parent_id,
    parent_kind: lineage.kind,
    extra_parents: lineage.extra_parents,
    indexed_at: new Date().toISOString(),
    raw,
  };
}

/**
 * Walk the library feed.
 *
 * Observed shapes:
 *   POST /api/feed/v3  body { page } or { next_cursor }
 *   response { clips, has_more, next_cursor }
 *
 * @param {AuthContext} auth
 * @param {{ cursor?: string | null, page?: number }} state
 */
export async function fetchFeedPage(auth, state) {
  const body = {};
  if (state.cursor) body.next_cursor = state.cursor;
  else body.page = state.page ?? 0;

  const data = await studioFetch(auth, "/api/feed/v3", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const clips = Array.isArray(data?.clips)
    ? data.clips
    : Array.isArray(data)
      ? data
      : [];

  return {
    clips: clips.map(normalizeClip).filter(Boolean),
    hasMore: Boolean(data?.has_more),
    nextCursor: data?.next_cursor ?? null,
    nextPage: (state.page ?? 0) + 1,
  };
}

/**
 * @param {AuthContext} auth
 * @param {string[]} ids
 */
export async function fetchClipsByIds(auth, ids) {
  if (!ids.length) return [];
  const params = ids.map((id) => `ids=${encodeURIComponent(id)}`).join("&");
  const data = await studioFetch(auth, `/api/clips/get_songs_by_ids?${params}`, {
    method: "GET",
  });
  const clips = Array.isArray(data?.clips) ? data.clips : [];
  return clips.map(normalizeClip).filter(Boolean);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
