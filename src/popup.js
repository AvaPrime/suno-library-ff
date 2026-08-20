const $ = (id) => document.getElementById(id);

async function send(msg) {
  return browser.runtime.sendMessage(msg);
}

function fmtTime(iso) {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function refresh() {
  const status = await send({ type: "GET_STATUS" });
  $("auth").textContent = status.auth ? "bearer present" : "missing — open suno.com";
  $("clips").textContent = String(status.clipCount ?? 0);
  $("sync").textContent = status.syncStatus || (status.running ? "running" : "idle");
  $("last").textContent = fmtTime(status.lastSyncAt);

  const exp = status.export || {};
  const exportLine = $("export-status");
  if (exp.running || exp.status === "running") {
    exportLine.textContent = `Export ${exp.status || "running"} ${exp.done}/${exp.total} · failed ${exp.failed}`;
  } else if (exp.status && exp.status !== "idle") {
    exportLine.textContent = `Export ${exp.status} ${exp.done}/${exp.total} · failed ${exp.failed}`;
  } else {
    exportLine.textContent = "Export idle. Files go to Downloads/suno-library-ff/";
  }

  const err = $("error");
  if (status.lastError) {
    err.hidden = false;
    err.textContent = status.lastError;
  } else {
    err.hidden = true;
    err.textContent = "";
  }

  const clips = await send({ type: "LIST_CLIPS", limit: 12 });
  const list = $("recent");
  list.replaceChildren();
  for (const clip of clips || []) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = clip.title || clip.id;
    const meta = document.createElement("span");
    meta.textContent = [clip.model_name, clip.created_at].filter(Boolean).join(" · ");
    li.append(title, meta);
    list.append(li);
  }
}

$("start").addEventListener("click", async () => {
  const result = await send({ type: "START_SYNC", speed: $("speed").value });
  if (!result?.ok) {
    $("error").hidden = false;
    $("error").textContent = result?.hint || result?.error || "sync failed";
  }
  await refresh();
});

$("stop").addEventListener("click", async () => {
  await send({ type: "STOP_SYNC" });
  await refresh();
});

$("export").addEventListener("click", async () => {
  const result = await send({
    type: "START_EXPORT",
    scope: $("scope").value,
    speed: $("speed").value,
    includeAudio: true,
    includeImage: $("include-image").checked,
    includeRaw: $("include-raw").checked,
  });
  if (!result?.ok) {
    $("error").hidden = false;
    $("error").textContent = result?.hint || result?.error || "export failed";
  }
  await refresh();
});

$("stop-export").addEventListener("click", async () => {
  await send({ type: "STOP_EXPORT" });
  await refresh();
});

refresh();
setInterval(refresh, 1500);
