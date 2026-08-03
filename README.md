# Universal Video Downloader

Chrome(Chromium) 확장 프로그램 — 페이지 미디어 감지 + HLS 병합 + **YouTube / TikTok** (로컬 yt-dlp 도우미).

**v1.9.0** — YouTube·TikTok 페이지 다운로드, 도우미 상태 표시

## 기능

| 기능 | 설명 |
|------|------|
| 페이지 스캔 | `<video>` / `<audio>`, `og:video`, data 속성 |
| 네트워크 캡처 | mp4, webm, m3u8, mpd, ts 등 |
| 플레이어 훅 | fetch / XHR / media `src` 후킹 |
| **HLS 병합** | m3u8 세그먼트 fetch → AES-128 복호화 → .ts/.mp4 병합 저장 |
| **화질 필터** | 4K / 1080p / 720p / 480p / 360p + 병합 시 선호 품질 |
| **우클릭 메뉴** | 미디어·링크·페이지 최고 화질 다운로드 |
| Blob 캡처 | `blob:` 소스 읽기 시도 |
| 배지 | 탭별 감지 개수 |

## 설치 (개발자 모드)

1. Chrome에서 `chrome://extensions` 열기
2. **개발자 모드** ON
3. **압축해제된 확장 프로그램을 로드합니다**
4. 폴더 선택: `video-downloader-extension`
5. 업데이트 후 **새로고침** 버튼으로 확장 재로드

## yt-dlp 헬퍼 (추천 — 지원 사이트 대폭 증가)

브라우저 확장만으로는 DRM·복잡 플레이어 한계가 있습니다.  
로컬에서 **yt-dlp** 를 켜 두면 YouTube 등 수천 사이트를 페이지 URL만으로 받을 수 있습니다.

### 1) yt-dlp 설치

```bash
# macOS
brew install yt-dlp

# 또는
pip3 install -U yt-dlp
```

### 2) 헬퍼 실행 (다운로드할 동안 켜 두기)

```bash
# 터미널
cd video-downloader-extension
python3 helper/yt_dlp_server.py

# 또는 macOS에서 start.command 더블클릭
chmod +x helper/start.command
open helper/start.command
```

- 주소: `http://127.0.0.1:8787`
- 저장 위치: `~/Downloads/VideoDownloader/`

### 3) 확장에서 확인

팝업 상단이 **yt-dlp 연결됨** (초록 점) 이면 준비 완료.

| 버튼 | 동작 |
|------|------|
| **이 페이지 받기** | 현재 탭 URL을 yt-dlp에 넘겨 저장 (가장 강력) |
| 목록 **다운로드** | yt-dlp 우선 → 실패 시 기존 브라우저 방식 |

헬퍼를 끄면 예전처럼 확장 단독 모드로 동작합니다.

## 사용법

### 팝업
1. 영상 페이지에서 **재생** 한 번
2. 확장 아이콘 클릭
3. 유형/화질 필터로 목록 좁히기
4. **HLS 병합 저장** 또는 **다운로드**
5. `m3u8` 버튼 → 플레이리스트만 저장 (병합 없이)

### 우클릭
- 영상/오디오 위: **이 미디어 다운로드**
- 링크 위: **링크를 미디어로 다운로드**
- 페이지: **페이지에서 최고 화질 다운로드** / **이 페이지 미디어 스캔**

### HLS 병합
- 마스터 플레이리스트면 **병합 품질**(최고/4K/1080p…)에 맞는 변형 선택
- 세그먼트를 병렬(4)로 받아 하나로 합침
- MPEG-TS → `.ts` / fMP4(`EXT-X-MAP`) → `.mp4`
- 진행률 바가 팝업에 표시됩니다
- VLC, IINA, 퀵타임 등에서 `.ts` 재생 가능. mp4가 필요하면:

```bash
ffmpeg -i input.ts -c copy output.mp4
```

## 한계

| 상황 | 결과 |
|------|------|
| 일반 mp4/webm | 직접 다운로드 |
| HLS (비암호화 / AES-128) | 확장 안에서 병합 |
| SAMPLE-AES / Widevine DRM | **불가** |
| DASH (mpd) | URL 수집만 (병합 미지원) |
| 매우 긴 라이브 슬라이딩 윈도우 | 세그먼트 상한(5000) |
| `chrome://`, 웹스토어 | 스크립트 제한 |

## 저작권

본인이 권리를 가진 콘텐츠·약관이 허용하는 경우에만 사용하세요.

## 구조

```
video-downloader-extension/
├── manifest.json
├── icons/
├── README.md
└── src/
    ├── background.js       # 캡처, 메뉴, 다운로드 조율
    ├── hls-downloader.js   # m3u8 파서 + 병합
    ├── content.js          # DOM 스캔
    ├── injected.js         # 페이지 훅
    └── popup.*             # UI
```

## 권한

- `downloads` — 파일 저장  
- `webRequest` — 미디어 요청 감지  
- `contextMenus` — 우클릭 메뉴  
- `scripting` / `tabs` / `storage` / `alarms`  
- `<all_urls>` — 범용 감지  

## 라이선스

MIT
