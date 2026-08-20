/**
 * Isolated-world bridge. Receives MAIN-world tokens and forwards them
 * to the background worker. Tokens are not written to page storage.
 */

const SOURCE = "suno-library-ff-hook";

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.source !== SOURCE || data.type !== "BEARER") return;
  if (typeof data.token !== "string") return;

  browser.runtime.sendMessage({ type: "AUTH_TOKEN", token: data.token }).catch(() => {
    /* background may be asleep; next request will retry */
  });
});
