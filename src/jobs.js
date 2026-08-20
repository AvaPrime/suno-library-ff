/**
 * Durable job records in sync_state.
 * RAM flags are a lock. IDB is the source of truth after event-page death.
 */

import { getSyncState, setSyncState } from "./idb.js";

export const EXPORT_ALARM = "export-watchdog";
export const SYNC_ALARM = "sync-watchdog";

export async function readExportJob() {
  return (await getSyncState("export")) || null;
}

export async function writeExportJob(job) {
  await setSyncState("export", job);
  return job;
}

export async function readSyncJob() {
  return (await getSyncState("sync_job")) || null;
}

export async function writeSyncJob(job) {
  await setSyncState("sync_job", job);
  return job;
}

export async function armWatchdog(name) {
  await browser.alarms.create(name, { periodInMinutes: 1 });
}

export async function disarmWatchdog(name) {
  await browser.alarms.clear(name);
}
