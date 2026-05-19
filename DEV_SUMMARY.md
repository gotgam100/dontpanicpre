# Don't Panic Pre — 개발 현황 요약

> 다른 Claude 세션에서 대화를 이어나가기 위한 문서.  
> 최종 업데이트: 2026-05-19

---

## ⚠️ 파일 구조 — 반드시 먼저 읽을 것

이 프로젝트는 파일이 분리되어 있습니다. **`index.html`은 HTML 뼈대만** 담고 있으며,
실제 로직과 스타일은 아래 파일에 있습니다.

| 파일 | 역할 | 줄 수 |
|------|------|-------|
| `index.html` | HTML 구조 (오버레이, 탭 패널, 버튼 등) | ~877줄 |
| `assets/app.js` | **모든 JavaScript 로직** (저장, 인증, UI, 에디터 등) | ~6740줄 |
| `assets/app.css` | 메인 스타일 | ~2170줄 |
| `assets/responsive.js` | 모바일 대응, 테마, 청크 렌더 | ~162줄 |
| `assets/responsive.css` | 반응형 미디어쿼리 | 별도 |
| `sw.js` | Service Worker (캐시 전략) | ~100줄 |

> **JavaScript 수정 = `assets/app.js` 수정**  
> **HTML 수정 = `index.html` 수정**  
> `index.html` 안에 `<script>` 태그로 JS를 추가하지 말 것.

---

## 프로젝트 개요

