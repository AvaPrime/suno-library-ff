import {
  buildAuthContext,
  hasAuth,
  setBearer,
  bearerAgeMs,
  clearBearer,
} from "./auth.js";
import { AuthError, RateLimitError, fetchFeedPage, sleep } from "./suno-api.js";
import {
  putClips,
  countClips,
  getSyncState,
  setSyncState,
  listClips,
  getCuration,
  getAllClips,
  getClip,
} from "./idb.js";
import { batchDir, exportClip, downloadJson, CATALOG_SCHEMA } from "./export.js";
import {
  EXPORT_ALARM,
  SYNC_ALARM,
  readExportJob,
  writeExportJob,
  readSyncJob,
  writeSyncJob,
  armWatchdog,
  disarmWatchdog,
} from "./jobs.js";

const DELAY_MS = {
  slow: 1200,
  balanced: 400,
  fast: 80,
};

/** @type {{ running: boolean, cancel: boolean, lastError: string | null }} */
const sync = {
  running: false,
  cancel: false,
  lastError: null,
};

const exporter = {
  running: false,
  cancel: false,
  lastError: null,
  done: 0,
  failed: 0,
  total: 0,
};

browser.runtime.onMessage.addListener((msg, _sender) => {
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "AUTH_TOKEN":
      setBearer(msg.token);
      resumeSyncIfNeeded();
      return Promise.resolve({ ok: true });
    case "GET_STATUS":
      return getStatus();
    case "START_SYNC":
      return startSync(msg.speed || "balanced");
    case "STOP_SYNC":
      return stopSync();
    case "LIST_CLIPS":
      return listClips(msg.limit || 40);
    case "CLEAR_AUTH":
      clearBearer();
      return Promise.resolve({ ok: true });
    case "START_EXPORT":
      return startExport(msg);
    case "STOP_EXPORT":
      return stopExport();
    default:
      return Promise.resolve({ error: "unknown_message" });
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EXPORT_ALARM) resumeExportIfNeeded();
  if (alarm.name === SYNC_ALARM) resumeSyncIfNeeded();
});

resumeExportIfNeeded();
resumeSyncIfNeeded();

async function getStatus() {
  const state = (await getSyncState("library")) || {};
  const jobSync = await readSyncJob();
  return {
    auth: hasAuth(),
    bearerAgeMs: bearerAgeMs(),
    clipCount: await countClips(),
    running: sync.running || jobSync?.status === "running" || jobSync?.status === "waiting_auth",
    syncStatus: jobSync?.status || (sync.running ? "running" : "idle"),
    lastError: sync.lastError || jobSync?.lastError || null,
    lastCursor: state.next_cursor || null,
    lastSyncAt: state.updated_at || null,
    lastPage: state.page ?? 0,
    export: await exportStatus(),
  };
}

async function exportStatus() {
  const job = await readExportJob();
  return {
    running: exporter.running || job?.status === "running",
    status: job?.status || "idle",
    done: exporter.running ? exporter.done : job?.done || 0,
    failed: exporter.running ? exporter.failed : job?.failed || 0,
    total: exporter.running ? exporter.total : job?.total || 0,
    dir: job?.dir || null,
    lastError: exporter.lastError || job?.lastError || null,
  };
}

async function focusSunoTab() {
  const tabs = await browser.tabs.query({
    url: ["https://suno.com/*", "https://www.suno.com/*"],
  });
  if (!tabs.length) return false;
  await browser.tabs.update(tabs[0].id, { active: true });
  try {
    if (tabs[0].windowId != null) {
      await browser.windows.update(tabs[0].windowId, { focused: true });
    }
  } catch {
    /* windows focus is best-effort */
  }
  return true;
}

