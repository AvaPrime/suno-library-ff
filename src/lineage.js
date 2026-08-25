/**
 * Cover / extend / mashup lineage.
 *
 * Feed records hide the parent under several keys. Cover used to be dropped
 * because only continue_clip_id / original_clip_id were read.
 * Immediate parent wins over the original-root pointer.
 */

/**
 * @param {...unknown} values
 * @returns {string | null}
 */
export function firstDefined(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    return String(value);
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function idList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item == null || item === "") continue;
    const id = String(item);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * @typedef {{ parent_id: string, kind: string }} LineageParent
 * @typedef {{ parent_id: string | null, kind: string | null, extra_parents: LineageParent[] }} Lineage
 */

/**
 * Pick the immediate parent and remix kind from a feed/raw clip.
 *
 * @param {unknown} raw
 * @returns {Lineage}
 */
export function lineageFromRaw(raw) {
  const empty = { parent_id: null, kind: null, extra_parents: [] };
  if (!raw || typeof raw !== "object") return empty;

  const record = /** @type {Record<string, unknown>} */ (raw);
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (record.metadata)
      : {};

  const cover = firstDefined(
    metadata.cover_clip_id,
    record.cover_clip_id,
    metadata.cover_audio_id,
    record.cover_audio_id,
  );
  const cont = firstDefined(metadata.continue_clip_id, record.continue_clip_id);
  const original = firstDefined(metadata.original_clip_id, record.original_clip_id);
  const additional = firstDefined(
    metadata.additional_audio_id,
    record.additional_audio_id,
  );
  const mashupIds = [
    ...idList(metadata.mashup_clip_ids),
    ...idList(record.mashup_clip_ids),
  ];
  if (additional && !mashupIds.includes(additional)) mashupIds.push(additional);

  const task = String(metadata.task || record.task || "").toLowerCase();
  const isRemix = metadata.is_remix === true || record.is_remix === true;

  if (task === "mashup" || mashupIds.length) {
    const unique = [...new Set(mashupIds)];
    if (unique.length) {
      return {
        parent_id: unique[0],
        kind: "mashup",
        extra_parents: unique.slice(1).map((id) => ({ parent_id: id, kind: "mashup" })),
      };
    }
  }

  if (task === "infill" && cont) {
    return { parent_id: cont, kind: "infill", extra_parents: [] };
  }

  if (task === "extend" && cont) {
    return { parent_id: cont, kind: "extend", extra_parents: [] };
  }

  if (task === "cover" || isRemix) {
    if (cover) return { parent_id: cover, kind: "cover", extra_parents: [] };
    if (cont) return { parent_id: cont, kind: "cover", extra_parents: [] };
  }

  if (cover) return { parent_id: cover, kind: "cover", extra_parents: [] };
  if (cont) return { parent_id: cont, kind: "extend", extra_parents: [] };
  if (original) return { parent_id: original, kind: "original", extra_parents: [] };
  return empty;
}

/**
 * @param {string} kind
 * @param {string} parentId
 * @param {string} childId
 */
export function edgeId(kind, parentId, childId) {
  return `${kind}:${parentId}->${childId}`;
}

/**
 * @param {{ id?: string, parent_id?: string | null, parent_kind?: string | null, extra_parents?: LineageParent[] }} clip
 * @returns {{ id: string, parent_id: string, child_id: string, kind: string }[]}
 */
export function edgesFromClip(clip) {
  if (!clip?.id) return [];
  const child = String(clip.id);
  /** @type {{ id: string, parent_id: string, child_id: string, kind: string }[]} */
  const rows = [];
  const seen = new Set();

  const push = (parentId, kind) => {
    if (!parentId) return;
    const parent = String(parentId);
    if (parent === child) return;
    const edgeKind = kind || "unknown";
    const id = edgeId(edgeKind, parent, child);
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({ id, parent_id: parent, child_id: child, kind: edgeKind });
  };

  push(clip.parent_id, clip.parent_kind);
  for (const extra of clip.extra_parents || []) {
    push(extra?.parent_id, extra?.kind);
  }
  return rows;
}