**Don't Panic Pre** — 영화/드라마 사전제작(pre-production) 웹앱 PWA  
- 순수 Vanilla JS, Firebase CDN compat SDK (ES Module 미사용)
- 로컬 서버: `python3 serve.py` → `http://localhost:8080`
- 확인은 반드시 `http://localhost:8080`에서 (file:// 열기는 Firebase Auth 미작동)

---

## 기술 스택

| 항목 | 내용 |
|------|------|
| 인증 | Firebase Auth — Google 로그인 / 이메일+비밀번호 |
| 저장소 | **File System Access API** (로컬 폴더 직접 읽기/쓰기) |
| 파일 포맷 | `.dpre.json` (프로젝트 1개 = 파일 1개) |
| 오프라인 캐시 | Firebase IndexedDB Persistence (초기화는 되어있으나 저장은 로컬 파일로) |
| 폴더 핸들 영속화 | IndexedDB (`dpre-fs` DB, `handles` objectStore) |
| 최근 프로젝트 | `localStorage['dpre-recent']` |
| 저장소 모드 | `localStorage['dpre-storage-chosen']` = `'drive'` \| `'app'` |

---

## 앱 상태 변수 (app.js 55~59줄)

```js
let _storageMode      = 'firestore'; // 'drive' | 'firestore' (런타임 결정)
let _currentFileName  = null;        // 현재 열린 파일명 (확장자 제외)
let _folderHandle     = null;        // FileSystemDirectoryHandle
let _folderParentName = null;        // 경로 표시용 상위 폴더명
let _currentFileHandle = null;       // FileSystemFileHandle
let _dataLoaded       = false;       // true일 때만 doSave() 허용
```

> **주의:** `_storageMode`의 값은 `'drive'` 또는 `'firestore'`이지만  
> `localStorage['dpre-storage-chosen']`의 값은 `'drive'` 또는 `'app'`으로 다름.

---

## IndexedDB 키 목록 (DB: `dpre-fs`, store: `handles`)

| 키 | 저장 내용 |
|----|----------|
| `'projectFolder'` | 현재 활성 `FileSystemDirectoryHandle` |
| `'folder:<폴더명>'` | 폴더명으로 핸들 조회 (최근 프로젝트 복원용) |
| `'parentName'` | 상위 폴더명 문자열 (경로 표시용) |

---

## 화면 플로우

```
최초 방문
  └─ #storageSetupOverlay (저장소 선택)
       ├─ Google Drive 선택 → signInWithPopup (팝업이 선택화면 위에 뜸)
       │    └─ 로그인 성공 → #projectsOverlay
       └─ 내 컴퓨터 선택 → #loginOverlay (이메일/Google 로그인)
            └─ 로그인 성공 → #projectsOverlay

재방문 (localStorage['dpre-storage-chosen'] 존재)
  └─ #loginOverlay → #projectsOverlay

로그아웃
  └─ localStorage['dpre-storage-chosen'] 삭제
     + IDB 핸들 전체 삭제 (idbClearFolderHandle)
     → #storageSetupOverlay
```

---

## 주요 화면 HTML ID 목록

| ID | 설명 |
|----|------|
| `#storageSetupOverlay` | 저장소 선택 화면 (최초 1회) |
| `#loginOverlay` | 로그인 화면 |
| `#projectsOverlay` | 프로젝트 목록 화면 |
| `#newProjectModal` | 새 프로젝트 생성 모달 |
| `#folderBrowseSection` | 폴더 열기 결과 (overlay 안 인라인) |
| `#recentProjectsList` | 최근 열어 본 프로젝트 목록 |
| `#folderGuideModal` | 폴더 선택 안내 모달 (JS로 동적 생성) |

---

## 프로젝트 목록 화면 (#projectsOverlay) 구조

```
Don't Panic Pre          ← .projects-title-area

안녕하세요. 이름         ← #projectsUserName

[＋ 새 프로젝트 만들기]  ← .proj-btn-primary → showNewProjectModal()
[📂 프로젝트 폴더 열기]  ← .proj-btn-secondary → pickOtherProjectFolder()

─ 폴더 탐색 결과 ─       ← #folderBrowseSection (기본 display:none)
  프로젝트1
  프로젝트2

─ 최근 열어 본 프로젝트 ─ ← #recentProjectsList
  프로젝트명
  📁 폴더경로

[🚪 로그아웃]
```

---

## 핵심 함수 목록 (app.js)

### 인증 / 저장소 선택
| 함수 | 줄 | 설명 |
|------|----|------|
| `onAuthStateChanged` | 62 | 로그인 상태 감지, 화면 분기 |
| `chooseStorage(choice)` | 119 | 저장소 선택 카드 클릭 핸들러 |
| `resetStorageChoice()` | 134 | 저장소 선택 초기화 → storageSetupOverlay |
| `googleLogin()` | ~148 | signInWithPopup |
| `logout()` | 266 | IDB 핸들 전체 삭제 + localStorage 삭제 + signOut |

### 폴더 선택 / 저장
| 함수 | 줄 | 설명 |
|------|----|------|
| `pickProjectFolder()` | 6115 | 가이드 모달 표시 후 `_doPickFolder` 호출 |
| `_doPickFolder()` | 6092 | `showDirectoryPicker` → 폴더 핸들 저장 |
| `_showFolderPickerGuide(onConfirm)` | 6054 | Drive/개인 모드별 안내 모달 표시 |
| `pickOtherProjectFolder()` | 6120 | 폴더 선택 → `_showFolderBrowseModal` |
| `_showFolderBrowseModal(handle)` | 6138 | 폴더 내 프로젝트 목록 인라인 표시 |
| `openBrowsedProject(idx)` | 6164 | 폴더 탐색 목록에서 프로젝트 열기 |
| `doSave()` | 5803 | 항상 로컬 파일로 저장 (두 모드 공통) |
| `localSaveProject(data)` | 6199 | `_folderHandle` + `_currentFileName`으로 파일 쓰기 |
| `localListProjects(dirHandle)` | 6188 | 폴더 내 `.dpre.json` 목록 반환 |

### 최근 프로젝트
| 함수 | 줄 | 설명 |
|------|----|------|
| `getRecentProjects()` | ~5988 | localStorage에서 최근 목록 읽기 |
| `addRecentProject(name, folderName, parentName)` | 5990 | 최근 목록에 추가 (최대 15개) |
| `renderRecentProjects()` | 5996 | `#recentProjectsList` 렌더링 |
| `openRecentProject(idx)` | 6010 | 3단계 fallback으로 파일 열기 |

### IndexedDB
| 함수 | 줄 | 설명 |
|------|----|------|
| `idbSaveFolderHandle(handle)` | 5949 | `projectFolder` + `folder:<name>` 두 키로 저장 |
| `idbGetFolderHandle()` | 5959 | 메인 키로 핸들 조회 |
| `idbGetFolderHandleByName(name)` | 5968 | 폴더명 키로 핸들 조회 |
| `idbClearFolderHandle()` | 5977 | store 전체 삭제 (로그아웃 시) |
| `verifyFolderAccess(handle)` | 6045 | queryPermission → requestPermission |

### 프로젝트 생성 / 불러오기
| 함수 | 줄 | 설명 |
|------|----|------|
| `showProjectsOverlay()` | 6235 | 프로젝트 화면 표시, IDB 핸들 복원 (권한 확인 없이) |
| `showNewProjectModal()` | 6284 | 새 프로젝트 모달 표시 |
| `confirmNewProject()` | 6308 | 에디터 초기화 + doSave() + addRecentProject() |
| `applyLoadedData(d)` | 6342 | JSON 데이터 → 에디터/변수 적용 |

---

## `openRecentProject` 동작 원리 (중요)

`showProjectsOverlay()`는 사용자 제스처 없이 호출되므로 `requestPermission`을 호출하지 않음.
대신 핸들만 메모리에 저장해두고, 실제 파일 열기 클릭 시점에 권한 요청.

```
클릭(사용자 제스처)
  → openRecentProject(idx)
       1. _folderHandle (메모리)
       2. idbGetFolderHandleByName(p.folderName)
       3. idbGetFolderHandle() (메인 키)
       ↓ 각 후보마다
       verifyFolderAccess() → requestPermission() ← 여기서 브라우저 권한 배너 표시
       → getFileHandle(name + '.dpre.json')
       → 파일 읽기 → applyLoadedData()
```

---

## 저장 방식 분기

```
doSave()
  └─ _storageMode 무관하게 항상 localSaveProject() 호출
       └─ _folderHandle.getFileHandle(_currentFileName + '.dpre.json', {create:true})
            → createWritable() → write(JSON) → close()
```

> `load()` 함수(Firestore 읽기)는 코드에 남아있으나 실제 호출 경로 없음.  
> 로그인 후 항상 프로젝트 목록 화면 → 수동 선택으로 진입.

---

## 현재 알려진 이슈 / 미완 사항

1. **`load()` 함수 (Firestore)** — 코드에 잔존하지만 호출되지 않음. 추후 정리 필요.
2. **`openFirestoreProject()` 함수** — 미사용 잔재, 삭제 가능.
3. **`_folderParentName` IDB 저장** — `_doPickFolder`에서만 저장됨. `pickOtherProjectFolder`로 열었을 때는 parentName이 null이므로 최근 목록 경로에 폴더명만 표시됨.
4. **최근 프로젝트 경로** — File System Access API는 전체 경로를 노출하지 않음 (보안 정책). 폴더명만 표시 가능.
5. **서식 패널 재설계** — 이전 플랜(plan 파일)에 설계된 CSS 인젝션 방식 리팩터링이 아직 미구현.

---

## 이전 플랜 파일 위치

```
/Users/baekmac/.claude/plans/generic-knitting-cloud.md
```

서식 패널 재설계(`fpUpdateParaCSS`, `fpRefreshFromSelection` 개선) 계획 포함.

---

## 로컬 서버 실행

```bash
cd /Users/baekmac/맥북_Home/01_개인작업/05_CODE/Dontpanicpre
python3 serve.py
# → http://localhost:8080
```