async function startSync(speed) {
  if (sync.running) return { ok: false, error: "already_running" };
  if (exporter.running) return { ok: false, error: "export_running" };

  const existing = await readSyncJob();
  if (existing?.status === "running" || existing?.status === "waiting_auth") {
    const resumed = await resumeSyncIfNeeded();
    return { ok: true, resumed: true, waitingAuth: resumed === "waiting_auth" };
  }

  const auth = await buildAuthContext();
  if (!auth.bearer && !auth.cookieHeader) {
    const focused = await focusSunoTab();
    await writeSyncJob({
      status: "waiting_auth",
      speed,
      lastError: null,
    });
    await armWatchdog(SYNC_ALARM);
    return {
      ok: false,
      error: "no_auth",
      hint: focused
        ? "Suno tab focused. Interact with the site; sync will resume when a Bearer arrives."
        : "Open suno.com while logged in; sync will resume when a Bearer arrives.",
    };
  }

  await writeSyncJob({ status: "running", speed, lastError: null });
  await armWatchdog(SYNC_ALARM);
  pumpSync(auth, speed);
  return { ok: true };
}

async function stopSync() {
  sync.cancel = true;
  const job = await readSyncJob();
  if (job?.status === "running" || job?.status === "waiting_auth") {
    await writeSyncJob({ ...job, status: "cancelled" });
  }
  await disarmWatchdog(SYNC_ALARM);
  return { ok: true };
}

async function resumeSyncIfNeeded() {
  if (sync.running) return "running";
  const job = await readSyncJob();
  if (!job || (job.status !== "running" && job.status !== "waiting_auth")) {
    return "idle";
  }

  const auth = await buildAuthContext();
  if (!auth.bearer && !auth.cookieHeader) {
    await writeSyncJob({ ...job, status: "waiting_auth" });
    await armWatchdog(SYNC_ALARM);
    await focusSunoTab();
    return "waiting_auth";
  }

  await writeSyncJob({ ...job, status: "running", lastError: null });
  await armWatchdog(SYNC_ALARM);
  pumpSync(auth, job.speed || "balanced");
  return "running";
}

function pumpSync(auth, speed) {
  sync.running = true;
  sync.cancel = false;
  sync.lastError = null;

  runSync(auth, speed)
    .catch(async (err) => {
      sync.lastError = String(err?.message || err);
      const job = (await readSyncJob()) || { speed };
      if (err instanceof AuthError) {
        await writeSyncJob({
          ...job,
          status: "waiting_auth",
          lastError: sync.lastError,
        });
        await armWatchdog(SYNC_ALARM);
        return;
      }
      await writeSyncJob({
        ...job,
        status: "failed",
        lastError: sync.lastError,
      });
      await disarmWatchdog(SYNC_ALARM);
    })
    .finally(() => {
      sync.running = false;
    });
}

async function runSync(auth, speed) {
  const delay = DELAY_MS[speed] ?? DELAY_MS.balanced;
  const prior = (await getSyncState("library")) || {};
  let cursor = prior.next_cursor || null;
  let page = prior.page ?? 0;
  let total = prior.accumulated || 0;

  while (!sync.cancel) {
    let pageResult;
    try {
      pageResult = await fetchFeedPage(auth, { cursor, page });
    } catch (err) {
      if (err instanceof RateLimitError) {
        await sleep(err.retryAfterMs);
        continue;
      }
      if (err instanceof AuthError) {
        clearBearer();
        throw err;
      }
      throw err;
    }

    if (pageResult.clips.length) {
      await putClips(pageResult.clips);
      total += pageResult.clips.length;
    }

    cursor = pageResult.nextCursor;
    page = pageResult.nextPage;

    await setSyncState("library", {
      next_cursor: cursor,
      page,
      last_batch: pageResult.clips.length,
      accumulated: total,
    });

    if (!pageResult.hasMore && !pageResult.nextCursor) break;
    if (!pageResult.clips.length) break;

    await sleep(delay);
  }

  const completed = !sync.cancel;
  await setSyncState("library", {
    next_cursor: cursor,
    page,
    last_batch: 0,
    accumulated: total,
    completed,
  });
  await writeSyncJob({
    status: completed ? "completed" : "cancelled",
    speed,
    lastError: null,
  });
  if (completed || sync.cancel) await disarmWatchdog(SYNC_ALARM);
}

