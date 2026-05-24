# Don't Panic Pre — 개발 로그

> 최종 업데이트: 2026-05-23  
> 현재 버전: v111  
> 배포 URL: https://dontpanicpre.web.app  
> GitHub: https://github.com/gotgam100/dontpanicpre

---

## 프로젝트 개요

영화/드라마 대본 공동 편집 웹앱.  
- **에디터**: ProseMirror (PM) + Yjs WebSocket 실시간 협업  
- **저장소**: Firestore 단일 저장소 (Google Drive·로컬 File System 제거 완료)  
- **인증**: Firebase Auth (Google 로그인)  
- **호스팅**: Firebase Hosting (`firebase deploy --only hosting`)

---

## 주요 파일

| 파일 | 역할 |
|------|------|
| `assets/app.js` | 메인 앱 로직 (저장/로드, 씬파싱, UI, 협업) |
| `assets/editor.js` | ProseMirror 에디터 모듈 (DPEditor API) |
| `assets/app.css` | 스타일 |
| `assets/responsive.js/css` | 반응형 |
| `index.html` | 진입점 (쿼리스트링 버전 관리) |
| `sw.js` | Service Worker — VERSION 상수만 bump하면 됨 |
| `firestore.rules` | Firestore 보안 규칙 |

---

## 배포 절차

```bash
# 1) sw.js — VERSION 상수 bump
const VERSION = "v{N}-{날짜}-{설명}";

# 2) index.html — script 쿼리스트링 bump (두 곳)
assets/editor.js?v={날짜}-{설명}
assets/app.js?v={날짜}-{설명}

# 3) 배포
firebase deploy --only hosting
```

---

## Firestore 데이터 구조

```
projects/{projectId}
  - name: string
  - owner: uid
  - ownerEmail: string
  - ownerName: string
  - memberEmails: string[]       ← 참여자(editor)
  - viewerEmails: string[]       ← 열람자(viewer)
  - memberProfiles: { [emailKey]: { name, emoji, email } }
  - shareCode: string
  - viewerCode: string
  - updatedBy: uid               ← 마지막 저장자 (리스너 중복 처리용)
  - updatedAt: Timestamp
  - data: {
      html, sched, schedDays,
      project, author, date,
      charNotes, charInfo,       ← charInfo[name].emoji 도 저장됨
      manualChars,
      sceneNotes, sceneExtras, csLabels,
      globalChars, charOrder, hiddenChars,
      locationInfo, locationOrder,
      propList, costumeList,
      callSheets, lastCSNum,
      pageNumberStyle, month,
      adPhone, pdPhone, savedAt
    }

projects/{projectId}/versions/{versionId}
  - name: string  (예: "20260521_1430_미숙의집")
  - createdAt: Timestamp
  - data: { ... }
```

---

## 핵심 전역 변수 (app.js)

```javascript
let _currentProjectId = null;   // 현재 Firestore 문서 ID
let _currentFileName  = null;   // 프로젝트 표시 이름
let _myRole = 'editor';         // 'owner' | 'editor' | 'viewer'
let _saveTimer = null;
let _dataLoaded = false;
let _suppressSave = false;
let _bootGateDone = false;      // boot gate 한 번만 해제되도록

// 요소 등록
let _lastElemRegTime = 0;
let _elemTagSyncTimer = null;

// 인물 탭
let selectedChar = null;
let _charScenesOpen = true;     // 등장씬 섹션 펼침 상태

// Firestore 리스너 해제 함수
let _projectDataListener = null;
let _presenceListener = null;
let _piPresenceUnsub = null;
```

---

## 실시간 협업 구조

### 1. 스크립트 텍스트
- **Yjs + WebSocket** (`DPEditor.connect(projectId)`)
- PM elemTag 마크도 Yjs로 동기화

### 2. 메타데이터 (`_projectDataListener`)
- `projects/{projectId}` onSnapshot
- **건너뜀**: `d.updatedBy === currentUser.uid`
- **MERGE**: 로컬 항목 보존 (`_mergeSceneExtras`, `_mergeList`)

#### 동기화 필드 목록
```
sceneExtras (MERGE), propList (MERGE), costumeList (MERGE)
charNotes, charInfo, manualCharsByScene
sceneNotes, locationInfo, locationOrder
csLabels, globalChars, charOrder, hiddenChars
sched, schedDays, callSheets
d.name → _currentFileName + sidebarProjectLabel
```

