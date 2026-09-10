(function initPopupStorageUI(root, factory) {
  const api = factory();
  root.UVDPopupStorageUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(
  typeof globalThis !== "undefined" ? globalThis : self,
  function makePopupStorageUI() {
    "use strict";

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}GB`;
      if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)}MB`;
      if (value >= 1024) return `${Math.round(value / 1024)}KB`;
      return `${value}B`;
    }

    function formatDate(mtime) {
      const date = new Date(Number(mtime) * 1000);
      if (Number.isNaN(date.getTime())) return "";
      return `${String(date.getFullYear()).slice(2)}.${String(
        date.getMonth() + 1
      ).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
    }

    function createController(deps) {
      const { $, document, sendMessage, getHistoryItems, toast, escapeHtml, escapeAttr } =
        deps;
      let files = [];
      let loaded = false;
      let armed = false;
      let sortMode = "recent";
      let errorText = "";

      function basename(path) {
        return String(path || "").split(/[/\\]/).pop();
      }

      /** History lookup by filename gives title/series labels for rows. */
      function historyFor(name) {
        for (const item of getHistoryItems?.() || []) {
          if (basename(item.path || item.filename) === name) return item;
        }
        return null;
      }

      function sorted() {
        const list = files.slice();
        if (sortMode === "size") {
          list.sort((a, b) => (b.size || 0) - (a.size || 0));
        } else {
          list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        }
        return list;
      }

      function render() {
        const wrap = $("#storageSection");
        const listEl = $("#storageList");
        const summary = $("#storageSummary");
        if (!wrap || !listEl) return;
        if (!loaded) {
          wrap.classList.add("hidden");
          return;
        }
        wrap.classList.remove("hidden");
        if (errorText) {
          if (summary) summary.textContent = "저장 폴더를 읽을 수 없습니다";
          listEl.innerHTML = `<li class="storage-item is-empty">저장 폴더 접근 권한이 필요합니다 —<br>시스템 설정 &gt; 개인정보 보호 및 보안 &gt; 파일 및 폴더에서<br>python3의 다운로드 폴더 접근을 허용해 주세요</li>`;
          updateButtons();
          return;
        }
        const total = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
        wrap.classList.remove("hidden");
        if (summary) {
          summary.textContent = `파일 ${files.length}개 · 총 ${formatBytes(total)}`;
        }
        listEl.innerHTML = sorted()
          .map((file) => {
            const history = historyFor(file.name);
            const label = history?.title || "";
            const series = history?.seriesKey || history?.seriesPrefix || "";
            const badge = series
              ? `<span class="storage-series">${escapeHtml(String(series))}</span>`
              : "";
            const sub = [formatBytes(file.size), formatDate(file.mtime)]
              .filter(Boolean)
              .join(" · ");
            return `<li class="storage-item" data-path="${escapeAttr(file.path)}">
              <input type="checkbox" class="storage-check" data-path="${escapeAttr(file.path)}" />
              <span class="storage-name" title="${escapeAttr(file.name)}">${escapeHtml(
                file.name
              )}</span>
              ${badge}
              <span class="storage-sub">${escapeHtml(
                label && label !== file.name ? `${sub} · ${label}` : sub
              )}</span>
            </li>`;
          })
          .join("");
        updateButtons();
      }

      function selectedPaths() {
        return [...document.querySelectorAll(".storage-check:checked")].map(
          (el) => el.getAttribute("data-path")
        );
      }

      function updateButtons() {
        const countEl = $("#storageCount");
        const button = $("#btnStorageTrash");
        const n = selectedPaths().length;
        if (countEl) countEl.textContent = n ? `${n}개 선택` : "";
        if (button) {
          button.classList.toggle("armed", armed && n > 0);
          button.textContent = armed
            ? `${n}개 삭제 확인`
            : "선택 항목 휴지통으로";
          button.disabled = n === 0;
        }
      }

      async function load() {
        let response = null;
        try {
          response = await sendMessage({ type: "FILES_LIST" });
        } catch {
          response = null; // helper down — hide quietly
        }
        files = Array.isArray(response?.files) ? response.files : [];
        errorText = response?.ok ? "" : String(response?.error || "");
        loaded = response != null;
        armed = false;
        render();
        if (loaded && !errorText && files.length === 0) {
          const empty = $("#storageList");
          if (empty) {
            empty.innerHTML = `<li class="storage-item is-empty">저장 폴더가 비어 있습니다</li>`;
          }
        }
      }

      function setSort(mode) {
        sortMode = mode === "size" ? "size" : "recent";
        render();
      }

      async function trashSelected() {
        const paths = selectedPaths();
        if (!paths.length) return;
        if (!armed) {
          armed = true;
          updateButtons();
          return;
        }
        const response = await sendMessage({ type: "FILES_TRASH", paths });
        armed = false;
        if (response?.trashed > 0) {
          toast(`${response.trashed}개를 휴지통으로 이동했습니다`, "ok");
        } else {
          toast("삭제하지 못했습니다", "error");
        }
        await load().catch(() => {});
      }

      function bind() {
        $("#btnStorageRefresh")?.addEventListener("click", () => {
          load().catch(() => {});
        });
        $("#storageSort")?.addEventListener("change", (event) => {
          setSort(event.target?.value);
        });
        $("#btnStorageTrash")?.addEventListener("click", () => {
          trashSelected().catch(() => {});
        });
        document
          .querySelector("#storageList")
          ?.addEventListener("change", (event) => {
            if (event.target?.classList?.contains("storage-check")) {
              armed = false;
              updateButtons();
            }
          });
      }

      return { load, bind, setSort, render, formatBytes };
    }

    return { createController, formatBytes };
  }
);
