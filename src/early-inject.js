/**
 * document_start (isolated): inject page hooks before player scripts run.
 * Same approach as MAX VDL network sniffing.
 */
(function () {
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/injected.js");
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
