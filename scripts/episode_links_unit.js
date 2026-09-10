"use strict";

const assert = require("node:assert/strict");
const EpisodeLinks = require("../src/episode-links.js");
const Naming = require("../src/naming.js");

const SELF = "https://supjav.com/genre/123.html";

function anchor(href, text, alt) {
  return { href, text: text || "", alt: alt || "" };
}

function run(anchors, selfUrl = SELF, options = {}) {
  return EpisodeLinks.collectFromAnchors(anchors, selfUrl, { min: 1, ...options }, Naming);
}

function main() {
  // Real watch pages pass; list/tag routes and junk never do.
  const episodes = run([
    anchor("https://supjav.com/455636.html", "붉은매 지혁민의 경기 중 한 생각"),
    anchor("https://supjav.com/455637.html", ""),
    anchor("https://supjav.com/455638.html", "", "제3화 표지"),
    anchor("https://supjav.com/genre/123", "같은 장르 더보기"),
    anchor("https://supjav.com/tag/1234", "태그"),
    anchor("https://supjav.com/", "홈"),
    anchor("https://other-site.com/999999.html", "타 사이트"),
    anchor("javascript:void(0)", "스크립트"),
    anchor("/455639.html", "상대 경로는 호출자가 절대화"),
    anchor("", "빈 링크"),
    anchor("https://supjav.com/455636.html?ref=menu", "쿼리 중복")
  ]);
  assert.equal(episodes.length, 3, "only known-code watch pages survive");
  assert.equal(episodes[0].url, "https://supjav.com/455636.html");
  assert.equal(episodes[0].title, "붉은매 지혁민의 경기 중 한 생각");
  assert.equal(episodes[0].code, "");
  assert.equal(episodes[1].url, "https://supjav.com/455637.html");
  assert.equal(episodes[2].title, "제3화 표지", "anchor img alt is the title fallback");

  // Document order is preserved and same-page duplicates collapse by path.
  const ordered = run([
    anchor("https://supjav.com/200.html", "b"),
    anchor("https://supjav.com/100.html", "a"),
    anchor("https://supjav.com/200.html", "b again")
  ]);
  assert.equal(ordered.length, 2);
  assert.equal(ordered[0].url, "https://supjav.com/200.html");
  assert.equal(ordered[1].url, "https://supjav.com/100.html");

  // The list page itself is never its own episode.
  const self = run([
    anchor("https://supjav.com/genre/123.html", "self"),
    anchor("https://supjav.com/300.html", "ep")
  ]);
  assert.equal(self.length, 1);
  assert.equal(self[0].url, "https://supjav.com/300.html");

  // Product-code URLs classify too, and the code rides along.
  const coded = run([
    anchor("https://123av.com/ko/v/snos-342", "SNOS-342 어떤 제목")
  ]);
  assert.equal(coded.length, 1);
  assert.equal(coded[0].code, "SNOS-342");
  assert.ok(coded[0].title.includes("SNOS-342"));

  // Below the minimum the result is empty (caller stays quiet); cap applies.
  assert.equal(
    run(
      [100, 101, 102, 103].map((n) => anchor(`https://supjav.com/${n}.html`, `편 ${n}`)),
      SELF,
      { min: 5 }
    ).length,
    0,
    "fewer than min episodes yields an empty list"
  );
  const capped = run(
    Array.from({ length: 80 }, (_, i) => anchor(`https://supjav.com/${700 + i}.html`, "")).map(
      (a, i) => anchor(`https://supjav.com/${700 + i}.html`, `편 ${i}`)
    ),
    SELF,
    { min: 5, max: 60 }
  );
  assert.equal(capped.length, 60, "collection stops at max");

  // Without the Naming API the collector refuses to guess.
  assert.equal(
    EpisodeLinks.collectFromAnchors(
      [anchor("https://supjav.com/1.html")],
      SELF,
      {},
      null
    ).length,
    0
  );

  // markDownloaded flags episodes whose page matches history (host+path).
  const history = [
    { url: "https://supjav.com/455636.html?utm=mail", title: "받은 편" },
    { pageUrl: "https://supjav.com/455637.html" }
  ];
  const marked = EpisodeLinks.markDownloaded(
    [
      { url: "https://supjav.com/455636.html", title: "편1" },
      { url: "https://supjav.com/455637.html", title: "편2" },
      { url: "https://supjav.com/455699.html", title: "편3" }
    ],
    history
  );
  assert.equal(marked[0].downloaded, true, "url match marks downloaded");
  assert.equal(marked[1].downloaded, true, "pageUrl match marks downloaded");
  assert.equal(marked[2].downloaded, undefined, "unseen page stays fresh");

  // mergeEpisodes: existing win, new append, duplicates collapse, capped.
  const merged = EpisodeLinks.mergeEpisodes(
    [
      { url: "https://supjav.com/100.html", title: "기존", selected: false },
      { url: "https://supjav.com/200.html", title: "기존2" }
    ],
    [
      { url: "https://supjav.com/200.html", title: "중복" },
      { url: "https://supjav.com/300.html", title: "신규" }
    ],
    { max: 60 }
  );
  assert.equal(merged.length, 3);
  assert.equal(merged[0].title, "기존", "existing entries keep position/state");
  assert.equal(merged[2].title, "신규");
  assert.equal(
    EpisodeLinks.mergeEpisodes(
      Array.from({ length: 60 }, (_, i) => ({
        url: `https://supjav.com/${i}.html`
      })),
      [{ url: "https://supjav.com/999.html" }]
    ).length,
    60,
    "merge respects the 60-item cap"
  );

  console.log("episode links: 17 assertions passed");
}

main();