#### 리스너 리렌더링
```javascript
renderSidebar(); renderLeftSidebar();
onTab('tab-scenebd')     → renderSceneBd()
onTab('tab-breakdown')   → renderBreakdown()
onTab('tab-chars')       → renderChars()
onTab('tab-loclist')     → renderLocList()
onTab('tab-proplist')    → renderPropList()
onTab('tab-costumelist') → renderCostumeList()
onTab('tab-schedule')    → renderSchedule()
onTab('tab-callsheet')   → renderCS()
```

---

## 저장 흐름

```
onEditorInput()
  → parseFromEditor(), renderSidebar(), renderLeftSidebar()
  → 탭 렌더 debounce 300ms (원격 Yjs 키스트로크 폭주 방지)
  → save() → setTimeout(doSave, 1500ms)

doSave()
  → fsStoreSave(name, data)  →  projects/{id}.set({ name, data, updatedBy, updatedAt })
  → 10번마다 saveVersionSnapshot()
```

---

## 권한 체계

| 역할 | 읽기 | 편집 | 초대 | 삭제/이름변경 |
|------|------|------|------|-------------|
| owner | ✅ | ✅ | ✅ | ✅ |
| editor | ✅ | ✅ | ✅ | ❌ |
| viewer | ✅ | ❌ | ❌ | ❌ |

- 초대 섹션: `_piIsOwner || _myRole === 'editor'` 일 때 표시

---

## 인물설정 탭 구조

```
#tab-chars
  ├── .chars-card-strip-wrap         ← 상단 가로 스크롤 카드 스트립
  │     └── .chars-card-strip        (overflow-x: auto)
  │           └── .char-card ×N      (90×120px, 3:4 비율)
  │                 ├── .char-card-color-bar  ← 인물 색상 바
  │                 ├── .char-card-emoji      ← 클릭 → 이모지 피커
  │                 ├── .char-card-name
  │                 ├── .char-card-sub        ← 성별·나이
  │                 └── .char-card-scene-count
  └── .chars-detail-panel #charsDetailPanel  ← 선택된 인물 세부정보
        └── .char-detail-inner
              ├── 이름 + 삭제버튼
              ├── .char-meta-row (성별 / 나이 / 색상)
              ├── .char-scenes-section  ← 접기/펼치기
              │     ├── .char-scenes-toggle (클릭)
              │     └── .char-scene-list   (S#1. 장소, INT, 낮 형식)
              └── textarea#charMemoArea   ← 캐릭터 설정/메모
```

### 이모지 피커
- `openCharEmojiPicker(name, anchorEl)` — 카드 이모지 클릭 시 호출
- `CHAR_EMOJIS` 배열 (40개)
- `setCharEmoji(name, emoji)` → `charInfo[name].emoji` 저장 후 `renderCharTab()`

---

## Boot 초기화 흐름 (중요)

Firebase Auth가 null → user 순서로 두 번 발화하는 경우 boot gate 플래시 버그 방지:

```javascript
let _bootGateDone = false;
function finishInitialOverlayGate() {
  if (_bootGateDone) return;  // 한 번만 실행
  _bootGateDone = true;
  document.body?.classList.remove('app-booting');
  document.getElementById('bootOverlayGate')?.remove();
}

// onAuthStateChanged:
// - user: restoreCurrentProjectOnBoot() 완료 후 finishInitialOverlayGate()
// - null: finishInitialOverlayGate() 호출 안 함 (boot gate 유지)
// showLanding(): _bootGateDone = false 로 리셋 (재활성화)
```

---

## 버전 히스토리 (최근)

| 버전 | 내용 |
|------|------|
| v95 | 요소 등록 버그 수정 (MERGE, _lastElemRegTime, fromEditor:false) |
| v96 | 다른 계정 동기화 수정 (_hasPendingLocalChanges 제거), 렌더 debounce |
| v97 | 촬영스케줄·일촬표 실시간 동기화 |
| v98 | 접속자 칩 UI (네모·쓰는중·불투명도 제거) |
| v99 | 페이지 구분선 "2쪽, 3쪽" 제거 |
| v100 | 소유자 중복 카드 수정, 참여자 초대 허용 |
| v101 | 프로젝트 이름 실시간 동기화 |
| v109 | boot gate 플래시 버그 수정 (Cmd+Shift+R) |
| v110 | 인물설정 → 상단 카드 스트립 (3:4, 좌우 스크롤) |
| v111 | 인물 이모지 피커, 배우/연락처 제거, 등장씬 형식 변경·접기 |

---

## 알려진 이슈 / 향후 과제

- **TextKit 2 Migration**: 긴 문서 성능 이슈 시 PM 에디터 추가 최적화 예정
- **버전 서브컬렉션 삭제**: batch 500건 제한 (현재 실사용 범위에서 문제없음)
