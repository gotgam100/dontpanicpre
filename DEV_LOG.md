# Don't Panic Pre — 개발 로그

> 최종 업데이트: 2026-05-23  
> 현재 버전: v101  
> 배포 URL: https://dontpanicpre.web.app

---

## 프로젝트 개요

영화/드라마 대본 공동 편집 웹앱.  
- **에디터**: ProseMirror (PM) + Yjs WebSocket 실시간 협업  
- **저장소**: Firestore 단일 저장소 (Google Drive·로컬 File System 제거 완료)  
- **인증**: Firebase Auth (Google 로그인)  
- **호스팅**: Firebase Hosting

---

## 주요 파일

| 파일 | 역할 |
|------|------|
| `assets/app.js` | 메인 앱 로직 (저장/로드, 씬파싱, UI, 협업) |
| `assets/editor.js` | ProseMirror 에디터 모듈 (DPEditor API) |
| `assets/app.css` | 스타일 |
| `assets/responsive.js/css` | 반응형 |
| `index.html` | 진입점 |
| `sw.js` | Service Worker (캐시 전략) |
| `firestore.rules` | Firestore 보안 규칙 |

---

## 데이터 구조 (Firestore)

```
projects/{projectId}
  - name: string
  - owner: uid
  - ownerEmail: string
  - ownerName: string
  - memberEmails: string[]       ← 참여자(editor)
  - viewerEmails: string[]       ← 열람자(viewer)
  - memberProfiles: { [emailKey]: { name, emoji, email } }
  - shareCode: string            ← 참여자 초대 코드
  - viewerCode: string           ← 열람자 초대 코드
  - updatedBy: uid               ← 마지막 저장자
  - updatedAt: Timestamp
  - data: {
      html, sched, schedDays,
      project, author, date,
      charNotes, charInfo, manualChars,
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
  - data: { ... }   ← 전체 프로젝트 스냅샷
```

---

## 핵심 변수 (app.js 전역)

```javascript
let _currentProjectId = null;   // 현재 편집 중인 Firestore 문서 ID
let _currentFileName  = null;   // 프로젝트 표시 이름
let _myRole = 'editor';         // 'owner' | 'editor' | 'viewer'
let _saveTimer = null;
let _dataLoaded = false;        // load() 완료 전에는 절대 저장 안 함
let _suppressSave = false;      // applyLoadedData 중 저장 억제

// 요소 등록 관련
let _lastElemRegTime = 0;       // syncElemTagsFromEditor 3초 억제용
let _elemTagSyncTimer = null;

// Firestore 실시간 리스너 해제 함수들
let _projectDataListener = null;
let _presenceListener = null;
let _piPresenceUnsub = null;
```

---

## 실시간 협업 구조

### 1. 스크립트 텍스트 동기화
- **Yjs + WebSocket** (`DPEditor.connect(projectId)`)
- PM 마크(elemTag 하이라이트)도 Yjs가 동기화

### 2. 메타데이터 동기화 (`_projectDataListener`)
- `db.collection('projects').doc(projectId).onSnapshot(...)`
- **건너뜀 조건**: `d.updatedBy === currentUser.uid` (내가 저장한 것은 이미 로컬 반영)
- **MERGE 전략**: 상대 데이터를 base로, 로컬 항목 보존

#### 동기화 필드 목록
```javascript
sceneExtras        // MERGE (_mergeSceneExtras)
propList           // MERGE (_mergeList)
costumeList        // MERGE (_mergeList)
charNotes, charInfo, manualCharsByScene
sceneNotes, locationInfo, locationOrder
csLabels, globalChars, charOrder, hiddenChars
sched, schedDays   // 촬영스케줄
callSheets         // 일촬표
d.name             // 프로젝트 이름 (사이드바 실시간 반영)
```

#### MERGE 헬퍼 (presenceJoin 클로저 내부)
```javascript
function _mergeSceneExtras(local, remote) {
  // remote를 base로, local에만 있는 항목 추가
  // ITEM_FIELDS: costumeItems, makeupItems, charPropItems,
  //              setPropItems, vfxItems, etcItems, locationItems
}
function _mergeList(local, remote, keyFields) {
  // remote를 base로, local에만 있는 항목 추가
}
```

