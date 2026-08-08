# Universal Video Downloader

Chrome(Chromium) 확장 프로그램 — 페이지 미디어 감지, HLS 병합, **YouTube / TikTok / 일반 영상 사이트**, 로컬 **yt-dlp 도우미**, 시리즈·나중 받기·로컬 서재.

**v1.23.1** — 다중 다운로드 큐 안정화, 파일명/저장 오류 보강, 시리즈 검증·나중받기 묶음

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| 페이지 스캔 | `<video>` / `og:video`, 네트워크 캡처, 플레이어 훅 |
| **HLS 병합** | m3u8 세그먼트 수집 → AES-128 복호화 → 파일 저장 |
| **화질 선택** | 최고 / 4K / 1080p / 720p … (사이트·스트림에 따라 다름) |
| **로컬 yt-dlp 도우미** | YouTube 등 복잡 사이트 URL 한 번으로 저장 |
| **다중 다운로드 큐** | 동시 받기, 파일별 진행률, 일시정지/취소, 실패 시 다시 받기 |
| **시리즈 완주** | YouTube 재생목록 / 품번(예: SSIS-001) 다음 편 제안 |
| **품번 존재 검증** | 추정만 하지 않고 페이지를 확인해 **있는 편만** 목록에 표시 |
| **나중 받기** | 워치리스트, 시리즈 묶음 받기/삭제, 예약 |
| **로컬 서재** | 완료·실패 기록, 시리즈 이어받기(서재 최대 번호 이후) |
| 우클릭 메뉴 | 미디어·링크·페이지 다운로드 |
| 단축키 | `Alt+Shift+D` 현재 탭 · `Alt+Shift+A` 오디오 · `Alt+Shift+B` 최고 화질 |

---

## 설치 (개발자 모드)

1. Chrome에서 `chrome://extensions` 열기  
2. **개발자 모드** ON  
3. **압축해제된 확장 프로그램을 로드합니다**  
4. 이 폴더(`video-downloader-extension`) 선택  
5. 코드 수정 후 확장 **새로고침**

---

## yt-dlp 헬퍼 (강력 추천)

브라우저만으로는 DRM·복잡 플레이어에 한계가 있습니다.  
로컬 헬퍼를 켜 두면 YouTube·소셜·다수 사이트 다운로드가 안정적입니다.

### 1) yt-dlp 설치

```bash
# macOS
brew install yt-dlp
# 또는
pip3 install -U yt-dlp
```

### 2) 헬퍼 실행

```bash
cd video-downloader-extension
python3 helper/yt_dlp_server.py

# 또는 macOS
chmod +x helper/start.command
open helper/start.command
```

- 주소: `http://127.0.0.1:8787`  
- 기본 저장: `~/Downloads/VideoDownloader/`  
- 백그라운드/로그인 시 자동 실행: `helper/install_autostart.command`

### 3) 확장에서 확인

팝업 상단 **도우미 연결됨**(초록)이면 준비 완료.

| 동작 | 설명 |
|------|------|
| **이 페이지 받기** | 현재 탭 URL을 yt-dlp로 저장 |
| 카드 **다운로드** | yt-dlp 우선 → 실패 시 브라우저/HLS 방식 |

---

## 사용법

### 기본

1. 영상 페이지에서 **재생** 한 번 (HLS/캡처 사이트)  
2. 확장 아이콘 클릭  
3. 화질 선택 후 **다운로드** / **이 페이지 받기**  
4. 여러 개면 상단 **받는 중** 큐에서 파일별 진행률 확인  

### 시리즈

- **YouTube 재생목록**: 나머지 항목 미리보기 → 체크 → 바로 받기  
- **품번 시리즈**(123av 등): 다음 번호를 **페이지에서 확인**한 뒤 목록 표시  
  - 없는 번호는 제외, 진행 UI에 확인 중 표시  
  - 서재에 이미 받은 최대 번호가 있으면 **그 다음부터** 이어받기  
- **나중 받기** 탭: 시리즈 묶음 받기 / 묶음 삭제  

### 우클릭

- 미디어 / 링크 / 페이지 최고 화질 다운로드  

---

## 지원·한계

| 상황 | 결과 |
|------|------|
| 일반 mp4/webm | 직접 또는 도우미로 저장 |
| HLS (AES-128 포함) | 확장 병합 저장 |
| YouTube / TikTok 등 | **도우미 권장** |
| 123av·missav 계열 | 페이지 재생 후 캡처 + 품번 시리즈 검증 |
| SAMPLE-AES / Widevine DRM | **불가** |
| DASH (mpd) | URL 수집만 (병합 미지원) |
| 품번 시리즈 | 사이트 구조·Cloudflare에 따라 확인 실패 가능 — **추정만으로 목록에 넣지 않음** |
| `chrome://`, 웹스토어 | 스크립트 제한 |

### 저작권

본인이 권리를 가진 콘텐츠·약관이 허용하는 경우에만 사용하세요.

---

## 구조

```
video-downloader-extension/
├── manifest.json
├── README.md
├── QA.md                 # 수동 스모크 체크리스트
├── icons/
├── helper/
│   ├── yt_dlp_server.py  # 로컬 도우미 :8787
│   ├── start.command
│   └── install_autostart.command
└── src/
    ├── background.js     # 큐, 다운로드, 메시지
    ├── popup.*           # UI
    ├── content.js        # 페이지 스캔, 시리즈 메타 probe
    ├── hls-downloader.js
    ├── naming.js
    ├── uvd-common.js
    └── ytdlp.js
```

---

## 권한

- `downloads` — 파일 저장  
- `webRequest` / `declarativeNetRequest` — 미디어·Referer  
- `contextMenus` — 우클릭  
- `scripting` / `tabs` / `storage` / `alarms` / `cookies` / `notifications`  
- `<all_urls>` — 범용 감지  

---

## 문제 해결

| 증상 | 조치 |
|------|------|
| 도우미 끊김 | `helper/start.command` 실행, 팝업에서 재확인 |
| 403 / 조각 실패 | 페이지에서 **재생 직후** 다시 받기 |
| 파일 저장 실패 | 확장 **새로고침** 후 재시도 |
| 시리즈 목록 비어 있음 | 해당 사이트 탭을 연 채 시도, Cloudflare/로그인 확인 |
| 큐 깜빡임 | v1.23.1+ 에서 개선 (확장 새로고침) |

자세한 수동 확인 항목은 **[QA.md](./QA.md)** 참고.

---

## 라이선스

MIT
