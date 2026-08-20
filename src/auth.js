/**
 * Auth is ephemeral.
 * Bearer lives in worker memory only. Cookies are read at sync time.
 */

/** @type {string | null} */
let bearer = null;
/** @type {number} */
let bearerSeenAt = 0;

const BEARER_TTL_MS = 25 * 60 * 1000;

export function setBearer(token) {
  if (typeof token !== "string" || token.length < 16) return false;
  if (token === bearer) return true;
  bearer = token;
  bearerSeenAt = Date.now();
  return true;
}

export function getBearer() {
  if (!bearer) return null;
  if (Date.now() - bearerSeenAt > BEARER_TTL_MS) {
    bearer = null;
    return null;
  }
  return bearer;
}

export function clearBearer() {
  bearer = null;
  bearerSeenAt = 0;
}

export function bearerAgeMs() {
  if (!bearer) return null;
  return Date.now() - bearerSeenAt;
}

/**
 * Collect Clerk / Suno cookies from the user's browser.
 * Used as fallback when no Bearer has been intercepted yet.
 */
export async function readCookieHeader() {
  const chunks = await browser.cookies.getAll({ domain: "suno.com" });
  if (!chunks.length) return null;
  return chunks.map((c) => `${c.name}=${c.value}`).join("; ");
}

export async function buildAuthContext() {
  return {
    bearer: getBearer(),
    cookieHeader: await readCookieHeader(),
  };
}

export function hasAuth() {
  return Boolean(getBearer());
}
