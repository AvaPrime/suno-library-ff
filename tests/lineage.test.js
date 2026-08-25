import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  edgeId,
  edgesFromClip,
  firstDefined,
  lineageFromRaw,
} from "../src/lineage.js";
import { normalizeClip } from "../src/suno-api.js";

describe("lineageFromRaw", () => {
  it("reads cover_clip_id before continue_clip_id", () => {
    const lineage = lineageFromRaw({
      id: "child",
      metadata: {
        cover_clip_id: "cover-parent",
        continue_clip_id: "extend-parent",
        original_clip_id: "root",
        is_remix: true,
      },
    });
    assert.equal(lineage.parent_id, "cover-parent");
    assert.equal(lineage.kind, "cover");
  });

  it("reads cover_audio_id from official-style metadata", () => {
    const lineage = lineageFromRaw({
      metadata: { cover_audio_id: "api-parent" },
    });
    assert.equal(lineage.parent_id, "api-parent");
    assert.equal(lineage.kind, "cover");
  });

  it("classifies extend from task + continue_clip_id", () => {
    const lineage = lineageFromRaw({
      task: "extend",
      continue_clip_id: "prefix",
      metadata: { original_clip_id: "root" },
    });
    assert.equal(lineage.parent_id, "prefix");
    assert.equal(lineage.kind, "extend");
  });

  it("classifies infill without treating it as cover", () => {
    const lineage = lineageFromRaw({
      metadata: { task: "infill", continue_clip_id: "host" },
    });
    assert.equal(lineage.kind, "infill");
    assert.equal(lineage.parent_id, "host");
  });

  it("fans mashup parents into extra_parents", () => {
    const lineage = lineageFromRaw({
      task: "mashup",
      mashup_clip_ids: ["a", "b", "a"],
      additional_audio_id: "c",
    });
    assert.equal(lineage.kind, "mashup");
    assert.equal(lineage.parent_id, "a");
    assert.deepEqual(
      lineage.extra_parents.map((p) => p.parent_id),
      ["b", "c"],
    );
  });

  it("falls back to original_clip_id", () => {
    const lineage = lineageFromRaw({ original_clip_id: "root" });
    assert.equal(lineage.parent_id, "root");
    assert.equal(lineage.kind, "original");
  });

  it("returns empty for a root clip", () => {
    const lineage = lineageFromRaw({ id: "root", title: "Foundation" });
    assert.equal(lineage.parent_id, null);
    assert.equal(lineage.kind, null);
    assert.deepEqual(lineage.extra_parents, []);
  });
});

describe("edgesFromClip", () => {
  it("skips self-loops and duplicates", () => {
    const edges = edgesFromClip({
      id: "same",
      parent_id: "same",
      parent_kind: "cover",
      extra_parents: [
        { parent_id: "other", kind: "cover" },
        { parent_id: "other", kind: "cover" },
      ],
    });
    assert.equal(edges.length, 1);
    assert.equal(edges[0].id, edgeId("cover", "other", "same"));
    assert.equal(edges[0].child_id, "same");
  });
});

describe("normalizeClip", () => {
  it("stamps parent_kind cover from metadata.cover_clip_id", () => {
    const clip = normalizeClip({
      id: "child-1",
      title: "Low Light — Escalation",
      metadata: {
        prompt: "score",
        tags: "sparse",
        cover_clip_id: "foundation-1",
        is_remix: true,
      },
    });
    assert.equal(clip.parent_id, "foundation-1");
    assert.equal(clip.parent_kind, "cover");
    const edges = edgesFromClip(clip);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].kind, "cover");
    assert.equal(edges[0].parent_id, "foundation-1");
    assert.equal(edges[0].child_id, "child-1");
  });

  it("does not invent a parent when none is present", () => {
    const clip = normalizeClip({ id: "root", title: "Foundation" });
    assert.equal(clip.parent_id, null);
    assert.deepEqual(edgesFromClip(clip), []);
  });
});

describe("firstDefined", () => {
  it("skips null and empty strings", () => {
    assert.equal(firstDefined(null, "", "kept"), "kept");
  });
});
