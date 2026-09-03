(function initPopupSound(root, factory) {
  const api = factory();
  root.UVDPopupSound = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupSound() {
    "use strict";

    /** Two-note rise (A5 → E6): short, soft, and clearly "finished". */
    const TONES = [
      { frequency: 880, offset: 0, duration: 0.16 },
      { frequency: 1318.51, offset: 0.1, duration: 0.26 }
    ];
    const PEAK_GAIN = 0.12;
    const SILENCE = 0.0001;

    function createController(deps = {}) {
      const { getSettings } = deps;
      const AudioCtor =
        deps.AudioContext ||
        (typeof globalThis !== "undefined"
          ? globalThis.AudioContext || globalThis.webkitAudioContext
          : null);
      let audio = null;

      function ensureContext() {
        if (audio) return audio;
        if (typeof AudioCtor !== "function") return null;
        try {
          audio = new AudioCtor();
        } catch {
          audio = null;
        }
        return audio;
      }

      function isEnabled() {
        try {
          return getSettings?.()?.completionSound === true;
        } catch {
          return false;
        }
      }

      function playChime() {
        const context = ensureContext();
        if (!context) return false;
        try {
          // Popups open suspended until the page has user activation.
          if (context.state === "suspended") {
            context.resume?.()?.catch?.(() => {});
          }
          const start = (context.currentTime || 0) + 0.01;
          for (const tone of TONES) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const at = start + tone.offset;
            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(tone.frequency, at);
            gain.gain.setValueAtTime(SILENCE, at);
            gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + 0.02);
            gain.gain.exponentialRampToValueAtTime(SILENCE, at + tone.duration);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start(at);
            oscillator.stop(at + tone.duration + 0.02);
          }
          return true;
        } catch {
          return false;
        }
      }

      function playCompletion() {
        if (!isEnabled()) return false;
        return playChime();
      }

      function close() {
        if (!audio) return;
        try {
          audio.close?.();
        } catch {
          /* ignore */
        }
        audio = null;
      }

      return { isEnabled, playChime, playCompletion, close };
    }

    return { createController, TONES };
  }
);