### 3. 리스너 리렌더링 (현재 열린 탭만)
```javascript
renderSidebar(); renderLeftSidebar();
if (onTab('tab-scenebd'))     renderSceneBd();
if (onTab('tab-breakdown'))   renderBreakdown();
if (onTab('tab-chars'))       renderChars();
if (onTab('tab-loclist'))     renderLocList();
if (onTab('tab-proplist'))    renderPropList();
if (onTab('tab-costumelist')) renderCostumeList();
if (onTab('tab-schedule'))    renderSchedule();
if (onTab('tab-callsheet'))   renderCS();
```

---

## 요소 등록 (addSceneElement) 핵심 로직

```javascript
function addSceneElement(type, btn) {
  // 1. PM 선택 영역 캡처 (pmSelectionRange)
  // 2. pushUndo()
  // 3. _lastElemRegTime = Date.now()  ← syncElemTagsFromEditor 3초 억제
  // 4. item = { text, fromEditor: false }  ← PM 모드는 항상 false
  // 5. sceneExtras[snum][field].push(item)
  // 6. DPEditor.applyElemTag(type, from, to)  ← PM 마크 적용
  // 7. save()
}
```

**`fromEditor: false`** 인 이유:  
PM 마크는 Yjs가 동기화하므로, 마크 DOM 유무와 데이터를 분리.  
`syncElemTagsFromEditor()`는 `fromEditor: true` 항목만 DOM 체크 후 삭제 — PM 모드 항목은 절대 삭제 안 됨.

---

## 저장 흐름

```
사용자 입력
  → onEditorInput()
    → parseFromEditor(), renderSidebar(), renderLeftSidebar()
    → 무거운 탭 렌더 setTimeout 300ms  ← 원격 Yjs 키스트로크 폭주 방지
    → save()  →  setTimeout(doSave, 1500ms)

doSave()
  → fsStoreSave(name, data)
    → db.collection('projects').doc(id).set({ name, data, updatedBy, updatedAt }, merge)
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
- 참여자 제거 버튼: `_piIsOwner` 일 때만 표시

---

## 버전 히스토리

| 버전 | 날짜 | 주요 변경 |
|------|------|----------|
| v95 | 2026-05-23 | 요소 등록 버그 수정 (MERGE 방식, _lastElemRegTime 가드, fromEditor:false) |
| v96 | 2026-05-23 | 다른 계정 동기화 수정 (_hasPendingLocalChanges 제거), 탭 렌더 디바운스 300ms |
| v97 | 2026-05-23 | 촬영스케줄·일촬표 계정 간 실시간 동기화 추가 |
| v98 | 2026-05-23 | 현재 접속자 UI 개선 (네모 테두리·쓰는중·불투명도 제거) |
| v99 | 2026-05-23 | 페이지 사이 "2쪽, 3쪽..." 표시 제거 |
| v100 | 2026-05-23 | 소유자 중복 카드 수정, 참여자도 초대 기능 허용 |
| v101 | 2026-05-23 | 프로젝트 이름 실시간 동기화 (사이드바 즉시 반영) |

---

## 알려진 이슈 / 향후 과제

- **TextKit 2 Migration**: 스크립트 에디터 TextKit 1→2 마이그레이션 예정 (긴 문서 성능 이슈 시 우선 적용). 별도 메모 파일 참고: `memory/project_textkit2_migration.md`
- **버전 서브컬렉션 일괄 삭제**: `fsStoreDeleteProject` 시 버전이 많으면 batch 500건 제한 초과 가능 — 현재는 실사용 범위에서 문제없음
- **Firestore 규칙**: `projects/{projectId}` 컬렉션 owner/member/viewer 접근제어 규칙 확인 필요

---

## SW 버전 업 절차

```javascript
// sw.js
const VERSION = "v{N}-{날짜}-{설명}";

// index.html (두 곳)
assets/editor.js?v={날짜}-{설명}
assets/app.js?v={날짜}-{설명}
```

배포:
```bash
firebase deploy --only hosting
```
