/**
 * document_start: inject page hooks before player scripts.
 * SKIP TikTok/YouTube — MSE/fetch hooks break their players.
 */
(function () {
  try {
    const host = (location.hostname || "").toLowerCase();
    if (
      host.includes("tiktok.com") ||
      host.includes("tiktokv.com") ||
      host.includes("youtube.com") ||
      host === "youtu.be" ||
      host.includes("youtube-nocookie.com") ||
      host.includes("instagram.com") ||
      host.includes("instagr.am")
    ) {
      return;
    }
    if (!globalThis.__UVD_BRIDGE_NONCE) {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      globalThis.__UVD_BRIDGE_NONCE = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
    }
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/injected.js") + "#" + globalThis.__UVD_BRIDGE_NONCE;
    s.async = false;
    s.onload = () => {
      try {
        s.remove();
      } catch {
        /* ignore */
      }
    };
    const root = document.documentElement || document.head || document;
    root.appendChild(s);
  } catch {
    /* ignore */
  }
})();
