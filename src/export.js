/**
 * Sidecar exporter.
 *
 * Writes to the browser Downloads folder:
 *   suno-library-ff/<batch>/<stem>.json
 *   suno-library-ff/<batch>/<stem>.mp3
 *
 * Firefox cannot grant a persistent directory handle. The download
 * manager is the supported path. Sidecar schema is versioned so a
 * later importer can stay stable while clip.raw drifts.
 */

export const SIDECAR_SCHEMA = "suno-library-ff.sidecar.v1";
export const CATALOG_SCHEMA = "suno-library-ff.catalog.v1";

const DOWNLOAD_TIMEOUT_MS = 120_000;

export function sanitizeStem(title, id) {
  const shortId = String(id).slice(0, 8);
  const base = String(title || "untitled")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return `${base || "untitled"}-${shortId}`;
}

export function extFromUrl(url, fallback) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.(mp3|wav|m4a|ogg|png|jpg|jpeg|webp)$/i);
    if (m) return m[1].toLowerCase();
  } catch {
    /* ignore */
  }
  return fallback;
}

export function buildSidecar(clip, curation, options = {}) {
  const includeRaw = Boolean(options.includeRaw);
  return {
    schema: SIDECAR_SCHEMA,
    exported_at: new Date().toISOString(),
    clip: {
      id: clip.id,
      title: clip.title,
      status: clip.status,
      model_name: clip.model_name,
      audio_url: clip.audio_url,
      image_url: clip.image_url,
      video_url: clip.video_url,
      created_at: clip.created_at,
      play_count: clip.play_count,
      upvote_count: clip.upvote_count,
      prompt: clip.prompt,
      tags: clip.tags,
      duration: clip.duration,
      parent_id: clip.parent_id,
    },
    curation: curation || null,
    files: {
      audio: clip.audio_url
        ? `${sanitizeStem(clip.title, clip.id)}.${extFromUrl(clip.audio_url, "mp3")}`
        : null,
      image: clip.image_url
        ? `${sanitizeStem(clip.title, clip.id)}.${extFromUrl(clip.image_url, "jpg")}`
        : null,
    },
    raw: includeRaw ? clip.raw ?? null : undefined,
  };
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.downloads.onChanged.removeListener(onChange);
      reject(new Error(`download ${downloadId} timed out`));
    }, DOWNLOAD_TIMEOUT_MS);

    function onChange(delta) {
      if (delta.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === "complete") {
        clearTimeout(timer);
        browser.downloads.onChanged.removeListener(onChange);
        resolve();
      } else if (state === "interrupted") {
        clearTimeout(timer);
        browser.downloads.onChanged.removeListener(onChange);
        reject(new Error(`download ${downloadId} interrupted`));
      }
    }

    browser.downloads.onChanged.addListener(onChange);
  });
}

/**
 * @param {string} url
 * @param {string} filename relative to Downloads
 */
export async function downloadTo(url, filename) {
  const id = await browser.downloads.download({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: false,
  });
  await waitForDownload(id);
  return id;
}

export async function downloadJson(doc, filename) {
  const blob = new Blob([JSON.stringify(doc, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  try {
    await downloadTo(url, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function batchDir(stamp = new Date()) {
  const iso = stamp.toISOString().replace(/[:.]/g, "-");
  return `suno-library-ff/${iso}`;
}

/**
 * Export one clip: sidecar first (always), then optional audio/image.
 *
 * @returns {Promise<{ id: string, sidecar: boolean, audio: boolean, image: boolean, skipped: string[] }>}
 */
export async function exportClip(clip, curation, dir, options = {}) {
  const includeAudio = options.includeAudio !== false;
  const includeImage = Boolean(options.includeImage);
  const stem = sanitizeStem(clip.title, clip.id);
  const skipped = [];

  const sidecar = buildSidecar(clip, curation, options);
  await downloadJson(sidecar, `${dir}/${stem}.json`);

  let audio = false;
  if (includeAudio && clip.audio_url) {
    const ext = extFromUrl(clip.audio_url, "mp3");
    await downloadTo(clip.audio_url, `${dir}/${stem}.${ext}`);
    audio = true;
  } else if (includeAudio) {
    skipped.push("audio_missing");
  }

  let image = false;
  if (includeImage && clip.image_url) {
    const ext = extFromUrl(clip.image_url, "jpg");
    await downloadTo(clip.image_url, `${dir}/${stem}.${ext}`);
    image = true;
  }

  return { id: clip.id, sidecar: true, audio, image, skipped };
}
