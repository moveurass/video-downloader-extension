"use strict";

const assert = require("node:assert/strict");
const DisplayUtils = require("../src/popup-display-utils.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function makeHarness() {
  const elements = {
    linkInput: { value: "" },
    linkCount: { textContent: "" }
  };
  const appended = [];
  const timers = [];
  const mediaCalls = [];
  let currentTabUrl = "https://www.youtube.com/watch?v=current";
  let allItems = [];
  let uvdSettings = { mediaMode: "video" };
  let selectedQuality = "best";
  let classifyError = () => ({ code: "other" });
  let localItem = {
    url: currentTabUrl,
    pageUrl: currentTabUrl,
    site: "youtube",
    title: "Local title",
    pageTitle: "Local page",
    displayName: "Local display",
    filename: "local.mp4",
    thumbnail: "local.jpg"
  };

  const document = {
    body: {
      appendChild(el) {
        appended.push(el);
      }
    },
    createElement(tag) {
      return {
        tag,
        className: "",
        textContent: "",
        removed: false,
        remove() {
          this.removed = true;
        }
      };
    }
  };
  const UVD = {
    parseUrlsFromText(text) {
      return String(text).match(/https?:\/\/\S+/g) || [];
    },
    classifyError(error) {
      return classifyError(error);
    },
    isGenericSaveName(value) {
      return /^(?:영상|동영상|video)$/i.test(String(value || ""));
    }
  };
  const UVDPopupMedia = {
    cleanTitleText(raw, Naming) {
      mediaCalls.push(["cleanTitleText", raw, Naming]);
      return `clean:${raw}`;
    },
    displayName(item, options) {
      mediaCalls.push(["displayName", item, options]);
      return "display";
    },
    downloadFilename(item, options) {
      mediaCalls.push(["downloadFilename", item, options]);
      return "download.mp4";
    },
    isUglyName: () => false
  };
  const Naming = {
    marker: "naming",
    isKnownCodeSite: (host) => /123av|supjav/i.test(host),
    isKnownCodeVideoPage: (url) => {
      try {
        const host = new URL(url).hostname.replace(/^www\./i, "");
        if (!/123av|supjav/i.test(host)) return false;
        if (/[a-z]{2,12}[-_]\d{2,5}/i.test(url)) return true;
        return /\/\d{3,}(?:\.html?)?$/i.test(new URL(url).pathname);
      } catch {
        return false;
      }
    },
    extractProductCode: (url) => {
      const match = String(url).match(/([a-z]{2,12})[-_](\d{2,5})/i);
      return match ? `${match[1].toUpperCase()}-${match[2]}` : "";
    },
    cleanPageTitle: (value) =>
      String(value || "").replace(/\s*-\s*123AV.*$/i, "").trim(),
    bindTitleToPage: (_url, title) => title,
    titlesMatchVideo: (a, b) => {
      const code = (value) => {
        const match = String(value || "").match(/([a-z]{2,12})[-_](\d{2,5})/i);
        return match ? `${match[1].toUpperCase()}-${match[2]}` : "";
      };
      const ca = code(a);
      const cb = code(b);
      if (ca && cb) return ca === cb;
      const na = String(a || "").trim();
      const nb = String(b || "").trim();
      return !!na && !!nb && na === nb;
    },
    buildFilename: ({ title }) => `${title}.mp4`
  };
  const pageHost = {
    textContent: "www.youtube.com/watch?v=current"
  };

  const utils = DisplayUtils.createUtils({
    $: (selector) => elements[selector.slice(1)] || null,
    document,
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    URL,
    pageHost,
    UVDSites: {
      buildSiteItem(tab, url) {
        return localItem && /youtube|tiktok|instagram/.test(url || "")
          ? { ...localItem, tabTitle: tab?.title, builtFor: url }
          : null;
      }
    },
    UVDPopupMedia,
    Naming,
    UVD,
    isSitePage: (url) => /youtube|tiktok|instagram/.test(url),
    isKnownDownloadablePage: (url) =>
      /youtube|tiktok|instagram/.test(url) ||
      Naming.isKnownCodeVideoPage(url),
    getCurrentTabUrl: () => currentTabUrl,
    getAllItems: () => allItems,
    getUvdSettings: () => uvdSettings,
    getSelectedQuality: () => selectedQuality,
    now: () => 1_000_000
  });

  return {
    utils,
    elements,
    appended,
    timers,
    mediaCalls,
    Naming,
    UVD,
    setCurrentTabUrl(value) {
      currentTabUrl = value;
    },
    setAllItems(value) {
      allItems = value;
    },
    setUvdSettings(value) {
      uvdSettings = value;
    },
    setSelectedQuality(value) {
      selectedQuality = value;
    },
    setClassifyError(value) {
      classifyError = value;
    },
    setLocalItem(value) {
      localItem = value;
    }
  };
}

