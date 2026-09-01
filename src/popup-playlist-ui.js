(function initPopupPlaylistUi(root, factory) {
  const api = factory();
  root.UVDPopupPlaylistUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function makePlaylistUi() {
  "use strict";

  function createController(deps) {
    function hide() {
      deps.setInfo(null);
      deps.$("#playlistBox")?.classList.add("hidden");
    }

    function render() {
      const box = deps.$("#playlistBox");
      if (!box) return;
      const info = deps.getInfo();
      const loading = deps.getLoading();
      if (!info?.entries?.length && !loading) {
        box.classList.add("hidden");
        return;
      }
      box.classList.remove("hidden");
      const title = deps.$("#plTitle");
      const count = deps.$("#plCount");
      if (loading && !info) {
        if (title) title.textContent = "재생목록 불러오는 중…";
        if (count) count.textContent = "";
        return;
      }
      if (title) title.textContent = info.title || "재생목록";
      if (count) {
        const visible = info.entries?.length || 0;
        const total = info.playlistCount || visible;
        count.textContent = total > visible
          ? `${visible}개 · 전체 약 ${total}개`
          : `${visible}개 영상`;
      }
      updateProgress();
    }

    function updateProgress() {
      const bar = deps.$("#plProgress");
      const fill = deps.$("#plProgressFill");
      const text = deps.$("#plProgressText");
      if (!bar) return;
      const state = deps.getDownload();
      if (!state.active) {
        if (state.jobIds.size) {
          let done = 0;
          let running = 0;
          for (const id of state.jobIds) {
            const job = deps.jobs.get(id);
            if (!job) continue;
            if (["done", "error", "cancelled"].includes(job.status)) done += 1;
            else if (["running", "paused"].includes(job.status)) running += 1;
          }
          const total = state.total || state.jobIds.size;
          if (done + running > 0 && done < total) {
            bar.classList.remove("hidden");
            if (fill) fill.style.width = `${Math.round((done / total) * 100)}%`;
            if (text) {
              text.textContent = `목록 진행 ${done}/${total}${
                running ? ` · 받는 중 ${running}` : ""
              }`;
            }
            return;
          }
          if (done >= total && total > 0) {
            bar.classList.remove("hidden");
            if (fill) fill.style.width = "100%";
            if (text) text.textContent = `목록 완료 ${done}/${total}`;
            state.active = false;
            return;
          }
        }
        bar.classList.add("hidden");
        return;
      }
      bar.classList.remove("hidden");
      const total = state.total || 1;
      if (fill) fill.style.width = `${Math.round(((state.done || 0) / total) * 100)}%`;
      if (text) text.textContent = `시작 중… ${state.done || 0}/${total}`;
    }

    async function load(url, force = false) {
      const target = url || deps.getCurrentTabUrl() || "";
      if (!target || !deps.UVD.isPlaylistOnlyUrl(target)) {
        if (target && deps.UVD.isWatchInPlaylistUrl?.(target)) {
          try {
            const listId = new URL(target).searchParams.get("list");
            if (listId) {
              return load(`https://www.youtube.com/playlist?list=${listId}`, force);
            }
          } catch {
            // Hide invalid playlist URLs below.
          }
        }
        hide();
        return null;
      }
      const current = deps.getInfo();
      if (!force && current?.url === target && current.entries?.length) {
        render();
        return current;
      }
      deps.setLoading(true);
      render();
      try {
        await deps.refreshHelperStatus(true);
        if (!deps.getHelperOk()) {
          deps.setInfo({
            url: target,
            title: "재생목록 (도우미 필요)",
            entries: [],
            playlistCount: 0
          });
          deps.setLoading(false);
          render();
          deps.toast("재생목록은 로컬 도우미가 필요합니다", "error");
          return null;
        }
        const response = await deps.sendMessage({
          type: "LIST_PLAYLIST",
          pageUrl: target,
          max: 200
        });
        if (!response?.ok) {
          throw new Error(response?.error || "재생목록을 불러오지 못했습니다");
        }
        const info = {
          url: target,
          title: response.title || "재생목록",
          entries: response.entries || [],
          playlistCount: response.playlistCount || response.count || 0
        };
        deps.setInfo(info);
        deps.setLoading(false);
        render();
        if (info.entries.length) {
          deps.openSeriesFromPlaylist(info, { quiet: true }).catch(() => {});
        }
        return info;
      } catch (error) {
        deps.setLoading(false);
        hide();
        deps.toast(deps.userError(error?.message) || "재생목록 조회 실패", "error");
        return null;
      }
    }

    function maxCount() {
      const pending = deps.getSeriesPending();
      const range = pending?.mode === "playlist"
        ? pending.rangePref || deps.getSeriesRangePref()
        : deps.getSeriesRangePref();
      return deps.seriesRangeLimit(range);
    }

    async function selectForDownload() {
      const info = deps.getInfo();
      if (!info?.entries?.length) {
        deps.toast("재생목록이 비어 있습니다", "error");
        return;
      }
      await deps.openSeriesFromPlaylist(info);
    }

    async function downloadAll() {
      const info = deps.getInfo();
      if (!info?.entries?.length) {
        deps.toast("재생목록이 비어 있습니다", "error");
        return;
      }
      const pending = deps.getSeriesPending();
      if (
        pending?.mode === "playlist" &&
        pending.items?.some((item) => item.selected !== false)
      ) {
        await deps.runSeriesComplete();
        return;
      }
      await deps.refreshHelperStatus(true);
      if (!deps.getHelperOk()) {
        deps.toast("재생목록 받기에는 도우미가 필요합니다", "error");
        return;
      }
      const entries = info.entries.slice(0, maxCount());
      const button = deps.$("#btnPlDownload");
      if (button) {
        button.disabled = true;
        button.textContent = "시작…";
      }
      const state = { active: true, total: entries.length, done: 0, jobIds: new Set() };
      deps.setDownload(state);
      updateProgress();
      let seriesId = "";
      try {
        const listId = new URL(info.url).searchParams.get("list");
        seriesId = listId
          ? `series:pl:${listId}`
          : `series:pl:${deps.UVD.normalizeUrlKey(info.url)}`;
      } catch {
        seriesId = `series:pl:${Date.now()}`;
      }
      deps.setLastSeriesRun({
        seriesId,
        title: info.title || "",
        mode: "playlist"
      });
      try {
        const response = await deps.sendMessage({
          type: "DOWNLOAD_PLAYLIST",
          pageUrl: info.url,
          title: info.title,
          entries,
          max: entries.length,
          tabId: deps.getCurrentTabId(),
          preferQuality: deps.getSelectedQuality() || "best",
          seriesId
        });
        if (!response?.ok) throw new Error(response?.error || "재생목록 받기 실패");
        for (const id of response.jobIds || []) {
          state.jobIds.add(id);
          deps.trackedJobIds.add(id);
        }
        state.active = true;
        state.total = response.count || entries.length;
        const selectedQuality = deps.getSelectedQuality();
        deps.toast(
          `재생목록 ${response.count || entries.length}개 받기 시작 · 화질 ${
            selectedQuality === "best" ? "최고" : selectedQuality
          }`,
          "ok"
        );
        deps.ensureQueuePoll();
        await deps.refreshJobsFromBackground();
        updateProgress();
      } catch (error) {
        state.active = false;
        deps.toast(deps.userError(error?.message) || "재생목록 받기 실패", "error");
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = "목록 받기";
        }
      }
    }

    return { hide, render, updateProgress, load, maxCount, selectForDownload, downloadAll };
  }

  return { createController };
});