async function startExport(msg) {
  if (exporter.running) return { ok: false, error: "export_running" };
  if (sync.running) return { ok: false, error: "sync_running" };
  const syncJob = await readSyncJob();
  if (syncJob?.status === "running" || syncJob?.status === "waiting_auth") {
    return { ok: false, error: "sync_running" };
  }

  const existing = await readExportJob();
  if (existing?.status === "running") {
    resumeExportIfNeeded();
    return { ok: true, resumed: true, total: existing.total };
  }

  const scope = msg.scope === "all" ? "all" : "recent";
  const limit = Number(msg.limit) || 12;
  const clips =
    scope === "all" ? await getAllClips() : await listClips(limit);

  if (!clips.length) {
    return { ok: false, error: "empty_index", hint: "Index the library first." };
  }

  const job = await writeExportJob({
    status: "running",
    dir: batchDir(),
    clipIds: clips.map((c) => c.id),
    nextIndex: 0,
    done: 0,
    failed: 0,
    total: clips.length,
    entries: [],
    options: {
      includeAudio: msg.includeAudio !== false,
      includeImage: Boolean(msg.includeImage),
      includeRaw: Boolean(msg.includeRaw),
    },
    speed: msg.speed || "balanced",
    lastError: null,
  });

  await armWatchdog(EXPORT_ALARM);
  pumpExport(job);
  return { ok: true, total: job.total, dir: job.dir };
}

async function stopExport() {
  exporter.cancel = true;
  const job = await readExportJob();
  if (job?.status === "running") {
    await writeExportJob({ ...job, status: "cancelled" });
  }
  await disarmWatchdog(EXPORT_ALARM);
  return { ok: true };
}

async function resumeExportIfNeeded() {
  if (exporter.running) return;
  const job = await readExportJob();
  if (!job || job.status !== "running") return;
  await armWatchdog(EXPORT_ALARM);
  pumpExport(job);
}

function pumpExport(job) {
  exporter.running = true;
  exporter.cancel = false;
  exporter.lastError = job.lastError || null;
  exporter.done = job.done || 0;
  exporter.failed = job.failed || 0;
  exporter.total = job.total || 0;

  runExport(job)
    .catch(async (err) => {
      exporter.lastError = String(err?.message || err);
      const latest = (await readExportJob()) || job;
      await writeExportJob({
        ...latest,
        status: "failed",
        lastError: exporter.lastError,
      });
    })
    .finally(() => {
      exporter.running = false;
    });
}

async function runExport(job) {
  const delay = DELAY_MS[job.speed] ?? DELAY_MS.balanced;
  const options = job.options || {};
  let nextIndex = job.nextIndex || 0;
  const entries = Array.isArray(job.entries) ? job.entries.slice() : [];

  while (nextIndex < job.clipIds.length) {
    if (exporter.cancel) {
      await writeExportJob({
        ...job,
        status: "cancelled",
        nextIndex,
        done: exporter.done,
        failed: exporter.failed,
        entries,
      });
      await disarmWatchdog(EXPORT_ALARM);
      return;
    }

    const clipId = job.clipIds[nextIndex];
    const clip = await getClip(clipId);
    if (!clip) {
      exporter.failed += 1;
      entries.push({ id: clipId, error: "missing_from_index" });
    } else {
      try {
        const curation = await getCuration(clip.id);
        const result = await exportClip(clip, curation || null, job.dir, options);
        entries.push(result);
        exporter.done += 1;
      } catch (err) {
        exporter.failed += 1;
        exporter.lastError = String(err?.message || err);
        entries.push({ id: clip.id, error: exporter.lastError });
      }
    }

    nextIndex += 1;
    await writeExportJob({
      ...job,
      status: "running",
      nextIndex,
      done: exporter.done,
      failed: exporter.failed,
      entries,
      lastError: exporter.lastError,
    });
    await sleep(delay);
  }

  await downloadJson(
    {
      schema: CATALOG_SCHEMA,
      exported_at: new Date().toISOString(),
      dir: job.dir,
      entries,
    },
    `${job.dir}/catalog.json`
  );

  await writeExportJob({
    ...job,
    status: "completed",
    nextIndex,
    done: exporter.done,
    failed: exporter.failed,
    entries,
  });
  await disarmWatchdog(EXPORT_ALARM);
}
