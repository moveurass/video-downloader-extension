"use strict";

const assert = require("node:assert/strict");
const StorageUI = require("../src/popup-storage-ui.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}
function ok(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

function element() {
  const el = {
    textContent: "",
    innerHTML: "",
    hidden: true,
    disabled: false,
    classes: new Set(),
    listeners: {},
    value: "recent",
    addEventListener(type, fn) {
      el.listeners[type] = fn;
    },
    classList: {
      add(name) {
        el.classes.add(name);
      },
      remove(name) {
        el.classes.delete(name);
      },
      toggle(name, on) {
        on ? el.classes.add(name) : el.classes.delete(name);
      },
      contains(name) {
        return el.classes.has(name);
      }
    }
  };
  return el;
}

function makeHarness({ files = [], history = [], failList = false, listError = null } = {}) {
  const elements = {
    storageSection: element(),
    storageList: element(),
    storageSummary: element(),
    storageCount: element(),
    btnStorageRefresh: element(),
    storageSort: element(),
    btnStorageTrash: element()
  };
  const messages = [];
  const toasts = [];
  let checkedPaths = [];

  const fakeDocument = {
    querySelector: (selector) =>
      selector === "#storageList" ? elements.storageList : null,
    querySelectorAll: (selector) => {
      if (selector !== ".storage-check:checked") return [];
      return checkedPaths.map(
        (path) =>
          ({
            getAttribute: (name) => (name === "data-path" ? path : null),
            classList: { contains: (name) => name === "storage-check" }
          })
      );
    }
  };

  const controller = StorageUI.createController({
    $: (selector) => elements[selector.replace(/^#/, "")] || null,
    document: fakeDocument,
    sendMessage: async (message) => {
      messages.push(message);
      if (message.type === "FILES_LIST") {
        if (failList) throw new Error("offline");
        if (listError) return { ok: false, files: [], error: listError };
        return { ok: true, files };
      }
      if (message.type === "FILES_TRASH") {
        return { ok: true, trashed: message.paths.length, results: [] };
      }
      return {};
    },
    getHistoryItems: () => history,
    toast: (...args) => toasts.push(args),
    escapeHtml: String,
    escapeAttr: String
  });

  return {
    controller,
    elements,
    messages,
    toasts,
    setChecked(paths) {
      checkedPaths = paths;
    }
  };
}

async function main() {
  // Helper failure / before load → section stays hidden, no throw.
  {
    const hidden = makeHarness({ failList: true });
    await hidden.controller.load();
    ok(
      hidden.elements.storageSection.classes.has("hidden"),
      "helper failure keeps the section hidden"
    );
  }

  // Permission error from the helper → visible section with guidance.
  {
    const denied = makeHarness({
      listError: "저장 폴더를 읽을 수 없습니다: [Errno 1] Operation not permitted"
    });
    await denied.controller.load();
    check(
      denied.elements.storageSection.classes.has("hidden"),
      false,
      "permission error keeps the section visible"
    );
    ok(
      denied.elements.storageList.innerHTML.includes("파일 및 폴더"),
      "permission error shows the grant guidance"
    );
  }

  // Happy path: list renders recent-first with history join.
  const h = makeHarness({
    files: [
      { path: "/d/VideoDownloader/b.mp4", name: "b.mp4", size: 2000, mtime: 200 },
      { path: "/d/VideoDownloader/a.mp4", name: "a.mp4", size: 1000, mtime: 300 }
    ],
    history: [{ title: "A 제목", filename: "a.mp4", seriesKey: "SNOS" }]
  });
  await h.controller.load();
  check(
    h.elements.storageSection.classes.has("hidden"),
    false,
    "section shown after load"
  );
  check(
    h.elements.storageSummary.textContent,
    "파일 2개 · 총 3KB",
    "summary aggregates count and bytes"
  );
  ok(
    h.elements.storageList.innerHTML.indexOf("a.mp4") <
      h.elements.storageList.innerHTML.indexOf("b.mp4"),
    "recent-first ordering"
  );
  ok(
    h.elements.storageList.innerHTML.includes("SNOS") &&
      h.elements.storageList.innerHTML.includes("A 제목"),
    "history join adds series badge and title"
  );

  // Size sort flips the order.
  h.controller.setSort("size");
  ok(
    h.elements.storageList.innerHTML.indexOf("b.mp4") <
      h.elements.storageList.innerHTML.indexOf("a.mp4"),
    "size sort puts the bigger file first"
  );
  h.controller.bind();

  // Delete flow: arm (first click) → confirm (second click) → FILES_TRASH.
  h.setChecked(["/d/VideoDownloader/a.mp4"]);
  h.elements.storageList.listeners.change({
    target: { classList: { contains: () => true } }
  });
  h.elements.btnStorageTrash.listeners.click();
  check(
    h.messages.filter((m) => m.type === "FILES_TRASH").length,
    0,
    "first click only arms"
  );
  ok(
    h.elements.btnStorageTrash.textContent.includes("삭제 확인"),
    "armed button asks for confirmation"
  );
  await h.elements.btnStorageTrash.listeners.click();
  const trash = h.messages.find((m) => m.type === "FILES_TRASH");
  check(trash.paths, ["/d/VideoDownloader/a.mp4"], "confirm trashes selection");
  check(
    h.toasts.at(-1),
    ["1개를 휴지통으로 이동했습니다", "ok"],
    "success toast"
  );
  check(
    h.messages.filter((m) => m.type === "FILES_LIST").length,
    2,
    "list refreshes after trash"
  );

  console.log(`popup storage ui unit: ${assertions} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
