/**
 * MAIN-world hook. Intercepts page fetch/XHR Authorization headers.
 * Does not persist tokens. Forwards a copy to the isolated bridge via postMessage.
 */
(() => {
  const SOURCE = "suno-library-ff-hook";

  function extractAuth(headers) {
    if (!headers) return null;
    if (headers instanceof Headers) {
      return headers.get("Authorization") || headers.get("authorization");
    }
    if (Array.isArray(headers)) {
      const hit = headers.find(([k]) => String(k).toLowerCase() === "authorization");
      return hit ? hit[1] : null;
    }
    if (typeof headers === "object") {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === "authorization") return v;
      }
    }
    return null;
  }

  function publish(headerValue) {
    if (typeof headerValue !== "string") return;
    const token = headerValue.replace(/^Bearer\s+/i, "").trim();
    if (!token) return;
    window.postMessage({ source: SOURCE, type: "BEARER", token }, location.origin);
  }

  const origFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    try {
      const fromInit = extractAuth(init?.headers);
      if (fromInit) publish(fromInit);
      else if (input instanceof Request) {
        const fromReq = input.headers.get("Authorization");
        if (fromReq) publish(fromReq);
      }
    } catch {
      /* never break the page */
    }
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function patchedOpen() {
    this.__slffAuth = null;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function patchedSet(name, value) {
    if (String(name).toLowerCase() === "authorization") this.__slffAuth = value;
    return origSetHeader.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function patchedSend() {
    if (this.__slffAuth) publish(this.__slffAuth);
    return origSend.apply(this, arguments);
  };
})();
