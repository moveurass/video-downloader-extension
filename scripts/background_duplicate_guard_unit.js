"use strict";

const assert = require("node:assert/strict");
const { createDuplicateGuard } = require("../src/background-duplicate-guard.js");

/**
 * Background paths (keyboard shortcuts, context menus) have no popup, so the
 * duplicate modal can't run. The guard must hold re-downloads and ask via a
 * notification; the notification's "그래도 받기" re-runs the stored starter.
 */
function makeChrome({ dup, warnDuplicates = true } = {}) {
  const listeners = { button: [], click: [], closed: [] };
  const created = [];
  const cleared = [];
  const state = {
    chrome: {
      runtime: { getURL: (p) => "/" + p, lastError: undefined },
      notifications: {
        create(id, opts, cb) {
          created.push({ id, opts });
          if (cb) cb();
        },
        clear(id, cb) {
          cleared.push(id);
          if (cb) cb();
        },
        onButtonClicked: { addListener: (fn) => listeners.button.push(fn) },
        onClicked: { addListener: (fn) => listeners.click.push(fn) },
        onClosed: { addListener: (fn) => listeners.closed.push(fn) }
      }
    },
    UVD: {
      getSettings: async () => ({ warnDuplicates }),
      findDuplicateDone: async () => (dup ? { ...dup } : null)
    },
    created,
    cleared,
    fireButton(id, index) {
      listeners.button.forEach((fn) => fn(id, index));
    },
    fireClick(id) {
      listeners.click.forEach((fn) => fn(id));
    },
    fireClosed(id) {
      listeners.closed.forEach((fn) => fn(id));
    }
  };
  return state;
}

function makeGuard(state) {
  const guard = createDuplicateGuard({
    chrome: state.chrome,
    UVD: state.UVD,
    setTimeout: () => {},
    console
  });
  guard.bind();
  return guard;
}

const DUP = {
  title: "테스트 영상",
  at: "2026-09-15T12:00:00Z",
  path: "/tmp/x.mp4",
  downloadId: 7
};

async function main() {
  // 1) No duplicate: proceed, nothing shown.
  const c1 = makeChrome();
  const guard1 = makeGuard(c1);
  const started1 = [];
  assert.equal(
    await guard1.allowOrAsk("https://youtu.be/abc123", {
      starter: () => started1.push(1)
    }),
    true
  );
  assert.equal(c1.created.length, 0);
  assert.equal(started1.length, 0);

  // 2) Duplicate: blocked + notification; "그래도 받기" re-runs the starter.
  const c2 = makeChrome({ dup: DUP });
  const guard2 = makeGuard(c2);
  const started2 = [];
  assert.equal(
    await guard2.allowOrAsk("https://youtu.be/abc123", {
      title: "페이지 제목",
      starter: () => started2.push(1)
    }),
    false
  );
  assert.equal(c2.created.length, 1);
  assert.match(c2.created[0].opts.title, /이미 받은 영상/);
  assert.match(c2.created[0].opts.message, /테스트 영상/);
  assert.match(c2.created[0].opts.message, /그래도 받기/);
  assert.equal(started2.length, 0);
  c2.fireButton(c2.created[0].id, 0);
  assert.equal(started2.length, 1, "accept button re-runs the download");
  c2.fireButton(c2.created[0].id, 0);
  assert.equal(started2.length, 1, "starter runs exactly once");

  // 3) "취소" (index 1) does not re-run.
  const c3 = makeChrome({ dup: DUP });
  const guard3 = makeGuard(c3);
  const started3 = [];
  await guard3.allowOrAsk("https://youtu.be/abc123", { starter: () => started3.push(1) });
  c3.fireButton(c3.created[0].id, 1);
  assert.equal(started3.length, 0);

  // 4) Body click (no-button platforms) also re-runs.
  const c4 = makeChrome({ dup: DUP });
  const guard4 = makeGuard(c4);
  const started4 = [];
  await guard4.allowOrAsk("https://youtu.be/abc123", { starter: () => started4.push(1) });
  c4.fireClick(c4.created[0].id);
  assert.equal(started4.length, 1);

  // 5) Setting off: always proceed even with a duplicate.
  const c5 = makeChrome({ dup: DUP, warnDuplicates: false });
  const guard5 = makeGuard(c5);
  assert.equal(await guard5.allowOrAsk("https://youtu.be/abc123"), true);
  assert.equal(c5.created.length, 0);

  console.log("background duplicate guard: hold + notification override passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