function main() {
  const h = makeHarness();
  const u = h.utils;

  check(h.appended.length, 0, "constructor does not touch DOM");
  check(h.timers.length, 0, "constructor does not start timers");
  check(h.mediaCalls.length, 0, "constructor does not invoke media helpers");

  check(u.escapeHtml(null), "", "null HTML escape");
  check(u.escapeHtml(`<a x="1">&`), "&lt;a x=&quot;1&quot;&gt;&amp;", "HTML escaping");
  check(u.escapeAttr(`"'&<>`), "&quot;&#39;&amp;&lt;&gt;", "attribute escaping");
  check(
    u.thumbHtml({ thumbnail: `https://x.test/a'"&.jpg` }),
    `<img class="thumb-img" src="https://x.test/a&#39;&quot;&amp;.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" />`,
    "thumbnail attribute escaping"
  );
  check(
    u.thumbHtml({}),
    `<span class="thumb-fallback">🎬</span>`,
    "thumbnail fallback"
  );

  h.setClassifyError(() => ({
    code: "helper",
    label: "공유 분류",
    hint: "공유 힌트"
  }));
  check(
    u.userError("Invalid filename and helper"),
    "공유 분류 — 공유 힌트",
    "shared classifier has first precedence"
  );
  h.setClassifyError(() => {
    throw new Error("classifier failed");
  });
  check(
    u.userError("Invalid filename and 403"),
    "파일 저장에 실패했습니다. 확장 프로그램을 새로고침한 뒤 다시 받아 주세요 (파일명·권한 문제일 수 있음)",
    "filename fallback precedes 403"
  );
  check(
    u.userError("Segment HTTP 403"),
    "접근이 거부되었습니다 (403). 페이지를 열어 재생한 직후 다시 시도하세요",
    "broad 403 fallback retains precedence"
  );
  check(
    u.userError("TikTok invalid URL"),
    "받을 주소가 없습니다. 페이지를 새로고침한 뒤 재생해 주세요",
    "URL fallback precedes site message"
  );
  check(
    u.userError("Error: 틱톡 페이지에서 재생해 주세요"),
    "틱톡 페이지에서 재생해 주세요",
    "Korean TikTok message remains"
  );
  check(u.userError("Widevine DRM"), "보호된 영상이라 받을 수 없습니다", "DRM message");
  check(u.userError(null), null, "empty error");

  check(u.pageKey("https://youtu.be/abc?t=4"), "yt:abc", "short YouTube identity");
  check(
    u.pageKey("https://www.youtube.com/watch?v=abc&list=PL1"),
    "yt:abc",
    "YouTube watch identity"
  );
  check(
    u.pageKey("https://m.youtube.com/shorts/xyz?feature=share"),
    "yt:shorts:xyz",
    "YouTube shorts identity"
  );
  check(
    u.pageKey("https://www.tiktok.com/@name/video/123456?lang=ko"),
    "tt:123456",
    "TikTok identity"
  );
  check(
    u.pageKey("https://www.instagram.com/reel/IGCODE/?utm_source=x"),
    "ig:reel:IGCODE",
    "Instagram identity"
  );
  check(
    u.pageKey("https://WWW.Example.com/path?q=one"),
    "example.com/path",
    "generic identity ignores query and www"
  );
  check(
    u.pageKey("https://123av.com/ko/v/snos-342-uncensore"),
    u.pageKey("https://123av.com/ko/v/snos-342"),
    "known-code suffix variants share one page identity"
  );
  check(u.pageKey("not a url"), "not a url", "invalid identity fallback");
  check(u.pageKey(""), "", "empty identity");

  h.setCurrentTabUrl("https://example.com/video");
  const ordinary = [{ url: "https://cdn.test/video.mp4" }];
  const ordinaryResult = u.ensureSiteItems(ordinary, {});
  check(ordinaryResult, ordinary, "non-site items retained");
  check(ordinaryResult === ordinary, false, "non-site list cloned");

  h.setCurrentTabUrl("https://www.youtube.com/watch?v=current");
  const emptyResult = u.ensureSiteItems([], { title: "Tab title" });
  check(emptyResult.length, 1, "empty site list gets local card");
  check(emptyResult[0].builtFor, "https://www.youtube.com/watch?v=current", "local item current URL");

  const samePage = u.ensureSiteItems(
    [{
      url: "https://cdn.test/fragment.m3u8",
      pageUrl: "https://youtu.be/current",
      title: "Captured title",
      pageTitle: "Captured page",
      displayName: "Captured display",
      filename: "captured.mp4",
      thumbnail: "captured.jpg",
      capturedOnly: true
    }],
    {}
  )[0];
  check(samePage.url, "https://www.youtube.com/watch?v=current", "same page gets local URL");
  check(samePage.title, "Captured title", "same page keeps captured title");
  check(samePage.thumbnail, "captured.jpg", "same page keeps captured thumbnail");
  check(samePage.displayName, "Captured display", "same page keeps captured display name");
  check(samePage.filename, "captured.mp4", "same page keeps captured filename");
  check(samePage.capturedOnly, true, "same page keeps captured metadata");

  const stalePage = u.ensureSiteItems(
    [{
      url: "https://www.youtube.com/watch?v=previous",
      pageUrl: "https://www.youtube.com/watch?v=previous",
      title: "Stale title",
      pageTitle: "Stale page",
      displayName: "Stale display",
      filename: "stale.mp4",
      thumbnail: "stale.jpg",
      staleOnly: true
    }],
    {}
  )[0];
  check(stalePage.title, "Local title", "new page uses local title");
  check(stalePage.pageTitle, "Local page", "new page uses local page title");
  check(stalePage.thumbnail, "local.jpg", "new page rejects stale thumbnail");
  check(stalePage.displayName, "Local display", "new page rejects stale display name");
  check(stalePage.filename, "local.mp4", "new page rejects stale filename");
  check(stalePage.staleOnly, undefined, "new page rejects stale metadata");

  h.setLocalItem({
    url: "https://www.youtube.com/watch?v=current",
    pageUrl: "https://www.youtube.com/watch?v=current",
    site: "youtube",
    title: "Fresh title"
  });
  const noFreshThumb = u.ensureSiteItems(
    [{
      pageUrl: "https://www.youtube.com/watch?v=previous",
      thumbnail: "stale.jpg"
    }],
    {}
  )[0];
  check(noFreshThumb.thumbnail, undefined, "missing fresh thumbnail stays empty");

  h.setAllItems([{ pageUrl: "https://youtu.be/current", title: "Getter title" }]);
  const getterResult = u.ensureSiteItems(null, {})[0];
  check(getterResult.title, "Getter title", "lazy allItems getter");

  const codePage =
    "https://123av.com/ko/v/snos-342-uncensore";
  h.setCurrentTabUrl(codePage);
  const codePlaceholder = u.ensureSiteItems([], {
    url: codePage,
    title: "SNOS-342 긴 영상 제목 - 123AV"
  })[0];
  check(codePlaceholder.isPagePlaceholder, true, "known code page gets a placeholder");
  check(codePlaceholder.title, "SNOS-342 긴 영상 제목", "placeholder uses page title");

  const codeMedia = u.ensureSiteItems([{
    url: "https://cdn.test/snos-342/master.m3u8",
    pageUrl: codePage,
    type: "stream",
    isHls: true,
    title: "SNOS-342 훨씬 긴 실제 영상 제목",
    thumbnail: "https://img.test/snos-342.jpg",
    quality: "720p"
  }], { url: codePage })[0];
  check(codeMedia.isPagePlaceholder, false, "real media replaces the placeholder");
  const afterEmpty = u.ensureSiteItems([], { url: codePage })[0];
  check(
    afterEmpty.url,
    "https://cdn.test/snos-342/master.m3u8",
    "empty refresh restores last good media"
  );
  const afterGeneric = u.ensureSiteItems([{
    url: "https://cdn.test/snos-342/master.m3u8",
    pageUrl: codePage,
    title: "SNOS-342_720p",
    quality: "720p"
  }], { url: codePage })[0];
  check(
    afterGeneric.title,
    "SNOS-342 훨씬 긴 실제 영상 제목",
    "short generic metadata cannot replace a richer same-page title"
  );
  h.setCurrentTabUrl("https://123av.com/ko/v/snos-342");
  const suffixVariant = u.ensureSiteItems([], {
    url: "https://123av.com/ko/v/snos-342"
  })[0];
  check(
    suffixVariant.thumbnail,
    "https://img.test/snos-342.jpg",
    "suffix variant retains same-page title and thumbnail"
  );

  h.setCurrentTabUrl("https://123av.com/ko/v/snos-341");
  const otherCode = u.ensureSiteItems([], {
    url: "https://123av.com/ko/v/snos-341",
    title: "SNOS-341"
  })[0];
  check(
    otherCode.thumbnail !== "https://img.test/snos-342.jpg",
    true,
    "other product code does not reuse last-good thumb"
  );

  const previewSizePage = "https://supjav.com/455639.html";
  h.setCurrentTabUrl(previewSizePage);
  u.ensureSiteItems([{
    url: "https://cdn.test/preview-30s.m3u8",
    pageUrl: previewSizePage,
    type: "stream",
    isHls: true,
    duration: 30,
    estimatedSize: 2_400_000,
    title: "Long feature title",
    pageTitle: "Long feature title",
    displayName: "Long feature title",
    filename: "Long feature title.mp4"
  }], { url: previewSizePage });
  const featureOverPreview = u.ensureSiteItems([{
    url: "https://cdn.test/feature-long.m3u8",
    pageUrl: previewSizePage,
    type: "stream",
    isHls: true,
    duration: 7200,
    estimatedSize: 0,
    title: "Long feature title",
    pageTitle: "Long feature title",
    displayName: "Long feature title",
    filename: "Long feature title.mp4"
  }], { url: previewSizePage })[0];
  check(
    featureOverPreview.url,
    "https://cdn.test/feature-long.m3u8",
    "ranked feature HLS replaces the preview URL"
  );
  check(
    featureOverPreview.duration,
    7200,
    "feature duration is not the 30s preview length"
  );
  check(
    !featureOverPreview.estimatedSize,
    true,
    "preview estimatedSize is not kept on a different feature URL"
  );

  const supjavPage = "https://supjav.com/455636.html";
  h.setCurrentTabUrl(supjavPage);
  const supjavPlaceholder = u.ensureSiteItems([], {
    url: supjavPage,
    title: "Supjav watch"
  })[0];
  check(
    supjavPlaceholder.isPagePlaceholder,
    true,
    "numeric Supjav article URL gets a placeholder"
  );
  const supjavMedia = u.ensureSiteItems([{
    url: "https://cdn.test/feature.m3u8",
    pageUrl: supjavPage,
    type: "stream",
    isHls: true,
    thumbnail: "https://img.test/supjav-current.jpg"
  }], { url: supjavPage })[0];
  check(supjavMedia.isPagePlaceholder, false, "real Supjav media replaces placeholder");
  const supjavEmpty = u.ensureSiteItems([], { url: supjavPage })[0];
  check(
    supjavEmpty.url,
    "https://cdn.test/feature.m3u8",
    "empty Supjav refresh restores same-page last-good media"
  );
  check(
    supjavEmpty.thumbnail,
    "https://img.test/supjav-current.jpg",
    "empty Supjav refresh keeps the same-page thumb"
  );
  const supjavPlaceholderUpdate = u.ensureSiteItems([{
    url: supjavPage,
    pageUrl: supjavPage,
    isPagePlaceholder: true,
    thumbnail: ""
  }], { url: supjavPage })[0];
  check(
    supjavPlaceholderUpdate.url,
    "https://cdn.test/feature.m3u8",
    "placeholder-only update does not replace last-good media"
  );
  h.setCurrentTabUrl("https://supjav.com/455637.html");
  const otherNumeric = u.ensureSiteItems([], {
    url: "https://supjav.com/455637.html",
    title: "Other clip"
  })[0];
  check(
    otherNumeric.thumbnail !== "https://img.test/supjav-current.jpg",
    true,
    "numeric Supjav page change does not flash the previous thumb"
  );

  h.setCurrentTabUrl(supjavPage);
  const keepThumb = u.ensureSiteItems([{
    url: supjavPage,
    pageUrl: supjavPage,
    isPagePlaceholder: true
  }], { url: supjavPage })[0];
  check(
    keepThumb.thumbnail,
    "https://img.test/supjav-current.jpg",
    "same-pageKey placeholder never blanks the last-good thumb"
  );

  h.setCurrentTabUrl("https://supjav.com/455638.html");
  const nextNumeric = u.ensureSiteItems([{
    url: "https://cdn.test/other-feature.m3u8",
    pageUrl: "https://supjav.com/455638.html",
    type: "stream",
    isHls: true,
    title: "Short current",
    pageTitle: "Short current",
    displayName: "Short current",
    filename: "Short current.mp4",
    thumbnail: "https://img.test/supjav-next.jpg"
  }], {
    url: "https://supjav.com/455638.html",
    title: "Short current"
  })[0];
  check(
    nextNumeric.title,
    "Short current",
    "a different numeric Supjav page uses the current title even when it is shorter"
  );
  check(
    nextNumeric.thumbnail,
    "https://img.test/supjav-next.jpg",
    "a different numeric Supjav page uses the current cover"
  );
  check(
    nextNumeric.filename,
    "Short current.mp4",
    "a different numeric Supjav page uses the current filename"
  );

  h.setCurrentTabUrl("https://supjav.com/455638.html");
  const replacedTitle = u.ensureSiteItems([{
    url: "https://cdn.test/other-feature.m3u8",
    pageUrl: "https://supjav.com/455638.html",
    type: "stream",
    isHls: true,
    title: "Updated current page title",
    filename: "Updated current page title.mp4",
    thumbnail: "https://img.test/supjav-next.jpg"
  }], { url: "https://supjav.com/455638.html" })[0];
  check(
    replacedTitle.title,
    "Updated current page title",
    "same-page incoming title replaces a different previous video name"
  );

  h.elements.linkInput.value = "";
  check(u.updateLinkCount(), [], "empty link parse result");
  check(h.elements.linkCount.textContent, "0개 링크", "empty link label");
  h.elements.linkInput.value = "https://one.test/video";
  check(u.updateLinkCount().length, 1, "single link parse result");
  check(h.elements.linkCount.textContent, "1개 링크", "single link label");
  h.elements.linkInput.value = "https://one.test/a\nhttps://two.test/b";
  check(u.updateLinkCount().length, 2, "batch link parse result");
  check(h.elements.linkCount.textContent, "2개 링크 (일괄)", "batch link label");

  check(u.formatTimeAgo(950_001), "방금", "under one minute");
  check(u.formatTimeAgo(940_000), "1분 전", "one minute boundary");
  check(u.formatTimeAgo(-7_200_000), "2시간 전", "hour formatting");
  check(u.formatTimeAgo(-171_800_000), "2일 전", "day formatting");
  check(u.formatDurShort(0), "", "empty short duration");
  check(u.formatDurShort(65.9), "1:05", "minute short duration");
  check(u.formatDurShort(3661), "1:01:01", "hour short duration");

  check(
    u.siteLabel(),
    "youtube.com",
    "site label removes www and raw page paths"
  );
  check(u.cleanTitleText(" Raw "), "clean: Raw ", "clean title wrapper");
  check(h.mediaCalls.at(-1)[2], h.Naming, "clean title passes Naming");
  h.setCurrentTabUrl("https://www.youtube.com/watch?v=later");
  h.setUvdSettings({ mediaMode: "audio" });
  h.setSelectedQuality("1080p");
  check(u.downloadFilename({ title: "Item" }), "download.mp4", "download filename wrapper");
  const filenameOptions = h.mediaCalls.at(-1)[2];
  check(filenameOptions.currentTabUrl, "https://www.youtube.com/watch?v=later", "filename lazy URL");
  check(filenameOptions.selectedQuality, "1080p", "filename lazy quality");
  check(filenameOptions.mediaMode, "audio", "filename lazy settings");

  u.toast("Saved", "ok");
  check(h.appended[0].className, "toast ok", "toast class");
  check(h.appended[0].textContent, "Saved", "toast text");
  check(h.timers[0].ms, 2800, "toast lifetime");
  h.timers[0].fn();
  check(h.appended[0].removed, true, "toast timer removes element");

  console.log(`popup display utils unit: ${assertions} assertions passed`);
}

main();
