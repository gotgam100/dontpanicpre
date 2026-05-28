"use strict";

// ══════════════════════════════════════════════════
// 상수
// ══════════════════════════════════════════════════
const VERSION_MAX      = 10;  // 프로젝트당 보관 버전 최대 개수
const VERSION_SAVE_INTERVAL = 20; // N번 저장마다 버전 스냅샷 생성

const LINE_TYPES = {
  heading:  { cls:'l-heading',  label:'씬 헤딩' },
  action:   { cls:'l-action',   label:'지문'    },
  char:     { cls:'l-char',     label:'인물명'  },
  dialogue: { cls:'l-dialogue', label:'대사'    },
  insert:   { cls:'l-insert',   label:'인서트'  },
};
const NEXT_TYPE = { heading:'action', action:'action', char:'dialogue', dialogue:'action', insert:'action' };

// 두 유형 사이에 빈 줄이 필요한지 판단 (예외: 씬헤딩→지문, 인물명→대사)
function needsBlankLine(typeA, typeB) {
  if (!typeA || !typeB || typeA === typeB) return false;
  if (typeA === 'heading' && typeB === 'action')   return false;
  if (typeA === 'char'    && typeB === 'dialogue') return false;
  return true;
}

const TIME_MAP = {
  '낮':'day','주간':'day','오전':'day','오후':'day',
  '밤':'night','야간':'night','심야':'night','한밤':'night',
  '새벽':'dawn','여명':'dawn',
  '저녁':'eve','황혼':'eve','석양':'eve','해질':'eve',
};
const TIME_LABEL = { day:'낮', night:'밤', dawn:'새벽', eve:'저녁' };

// ══════════════════════════════════════════════════
// 🔥 Firebase 설정 — Firebase 콘솔에서 복사한 값으로 교체하세요
// ══════════════════════════════════════════════════
const firebaseConfig = {
  apiKey: "AIzaSyAgIRuMafXvUvz02_GEg3YCgjfxFWX-QjU",
  authDomain: "dontpanicpre.firebaseapp.com",
  projectId: "dontpanicpre",
  storageBucket: "dontpanicpre.firebasestorage.app",
  messagingSenderId: "531762901611",
  appId: "1:531762901611:web:fff6facfda7415fd47b72e",
  measurementId: "G-KZM84JP8YD"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// 오프라인에서도 마지막 데이터 볼 수 있도록 캐시 활성화
db.enablePersistence().catch(() => {});

// ── 인증 및 저장소 설정 ─────────────────────────────
const googleProvider = new firebase.auth.GoogleAuthProvider();

let _currentFileName  = null;   // 현재 편집 중인 프로젝트 표시 이름
let _currentProjectId = null;   // 현재 편집 중인 Firestore 문서 ID

let _suppressSave = false;  // applyLoadedData 중 save() 무시 (무한루프 방지)

// ── 커서 공유 & 역할 ─────────────────────────────────
const CURSOR_COLORS = ['#ef4444','#f97316','#a78bfa','#22c55e','#3b82f6','#f472b6','#14b8a6','#fb923c'];
let _cursorTimer = null;
let _myRole = 'editor'; // 'owner' | 'editor' | 'viewer'

const _bootHash = location.hash;
const _forceLandingOnBoot = _bootHash === '#landing';
const _forceLoginOnBoot = _bootHash === '#login';

// 정책 문서 등에서 돌아올 때는 인증 상태와 무관하게 랜딩을 먼저 보여준다.
if (_forceLandingOnBoot) {
  localStorage.removeItem('dpre-landing-v1');
  history.replaceState(null, '', location.pathname);
}

// #login 해시로 진입 시 랜딩 건너뛰고 바로 로그인창 표시
if (_forceLoginOnBoot) {
  localStorage.setItem('dpre-landing-v1', '1');
  history.replaceState(null, '', location.pathname);
}

// ══════════════════════════════════════════════════
// 랜딩 페이지
// ══════════════════════════════════════════════════
(function initLanding() {
  const overlay = document.getElementById('landingOverlay');
  if (!overlay) return;

  // 이미 방문한 경우 숨김 상태 유지 (remove 하지 않음 — showLanding 재사용)
  if (localStorage.getItem('dpre-landing-v1')) {
    return;
  }

  _setupLandingOverlay(overlay);
})();

function _setupLandingOverlay(overlay) {
  overlay.classList.remove('hidden', 'lp-out');

  // 리빌 상태 초기화
  overlay.querySelectorAll('.lp-reveal, .lp-hanim').forEach(el => {
    el.classList.remove('in-view');
  });

  // 스크롤 맨 위로
  const scroller = overlay.querySelector('#lpScroller') || document.getElementById('lpScroller');
  if (scroller) scroller.scrollTop = 0;

  // 히어로 입장 애니메이션 트리거
  overlay.classList.remove('lp-loaded');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    overlay.classList.add('lp-loaded');
  }));

  // IntersectionObserver — 스크롤 리빌
  if (scroller) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('in-view');
          io.unobserve(e.target);
        }
      });
    }, { root: scroller, threshold: 0.18 });
    overlay.querySelectorAll('.lp-reveal, .lp-hanim').forEach(el => io.observe(el));

    // 히어로 패럴랙스
    const heroContent = overlay.querySelector('#lpHeroContent');
    const glow1 = overlay.querySelector('.lp-glow-1');
    scroller.addEventListener('scroll', () => {
      const y = scroller.scrollTop;
      if (heroContent) {
        heroContent.style.opacity = Math.max(0, 1 - y / 320);
        heroContent.style.transform = `translateY(${y * 0.38}px)`;
      }
      if (glow1) {
        glow1.style.transform = `translate(-50%, calc(-54% + ${y * 0.15}px))`;
      }
    }, { passive: true });
  }
}

// ── Firebase Auth 상태 감지 ───────────────────────
function _isLandingVisible() {
  const el = document.getElementById('landingOverlay');
  return el && !el.classList.contains('hidden');
}

let _bootGateDone = false;
function finishInitialOverlayGate() {
  if (_bootGateDone) return;
  _bootGateDone = true;
  document.body?.classList.remove('app-booting');
  document.getElementById('bootOverlayGate')?.remove();
}

auth.onAuthStateChanged(async user => {
  if (user) {
    document.getElementById('loginOverlay')?.classList.add('hidden');
    try {
      const name  = getProfileName();
      const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      setEl('myInfoEmail',      user.email || '');
      setEl('myInfoName',       name);
      setEl('sidebarUserName',  name);
      setEl('sidebarUserEmail', user.email || '');
      setEl('sidebarPopupName',  name);
      setEl('sidebarPopupEmail', user.email || '');
      updateSidebarRoleBadge();
      applyProfileEmoji();
      initEmojiPicker();
    } catch(e) {
      console.error('사용자 정보 표시 오류:', e);
    }
    if (_forceLandingOnBoot) {
      showLanding();
      finishInitialOverlayGate();
      return;
    }
    // 랜딩이 떠 있는 경우 dismissLanding()이 showProjectsOverlay를 호출하므로 여기서는 건너뜀
    if (!_isLandingVisible()) {
      const restored = await restoreCurrentProjectOnBoot();
      finishInitialOverlayGate();
      if (!restored) showProjectsOverlay();
    }
  } else {
    document.getElementById('projectsOverlay')?.classList.add('hidden');
    if (!_isLandingVisible()) {
      document.getElementById('loginOverlay')?.classList.remove('hidden');
      // null 상태에서는 boot gate를 해제하지 않음:
      // Firebase가 null → user 순으로 두 번 발화할 때 boot gate가
      // 미리 제거되면 user 콜백 중 projectsOverlay가 잠깐 노출되는 버그 방지.
      // 로그인 완료(user 콜백) 또는 로그인 액션 후에 해제됨.
    }
  }
});

// ── Google 로그인 ────────────────────────────────
async function googleLogin() {
  setAuthLoading(true);
  try {
    await auth.signInWithPopup(googleProvider);
  } catch(e) {
    if (e.code !== 'auth/popup-closed-by-user') {
      _authSetError(firebaseErrMsg(e.code));
    }
  }
  setAuthLoading(false);
}

// ── 이메일 인증 ────────────────────────────────────
window._authMode = 'login';

function switchAuthTab(mode) {
  window._authMode = mode;
  document.getElementById('authTabLogin')?.classList.toggle('active', mode === 'login');
  document.getElementById('authTabSignup')?.classList.toggle('active', mode === 'signup');
  const confirmEl = document.getElementById('authPasswordConfirm');
  const forgotEl  = document.getElementById('authForgotBtn');
  const submitEl  = document.getElementById('authSubmitBtn');
  const passEl    = document.getElementById('authPassword');
  if (confirmEl) confirmEl.style.display = mode === 'signup' ? '' : 'none';
  if (forgotEl)  forgotEl.style.display  = mode === 'login'  ? '' : 'none';
  if (submitEl)  submitEl.textContent    = mode === 'login'  ? '로그인' : '회원가입';
  if (passEl)    passEl.autocomplete     = mode === 'login'  ? 'current-password' : 'new-password';
  _authSetError('');
}

async function authSubmit() {
  const email    = (document.getElementById('authEmail')?.value    || '').trim();
  const password =  document.getElementById('authPassword')?.value || '';
  if (!email || !password) { _authSetError('이메일과 비밀번호를 입력하세요'); return; }

  if (window._authMode === 'signup') {
    const confirm = document.getElementById('authPasswordConfirm')?.value || '';
    if (password.length < 6)       { _authSetError('비밀번호는 6자 이상이어야 합니다'); return; }
    if (password !== confirm)      { _authSetError('비밀번호가 일치하지 않습니다'); return; }
    setAuthLoading(true);
    try {
      await auth.createUserWithEmailAndPassword(email, password);
    } catch(e) { _authSetError(firebaseErrMsg(e.code)); }
  } else {
    setAuthLoading(true);
    try {
      await auth.signInWithEmailAndPassword(email, password);
    } catch(e) { _authSetError(firebaseErrMsg(e.code)); }
  }
  setAuthLoading(false);
}

function showResetPanel() {
  document.getElementById('authResetPanel').style.display = '';
  document.getElementById('authFormDiv').style.display    = 'none';
  document.getElementById('authTabsDiv').style.display    = 'none';
  document.getElementById('authOrDiv').style.display      = 'none';
  document.getElementById('authGoogleBtn').style.display  = 'none';
  const resetEmail = document.getElementById('authResetEmail');
  if (resetEmail) { resetEmail.value = document.getElementById('authEmail')?.value || ''; resetEmail.focus(); }
  _authSetError('');
}

function hideResetPanel() {
  document.getElementById('authResetPanel').style.display = 'none';
  document.getElementById('authFormDiv').style.display    = '';
  document.getElementById('authTabsDiv').style.display    = '';
  document.getElementById('authOrDiv').style.display      = '';
  document.getElementById('authGoogleBtn').style.display  = '';
  _authSetError('');
}

async function sendResetEmail() {
  const email = (document.getElementById('authResetEmail')?.value || '').trim();
  if (!email) { _authSetError('이메일을 입력하세요'); return; }
  setAuthLoading(true);
  try {
    await auth.sendPasswordResetEmail(email);
    _authSetError('재설정 메일을 보냈습니다. 받은 편지함을 확인하세요.', true);
    hideResetPanel();
  } catch(e) {
    _authSetError(firebaseErrMsg(e.code));
  }
  setAuthLoading(false);
}

function _authSetError(msg, isSuccess = false) {
  const el = document.getElementById('authLoginError');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isSuccess ? '#4ade80' : '';
}

// ── 계정 삭제 ────────────────────────────────────
async function deleteAccount() {
  if (!auth.currentUser) return;
  const user     = auth.currentUser;
  const email    = user.email;
  const provider = user.providerData[0]?.providerId;
  if (!confirm(`⚠️ 계정(${email})을 정말 삭제하시겠습니까?\n\n모든 프로젝트 데이터가 영구 삭제되며\n이 작업은 되돌릴 수 없습니다.`)) return;
  try {
    if (provider === 'google.com') {
      await auth.signInWithPopup(googleProvider);
    } else {
      const pw = prompt('계정 삭제 확인을 위해 비밀번호를 입력하세요:');
      if (!pw) return;
      const cred = firebase.auth.EmailAuthProvider.credential(email, pw);
      await user.reauthenticateWithCredential(cred);
    }
    await db.collection('users').doc(user.uid).delete().catch(() => {});
    await user.delete();
    alert('계정이 삭제되었습니다. 이용해 주셔서 감사합니다.');
  } catch(e) {
    alert(firebaseErrMsg(e.code) || '오류: ' + e.message);
  }
}

// ── 로그아웃 ─────────────────────────────────────
function confirmLogout() {
  showConfirmModal('로그아웃 하시겠습니까?', logout);
}

async function logout() {
  await presenceLeave().catch(() => {});

  _currentFileName = null;
  _currentProjectId = null;
  clearCurrentProjectMemory();
  _dataLoaded = false;
  await auth.signOut();
  if (window.DPEditor?.isReady()) DPEditor.setContent('');
  else ed().innerHTML = '';
  scenes=[]; sched={}; charNotes={}; charInfo={}; manualCharsByScene={}; sceneNotes={}; sceneExtras={}; csLabels={}; globalChars=[]; charOrder=[]; hiddenChars=[]; propList=[]; costumeList=[]; staffList=[]; actorList=[]; pageNumberStyle=null;
  _deletionLog.clear();
  calMonth = new Date();
  document.getElementById('projectName').value = '새 프로젝트';
  document.getElementById('authorName').value  = '';
  document.getElementById('projectDate').value = '';
  _authSetError('');
  checkEditorEmpty();
  // 랜딩 페이지로 복귀
  localStorage.removeItem('dpre-landing-v1');
  showLanding();
}

// ── 오류 메시지 한국어 변환 ────────────────────────
function firebaseErrMsg(code) {
  return ({
    'auth/user-not-found':         '등록되지 않은 이메일입니다',
    'auth/wrong-password':         '비밀번호가 올바르지 않습니다',
    'auth/invalid-credential':     '이메일 또는 비밀번호가 올바르지 않습니다',
    'auth/email-already-in-use':   '이미 사용 중인 이메일입니다',
    'auth/invalid-email':          '올바른 이메일 형식이 아닙니다',
    'auth/weak-password':          '비밀번호가 너무 약합니다 (6자 이상)',
    'auth/too-many-requests':      '잠시 후 다시 시도해주세요',
    'auth/network-request-failed': '네트워크 오류가 발생했습니다',
  })[code] || `오류: ${code}`;
}

function setAuthLoading(on) {
  document.getElementById('authLoading').style.display = on ? 'block' : 'none';
}

// ══════════════════════════════════════════════════
// Google Drive REST API 헬퍼
// ══════════════════════════════════════════════════
// Firestore 프로젝트 저장소
// ══════════════════════════════════════════════════

// ══════════════════════════════════════════════════
// Firestore 프로젝트 저장소 (top-level projects 컬렉션)
// 구조: projects/{projectId}  owner, memberEmails 필드로 접근 제어
// ══════════════════════════════════════════════════

// 프로젝트 문서에 내 프로필(이름+이모티콘) 저장
// 접속 여부와 무관하게 항상 최신 프로필이 보이도록 한다
async function _syncProfileToProject(projectId) {
  if (!projectId || !auth.currentUser) return;
  const user  = auth.currentUser;
  const email = (user.email || '').toLowerCase();
  const name  = getProfileName();
  const emoji = localStorage.getItem(PROFILE_EMOJI_KEY()) || DEFAULT_EMOJI;
  await db.collection('projects').doc(projectId).update({
    [`memberProfiles.${email.replace(/\./g,'_')}`]: { name, emoji, email }
  }).catch(() => {});
}

async function fsStoreSave(name, data) {
  const user = auth.currentUser;
  const col  = db.collection('projects');
  if (_currentProjectId) {
    await col.doc(_currentProjectId).update({
      name, data,
      updatedAt:     firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy:     user.uid,
      updatedByName: user.displayName || user.email || '알 수 없음',
    });
  } else {
    const ref = await col.add({
      name, data,
      owner:      user.uid,
      ownerEmail: user.email || '',
      ownerName:  user.displayName || user.email || '',
      memberEmails: [],
      createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:  firebase.firestore.FieldValue.serverTimestamp(),
    });
    _currentProjectId = ref.id;
  }
}

async function fsStoreListProjects() {
  const user = auth.currentUser;
  const col  = db.collection('projects');
  const [ownedSnap, sharedSnap, viewerSnap] = await Promise.all([
    col.where('owner', '==', user.uid).get(),
    col.where('memberEmails', 'array-contains', user.email).get(),
    col.where('viewerEmails', 'array-contains', user.email).get(),
  ]);
  const ownedSet = new Set(ownedSnap.docs.map(d => d.id));
  const sharedSet = new Set(sharedSnap.docs.map(d => d.id));
  const toItem = (d, isOwner, isViewer) => ({
    id: d.id, name: d.data().name,
    updatedAt: d.data().updatedAt?.toDate(),
    owner: d.data().owner, ownerEmail: d.data().ownerEmail || '',
    ownerName: d.data().ownerName || '', memberEmails: d.data().memberEmails || [],
    isOwner, isViewer: isViewer || false,
  });
  const owned  = ownedSnap.docs.map(d => toItem(d, true, false));
  const shared = sharedSnap.docs.filter(d => !ownedSet.has(d.id)).map(d => toItem(d, false, false));
  const viewer = viewerSnap.docs.filter(d => !ownedSet.has(d.id) && !sharedSet.has(d.id)).map(d => toItem(d, false, true));
  return [...owned, ...shared, ...viewer].sort((a, b) => (b.updatedAt?.getTime() || 0) - (a.updatedAt?.getTime() || 0));
}

async function fsStoreLoadProject(projectId) {
  const doc = await db.collection('projects').doc(projectId).get();
  if (!doc.exists) throw new Error('프로젝트를 찾을 수 없습니다');
  return doc.data().data;
}

async function fsStoreGetProject(projectId) {
  const doc = await db.collection('projects').doc(projectId).get();
  if (!doc.exists) throw new Error('프로젝트를 찾을 수 없습니다');
  return { id: doc.id, ...doc.data() };
}

async function fsStoreDeleteProject(projectId) {
  const vSnap = await db.collection('projects').doc(projectId).collection('versions').get();
  const batch = db.batch();
  vSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(db.collection('projects').doc(projectId));
  await batch.commit();
}

async function fsStoreRenameProject(projectId, newName) {
  await db.collection('projects').doc(projectId).update({
    name: newName, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function fsStoreInviteMember(projectId, email) {
  await db.collection('projects').doc(projectId).update({
    memberEmails: firebase.firestore.FieldValue.arrayUnion(email.toLowerCase().trim())
  });
}

async function fsStoreRemoveMember(projectId, email) {
  await db.collection('projects').doc(projectId).update({
    memberEmails: firebase.firestore.FieldValue.arrayRemove(email.toLowerCase().trim())
  });
}

// ── 공유 코드 ────────────────────────────────────
function _genShareCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length: 8}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function fsStoreSetShareCode(projectId, code) {
  const batch = db.batch();
  batch.update(db.collection('projects').doc(projectId), { shareCode: code });
  batch.set(db.collection('shareCodes').doc(code), {
    projectId, role: 'editor',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await batch.commit();
}

async function fsStoreSetViewerCode(projectId, code) {
  const batch = db.batch();
  batch.update(db.collection('projects').doc(projectId), { viewerCode: code });
  batch.set(db.collection('shareCodes').doc(code), {
    projectId, role: 'viewer',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await batch.commit();
}

async function fsStoreFindByShareCode(code) {
  const doc = await db.collection('shareCodes').doc(code.toUpperCase()).get();
  if (!doc.exists) return null;
  return doc.data(); // { projectId, role }
}

async function fsStoreInviteViewer(projectId, email) {
  await db.collection('projects').doc(projectId).update({
    viewerEmails: firebase.firestore.FieldValue.arrayUnion(email.toLowerCase().trim())
  });
}

async function fsStoreRemoveViewer(projectId, email) {
  await db.collection('projects').doc(projectId).update({
    viewerEmails: firebase.firestore.FieldValue.arrayRemove(email.toLowerCase().trim())
  });
}

// ── 참여자/열람자 코드로 프로젝트 참여 (projectsOverlay에서 호출) ──
// 최근 프로젝트 탭의 코드 참여 — 입력값을 mine 탭 input에 복사 후 위임
async function joinByShareCode2() {
  const input2 = document.getElementById('joinCodeInput2');
  const input  = document.getElementById('joinCodeInput');
  if (input && input2) input.value = input2.value;
  return joinByShareCode();
}

async function joinByShareCode() {
  const input = document.getElementById('joinCodeInput');
  const code  = (input?.value || '').trim().toUpperCase();
  if (code.length < 6) { showToast('올바른 코드를 입력하세요'); return; }
  const user = auth.currentUser;
  if (!user) { showToast('로그인이 필요합니다'); return; }
  try {
    showToast('확인 중...');
    const codeData = await fsStoreFindByShareCode(code);
    if (!codeData || !codeData.projectId) { showToast('코드를 찾을 수 없습니다'); return; }
    const { projectId, role } = codeData;
    const isViewer = role === 'viewer';

    const email = (user.email || '').toLowerCase();

    // 비회원은 projects 문서를 직접 읽을 수 없으므로
    // update 를 먼저 시도 — Firestore 규칙이 shareCode/viewerCode 기반 자기 이메일 추가를 허용
    try {
      if (isViewer) {
        await db.collection('projects').doc(projectId).update({
          viewerEmails: firebase.firestore.FieldValue.arrayUnion(email)
        });
      } else {
        await db.collection('projects').doc(projectId).update({
          memberEmails: firebase.firestore.FieldValue.arrayUnion(email)
        });
      }
    } catch(updateErr) {
      if (updateErr.code === 'permission-denied') {
        showToast('이미 참여 중이거나 유효하지 않은 코드입니다');
      } else {
        showToast('참여 실패: ' + updateErr.message);
      }
      return;
    }

    // update 성공 → 이제 멤버/열람자이므로 읽기 가능
    if (input) input.value = '';
    try {
      const projDoc = await db.collection('projects').doc(projectId).get();
      const name = projDoc.exists ? projDoc.data().name : '프로젝트';
      showToast(`"${name}"${isViewer ? '을(를) 열람자로 참여했습니다!' : '에 참여했습니다!'}`);
    } catch(_) {
      showToast('프로젝트에 참여했습니다!');
    }
    showProjectsOverlay();
  } catch(e) { showToast('오류: ' + e.message); }
}

// ── 역할 판단 ─────────────────────────────────────────
function _getMyRole(proj) {
  if (!proj || !auth.currentUser) return 'viewer';
  const uid   = auth.currentUser.uid;
  const email = (auth.currentUser.email || '').toLowerCase();
  if (proj.owner === uid) return 'owner';
  if ((proj.memberEmails  || []).includes(email)) return 'editor';
  if ((proj.viewerEmails  || []).includes(email)) return 'viewer';
  return 'viewer';
}

function updateSidebarRoleBadge() {
  const el = document.getElementById('sidebarUserRole');
  if (!el) return;
  const meta = {
    owner:  { label: '소유자', cls: 'role-owner' },
    editor: { label: '참여자', cls: 'role-editor' },
    viewer: { label: '열람자', cls: 'role-viewer' },
  }[_myRole] || { label: '', cls: '' };
  el.textContent = meta.label;
  el.className = `sidebar-user-role ${meta.cls}`.trim();
  el.style.display = meta.label ? '' : 'none';
}

async function fsStoreSaveVersion(name, data) {
  if (!_currentProjectId) return;
  await db.collection('projects').doc(_currentProjectId).collection('versions').add({
    name, data, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  await fsStorePruneVersions();
}

async function fsStoreListVersions() {
  if (!_currentProjectId) return [];
  const snap = await db.collection('projects').doc(_currentProjectId).collection('versions')
    .orderBy('createdAt', 'desc').limit(VERSION_MAX).get();
  return snap.docs.map(d => ({ id: d.id, name: d.data().name }));
}

async function fsStoreLoadVersion(versionId) {
  const doc = await db.collection('projects').doc(_currentProjectId)
    .collection('versions').doc(versionId).get();
  if (!doc.exists) throw new Error('버전을 찾을 수 없습니다');
  return doc.data().data;
}

async function fsStorePruneVersions() {
  if (!_currentProjectId) return;
  const snap = await db.collection('projects').doc(_currentProjectId).collection('versions')
    .orderBy('createdAt', 'desc').get();
  const toDelete = snap.docs.slice(VERSION_MAX);
  if (!toDelete.length) return;
  const batch = db.batch();
  toDelete.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// ── 프로젝트 목록 렌더링 ─────────────────────────
let _fsProjectList = [];

function _renderFsProjectList(projects) {
  _fsProjectList = projects;
  const listEl = document.getElementById('folderBrowseList');
  if (!listEl) return;
  listEl.className = projects.length > 3 ? 'folder-browse-scroll' : '';

  const gearSvg  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

  if (!projects.length) {
    listEl.innerHTML = '<div style="text-align:center;padding:12px;font-size:12px;opacity:.55">프로젝트가 없습니다</div>';
    return;
  }

  listEl.innerHTML = projects.map((p, i) => {
    const memberCount = p.memberEmails?.length || 0;
    const roleBadge = p.isViewer
      ? `<span class="fbi-shared-badge fbi-viewer-badge">열람자</span>`
      : !p.isOwner
        ? `<span class="fbi-shared-badge">공유됨</span>`
        : memberCount > 0
          ? `<span class="fbi-member-badge">👥 ${memberCount}</span>`
          : '';
    const ownerLabel = !p.isOwner
      ? `<span class="fbi-owner-label">${esc(p.ownerName || p.ownerEmail || '공유')}</span>`
      : '';
    // 열람자는 설정 기어 아이콘 숨김
    const actionBtn = !p.isViewer
      ? `<button class="fbi-action-btn" title="프로젝트 관리" onclick="showProjectManage('${p.id}',event)">${gearSvg}</button>`
      : '';
    return `
      <div class="folder-browse-item fbi-drive-item" onclick="openFsProject(${i})">
        <span class="fbi-icon">🎬</span>
        <div class="fbi-main">
          <span class="fbi-name fbi-open-link">${esc(p.name)}</span>
          <div class="fbi-meta">${ownerLabel}${roleBadge}</div>
        </div>
        <span class="fbi-actions">${actionBtn}</span>
        <span class="fbi-date">${_fmtModified(p.updatedAt?.getTime())}</span>
      </div>`;
  }).join('');
}

async function openFsProject(idx) {
  const p = _fsProjectList[idx];
  if (!p) return;
  showToast('불러오는 중...');
  try {
    await openProjectById(p.id, p.name);
  } catch(e) { showToast('불러오기 오류: ' + e.message); }
}

// ── 프로젝트 관리 모달 ──────────────────────────
let _pmProjectId       = null;
let _pmCurrentProj     = null;
let _pmIsOwner         = false;
let _pmPresenceData    = {};
let _pmPresenceUnsub   = null;

async function showProjectManage(projectId, e) {
  e?.stopPropagation();
  _pmProjectId = projectId;
  document.getElementById('projectManageModal')?.classList.remove('hidden');
  await _pmRefresh();
  // presence 실시간 구독
  if (_pmPresenceUnsub) _pmPresenceUnsub();
  _pmPresenceUnsub = db.collection('presence').doc(projectId).onSnapshot(snap => {
    _pmPresenceData = snap.exists ? snap.data() : {};
    _pmRenderMembers();
  });
}

function closeProjectManage() {
  document.getElementById('projectManageModal')?.classList.add('hidden');
  if (_pmPresenceUnsub) { _pmPresenceUnsub(); _pmPresenceUnsub = null; }
  _pmProjectId = null; _pmCurrentProj = null;
}

async function _pmRefresh() {
  if (!_pmProjectId) return;
  try {
    const proj = await fsStoreGetProject(_pmProjectId);
    const user = auth.currentUser;
    _pmCurrentProj = proj;
    _pmIsOwner = proj.owner === user.uid;

    const nameEl = document.getElementById('pmProjectName');
    if (nameEl) nameEl.textContent = proj.name;

    document.getElementById('pmDangerZone').style.display = _pmIsOwner ? '' : 'none';
    document.getElementById('pmLeaveZone').style.display  = !_pmIsOwner ? '' : 'none';
    _pmRenderMembers(); // 소유자 행도 여기서 presence 기반 렌더링
  } catch(e) { showToast('불러오기 오류: ' + e.message); }
}

function _pmRenderMembers() {
  const proj = _pmCurrentProj;
  if (!proj) return;
  const user  = auth.currentUser;
  const now   = Date.now();

  const gridEl = document.getElementById('pmMemberGrid');
  if (!gridEl) return;

  // presence에서 email 매핑
  const presenceByEmail = {};
  Object.values(_pmPresenceData).forEach(v => {
    if (v.email) presenceByEmail[v.email.toLowerCase()] = v;
  });

  function _mkCard(email, type, removeFn) {
    const pData   = presenceByEmail[email.toLowerCase()];
    const isOnline= pData && (now - pData.updatedAt < 120000);
    const profileKey = email.toLowerCase().replace(/\./g, '_');
    const profile = proj.memberProfiles?.[profileKey];
    const isMe    = email.toLowerCase() === (user.email || '').toLowerCase();
    const name    = isMe ? getProfileName() : (profile?.name || pData?.name || email.split('@')[0]);
    const emoji   = isMe ? (localStorage.getItem(PROFILE_EMOJI_KEY()) || DEFAULT_EMOJI)
                         : (profile?.emoji || pData?.emoji || '👤');
    const removeBtn = removeFn && !isMe
      ? `<button class="mc-remove-btn" title="제거" onclick="${removeFn}('${esc(email)}')">×</button>`
      : '';
    return `<div class="mc-card ${type}">
      ${removeBtn}
      <span class="mc-card-dot ${type} ${isOnline ? 'online' : ''}"></span>
      <span class="mc-emoji">${emoji}</span>
      <div class="mc-name">${esc(name)}</div>
      ${isMe ? '<span class="mc-me-badge">나</span>' : ''}
    </div>`;
  }

  // 소유자 카드 (이메일 없음)
  const op = _pmPresenceData[proj.owner];
  const ownerOnline = op && (now - op.updatedAt < 120000);
  const ownerProfileKey = (proj.ownerEmail || '').toLowerCase().replace(/\./g, '_');
  const ownerProfile = proj.memberProfiles?.[ownerProfileKey];
  const ownerEmoji = (proj.owner === user.uid)
    ? (localStorage.getItem(PROFILE_EMOJI_KEY()) || ownerProfile?.emoji || '👤')
    : (ownerProfile?.emoji || op?.emoji || '👤');
  const ownerName = (proj.owner === user.uid)
    ? getProfileName()
    : (ownerProfile?.name || op?.name || proj.ownerName || proj.ownerEmail || '소유자');
  const ownerIsMe = proj.owner === user.uid;
  const ownerCard = `<div class="mc-card owner">
    <span class="mc-card-dot owner ${ownerOnline ? 'online' : ''}"></span>
    <span class="mc-emoji">${ownerEmoji}</span>
    <div class="mc-name">${esc(ownerName)}</div>
    ${ownerIsMe ? '<span class="mc-me-badge">나</span>' : ''}
  </div>`;

  const ownerEmailLower = (proj.ownerEmail || '').toLowerCase();
  const memberCards = (proj.memberEmails || [])
    .filter(e => e.toLowerCase() !== ownerEmailLower)
    .map(e => _mkCard(e, 'member', 'pmRemoveMember')).join('');
  const viewerCards = (proj.viewerEmails || [])
    .filter(e => e.toLowerCase() !== ownerEmailLower)
    .map(e => _mkCard(e, 'viewer', 'pmRemoveViewer')).join('');

  gridEl.innerHTML = ownerCard + memberCards + viewerCards;
}

async function pmInviteMember() {
  const input = document.getElementById('pmInviteEmail');
  const email = (input?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) { showToast('올바른 이메일을 입력하세요'); return; }
  if (email === (auth.currentUser.email || '').toLowerCase()) { showToast('본인은 이미 소유자입니다'); return; }
  if (_pmCurrentProj?.memberEmails?.includes(email)) { showToast('이미 초대된 참여자입니다'); return; }
  try {
    await fsStoreInviteMember(_pmProjectId, email);
    // local 캐시 즉시 반영
    if (_pmCurrentProj) _pmCurrentProj.memberEmails = [...(_pmCurrentProj.memberEmails || []), email];
    if (input) input.value = '';
    showToast(`${email} 초대 완료`);
    _pmRenderMembers();
    // home 목록도 갱신 (백그라운드)
    showProjectsOverlay().catch(() => {});
  } catch(e) { showToast('초대 실패: ' + e.message); }
}

async function pmRemoveMember(email) {
  if (!confirm(`"${email}" 참여자를 제거하시겠습니까?`)) return;
  try {
    await fsStoreRemoveMember(_pmProjectId, email);
    showToast('참여자 제거 완료');
    // Firestore에서 재조회하여 최신 상태 반영
    _pmCurrentProj = await fsStoreGetProject(_pmProjectId);
    _pmRenderMembers();
  } catch(e) { showToast('제거 실패: ' + e.message); }
}

async function pmRenameProject() {
  if (!_pmCurrentProj) return;
  const input = document.getElementById('pmRenameInput');
  const newName = (input?.value || '').trim();
  if (!newName || newName === _pmCurrentProj.name) return;
  try {
    await fsStoreRenameProject(_pmProjectId, newName);
    _pmCurrentProj.name = newName;
    if (_currentProjectId === _pmProjectId) _currentFileName = newName;
    const nameEl = document.getElementById('pmProjectName');
    if (nameEl) nameEl.textContent = newName;
    showToast('이름 변경 완료');
    showProjectsOverlay().catch(() => {});
  } catch(e) { showToast('이름 변경 오류: ' + e.message); }
}

async function pmLeaveProject() {
  if (!_pmCurrentProj) return;
  if (!confirm(`"${_pmCurrentProj.name}" 프로젝트에서 나가시겠습니까?`)) return;
  try {
    await fsStoreRemoveMember(_pmProjectId, auth.currentUser.email);
    closeProjectManage();
    if (_currentProjectId === _pmProjectId) { _currentProjectId = null; _currentFileName = null; _dataLoaded = false; }
    showToast('프로젝트에서 나갔습니다');
    showProjectsOverlay();
  } catch(e) { showToast('오류: ' + e.message); }
}

async function pmDeleteProject() {
  if (!_pmCurrentProj) return;
  if (!confirm(`"${_pmCurrentProj.name}" 프로젝트를 삭제하시겠습니까?\n버전 히스토리도 모두 삭제됩니다.`)) return;
  try {
    await fsStoreDeleteProject(_pmProjectId);
    if (_currentProjectId === _pmProjectId) { _currentProjectId = null; _currentFileName = null; _dataLoaded = false; }
    closeProjectManage();
    showToast('삭제 완료');
    showProjectsOverlay();
  } catch(e) { showToast('삭제 오류: ' + e.message); }
}

// ══════════════════════════════════════════════════
// 상태
// ══════════════════════════════════════════════════
let scenes            = [];
let filter            = 'all';
let sched             = {};       // { 'YYYY-MM-DD': [sceneNum,...] }
let schedDays         = {};       // { 'YYYY-MM-DD': 회차번호(int) }
let calMonth          = new Date();
let projectAdPhone    = '';       // 프로젝트 조감독 연락처
let projectPdPhone    = '';       // 프로젝트 PD 연락처
let charNotes         = {};       // { name: memo }
let charInfo          = {};       // { name: { gender:'남/여', age:'30대' } }
let manualCharsByScene= {};       // { sceneNum: [name,...] }
let sceneNotes        = {};       // { sceneNum: customSummary }
let sceneExtras       = {};       // { sceneNum: { costume, charProps, setProps, memo } }
let propList          = [];       // [{ id, name, category, character, location, desc }]
let propSort          = { charProp: 'default', setProp: 'default' }; // 'default'|'char'|'loc'|'status'
let costumeList       = [];       // [{ id, name, character, category:'costume'|'makeup', status, desc }]
let staffList         = [];       // [{ id, dept, role, detailRole, name, phone, email, note }]
let actorList         = [];       // [{ id, character, name, phone, note }]
let _ctxSavedSel      = null;     // 우클릭 요소 등록용 저장된 선택 정보

// ── 삭제 로그 (Firestore merge 시 삭제 항목 복원 방지용 tombstone) ──
// Firestore 실시간 리스너가 remote 데이터를 merge할 때, 로컬에서 삭제한 항목을
// 다시 복원하는 문제를 막기 위해 삭제 시각을 기록한다.
const _deletionLog = {
  // key: "snum::field::text"  value: timestamp(ms)  — 씬 단위 삭제
  elem:       new Map(),
  // key: "field::text"         value: timestamp(ms)  — 리스트 전체 삭제 (모든 씬)
  elemGlobal: new Map(),
  // key: "name::category"      value: timestamp(ms)
  prop:    new Map(),
  costume: new Map(),
  TTL:     300000, // 5분 — 여러 계정 간 Firestore 전파까지 충분한 시간

  _check(map, key) {
    const ts = map.get(key);
    if (!ts) return false;
    if (Date.now() - ts > this.TTL) { map.delete(key); return false; }
    return true;
  },
  // 씬 요소 (sceneExtras 배열 항목) — 씬 단위
  addElem(snum, field, text) {
    this.elem.set(`${snum}::${field}::${text}`, Date.now());
  },
  hasElem(snum, field, text) {
    return this._check(this.elem, `${snum}::${field}::${text}`);
  },
  // 리스트 전체 삭제 시 — 씬 번호 무관하게 해당 (field, text) 차단
  addElemGlobal(field, text) {
    this.elemGlobal.set(`${field}::${text}`, Date.now());
  },
  hasElemGlobal(field, text) {
    return this._check(this.elemGlobal, `${field}::${text}`);
  },
  // 소품리스트 항목
  addProp(name, category) {
    this.prop.set(`${name}::${category}`, Date.now());
  },
  hasProp(name, category) {
    return this._check(this.prop, `${name}::${category}`);
  },
  // 의상/분장 리스트 항목
  addCostume(name, category) {
    this.costume.set(`${name}::${category}`, Date.now());
  },
  hasCostume(name, category) {
    return this._check(this.costume, `${name}::${category}`);
  },
  // ── Firestore 직렬화 / 역직렬화 ──────────────────────────────
  // 유효 항목만 plain object로 변환 (doSave에서 저장)
  toFirestore() {
    const now = Date.now();
    const toObj = (map) => {
      const obj = {};
      for (const [k, ts] of map) {
        if (now - ts < this.TTL) obj[k] = ts;
      }
      return obj;
    };
    return {
      elem:       toObj(this.elem),
      elemGlobal: toObj(this.elemGlobal),
      prop:       toObj(this.prop),
      costume:    toObj(this.costume),
    };
  },
  // Firestore에서 받은 다른 계정의 삭제 로그를 병합 (최신 타임스탬프 우선)
  mergeFromFirestore(d) {
    if (!d) return;
    const now = Date.now();
    const mergeMap = (map, obj) => {
      for (const [k, ts] of Object.entries(obj || {})) {
        if (now - ts < this.TTL) {
          const existing = map.get(k);
          if (!existing || existing < ts) map.set(k, ts);
        }
      }
    };
    mergeMap(this.elem,       d.elem       || {});
    mergeMap(this.elemGlobal, d.elemGlobal || {});
    mergeMap(this.prop,       d.prop       || {});
    mergeMap(this.costume,    d.costume    || {});
  },
  // 프로젝트 변경 시 전체 초기화
  clear() {
    this.elem.clear(); this.elemGlobal.clear(); this.prop.clear(); this.costume.clear();
  },
};
let costumeSort       = 'default'; // 'default'|'char'|'category'|'status'
let pageNumberStyle   = null;     // null | 'single' | 'total'
let _pendingInsertRange = null;   // 인서트씬 등록 모달 대기 중 Range
let _pendingInsertMarkerId = null; // 모달 열기 전 삽입된 span 추적 ID

// insertId → 인서트씬 sceneNum 매핑 (parseFromEditor 실행 시 갱신)
// PM 재렌더로 data-scene-num 이 지워져도 올바른 씬 번호를 찾을 수 있도록
let _insertIdToSceneNum = {}; // { 'parentSeq:insertId': '1_ins1', ... }

const ensureArray = v => Array.isArray(v) ? v : [];
function normalizeListState() {
  propList    = ensureArray(propList);
  costumeList = ensureArray(costumeList);
  staffList   = ensureArray(staffList);
  actorList   = ensureArray(actorList);
  // 스태프 필드 마이그레이션: 구버전 데이터에 없는 필드 보완
  staffList.forEach(s => {
    if (s.detailRole === undefined) s.detailRole = '';
    if (s.email      === undefined) s.email      = '';
  });
  // 배우 필드 마이그레이션
  actorList.forEach(a => {
    if (a.agency === undefined) a.agency = '';
    if (a.phone2  === undefined) a.phone2  = '';
  });
}

const DEFAULT_STAFF = [
  { dept:'연출부',   role:'연출' },      { dept:'연출부',   role:'조연출' },
  { dept:'연출부',   role:'연출부 1st' }, { dept:'연출부',   role:'연출부 2nd' },
  { dept:'연출부',   role:'스크립터' },
  { dept:'제작부',   role:'프로듀서' },   { dept:'제작부',   role:'제작실장' },
  { dept:'제작부',   role:'제작부장' },   { dept:'제작부',   role:'제작부 1st' },
  { dept:'제작부',   role:'제작부 2nd' },
  { dept:'촬영부',   role:'촬영' },       { dept:'촬영부',   role:'촬영 1st' },
  { dept:'촬영부',   role:'촬영 2nd' },   { dept:'촬영부',   role:'촬영 3rd' },
  { dept:'촬영부',   role:'B캠 촬영' },
  { dept:'조명부',   role:'조명' },       { dept:'조명부',   role:'조명 1st' },
  { dept:'조명부',   role:'조명 2nd' },   { dept:'조명부',   role:'조명 3rd' },
  { dept:'동시녹음', role:'녹음' },       { dept:'동시녹음', role:'붐 오퍼레이터' },
  { dept:'미술',     role:'미술' },       { dept:'미술',     role:'미술팀' },
  { dept:'세트',     role:'세트' },       { dept:'세트',     role:'세트팀' },
  { dept:'의상',     role:'의상' },       { dept:'의상',     role:'의상팀' },
  { dept:'분장',     role:'분장' },       { dept:'분장',     role:'분장팀' },
  { dept:'편집',     role:'편집' },
  { dept:'사운드',   role:'믹싱' },
  { dept:'음악',     role:'음악' },
  { dept:'VFX',      role:'VFX' },
];
function _crewId() { return 'cr' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function _defaultStaff() {
  return DEFAULT_STAFF.map(s => ({
    id: _crewId(),
    dept: s.dept,
    role: s.role,
    detailRole: '',
    name: '',
    phone: '',
    email: '',
    note: ''
  }));
}

// ── 앱 레벨 Undo 스택 ─────────────────────────────────
let undoStack = [];
const MAX_UNDO = 40;
let _applyingUndo = false;  // undo 중 rename 감지 억제 플래그

function captureState() {
  normalizeListState();
  return {
    html:              ed().innerHTML,
    sceneExtras:       JSON.parse(JSON.stringify(sceneExtras)),
    charInfo:          JSON.parse(JSON.stringify(charInfo)),
    manualCharsByScene:JSON.parse(JSON.stringify(manualCharsByScene)),
    sceneNotes:        JSON.parse(JSON.stringify(sceneNotes)),
    charNotes:         JSON.parse(JSON.stringify(charNotes)),
    globalChars:       [...globalChars],
    charOrder:         [...charOrder],
    hiddenChars:       [...hiddenChars],
    locationInfo:      JSON.parse(JSON.stringify(locationInfo)),
    locationOrder:     [...locationOrder],
    propList:          JSON.parse(JSON.stringify(propList)),
    costumeList:       JSON.parse(JSON.stringify(costumeList)),
    pageNumberStyle,
  };
}

function pushUndo() {
  undoStack.push(captureState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function applyUndo() {
  if (!undoStack.length) return;
  const snap = undoStack.pop();
  // 상태 복원
  ed().innerHTML         = snap.html;
  sceneExtras            = snap.sceneExtras;
  charInfo               = snap.charInfo;
  manualCharsByScene     = snap.manualCharsByScene;
  sceneNotes             = snap.sceneNotes;
  charNotes              = snap.charNotes;
  globalChars            = snap.globalChars;
  charOrder              = snap.charOrder;
  hiddenChars            = snap.hiddenChars;
  locationInfo           = snap.locationInfo;
  locationOrder          = snap.locationOrder;
  propList               = ensureArray(snap.propList);
  costumeList            = ensureArray(snap.costumeList);
  pageNumberStyle        = snap.pageNumberStyle || null;
  // 리파싱 + 렌더 (rename 감지 억제)
  _applyingUndo = true;
  onEditorInput();
  _applyingUndo = false;
  // 유형 버튼 하이라이트 갱신
  refreshTypeUI();
  // 열려 있는 탭 즉시 갱신
  if (document.getElementById('tab-chars')?.classList.contains('on'))      renderCharTab();
}
let locationInfo      = {};       // { "장소명": { address: "", setPropItems: [] } }
let locationOrder     = [];       // 장소 카드 표시 순서
let csLabels          = {};       // 일촬표 공용 헤더 라벨 (모든 회차 공유)
let globalChars       = [];       // characters registered from selection (not tied to a scene)
let charOrder         = [];       // 인물 목록 표시 순서 (드래그로 변경)
let hiddenChars       = [];       // 명시적으로 삭제된 인물 (스크립트에서 재감지 방지)
let charDragName      = null;     // 드래그 중인 인물 이름
let selectedChar      = null;
let _charScenesOpen   = true;  // 등장씬 섹션 펼침/접기 상태
let _charDetailTab    = 'setting'; // 'setting' | 'scenes' | 'memo'
let selectedNums      = new Set();
let dragging          = null;
let lastDragY         = 0;

// ══════════════════════════════════════════════════
// 초기화
// ══════════════════════════════════════════════════
window.addEventListener('load', () => {
  // Firebase onAuthStateChanged가 로그인 상태를 자동 감지하여 처리합니다
  checkEditorEmpty();
  // showWelcomeIfFirst(); // 임시 비활성화
});

// ══════════════════════════════════════════════════
// 에디터
// ══════════════════════════════════════════════════
const ed = () => document.getElementById('scriptEditor');

function checkEditorEmpty() {
  const el = ed();
  const has = [...el.querySelectorAll('p')].some(p => p.textContent.trim());
  el.classList.toggle('empty', !has);
  document.getElementById('emptyOverlay').classList.toggle('hidden', has);

  // 내용이 완전히 비었으면 빈 <p> 잔재를 1개로 정리하고 minHeight 리셋
  // → 삭제 후 빈 페이지가 여러 장 남는 문제 방지
  if (!has) {
    // 남아 있는 모든 <p>의 pbPushed 마진 제거
    el.querySelectorAll('p').forEach(p => {
      p.style.marginTop = '';
      delete p.dataset.pbPushed;
    });
    // 빈 <p> 가 2개 이상이면 1개만 남김
    const paras = [...el.querySelectorAll('p')];
    if (paras.length > 1) {
      paras.slice(1).forEach(p => p.remove());
    }
    // inline minHeight 초기화 → CSS min-height: 297mm(1페이지)로 돌아감
    el.style.minHeight = '';
  }
}

function getCurrentP() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  const root = ed();
  while (node && node !== root) {
    if (node.nodeName === 'P') return node;
    node = node.parentNode;
  }
  return null;
}

function makePara(type, text) {
  const p = document.createElement('p');
  p.dataset.type = type;
  p.className = LINE_TYPES[type]?.cls || 'l-action';
  if (text) p.textContent = text;
  else p.innerHTML = '<br>';
  return p;
}

function moveCursorTo(el, selectAll) {
  if (window.DPEditor?.isReady()) {
    DPEditor.moveCursorToDOM(el, selectAll);
    return;
  }
  const range = document.createRange();
  const sel   = window.getSelection();
  if (selectAll && el.firstChild && el.firstChild.nodeType !== Node.ELEMENT_NODE)
    range.selectNodeContents(el);
  else { range.setStart(el, 0); range.collapse(true); }
  sel.removeAllRanges();
  sel.addRange(range);
  ed().focus();
}

// Ctrl+1~4: 현재 줄 유형 변경
function setLineType(type) {
  if (window.DPEditor?.isReady()) {
    DPEditor.setNodeType(type);
    refreshTypeUI();
    return;
  }
  // ProseMirror 미준비 시 폴백 (contentEditable 직접 조작)
  ed().focus();
  let p = getCurrentP();
  if (!p) {
    pushUndo();
    const newP = makePara(type, '');
    ed().appendChild(newP);
    moveCursorTo(newP, false);
    refreshTypeUI(); onEditorInput();
    return;
  }
  pushUndo();
  p.dataset.type = type;
  p.className = LINE_TYPES[type]?.cls || 'l-action';
  refreshTypeUI(); onEditorInput(); ed().focus();
}

// ── 씬 헤딩 입력 모달 ──────────────────────────────
let _hmSavedRange = null;
let _hmEditingP   = null;  // 수정 중인 기존 heading 단락 (null이면 신규)

function openHeadingModal() {
  const sel = window.getSelection();
  _hmSavedRange = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : null;

  const curP = getCurrentP();
  const isEditing = curP && curP.classList.contains('l-heading');
  _hmEditingP = isEditing ? curP : null;

  if (isEditing) {
    // 기존 헤딩 파싱해서 필드에 채우기
    const txt = curP.textContent.trim();
    const numM = txt.match(/^S#(\d+(?:-\d+)?)/i);
    if (numM) {
      document.getElementById('hmSceneNum').value = numM[1];
    } else {
      // 빈 헤딩 또는 번호 없는 헤딩: 다음 씬 번호 자동 계산
      const maxNum = scenes.length
        ? Math.max(0, ...scenes.filter(s => !s.isInsert).map(s => parseInt(s.number) || 0))
        : 0;
      document.getElementById('hmSceneNum').value = maxNum + 1;
    }
    document.getElementById('hmLoc').value = extractLoc(txt);

    const ie = detectIE(txt);
    document.querySelectorAll('#hmIE .hm-chip').forEach(b => b.classList.toggle('on', b.dataset.val === ie));

    const timeVal = detectTime(txt);
    const timeLabel = { day:'오후', night:'밤', dawn:'새벽', eve:'저녁' };
    // 원문에서 오전/오후/해질녘 직접 감지
    let label = '오후';
    if (txt.includes('새벽'))    label = '새벽';
    else if (txt.includes('오전')) label = '오전';
    else if (txt.includes('오후')) label = '오후';
    else if (txt.includes('해질')) label = '해질녘';
    else if (txt.includes('저녁')) label = '저녁';
    else if (txt.includes('밤'))  label = '밤';
    else label = timeLabel[timeVal] || '오후';
    document.querySelectorAll('#hmTime .hm-chip').forEach(b => b.classList.toggle('on', b.dataset.val === label));
  } else {
    // 신규: 다음 씬 번호 자동 계산
    const maxNum = scenes.length
      ? Math.max(0, ...scenes.filter(s => !s.isInsert).map(s => parseInt(s.number) || 0))
      : 0;
    document.getElementById('hmSceneNum').value = maxNum + 1;
    document.getElementById('hmLoc').value = '';
    document.querySelectorAll('#hmIE .hm-chip').forEach(b => b.classList.toggle('on', b.dataset.val === 'INT'));
    document.querySelectorAll('#hmTime .hm-chip').forEach(b => b.classList.toggle('on', b.dataset.val === '오후'));
  }

  document.getElementById('headingModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('hmLoc').focus(), 50);
}

function closeHeadingModal() {
  document.getElementById('headingModal').classList.add('hidden');
  _hmSavedRange = null;
  _hmEditingP   = null;
}

function hmSelect(groupId, btn) {
  document.querySelectorAll(`#${groupId} .hm-chip`).forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
}

function confirmHeading() {
  const num  = document.getElementById('hmSceneNum').value.trim();
  const loc  = document.getElementById('hmLoc').value.trim() || '장소 미지정';
  const ie   = document.querySelector('#hmIE .hm-chip.on')?.dataset.val || 'INT';
  const time = document.querySelector('#hmTime .hm-chip.on')?.dataset.val || '오후';

  const text = `S#${num}. ${ie}. ${loc} - ${time}`;

  pushUndo();
  ed().focus();

  if (_hmEditingP) {
    // 기존 헤딩 수정: 텍스트만 교체
    _hmEditingP.textContent = text;
    moveCursorTo(_hmEditingP, false);
  } else {
    // 신규 삽입
    if (_hmSavedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(_hmSavedRange);
    }
    const curP = getCurrentP();
    const newP = makePara('heading', text);
    if (curP) {
      if (!curP.textContent.trim()) curP.replaceWith(newP);
      else curP.after(newP);
    } else {
      ed().appendChild(newP);
    }
    moveCursorTo(newP, false);
  }

  refreshTypeUI();
  onEditorInput();
  save();
  closeHeadingModal();
}

// 삽입 버튼: 새 줄 삽입 + 커서(텍스트 전체 선택)
const INSERT_TEXT = {
  heading:'S#. INT. 장소명 - 낮', action:'지문을 입력하세요.', char:'인물명', dialogue:'대사를 입력하세요.',
};
function insertLine(type) {
  pushUndo();
  ed().focus();
  const curP = getCurrentP();
  const newP = makePara(type, INSERT_TEXT[type]);

  // 커서를 curP 뒤(또는 에디터 끝)에 위치시킨 후 execCommand로 삽입
  // → execCommand는 브라우저 undo 스택에 등록됨
  const sel = window.getSelection();
  const range = document.createRange();
  if (curP?.parentNode === ed()) {
    range.setStartAfter(curP); range.collapse(true);
  } else {
    range.selectNodeContents(ed()); range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);

  document.execCommand('insertHTML', false, newP.outerHTML);

  // 삽입된 단락으로 커서 이동
  const inserted = curP ? curP.nextElementSibling : ed().lastElementChild;
  if (inserted) {
    // data-type이 날아갔을 경우 복원
    if (!inserted.dataset.type) {
      inserted.dataset.type = type;
      inserted.className = LINE_TYPES[type]?.cls || 'l-action';
    }
    moveCursorTo(inserted, true);
  }
  refreshTypeUI(); onEditorInput();
}

// Enter 키 처리
function handleEnter() {
  pushUndo();
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range  = sel.getRangeAt(0);
  const curP   = getCurrentP();
  const root   = ed();
  if (!curP) { const p = makePara('action',''); root.appendChild(p); moveCursorTo(p,false); return; }

  const curType  = curP.dataset.type || 'action';
  const nextType = NEXT_TYPE[curType] || 'action';

  const rangeToEnd = range.cloneRange();
  rangeToEnd.selectNodeContents(curP);
  rangeToEnd.setStart(range.endContainer, range.endOffset);
  const afterText = rangeToEnd.toString();
  rangeToEnd.deleteContents();
  if (!curP.textContent.trim()) curP.innerHTML = '<br>';

  const newP = makePara(nextType, afterText);
  if (needsBlankLine(curType, nextType)) {
    const blankP = makePara('action', '');
    curP.after(blankP);
    blankP.after(newP);
  } else {
    curP.after(newP);
  }
  moveCursorTo(newP, false);
  onEditorInput();
  // Enter 직후 즉시 페이지 경계 조정 (플래시 방지)
  requestAnimationFrame(adjustPageBreaks);
}

// 숫자키 물리적 위치(e.code) → 숫자 매핑 (IME·레이아웃 무관하게 동작)
const _DIGIT_MAP = { Digit1:'1', Digit2:'2', Digit3:'3', Digit4:'4' };

function _getDigit(e) {
  // e.key가 정확히 숫자면 그대로, 아니면 e.code로 폴백
  if (/^[1-4]$/.test(e.key)) return e.key;
  return _DIGIT_MAP[e.code] || null;
}

function editorKeyDown(e) {
  // ProseMirror가 활성화되면 모든 키 처리를 PM 플러그인에 위임
  if (window.DPEditor?.isReady()) return;
  if (e.key === 'Enter') { e.preventDefault(); handleEnter(); }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    requestAnimationFrame(adjustPageBreaks);
  }
}

// window capture 단계에서 Cmd/Ctrl+숫자 가로채기
// → Chrome의 Cmd+1~4 탭 전환 인터셉트보다 먼저 실행됨
window.addEventListener('keydown', function(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  // ── 앱 레벨 Undo (Ctrl+Z / Cmd+Z) ──────────────────────
  if (ctrl && !e.shiftKey && e.key === 'z' && undoStack.length > 0) {
    e.preventDefault();
    e.stopPropagation();
    applyUndo();
    return;
  }
  if (ctrl && e.key === 'f' && document.getElementById('tab-editor')?.classList.contains('on')) {
    e.preventDefault();
    e.stopPropagation();
    const _fp = document.getElementById('frPanel');
    if (_fp.classList.contains('open')) closeFindReplace();
    else openFindReplace();
    return;
  }
  if (document.activeElement !== document.getElementById('scriptEditor')) return;
  if (!ctrl) return;
  const digit = _getDigit(e);
  if (!digit) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.altKey) {
    // Cmd/Ctrl+Alt+1~4 : 삽입
    if (digit==='1') insertLine('heading');
    else if (digit==='2') insertLine('action');
    else if (digit==='3') insertLine('char');
    else if (digit==='4') insertLine('dialogue');
  } else {
    // Cmd/Ctrl+1~4 : 유형 변경
    if (digit==='1') setLineType('heading');
    else if (digit==='2') setLineType('action');
    else if (digit==='3') setLineType('char');
    else if (digit==='4') setLineType('dialogue');
  }
}, { capture: true });

// ── 씬번호 자동 재매김 ─────────────────────────────
// ProseMirror 모드에서는 DOM 직접 조작 불가 → appendTransaction 방식으로 추후 구현 예정
function autoRenumberHeadings() {
  if (window.DPEditor?.isReady()) return;
  const sel = window.getSelection();
  const curNode = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  const paras = [...ed().querySelectorAll('p')];
  let seq = 0, insSeq = 0, curDisp = null;
  paras.forEach(p => {
    const text = p.textContent.trim();
    if (!text) return;
    const type = p.dataset.type || guessType(text);
    if (type === 'heading') {
      if (/^S#\d+-\d+/i.test(text)) return;
      seq++; insSeq = 0;
      const m = text.match(/^(S#)(\d+)([\s\S]*)/i);
      curDisp = seq;
      if (!m) return;
      if (parseInt(m[2]) !== seq) {
        const inThis = curNode && p.contains(curNode);
        if (!inThis) p.textContent = `${m[1]}${seq}${m[3]}`;
      }
    } else if (type === 'insert' && curDisp !== null) {
      insSeq++;
      const expected = `S#${curDisp}_INS_${insSeq}`;
      if (p.textContent.trim() !== expected) {
        const inThis = curNode && p.contains(curNode);
        if (!inThis) p.textContent = expected;
      }
    }
  });
}

function extractSceneNum(headingText) {
  const m = headingText.trim().match(/^S#(\d+(?:-\d+)?)/i);
  return m ? m[1] : null;
}

// ── 외부 붙여넣기 처리 ──────────────────────────────
// ProseMirror 활성 시: editor.js의 transformPastedText/transformPastedHTML이 처리.
// 폴백(PM 미준비): 기존 contentEditable 로직.
function editorPaste(e) {
  if (window.DPEditor?.isReady()) return;
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  if (!text) return;

  // 빈 줄은 유지하되 완전히 공백만 있는 줄은 제거
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return;

  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  // 선택 영역이 있으면 먼저 삭제
  sel.getRangeAt(0).deleteContents();

  const curP = getCurrentP();
  let insertAfter = (curP && curP.parentNode === ed()) ? curP : null;

  // 현재 <p>가 비어 있으면 그 자리를 첫 번째 줄로 교체
  const curEmpty = insertAfter && (insertAfter.textContent.trim() === '');

  lines.forEach((line, i) => {
    if (i === 0 && curEmpty) {
      // 현재 빈 줄을 첫 번째 붙여넣기 줄로 교체 (유형은 그대로 유지)
      insertAfter.textContent = line;
      return;
    }
    const p = document.createElement('p');
    p.dataset.type = 'action';
    p.className = LINE_TYPES['action'].cls;
    p.textContent = line;
    if (insertAfter) {
      insertAfter.parentNode.insertBefore(p, insertAfter.nextSibling);
    } else {
      ed().appendChild(p);
    }
    insertAfter = p;
  });

  // 커서를 마지막 삽입 줄 끝으로 이동
  if (insertAfter) {
    const r = document.createRange();
    r.selectNodeContents(insertAfter);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  refreshTypeUI();
  onEditorInput();
}

// ── 파싱 ──────────────────────────────────────────
let _inputRenderTimer = null; // 무거운 탭 렌더 디바운스 타이머

function onEditorInput() {
  // 인물 rename 감지: 이전 인물 목록 스냅샷
  const prevChars = allSceneChars();

  normalizeEditor();
  autoRenumberHeadings();
  const _prevInsertMap = { ..._insertIdToSceneNum }; // 파싱 전 스냅샷
  scenes = parseFromEditor();
  migrateInsertSceneData(_prevInsertMap);            // sceneNum 변경 시 데이터 이전
  // 스케줄 날짜 복원 + 인서트 씬 ie/time 수동 설정 복원
  scenes.forEach(s => {
    for (const [date, nums] of Object.entries(sched))
      if (nums.includes(s.number)) { s.schedDate = date; break; }
    if (s.isInsert) {
      const extra = sceneExtras[s.number] || {};
      if (extra.ie)   s.ie   = extra.ie;
      if (extra.time) s.time = extra.time;
      if (extra.loc)  s.loc  = extra.loc;
    }
  });
  checkEditorEmpty();
  renderSidebar();
  renderLeftSidebar();
  updatePageBreaks();
  scheduleAdjustPageBreaks();
  scheduleElemTagSync();

  // 인물 1개 삭제 + 1개 추가 = 이름 변경으로 판단 → 데이터 이전 (undo 중엔 skip)
  // added[0]이 이미 charInfo 데이터를 가진 기존 인물이면 rename이 아닌 "다른 씬에 동일 인물 추가"로 처리 → skip
  if (!_applyingUndo) {
    const newChars = allSceneChars();
    const removed  = prevChars.filter(c => !newChars.includes(c));
    const added    = newChars.filter(c => !prevChars.includes(c));
    if (removed.length === 1 && added.length === 1) {
      const addedInfo = charInfo[added[0]];
      const addedIsKnown = addedInfo && Object.keys(addedInfo).length > 0;
      if (!addedIsKnown) renameCharSilent(removed[0], added[0]);
    }
  }

  // 무거운 탭 렌더는 300ms 디바운스 — 원격 Yjs 키스트로크마다 실행되지 않도록
  clearTimeout(_inputRenderTimer);
  _inputRenderTimer = setTimeout(() => {
    if (document.getElementById('tab-chars')?.classList.contains('on'))      renderCharTab();
    if (document.getElementById('tab-scenebd')?.classList.contains('on'))    renderSceneBd();
    if (document.getElementById('tab-breakdown')?.classList.contains('on'))  renderBreakdown();
  }, 300);

  _sendCursorPosition();
  save();
}

// ── A4 페이지 구분선 + 상태바 업데이트 ───────────
const A4_PAGE_H = 1123; // A4 @ 96 dpi
function updatePageBreaks() {
  const layer  = document.getElementById('pageBreakLayer');
  const editor = document.getElementById('scriptEditor');
  if (!layer || !editor) return;
  // minHeight를 먼저 1페이지로 리셋해야 실제 콘텐츠 높이를 정확히 측정할 수 있음
  // (기존 minHeight가 남아 있으면 내용을 지워도 scrollHeight가 줄어들지 않음)
  editor.style.minHeight = A4_PAGE_H + 'px';
  const totalH   = editor.scrollHeight;
  const totalPages = Math.max(1, Math.ceil(totalH / A4_PAGE_H));
  // 마지막 페이지가 항상 꽉 찬 1페이지로 보이도록 min-height 강제
  const targetMinH = totalPages * A4_PAGE_H;
  if (editor.style.minHeight !== targetMinH + 'px') {
    editor.style.minHeight = targetMinH + 'px';
  }
  let html = '';
  if (pageNumberStyle) {
    for (let page = 1; page <= totalPages; page++) {
      const label = pageNumberStyle === 'total' ? `${page}/${totalPages}` : String(page);
      html += `<div class="page-footer-num" style="top:${page * A4_PAGE_H - 46}px">${label}</div>`;
    }
  }
  for (let y = A4_PAGE_H; y < totalPages * A4_PAGE_H; y += A4_PAGE_H) {
    html += `<div class="page-break-line" style="top:${y}px"></div>`;
  }
  layer.innerHTML = html;

  // 상태바: 총 페이지 (항상) + 씬 수 (있을 때만)
  const el = document.getElementById('parseStatus');
  if (el) {
    const sc = scenes.length;
    const pageStr = `<span style="color:var(--text-dim);font-weight:400">총 </span>`
      + `<b style="color:var(--text);font-weight:700">${totalPages}</b>`
      + `<span style="color:var(--text-dim);font-weight:400"> 페이지</span>`;
    const sceneStr = sc
      ? `<span style="color:var(--border2);margin:0 6px">|</span>`
        + `<b style="color:var(--text);font-weight:700">${sc}</b>`
        + `<span style="color:var(--text-dim);font-weight:400"> 씬</span>`
      : '';
    el.innerHTML = pageStr + sceneStr;
  }
}

// ── 페이지 경계 글자 잘림 방지 ───────────────────────────
// 구분선 밴드(52px, 위아래 26px)에 걸치는 단락을 다음 페이지로 밀어냄
let _pbAdjustTimer = null;
function scheduleAdjustPageBreaks() {
  if (window.DPEditor?.isReady()) return; // PM 모드에서는 DOM 직접 조작 금지
  clearTimeout(_pbAdjustTimer);
  _pbAdjustTimer = setTimeout(adjustPageBreaks, 50);
}
function adjustPageBreaks() {
  // ProseMirror 모드에서는 PM이 DOM을 직접 관리하므로
  // 단락에 style.marginTop을 주입하면 MutationObserver 루프가 발생한다.
  // pageBreakLayer(오버레이)만 사용하므로 여기서 종료.
  if (window.DPEditor?.isReady()) return;
  const editor = document.getElementById('scriptEditor');
  if (!editor) return;
  const paras = [...editor.querySelectorAll('p')];
  const MARGIN = 95; // 25mm @ 96dpi — 상단·하단 여백 (PDF @page margin 과 동일)

  paras.forEach(p => {
    if (p.dataset.pbPushed) {
      p.style.marginTop = '';
      delete p.dataset.pbPushed;
    }
  });
  void editor.offsetHeight;

  for (const p of paras) {
    const top    = p.offsetTop;
    const bottom = top + p.offsetHeight;
    // 이 단락에 영향 주는 페이지 구분선 범위 탐색
    const startPage = Math.max(1, Math.floor(top / A4_PAGE_H));
    const endPage   = Math.ceil((bottom + MARGIN) / A4_PAGE_H);

    for (let page = startPage; page <= endPage; page++) {
      const breakY  = page * A4_PAGE_H;
      const bandTop = breakY - MARGIN; // 하단 여백 시작
      const bandBot = breakY + MARGIN; // 상단 여백 끝

      if (top < bandBot && bottom > bandTop) {
        p.style.marginTop = (bandBot - top) + 'px';
        p.dataset.pbPushed = '1';
        break;
      }
    }
  }

  updatePageBreaks();
}

function normalizeEditor() {
  if (window.DPEditor?.isReady()) return; // ProseMirror이 DOM 직접 관리
  [...ed().childNodes].forEach(node => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      const p = makePara('action', node.textContent);
      ed().replaceChild(p, node);
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'P') {
      const p = makePara('action', node.textContent);
      ed().replaceChild(p, node);
    }
  });
}

function parseFromEditor() {
  const paras = [...ed().querySelectorAll('p')];
  const lines  = [];
  let seq = 0, insSeqMap = {}, insertGroupSeqMap = {};
  paras.forEach(p => { delete p.dataset.sceneNum; delete p.dataset.parentSceneNum; });
  ed().querySelectorAll('span.elem-insert').forEach(sp => {
    delete sp.dataset.sceneNum; delete sp.dataset.parentSceneNum;
  });
  _insertIdToSceneNum = {};

  paras.forEach(p => {
    const text = p.textContent.trim();
    if (!text) return;
    const type = p.dataset.type || guessType(text);
    const insertId = p.dataset.insertId;
    if (type === 'heading') {
      seq++;
      p.dataset.sceneNum = seq;
      insSeqMap[seq] = 0;
    } else if (insertId && seq > 0) {
      // 항상 현재 seq를 parentSeq로 사용 (stale insertParentSeq 무시)
      // DOM 위치 순서대로 번호 부여 → 중간에 인서트씬이 추가되면 이후 번호 자동 갱신
      // (sceneNum 변경 시 sceneExtras 자동 마이그레이션 → onEditorInput의 migrateInsertSceneData)
      const parentSeq = seq;
      const groupKey  = `${parentSeq}:${insertId}`;
      if (!insertGroupSeqMap[groupKey]) {
        insSeqMap[parentSeq] = (insSeqMap[parentSeq] || 0) + 1;
        insertGroupSeqMap[groupKey] = `${parentSeq}_ins${insSeqMap[parentSeq]}`;
      }
      const sceneNum = insertGroupSeqMap[groupKey];
      p.dataset.sceneNum       = sceneNum;
      p.dataset.parentSceneNum = String(parentSeq);
      _insertIdToSceneNum[insertId] = sceneNum;
      lines.push({
        type: 'insertLine',
        originalType: type,
        text,
        insertId,
        insertIE:   p.dataset.insertIe   || '',
        insertTime: p.dataset.insertTime  || '',
        insertLoc:  p.dataset.insertLoc   || '',
        parentSeq,
        sceneNum,
      });
    } else if (type === 'insert' && seq > 0) {
      // 레거시: l-insert 단락
      insSeqMap[seq] = (insSeqMap[seq] || 0) + 1;
      p.dataset.sceneNum       = `${seq}_ins${insSeqMap[seq]}`;
      p.dataset.parentSceneNum = seq;
    } else if (seq > 0) {
      p.dataset.sceneNum = seq;
      // 단락 내 elem-insert 스팬
      p.querySelectorAll('span.elem-insert').forEach(span => {
        insSeqMap[seq] = (insSeqMap[seq] || 0) + 1;
        span.dataset.sceneNum       = `${seq}_ins${insSeqMap[seq]}`;
        span.dataset.parentSceneNum = seq;
        lines.push({ type: 'insert', text: span.textContent.trim(), spanBased: true, parentSeq: seq });
      });
    }
    if (!insertId || type === 'heading') lines.push({ type, text });
  });
  return buildScenes(lines);
}

function guessType(text) {
  if (/^(S#|씬\s*\d+|#\d+|INT\.|EXT\.|내부|외부)/i.test(text)) return 'heading';
  return 'action';
}

function buildScenes(lines) {
  const result = [];
  const spanInserts = {}; // parentSeq → [insert scenes]
  const insertGroupMap = {};
  let cur = null, curIns = null;
  let seq = 0, insSeqMap = {};

  const pushCharsAction = (target, line) => {
    if (line.type === 'char') {
      if (/^\([^)]*\)$/.test(line.text.trim())) return;
      const name = line.text.replace(/\s*\([^)]*\)$/, '').trim();
      if (name && !target.chars.includes(name)) target.chars.push(name);
    } else if (line.type === 'action') {
      target.action.push(line.text);
      extractCharInfoFromAction(line.text);
    }
  };

  for (const line of lines) {
    if (line.type === 'heading') {
      if (curIns) { result.push(curIns); curIns = null; }
      if (cur)    { result.push(cur); }
      seq++;
      insSeqMap[seq] = 0;
      cur = {
        number: seq,
        displayNum: extractSceneNum(line.text),
        heading: line.text,
        ie: detectIE(line.text), time: detectTime(line.text),
        loc: extractLoc(line.text), chars: [], action: [], schedDate: null,
      };
    } else if (line.type === 'insert' && cur) {
      if (line.spanBased) {
        // 스팬 기반: 즉시 인서트 씬 생성, curIns 영향 없음
        insSeqMap[seq] = (insSeqMap[seq] || 0) + 1;
        const insSeq = insSeqMap[seq];
        const pDisp  = cur.displayNum || String(seq);
        const ins = {
          number:     `${seq}_ins${insSeq}`,
          displayNum: `S#${pDisp}_INS_${insSeq}`,
          heading:    `S#${pDisp}_INS_${insSeq}`,
          parentNum:  seq, isInsert: true, spanBased: true,
          ie: cur.ie, time: cur.time, loc: cur.loc,
          chars: [], action: [line.text], schedDate: null,
        };
        if (!spanInserts[seq]) spanInserts[seq] = [];
        spanInserts[seq].push(ins);
      } else {
        // 레거시 단락 기반
        if (curIns) result.push(curIns);
        insSeqMap[seq] = (insSeqMap[seq] || 0) + 1;
        const insSeq = insSeqMap[seq];
        const pDisp  = cur.displayNum || String(seq);
        curIns = {
          number:     `${seq}_ins${insSeq}`,
          displayNum: `S#${pDisp}_INS_${insSeq}`,
          heading:    line.text,
          parentNum:  seq, isInsert: true,
          ie: cur.ie, time: cur.time, loc: cur.loc,
          chars: [], action: [], schedDate: null,
        };
      }
    } else if (line.type === 'insertLine' && cur) {
      const parentSeq = line.parentSeq || seq;
      const key = `${parentSeq}:${line.insertId}`;
      let ins = insertGroupMap[key];
      if (!ins) {
        const insertHeading = line.insertLoc || cur.loc || '인서트 헤딩';
        ins = {
          number:     line.sceneNum,  // parseFromEditor가 1차 패스에서 할당한 stable sceneNum
          displayNum: 'INS',
          heading:    insertHeading,
          parentNum:  parentSeq, isInsert: true,
          ie: line.insertIE || cur.ie,
          time: line.insertTime || cur.time,
          loc: insertHeading,
          chars: [], action: [], schedDate: null,
        };
        insertGroupMap[key] = ins;
        if (!spanInserts[parentSeq]) spanInserts[parentSeq] = [];
        spanInserts[parentSeq].push(ins);
      }
      pushCharsAction(ins, { type: line.originalType, text: line.text });
    } else if (curIns) {
      pushCharsAction(curIns, line);
    } else if (cur) {
      pushCharsAction(cur, line);
    }
  }
  if (curIns) result.push(curIns);
  if (cur)    result.push(cur);

  // 스팬 기반 인서트를 부모 씬 바로 뒤에 삽입
  if (Object.keys(spanInserts).length > 0) {
    const merged = [];
    result.forEach(s => {
      merged.push(s);
      if (!s.isInsert && spanInserts[s.number]) {
        spanInserts[s.number].forEach(ins => merged.push(ins));
      }
    });
    return merged;
  }
  return result;
}

// 지문에서 인물 정보 자동 추출: 민준(남, 20세), 지영(여, 30대), 철수(남, 10대)
function extractCharInfoFromAction(text) {
  const pattern = /([가-힣]{1,6}(?:\s[가-힣]{1,4})?)\(([^)]{1,30})\)/g;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const name = m[1].trim();
    const info = m[2];
    const gm   = info.match(/남(?:자|성)?|여(?:자|성)?/);
    const am   = info.match(/(\d+(?:대|세))/);  // '대'와 '세' 모두 지원
    if ((gm || am) && name.length >= 1) {
      if (!charInfo[name]) charInfo[name] = {};
      // 수동 설정이 없으면 스크립트 변경 내용을 항상 반영
      if (gm && !charInfo[name]._manualGender)
        charInfo[name].gender = gm[0].startsWith('남') ? '남' : '여';
      if (am && !charInfo[name]._manualAge) {
        charInfo[name].age = am[0];
        charInfo[name]._autoAge = true;
      }
    }
  }
}

function detectIE(l) {
  const u = l.toUpperCase();
  if (u.includes('INT./EXT.')||l.includes('내/외부')) return 'INT/EXT';
  if (u.includes('INT.')||l.includes('내부')||l.includes('실내')) return 'INT';
  if (u.includes('EXT.')||l.includes('외부')||l.includes('실외')) return 'EXT';
  return 'INT';
}
function detectTime(l) {
  for (const [k,v] of Object.entries(TIME_MAP)) if (l.includes(k)) return v;
  return 'day';
}
function extractLoc(l) {
  let s = l.trim()
    .replace(/^(S#\s*\d+(?:-\d+)?\.?\s*|씬\s*\d+\.?\s*|#\d+\.?\s*)/i,'')
    .replace(/^(INT\.\/EXT\.|INT\.|EXT\.|내\/외부\.?\s*|내부\.?\s*|외부\.?\s*)/i,'').trim();
  const di = s.lastIndexOf('-');
  if (di > 0) s = s.substring(0, di).trim();
  return s || '장소 미지정';
}

function refreshTypeUI() {
  const type = window.DPEditor?.isReady()
    ? DPEditor.getCurrentType()
    : (getCurrentP()?.dataset.type || null);
  document.querySelectorAll('.t-btn[data-type]').forEach(btn =>
    btn.classList.toggle('active-type', btn.dataset.type === type));
  _sendCursorPosition();
}

// ── 왼쪽 사이드바: 프로젝트 제목 + 씬리스트 ────────────────
function startEditProjectName() {
  const nameEl = document.getElementById('sidebarProjectLabel');
  const input  = document.getElementById('projectName');
  if (!nameEl || !input) return;

  const current = _currentFileName || input.value || '';
  // hidden input도 currentFileName과 동기화 (out-of-sync 방지)
  if (_currentFileName && input.value !== _currentFileName) input.value = _currentFileName;
  nameEl.contentEditable = 'true';
  nameEl.textContent = current;
  nameEl.focus();

  // 커서를 끝으로
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function commit() {
    const val = nameEl.textContent.trim() || _currentFileName || '새 프로젝트';
    nameEl.contentEditable = 'false';
    input.value = val;
    _currentFileName = val; // 항상 동기화
    nameEl.textContent = val; // 표시도 즉시 확정
    input.dispatchEvent(new Event('input', { bubbles: true }));
    nameEl.removeEventListener('blur', commit);
    nameEl.removeEventListener('keydown', onKey);
    // 이름이 바뀐 경우 Firestore 저장 + 최근목록 반영
    save();
    if (_currentProjectId) addRecentProject(val, _currentProjectId);
  }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { nameEl.textContent = input.value; nameEl.contentEditable = 'false'; nameEl.removeEventListener('blur', commit); nameEl.removeEventListener('keydown', onKey); }
  }
  nameEl.addEventListener('blur', commit);
  nameEl.addEventListener('keydown', onKey);
}

function renderLeftSidebar() {
  // 프로젝트 제목 — _currentFileName을 우선, 없으면 hidden input 값 사용
  const nameEl = document.getElementById('sidebarProjectLabel');
  const projectName = _currentFileName || document.getElementById('projectName')?.value || '제목 없음';
  if (nameEl && !nameEl.isContentEditable) { nameEl.textContent = projectName; nameEl.title = '클릭해서 프로젝트 이름 수정'; }

  const nav = document.getElementById('sidebarSceneNav');
  if (!nav) return;

  if (!scenes.length) {
    nav.innerHTML = `<div class="sidebar-scene-empty">씬 없음</div>`;
    return;
  }

  const esc  = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const toDN = t  => ({day:'낮',night:'밤',dawn:'새벽',eve:'저녁'}[t] || t || '');
  nav.innerHTML = scenes.map(s => {
    const numLabel = s.isInsert
      ? `INS.${String(s.number).replace(/^\d+_ins/, '')}`
      : `S#${esc(s.displayNum || s.number)}`;
    const loc  = esc(s.loc || '장소 미지정');
    const numQ = typeof s.number === 'string' ? `'${s.number}'` : s.number;
    const cls  = s.isInsert ? 'sidebar-scene-item si-insert' : 'sidebar-scene-item';
    const ieCls  = ieBadge(s.ie);
    const timeCls = timeBadge(s.time);
    const badges = [
      s.ie   ? `<span class="badge ${ieCls}">${esc(s.ie)}</span>` : '',
      s.time ? `<span class="badge ${timeCls}">${esc(toDN(s.time))}</span>` : '',
    ].filter(Boolean).join('');
    return `<button class="${cls}" onclick="sidebarGoToScene(${numQ})" title="${esc(numLabel)} ${esc(s.loc||'')}">` +
           `<div class="sb-top"><span class="sb-snum">${esc(numLabel)}</span><span class="sb-sloc">${loc}</span></div>` +
           (badges ? `<div class="sb-badges">${badges}</div>` : '') +
           `</button>`;
  }).join('');
}

// ProseMirror 모드 전용: getBoundingClientRect 기준 scrollTop 직접 대입
function pmScrollToEl(el, offset = 80) {
  const wrap = document.getElementById('editorScrollWrap');
  if (!wrap) { el.scrollIntoView({ block: 'start' }); return; }
  const elRect   = el.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const newTop   = wrap.scrollTop + (elRect.top - wrapRect.top) - offset;
  wrap.scrollTop = Math.max(0, newTop);
}

function scrollToSceneHeading(heading, { smooth = true } = {}) {
  const scrollWrap = document.querySelector('.editor-scroll-wrap');
  if (!scrollWrap) { heading.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const OFFSET = 60; // 씬헤딩 위쪽 여백 (px)
  const wrapRect    = scrollWrap.getBoundingClientRect();
  const headingRect = heading.getBoundingClientRect();
  const delta       = headingRect.top - wrapRect.top - OFFSET;
  scrollWrap.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'instant' });
}

function sidebarGoToScene(sceneNum) {
  switchTab('editor', document.querySelectorAll('.nav-btn')[0]);
  if (window.DPEditor?.isReady() && typeof sceneNum === 'number') {
    // ProseMirror 모드: PM 문서에서 N번째 heading 노드를 직접 탐색
    const headingEl = DPEditor.goToHeading(sceneNum);
    if (headingEl) {
      setTimeout(() => pmScrollToEl(headingEl), 80);
    }
    return;
  }
  // 폴백: contentEditable / insert 씬
  const heading = ed().querySelector(`[data-scene-num="${sceneNum}"]`);
  if (!heading) return;
  scrollToSceneHeading(heading);
  setTimeout(() => moveCursorTo(heading, false), 150);
}

// ── 사이드바 씬 브레이크다운 ────────────────────────
function renderSidebar() {
  const el = document.getElementById('sidebarList');
  if (!scenes.length) {
    el.innerHTML = `<div class="empty" style="height:140px"><div class="empty-icon">🎬</div><div>씬 없음</div></div>`;
    return;
  }

  const _toDN = t => ({day:'낮',night:'밤',dawn:'새벽',eve:'저녁'}[t]||t);

  // 현재 스크롤 위치 기억 (재렌더 후 복원)
  const scrollTop = el.scrollTop;

  el.innerHTML = scenes.map(s => {
    const extra     = sceneExtras[s.number] || {};
    const synopsis  = sceneNotes[s.number] || '';
    const allChars  = getAllChars(s);
    const cosItems  = extra.costumeItems  || [];
    const mkItems   = extra.makeupItems   || [];
    const cpItems   = extra.charPropItems || [];
    const spItems   = extra.setPropItems  || [];
    const vfxItems  = extra.vfxItems      || [];
    const etcItems  = extra.etcItems      || [];

    const allKnownChars = [...new Set([...allChars, ...allSceneChars()])];
    const snumJs = typeof s.number === 'string' ? `'${s.number}'` : s.number;

    const itemsHtml = (arr, field) => arr.map((item, i) => {
      const text     = getItemText(item);
      const charName = getItemChar(item);
      const color    = charName ? (charInfo[charName] || {}).color : null;
      const chipSt   = color ? `background:${color}22;border-color:${color}88;` : '';
      const selSt    = color ? `color:${color};font-weight:700;` : '';
      const optChars = charName && !allKnownChars.includes(charName) ? [...allKnownChars, charName] : allKnownChars;
      const charOpts = ['', ...optChars].map(c =>
        `<option value="${esc(c)}" ${c === charName ? 'selected' : ''}>${c ? esc(c) : '— 인물 —'}</option>`
      ).join('');
      return `<div class="sbd-item" style="${chipSt}">` +
        `<select class="sbd-item-char-sel" style="${selSt}" onchange="setItemChar(${snumJs},'${field}',${i},this.value)">${charOpts}</select>` +
        `<input class="sbd-item-inp" value="${esc(text)}" onchange="updateSceneElementText(${snumJs},'${field}',${i},this.value)">` +
        `<button class="sbd-item-del" onclick="removeSceneElement(${snumJs},'${field}',${i})">✕</button>` +
        `</div>`;
    }).join('');

    const colHdr = (label, field) =>
      `<div class="sbd-col-hdr">
        <div class="sbd-col-title">${label}</div>
        <button class="sbd-col-toggle-btn" onclick="toggleSbdAddRow('sb-add-${s.number}-${field}')" title="항목 추가">+</button>
      </div>`;

    const addRow = (field) => {
      const rowId    = `sb-add-${s.number}-${field}`;
      const charOpts = allKnownChars.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      return `<div class="sbd-add-row" id="${rowId}">
        <select class="sbd-add-char-sel"><option value="">— 인물 —</option>${charOpts}</select>
        <input class="sbd-add-input" placeholder="항목 추가..."
          onkeydown="if(event.key==='Enter'){addItemFromBdRow('${rowId}',${snumJs},'${field}');event.preventDefault()}else if(event.key==='Escape'){toggleSbdAddRow('${rowId}')}">
        <button class="sbd-add-btn" onclick="addItemFromBdRow('${rowId}',${snumJs},'${field}')">✓</button>
      </div>`;
    };

    const colBox = (label, field, items) =>
      `<div class="sbd-col-box">
        ${colHdr(label, field)}
        <div class="sbd-items">${itemsHtml(items, field)}</div>
        ${addRow(field)}
      </div>`;

    const label = s.isInsert ? esc(s.displayNum) : `S#${esc(s.displayNum||s.number)}`;

    return `<div class="sb-card" id="sb-${s.number}">
      <div class="sb-card-hdr" onclick="scrollToScene('${s.number}')" title="스크립트로 이동">
        <span class="sb-snum">${label}</span>
        <span class="badge ${ieBadge(s.ie)}" style="font-size:10px">${s.ie||''}</span>
        <span class="badge ${timeBadge(s.time)}" style="font-size:10px">${_toDN(s.time)}</span>
        <span class="sb-loc">${esc(s.loc)}</span>
        ${s.schedDate ? `<span class="sb-sched-date">📅 ${s.schedDate}</span>` : ''}
      </div>
      <div class="sb-card-body">
        <div>
          <div class="sbd-sec-title">장면 내용</div>
          <textarea class="sbd-synopsis-ta" data-snum="${s.number}"
            oninput="saveSceneNote(${snumJs},this.value)"
            placeholder="장면 내용...">${esc(synopsis)}</textarea>
        </div>
        <div>
          <div class="sbd-sec-title">등장인물</div>
          <div class="sbd-chars">
            ${allChars.length
              ? allChars.map(c => {
                  const col = (charInfo[c]||{}).color;
                  const st  = col ? `background:${col}22;border-color:${col}88;` : '';
                  return `<span class="sbd-char-tag" style="cursor:pointer;${st}" onclick="goToChar('${esc(c)}')" title="인물설정">${esc(c)}</span>`;
                }).join('')
              : `<span style="color:var(--text-dim);font-size:12px">없음</span>`}
          </div>
        </div>
        <div class="sb-elem-grid">
          ${colBox('의상',       'costumeItems',  cosItems)}
          ${colBox('분장',       'makeupItems',   mkItems)}
          ${colBox('인물 소품',  'charPropItems', cpItems)}
          ${colBox('공간 소품',  'setPropItems',  spItems)}
          ${colBox('효과',       'vfxItems',      vfxItems)}
          ${colBox('기타',       'etcItems',      etcItems)}
        </div>
        <div>
          <div class="sbd-sec-title" style="margin-top:10px">메모</div>
          <textarea class="sbd-col-ta" data-field="memo" data-snum="${s.number}"
            oninput="onBdInput(event)" placeholder="씬 메모...">${esc(extra.memo||'')}</textarea>
        </div>
      </div>
    </div>`;
  }).join('');

  // 스크롤 복원
  el.scrollTop = scrollTop;
}

// 씬 클릭 → 에디터 스크롤 + 커서 이동
function scrollToScene(sceneNum) {
  switchTab('editor', document.querySelectorAll('.nav-btn')[0]);
  // sceneNum이 문자열 숫자('1', '2'...)로 올 수 있으므로 Number 변환
  const seq = Number(sceneNum);
  if (window.DPEditor?.isReady() && Number.isInteger(seq) && seq > 0) {
    const headingEl = DPEditor.goToHeading(seq);
    if (headingEl) {
      setTimeout(() => pmScrollToEl(headingEl), 80);
    }
    return;
  }
  const heading = ed().querySelector(`[data-scene-num="${sceneNum}"]`);
  if (!heading) return;
  scrollToSceneHeading(heading);
  setTimeout(() => moveCursorTo(heading, false), 150);
}

// ── 예시 / 지우기 ────────────────────────────────
function loadSample() {
  const data = [
    ['heading','S#1. INT. 경찰서 취조실 - 낮'],
    ['action','형사 김민준(남, 40대)이 차가운 눈으로 테이블 건너편을 바라본다.'],
    ['action','테이블 위에는 두꺼운 서류 파일이 놓여있다.'],
    ['action',''],
    ['char','민준'],
    ['dialogue','그날 밤 어디 있었습니까?'],
    ['action',''],
    ['char','이상철'],
    ['dialogue','집에 있었어요. 혼자.'],
    ['action',''],
    ['action','민준이 파일을 열며 사진 한 장을 꺼낸다.'],
    ['action',''],
    ['char','민준'],
    ['dialogue','CCTV는 다른 말을 하던데요.'],
    ['action',''],
    ['heading','S#2. EXT. 한강 다리 위 - 밤'],
    ['action','비가 내리는 한강 다리. 박지영(여, 30대)이 난간에 기대어 강을 내려다본다.'],
    ['action',''],
    ['char','지영'],
    ['dialogue','왜 왔어요? 내가 부르지 않았는데.'],
    ['action',''],
    ['char','민준'],
    ['dialogue','형사는 부르지 않아도 오는 거야.'],
    ['action',''],
    ['heading','S#3. INT. 낡은 아파트 - 새벽'],
    ['action','이상철(남, 50대)이 어두운 방 안에서 전화기를 들여다보고 있다.'],
    ['action',''],
    ['char','이상철'],
    ['dialogue','이제 선택해야 해.'],
    ['action',''],
    ['heading','S#4. EXT. 폐공장 앞 - 저녁'],
    ['action','석양이 지는 폐공장. 민준과 지영이 마주 선다.'],
    ['action',''],
    ['char','지영'],
    ['dialogue','처음부터 알고 있었던 거야?'],
    ['action',''],
    ['char','민준'],
    ['dialogue','...처음부터는 아니었어.'],
    ['action',''],
    ['heading','S#5. INT. 경찰서 복도 - 낮'],
    ['action','민준이 긴 복도를 걷는다.'],
    ['action',''],
    ['char','민준'],
    ['dialogue','(독백) 이건 끝이 아니야.'],
    ['action',''],
    ['heading','S#6. EXT. 한강 산책로 - 낮'],
    ['action','맑은 낮, 강변을 걷는 지영. 손에 작은 봉투가 들려있다.'],
  ];
  const html = data.map(([type, text]) =>
    `<p class="${LINE_TYPES[type].cls}" data-type="${type}">${esc(text)}</p>`
  ).join('');
  if (window.DPEditor?.isReady()) DPEditor.setContent(html);
  else ed().innerHTML = html;
  onEditorInput();
}

function clearAll() {
  if (!confirm('스크립트를 모두 지우시겠습니까?\n(인물 정보·씬 메모·촬영 스케줄·일촬표도 함께 초기화됩니다)')) return;
  if (window.DPEditor?.isReady()) DPEditor.setContent('');
  else ed().innerHTML = '';
  manualCharsByScene = {};
  sceneNotes        = {};
  sceneExtras       = {};
  csLabels          = {};
  charInfo          = {};
  charNotes         = {};
  globalChars       = [];
  charOrder         = [];
  hiddenChars       = [];
  sched             = {};
  schedDays         = {};
  callSheets        = [];
  currentCSIdx      = 0;
  onEditorInput();
  renderCalendar();
  renderUnsched();
  renderCSSelect();
  renderCS();
  save();
}

// ══════════════════════════════════════════════════
// 서식 (Bold / Italic / Underline / Color)
// ══════════════════════════════════════════════════
function applyFormat(cmd) {
  document.execCommand(cmd, false, null);
}

function toggleColorPicker(e) {
  e.stopPropagation();
  document.getElementById('colorSwatches').classList.toggle('open');
}

function applyColor(color) {
  document.getElementById('colorSwatches').classList.remove('open');
  if (color === 'inherit') {
    document.execCommand('removeFormat', false, null);
  } else {
    document.execCommand('foreColor', false, color);
  }
}

document.addEventListener('click', () => {
  const el = document.getElementById('colorSwatches');
  if (el) el.classList.remove('open');
});

function registerSelectedAsChar(btn) {
  const sel = window.getSelection();
  const name = sel ? sel.toString().trim() : '';
  if (!name) { alert('인물로 등록할 텍스트를 드래그해서 선택해주세요.'); return; }
  if (name.length > 20) { alert('선택한 텍스트가 너무 깁니다. 인물 이름만 선택해주세요.'); return; }

  // 선택 영역이 속한 씬 번호 탐색
  let sceneNum = null;
  if (sel.rangeCount) {
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    // contenteditable 바로 아래 <p> 찾기
    while (node && node.parentElement !== ed()) node = node.parentElement;
    if (node) {
      const paras = [...ed().querySelectorAll('p')];
      const idx   = paras.indexOf(node);
      for (let i = idx; i >= 0; i--) {
        if ((paras[i].dataset.type || guessType(paras[i].textContent)) === 'heading') {
          sceneNum = extractSceneNum(paras[i].textContent);
          break;
        }
      }
    }
  }

  pushUndo();
  if (!charInfo[name]) charInfo[name] = {};
  if (!globalChars.includes(name)) globalChars.push(name);
  hiddenChars = hiddenChars.filter(n => n !== name); // 삭제 후 재추가 시 복원
  if (sceneNum) {
    if (!manualCharsByScene[sceneNum]) manualCharsByScene[sceneNum] = [];
    if (!manualCharsByScene[sceneNum].includes(name)) manualCharsByScene[sceneNum].push(name);
  }
  flashBtn(btn);
  save();
  renderCharTab();
  renderSidebar();
  if (document.getElementById('tab-breakdown').classList.contains('on')) renderBreakdown();
}

// ══════════════════════════════════════════════════
// 환영 배너 — 로그인할 때마다 항상 표시
function showWelcomeIfFirst() {
  document.getElementById('welcomeOverlay')?.classList.add('open');
}
function closeWelcome() {
  document.getElementById('welcomeOverlay')?.classList.remove('open');
}
function neverShowWelcome() {
  document.getElementById('welcomeOverlay')?.classList.remove('open');
}
function openGuideFromWelcome() {
  window.open(GUIDE_URL, '_blank', 'noopener,noreferrer');
}

// ══════════════════════════════════════════════════
// 찾기 / 바꾸기
// ══════════════════════════════════════════════════
let frMatches    = [];   // [{para, start, end}]
let frCurrentIdx = -1;

function toggleFindReplace() {
  const fp = document.getElementById('frPanel');
  if (fp.classList.contains('open')) closeFindReplace();
  else openFindReplace();
}
function openFindReplace() {
  document.getElementById('frPanel').classList.add('open');
  document.getElementById('findReplaceToggleBtn')?.classList.add('on');
  document.getElementById('frFind').select();
  document.getElementById('frFind').focus();
}
function closeFindReplace() {
  document.getElementById('frPanel').classList.remove('open');
  document.getElementById('findReplaceToggleBtn')?.classList.remove('on');
  frClearHighlights();
  frMatches = []; frCurrentIdx = -1;
  document.getElementById('frCount').textContent = '';
}

// 에디터 단락의 텍스트 노드에서 offset 위치 찾기
function frTextNodeAt(container, offset) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let cur = 0, node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (cur + len > offset) return { node, offset: offset - cur };
    cur += len;
  }
  return null;
}

// 전체 매치 목록 생성
function frFindMatches(query) {
  if (!query) return [];
  const q   = query.toLowerCase();
  const res = [];
  ed().querySelectorAll('p').forEach(p => {
    const txt = p.textContent.toLowerCase();
    let idx = 0;
    while ((idx = txt.indexOf(q, idx)) !== -1) {
      res.push({ para: p, start: idx, end: idx + query.length });
      idx++;
    }
  });
  return res;
}

// 하이라이트 전체 제거 (focus 유지)
function frClearHighlights() {
  const saved = document.activeElement;
  ed().querySelectorAll('.fr-hl').forEach(mark => {
    const parent = mark.parentNode;
    if (parent) { parent.replaceChild(document.createTextNode(mark.textContent), mark); parent.normalize(); }
  });
  if (saved && saved !== document.body && ed() !== saved && !ed().contains(saved)) saved.focus();
}

// 전체 매치 하이라이트 그리기 (focus 유지)
function frDrawHighlights(query, currentIdx) {
  const saved = document.activeElement;
  const edEl  = ed();
  edEl.setAttribute('contenteditable', 'false'); // DOM 조작 중 포커스 탈취 방지
  frClearHighlights();
  if (!query) {
    edEl.setAttribute('contenteditable', 'true');
    if (saved && saved !== document.body) saved.focus();
    return;
  }
  const q = query.toLowerCase();
  edEl.querySelectorAll('p').forEach(p => {
    const txt = p.textContent;
    const lower = txt.toLowerCase();
    let idx = 0, parts = [], last = 0;
    while ((idx = lower.indexOf(q, idx)) !== -1) {
      if (idx > last) parts.push(document.createTextNode(txt.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.className = 'fr-hl';
      mark.textContent = txt.slice(idx, idx + query.length);
      parts.push(mark);
      last = idx + query.length;
      idx++;
    }
    if (!parts.length) return;
    if (last < txt.length) parts.push(document.createTextNode(txt.slice(last)));
    while (p.firstChild) p.removeChild(p.firstChild);
    parts.forEach(n => p.appendChild(n));
  });
  // 현재 항목 강조
  const allMarks = [...edEl.querySelectorAll('.fr-hl')];
  if (allMarks[currentIdx]) allMarks[currentIdx].className = 'fr-hl fr-hl-cur';
  edEl.setAttribute('contenteditable', 'true');
  if (saved && saved !== document.body) saved.focus();
}

// 현재 항목으로 스크롤 (포커스는 팝업 유지)
function frScrollToCurrent() {
  const marks = [...ed().querySelectorAll('.fr-hl')];
  if (marks[frCurrentIdx]) {
    marks[frCurrentIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function frSearch() {
  const query = document.getElementById('frFind').value;
  frMatches = frFindMatches(query);
  frCurrentIdx = frMatches.length ? 0 : -1;
  frDrawHighlights(query, frCurrentIdx);
  frUpdateCount();
  if (frCurrentIdx >= 0) frScrollToCurrent();
  // 팝업이 열려 있으면 입력창 포커스 유지
  if (document.getElementById('frPanel').classList.contains('open')) {
    document.getElementById('frFind').focus();
  }
}

function frUpdateCount() {
  const el = document.getElementById('frCount');
  if (!frMatches.length) {
    el.textContent = document.getElementById('frFind').value ? '없음' : '';
  } else {
    el.textContent = `${frCurrentIdx + 1} / ${frMatches.length}`;
  }
}

function frNext() {
  if (!frMatches.length) return;
  frCurrentIdx = (frCurrentIdx + 1) % frMatches.length;
  const q = document.getElementById('frFind').value;
  frDrawHighlights(q, frCurrentIdx);
  frUpdateCount(); frScrollToCurrent();
  document.getElementById('frFind').focus();
}
function frPrev() {
  if (!frMatches.length) return;
  frCurrentIdx = (frCurrentIdx - 1 + frMatches.length) % frMatches.length;
  const q = document.getElementById('frFind').value;
  frDrawHighlights(q, frCurrentIdx);
  frUpdateCount(); frScrollToCurrent();
  document.getElementById('frFind').focus();
}

function frFindKeyDown(e) {
  if (e.key === 'Enter') { e.shiftKey ? frPrev() : frNext(); e.preventDefault(); }
  if (e.key === 'Escape') closeFindReplace();
}

// 현재 매치 1개 바꾸기
function frReplaceOne() {
  const query   = document.getElementById('frFind').value;
  const replace = document.getElementById('frReplace').value;
  if (!query || frCurrentIdx < 0 || !frMatches.length) return;

  const match = frMatches[frCurrentIdx];
  const p     = match.para;
  // 하이라이트 mark 제거 후 plain text 기준으로 교체
  frClearHighlights();
  const txt = p.textContent;
  const q   = query.toLowerCase();
  const lo  = txt.toLowerCase();
  const idx = lo.indexOf(q);
  if (idx === -1) { frSearch(); return; }
  p.textContent = txt.slice(0, idx) + replace + txt.slice(idx + query.length);

  onEditorInput();
  // 재검색
  frSearch();
}

// 모두 바꾸기
function frReplaceAll() {
  const query   = document.getElementById('frFind').value;
  const replace = document.getElementById('frReplace').value;
  if (!query) return;

  frClearHighlights();
  const q = query.toLowerCase();
  let count = 0;
  ed().querySelectorAll('p').forEach(p => {
    const txt = p.textContent;
    const lo  = txt.toLowerCase();
    if (lo.includes(q)) {
      // 대소문자 보존 교체 (case-insensitive replace)
      let result = '', i = 0;
      while (i < txt.length) {
        const found = lo.indexOf(q, i);
        if (found === -1) { result += txt.slice(i); break; }
        result += txt.slice(i, found) + replace;
        i = found + query.length;
        count++;
      }
      p.textContent = result;
    }
  });

  if (count) {
    onEditorInput();
    alert(`${count}개를 바꿨습니다.`);
  } else {
    alert('찾을 수 없습니다.');
  }
  frSearch();
}

// 도움말 화면
// ══════════════════════════════════════════════════
const GUIDE_URL = 'https://gotgam100.github.io/dontpanicpre/guide.html';

function showHelp() {
  window.open(GUIDE_URL, '_blank', 'noopener,noreferrer');
}
function closeHelp() {
  // 탭 전환은 더 이상 사용하지 않지만 외부 참조 대비 유지
  switchTab('editor', document.querySelector('.nav-btn'));
}

// ══════════════════════════════════════════════════
// 씬 브레이크다운
// ══════════════════════════════════════════════════

// 씬의 모든 인물 (스크립트 감지 + 수동 추가)
function getAllChars(scene) {
  const manual = (manualCharsByScene[scene.number] || []);
  return [...new Set([...scene.chars, ...manual])];
}

function renderBreakdown() {
  renderStats();
  let list = filter === 'all' ? scenes
    : scenes.filter(s => (filter==='INT'||filter==='EXT') ? s.ie===filter : s.time===filter);

  document.getElementById('filterCount').textContent = filter!=='all' ? `${list.length}개 씬` : '';

  const _toDN = t => ({ day:'낮', night:'밤', dawn:'새벽', eve:'저녁' }[t] || '');
  const _toIE = ie => ({ INT:'INT', EXT:'EXT', 'INT/EXT':'I/E', 'EXT/INT':'E/I' }[ie] || ie);
  const _dnBg = t => ({ day:'rgba(251,191,36,.15)', night:'rgba(99,102,241,.15)', dawn:'rgba(96,165,250,.13)', eve:'rgba(251,146,60,.13)' }[t] || '');
  const _ieBg = ie => ({ INT:'rgba(52,211,153,.12)', EXT:'rgba(248,113,113,.12)', 'INT/EXT':'rgba(148,163,184,.12)', 'EXT/INT':'rgba(148,163,184,.12)' }[ie] || '');

  const wrap = document.getElementById('bdTableWrap');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty">
      <div class="empty-icon">${scenes.length?'🔍':'🎬'}</div>
      <div>${scenes.length?'해당 조건의 씬이 없습니다':'스크립트 탭에서 스크립트를 입력해주세요'}</div></div>`;
    return;
  }

  // 씬브레이크다운 요소 읽기전용 칩 생성
  const makeROChips = (items, cls, propCategory) => {
    if (!items || !items.length) return '<span class="bd-empty-dash">-</span>';
    return `<div class="bd-chips-wrap">${items.map(i => {
      const txt = esc(getItemText(i));
      if (propCategory) {
        return `<span class="bd-chip ${cls} prop-link" title="소품리스트에서 보기" onclick="linkToProp(${JSON.stringify(getItemText(i))}, '${propCategory}')">${txt}</span>`;
      }
      return `<span class="bd-chip ${cls}">${txt}</span>`;
    }).join('')}</div>`;
  };

  // 인서트 씬 D/N 드롭다운
  const dnCell = s => {
    if (!s.isInsert) { const bg=_dnBg(s.time); return `<td class="bd-cell bd-ro" style="text-align:center;font-weight:700;${bg?`background:${bg};`:''}font-size:12px">${_toDN(s.time)}</td>`; }
    const v = s.time || '';
    return `<td class="bd-cell" style="padding:2px"><select class="bd-ins-sel" data-field="time" data-snum="${s.number}" onchange="onBdInsertSelect(this)">
      <option value="">-</option>
      <option value="day"   ${v==='day'  ?'selected':''}>낮(D)</option>
      <option value="night" ${v==='night'?'selected':''}>밤(N)</option>
      <option value="dawn"  ${v==='dawn' ?'selected':''}>새벽(D)</option>
      <option value="eve"   ${v==='eve'  ?'selected':''}>저녁(N)</option>
    </select></td>`;
  };
  // 인서트 씬 I/E 드롭다운
  const ieCell = s => {
    if (!s.isInsert) { const bg=_ieBg(s.ie); return `<td class="bd-cell bd-ro" style="text-align:center;font-weight:700;${bg?`background:${bg};`:''}font-size:12px">${_toIE(s.ie)}</td>`; }
    const v = s.ie || '';
    return `<td class="bd-cell" style="padding:2px"><select class="bd-ins-sel" data-field="ie" data-snum="${s.number}" onchange="onBdInsertSelect(this)">
      <option value="">-</option>
      <option value="INT" ${v==='INT'?'selected':''}>INT</option>
      <option value="EXT" ${v==='EXT'?'selected':''}>EXT</option>
      <option value="INT/EXT" ${v==='INT/EXT'?'selected':''}>INT/EXT</option>
    </select></td>`;
  };

  const rows = list.map(s => {
    const extra    = sceneExtras[s.number] || {};
    const synopsis = sceneNotes[s.number] || '';
    const chars    = getAllChars(s).join(', ');

    return `<tr class="bd-row${s.isInsert?' bd-row-insert':''}" data-snum="${s.number}">
      <td class="bd-cell bd-ro bd-snum-cell" style="font-weight:800;color:${s.isInsert?'#fb923c':'#fff'}">${s.isInsert?esc(s.displayNum):'S#'+esc(s.displayNum||s.number)}</td>
      ${dnCell(s)}
      ${ieCell(s)}
      <td class="bd-cell bd-ro wide">${esc(s.loc)}</td>
      <td class="bd-cell"><textarea class="bd-ta" data-field="synopsis" data-snum="${s.number}" placeholder="장면 내용">${esc(synopsis)}</textarea></td>
      <td class="bd-cell bd-ro wide">${esc(chars)}</td>
      <td class="bd-cell bd-chips-ro">${makeROChips(extra.costumeItems,  'elem-costume')}</td>
      <td class="bd-cell bd-chips-ro">${makeROChips(extra.makeupItems,   'elem-makeup')}</td>
      <td class="bd-cell bd-chips-ro">${makeROChips(extra.charPropItems, 'elem-charProp', 'charProp')}</td>
      <td class="bd-cell bd-chips-ro">${makeROChips(extra.setPropItems,  'elem-setProp',  'setProp')}</td>
      <td class="bd-cell bd-chips-ro">${makeROChips(extra.vfxItems,      'elem-vfx')}</td>
      <td class="bd-cell bd-chips-ro">${makeROChips(extra.etcItems,      'elem-etc')}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="bd-table">
    <colgroup>
      <col style="width:48px">
      <col style="width:34px">
      <col style="width:34px">
      <col style="width:100px">
      <col style="width:200px">
      <col style="width:110px">
      <col style="width:80px">
      <col style="width:80px">
      <col style="width:80px">
      <col style="width:80px">
      <col style="width:70px">
      <col style="width:70px">
    </colgroup>
    <thead><tr>
      <th class="bd-th">씬#</th>
      <th class="bd-th">D/N</th>
      <th class="bd-th">I/E</th>
      <th class="bd-th">촬영장소</th>
      <th class="bd-th">장면내용</th>
      <th class="bd-th">주요등장인물</th>
      <th class="bd-th">의상</th>
      <th class="bd-th">분장</th>
      <th class="bd-th">인물소품</th>
      <th class="bd-th">공간소품</th>
      <th class="bd-th">효과</th>
      <th class="bd-th">기타</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  // textarea 이벤트 연결 + auto-grow 초기화
  wrap.querySelectorAll('.bd-ta').forEach(ta => {
    ta.addEventListener('input', onBdInput);
    ta.addEventListener('input', () => bdAutoGrow(ta));
    bdAutoGrow(ta);
  });
}

function charTagHTML(c, sceneNum) {
  const isManual = (manualCharsByScene[sceneNum]||[]).includes(c);
  const color = (charInfo[c] || {}).color;
  const style = color ? `background:${color}22;border-color:${color}88;` : '';
  return `<span class="char-tag" style="${style}" onclick="goToChar('${esc(c)}')" title="인물설정으로 이동">${esc(c)}${isManual?` <span onclick="event.stopPropagation();removeManualChar(${sceneNum},'${esc(c)}')" style="opacity:.5;font-size:10px;margin-left:2px;cursor:pointer">✕</span>`:''}</span>`;
}

function showAddChar(e, sceneNum) {
  e.stopPropagation();
  const btn = e.target.closest('.add-char-btn') || e.target;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'char-add-input';
  input.placeholder = '인물명...';
  input.onkeydown = evt => {
    if (evt.key === 'Enter') { evt.preventDefault(); addManualChar(sceneNum, input.value); }
    if (evt.key === 'Escape') renderBreakdown();
  };
  input.onblur = () => setTimeout(renderBreakdown, 150);
  btn.replaceWith(input);
  input.focus();
}

function addManualChar(sceneNum, name) {
  name = name.trim();
  if (!name) { renderBreakdown(); return; }
  if (!manualCharsByScene[sceneNum]) manualCharsByScene[sceneNum] = [];
  if (!manualCharsByScene[sceneNum].includes(name)) manualCharsByScene[sceneNum].push(name);
  save(); renderBreakdown();
}

function removeManualChar(sceneNum, name) {
  if (manualCharsByScene[sceneNum])
    manualCharsByScene[sceneNum] = manualCharsByScene[sceneNum].filter(n=>n!==name);
  save(); renderBreakdown();
}

// ══════════════════════════════════════════════════
// 씬브레이크다운 (페이지뷰) + 요소 등록
// ══════════════════════════════════════════════════

// 현재 선택(Selection)이 속한 씬의 sceneNum 반환
// ── 인서트 씬 추가 (스팬 방식) ──────────────────────────────────
function getTopLevelEditorPara(node) {
  if (!node) return null;
  const edEl = ed();
  if (!edEl) return null;
  if (node === edEl) return null;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  // PM 구조: #scriptEditor > .ProseMirror > p
  // contentEditable 폴백 구조: #scriptEditor > p
  while (node && node !== edEl) {
    if (node.tagName === 'P') {
      const par = node.parentElement;
      // p의 부모가 edEl 이거나, edEl 바로 아래 자식(.ProseMirror)인 경우
      if (par === edEl || par?.parentElement === edEl) return node;
    }
    node = node.parentElement;
  }
  return null;
}

function getSelectedEditorParas(range) {
  return [...ed().querySelectorAll('p')].filter(p => {
    try { return range.intersectsNode(p); } catch(e) { return false; }
  });
}

function addInsertToSelection(btn) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  const currentP = getTopLevelEditorPara(range.commonAncestorContainer);

  // 이미 인서트 그룹 안에 있으면 → 해당 인서트 그룹 전체 토글 제거
  if (currentP?.dataset.insertId) {
    const insertId = currentP.dataset.insertId;
    pushUndo();
    // sceneExtras / sched 등 부가 데이터 먼저 정리
    ed().querySelectorAll(`p[data-insert-id="${insertId}"]`).forEach(p => {
      const snum = p.dataset.sceneNum;
      if (snum) {
        delete sceneExtras[snum];
        delete sceneNotes[snum];
        Object.keys(sched).forEach(date => {
          sched[date] = (sched[date] || []).filter(n => String(n) !== String(snum));
        });
      }
    });
    // PM 트랜잭션으로 insert attrs 제거
    if (window.DPEditor?.isReady()) {
      window.DPEditor.clearInsertGroup(insertId);
    } else {
      ed().querySelectorAll(`p[data-insert-id="${insertId}"]`).forEach(p => {
        delete p.dataset.insertId;
        delete p.dataset.insertContent;
        delete p.dataset.insertIe;
        delete p.dataset.insertTime;
        delete p.dataset.insertLoc;
        delete p.dataset.insertParentSeq;
      });
    }
    sel.removeAllRanges();
    flashBtn(btn);
    onEditorInput();
    save();
    return;
  }

  if (sel.isCollapsed) {
    alert('인서트씬으로 지정할 구간을 드래그하여 선택해주세요.'); return;
  }
  if (!ed().contains(range.commonAncestorContainer)) return;
  const selectedParas = getSelectedEditorParas(range).filter(p => (p.dataset.type || guessType(p.textContent)) !== 'heading');
  if (!selectedParas.length) { alert('인서트씬으로 지정할 줄을 선택해주세요.'); return; }

  // 씬 헤딩 아래에 있는지 확인
  let startNode = selectedParas[0];
  if (!startNode) { alert('씬 안의 텍스트를 선택해주세요.'); return; }

  const paras = [...ed().querySelectorAll('p')];
  const startIdx = paras.indexOf(startNode);
  let hasParent = false, parentSeq = null, parentHeadingText = '';
  for (let i = startIdx; i >= 0; i--) {
    const t = paras[i].dataset.type || guessType(paras[i].textContent);
    if (t === 'heading') {
      hasParent = true;
      parentSeq = paras[i].dataset.sceneNum || extractSceneNum(paras[i].textContent) || null;
      parentHeadingText = paras[i].textContent || '';
      break;
    }
  }
  if (!hasParent) { alert('씬 헤딩 아래의 텍스트를 선택해주세요.'); return; }

  // ── 선택된 여러 줄을 하나의 인서트 씬 그룹으로 표시 ──────────────
  pushUndo();
  const markerId = 'ins-m-' + Date.now();

  // PM 트랜잭션으로 insert attrs 세팅 (DOM 직접 조작 시 Yjs 재렌더 후 소멸 문제 방지)
  if (window.DPEditor?.isReady()) {
    window.DPEditor.markSelectionAsInsert(markerId, parentSeq);
  } else {
    selectedParas.forEach(p => {
      p.dataset.insertId = markerId;
      if (parentSeq) p.dataset.insertParentSeq = String(parentSeq);
    });
  }
  sel.removeAllRanges();
  _pendingInsertMarkerId = markerId;

  const parentScene = scenes.find(s => String(s.number) === String(parentSeq));

  // 모달 열기 (인서트 헤딩 수집)
  document.getElementById('insModal').classList.add('open');
  document.getElementById('insLocInput').value = parentScene?.loc || extractLoc(parentHeadingText) || '';
  setTimeout(() => document.getElementById('insLocInput').focus(), 80);
}

// 커서/선택이 elem-tag span 안에 있으면 해당 타입 반환
function getSelectionElemSpan() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node = sel.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  while (node && node !== ed()) {
    if (node.classList?.contains('elem-tag')) return node;
    node = node.parentElement;
  }
  return null;
}

function getSelectionElemType() {
  return getSelectionElemSpan()?.dataset.elemType || null;
}

// ── 인서트씬 sceneNum 변경 시 sceneExtras / sched / sceneNotes 자동 마이그레이션 ──
// onEditorInput에서 parseFromEditor 직후 호출
// prevMap: { insertId → oldSceneNum }  /  최신 매핑은 _insertIdToSceneNum
function migrateInsertSceneData(prevMap) {
  let changed = false;
  for (const [insertId, newNum] of Object.entries(_insertIdToSceneNum)) {
    const oldNum = prevMap[insertId];
    if (!oldNum || String(oldNum) === String(newNum)) continue;
    // sceneExtras 이전
    if (sceneExtras[oldNum]) {
      if (!sceneExtras[newNum]) sceneExtras[newNum] = {};
      Object.assign(sceneExtras[newNum], sceneExtras[oldNum]);
      delete sceneExtras[oldNum];
      changed = true;
    }
    // sceneNotes 이전
    if (sceneNotes[oldNum] !== undefined) {
      sceneNotes[newNum] = sceneNotes[oldNum];
      delete sceneNotes[oldNum];
      changed = true;
    }
    // sched 이전
    for (const date of Object.keys(sched)) {
      const arr = sched[date] || [];
      const idx = arr.findIndex(n => String(n) === String(oldNum));
      if (idx >= 0) { arr[idx] = newNum; changed = true; }
    }
  }
  if (changed) save();
}

// ── 인서트씬 생성 시 해당 구간 elem-tag 요소 부모씬 → 인서트씬 자동 이동 ──
// insertId 단락의 elem-tag span과 일치하는 항목을 부모씬 sceneExtras에서 제거 후
// 인서트씬 sceneExtras로 이동 (breakdown, 각종 리스트 자동 반영)
function autoMigrateElemsToInsert(insertId, parentSnumKey, insertSnum) {
  const ELEM_TO_FIELD = {
    costume:  'costumeItems',  makeup:   'makeupItems',
    charProp: 'charPropItems', setProp:  'setPropItems',
    vfx:      'vfxItems',      etc:      'etcItems',
  };
  const insertParas = [...ed().querySelectorAll(`p[data-insert-id="${insertId}"]`)];
  if (!insertParas.length) return false;
  const parentExtra = sceneExtras[parentSnumKey];
  if (!parentExtra) return false;

  let migrated = false;
  for (const p of insertParas) {
    for (const span of p.querySelectorAll('span.elem-tag[data-elem-type]')) {
      const type  = span.dataset.elemType;
      const field = ELEM_TO_FIELD[type];
      if (!field) continue;
      const text = span.textContent.trim();
      if (!text) continue;
      const parentItems = parentExtra[field];
      if (!parentItems?.length) continue;
      const idx = parentItems.findIndex(it => getItemText(it) === text);
      if (idx < 0) continue;
      // 부모씬에서 제거
      const [item] = parentItems.splice(idx, 1);
      removeFromListField(String(parentSnumKey), ITEMS_TO_LIST[field], text);
      // 인서트씬에 추가
      if (!sceneExtras[insertSnum]) sceneExtras[insertSnum] = {};
      if (!sceneExtras[insertSnum][field]) sceneExtras[insertSnum][field] = [];
      if (!sceneExtras[insertSnum][field].some(it => getItemText(it) === text)) {
        sceneExtras[insertSnum][field].push(item);
        appendToListField(insertSnum, ITEMS_TO_LIST[field], text);
      }
      migrated = true;
    }
  }
  return migrated;
}

// ── 인서트씬 등록 모달 ────────────────────────────
function closeInsModal() {
  document.getElementById('insModal').classList.remove('open');
  _pendingInsertRange = null;
  // 취소 시 — 마킹을 되돌리기
  if (_pendingInsertMarkerId) {
    const mid = _pendingInsertMarkerId;
    _pendingInsertMarkerId = null;
    // sceneExtras 정리
    ed().querySelectorAll(`p[data-insert-id="${mid}"]`).forEach(p => {
      const snum = p.dataset.sceneNum;
      if (snum) { delete sceneExtras[snum]; delete sceneNotes[snum]; }
    });
    // PM 트랜잭션으로 attrs 제거
    if (window.DPEditor?.isReady()) {
      window.DPEditor.clearInsertGroup(mid);
    } else {
      ed().querySelectorAll(`p[data-insert-id="${mid}"]`).forEach(p => {
        delete p.dataset.insertId;
        delete p.dataset.insertContent;
        delete p.dataset.insertIe;
        delete p.dataset.insertTime;
        delete p.dataset.insertLoc;
        delete p.dataset.insertParentSeq;
      });
    }
    onEditorInput();
  }
}

function confirmInsertScene() {
  if (!_pendingInsertMarkerId) { closeInsModal(); return; }

  const loc = document.getElementById('insLocInput').value.trim() || '인서트 헤딩';

  // 1) 모달 닫기 (closeInsModal의 취소 분기를 건너뜀)
  const markerId = _pendingInsertMarkerId;
  _pendingInsertMarkerId = null;
  _pendingInsertRange    = null;
  document.getElementById('insModal').classList.remove('open');

  // 마킹된 그룹에서 parentSeq 읽기 (DOM attr — PM이 이미 렌더링 완료)
  const markedGroup = [...ed().querySelectorAll(`p[data-insert-id="${markerId}"]`)];
  const parentSeq = markedGroup[0]?.dataset.insertParentSeq || null;
  const parentScene = scenes.find(s => String(s.number) === String(parentSeq));
  const ie = parentScene?.ie || 'INT';
  const dn = parentScene?.time || 'day';

  // PM 트랜잭션으로 insert attrs 갱신 (DOM 직접 조작 금지)
  if (window.DPEditor?.isReady()) {
    window.DPEditor.updateInsertGroup(markerId, {
      insertIe:   ie,
      insertTime: dn,
      insertLoc:  loc,
      // insertContent 제거 (null로 덮어씀)
      insertId:   markerId, // 유지
    });
  } else {
    markedGroup.forEach(p => {
      delete p.dataset.insertContent;
      p.dataset.insertIe   = ie;
      p.dataset.insertTime = dn;
      p.dataset.insertLoc  = loc;
    });
  }

  // 2) 파싱 실행 → 인서트 그룹 단락에 dataset.sceneNum 채워짐
  onEditorInput();

  // 3) 마커로 첫 단락 찾기 → snum 취득 → sceneExtras 적용
  const markedPara = ed().querySelector(`p[data-insert-id="${markerId}"]`);
  if (markedPara) {
    const snum = markedPara.dataset.sceneNum;   // e.g. "1_ins1"
    if (snum) {
      if (!sceneExtras[snum]) sceneExtras[snum] = {};
      sceneExtras[snum].ie   = ie;
      sceneExtras[snum].time = dn;
      sceneExtras[snum].loc  = loc;
      delete sceneNotes[snum];

      // scene 객체에도 즉시 반영
      const s = scenes.find(sc => String(sc.number) === String(snum));
      if (s) { s.ie = ie; s.time = dn; s.heading = loc; s.loc = loc; }

      // 장소 → locationInfo 자동 등록
      if (loc && !locationInfo[loc]) locationInfo[loc] = { address: '', setPropItems: [] };

      // 4) 인서트 구간의 elem-tag 요소 → 부모씬에서 인서트씬으로 자동 이동
      if (parentSeq) autoMigrateElemsToInsert(markerId, parentSeq, snum);
    }
  }

  save();
  // 열려 있는 탭 갱신
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
  if (document.getElementById('tab-scenebd')?.classList.contains('on')) renderSceneBd();
  if (document.getElementById('tab-proplist')?.classList.contains('on'))  renderPropList();
  if (document.getElementById('tab-loclist')?.classList.contains('on'))   renderLocList();
  renderSidebar();
}

// 요소 버튼 활성 상태 갱신
function refreshElemTagUI() {
  document.querySelectorAll('.fmt-btn[data-elem-type]').forEach(b => b.classList.remove('elem-active'));
  const type = getSelectionElemType();
  if (type) document.querySelector(`.fmt-btn[data-elem-type="${type}"]`)?.classList.add('elem-active');
}
document.addEventListener('selectionchange', refreshElemTagUI);

// ── 우클릭 요소 등록 컨텍스트 메뉴 ─────────────────────────────
// elem-tag span 위의 노드에서 씬 번호 추출 헬퍼
function _getSnumFromNode(node) {
  const para = getTopLevelEditorPara(node);
  if (!para) return null;

  // 인서트 씬 단락 우선 처리
  if (para.dataset.insertId) {
    const snum = para.dataset.sceneNum || _insertIdToSceneNum[para.dataset.insertId];
    if (snum) {
      const sc = scenes.find(s => String(s.number) === String(snum));
      return sc ? sc.number : snum;
    }
  }
  if (para.dataset.sceneNum) {
    const sc = scenes.find(s => String(s.number) === String(para.dataset.sceneNum));
    if (sc) return sc.number;
  }
  const paras = [...(document.getElementById('scriptEditor')?.querySelectorAll('p') || [])];
  const idx = paras.indexOf(para);
  if (idx < 0) return null;
  for (let i = idx; i >= 0; i--) {
    // 인서트 씬 단락
    if (paras[i].dataset.insertId) {
      const snum = paras[i].dataset.sceneNum || _insertIdToSceneNum[paras[i].dataset.insertId];
      if (snum) {
        const sc = scenes.find(s => String(s.number) === String(snum));
        return sc ? sc.number : snum;
      }
    }
    const t = paras[i].dataset.type || guessType(paras[i].textContent);
    if (t === 'heading' || t === 'insert') {
      const scnum = paras[i].dataset.sceneNum;
      if (scnum != null) {
        const sc = scenes.find(s => String(s.number) === String(scnum));
        return sc ? sc.number : null;
      }
      return null;
    }
  }
  return null;
}

function _openElemCtxMenu(e) {
  const edEl = document.getElementById('scriptEditor');
  if (!edEl) return false;

  // ── 1. 우클릭 대상이 elem-tag span 위인지 확인 ──────────────────
  let elemSpan = null;
  let node = e.target;
  while (node && node !== edEl) {
    if (node.classList?.contains('elem-tag')) { elemSpan = node; break; }
    node = node.parentElement;
  }

  const sel     = window.getSelection();
  const selText = sel ? sel.toString().trim() : '';

  let text, snum, pmSel = null, savedRange = null, existingType = null;

  if (elemSpan) {
    // 이미 등록된 span 위를 우클릭 — 선택 없어도 동작
    existingType = elemSpan.dataset.elemType || null;
    text = elemSpan.textContent.trim();
    snum = _getSnumFromNode(elemSpan);
  } else if (selText && sel.rangeCount) {
    // 텍스트 선택 후 우클릭
    const range = sel.getRangeAt(0);
    if (!edEl.contains(range.commonAncestorContainer)) return false;
    text = selText;
    snum = getSceneNumFromSelection(sel);
    pmSel = window.DPEditor?.isReady() ? window.DPEditor.pmSelectionRange?.() : null;
    savedRange = (!pmSel && !sel.isCollapsed) ? range.cloneRange() : null;
    existingType = getSelectionElemType(); // 선택이 이미 태그된 span 안이면 해당 타입
  } else {
    return false; // 에디터 안이지만 선택도 없고 span도 아님 → 기본 메뉴
  }

  if (!text) return false;
  _ctxSavedSel = { text, snum, pmSel, savedRange, existingType, elemSpan };

  // ── 2. 메뉴 항목 상태 업데이트 ──────────────────────────────────
  const menu = document.getElementById('elemCtxMenu');
  menu.querySelectorAll('.elem-ctx-item[data-elem-type]').forEach(btn => {
    const isActive = btn.dataset.elemType === existingType;
    btn.classList.toggle('elem-ctx-item--active', isActive);
  });
  // 등록 취소 버튼: existingType 있을 때만 표시
  const cancelBtn = document.getElementById('elemCtxCancelBtn');
  const cancelSep = document.getElementById('elemCtxCancelSep');
  const show = !!existingType;
  if (cancelBtn) cancelBtn.style.display = show ? 'flex' : 'none';
  if (cancelSep) cancelSep.style.display = show ? 'block' : 'none';

  // ── 3. 위치 계산 ─────────────────────────────────────────────
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top  = '0px';
  menu.classList.add('open');
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = e.clientX, y = e.clientY;
  if (x + rect.width  > vw - 8) x = vw - rect.width  - 8;
  if (y + rect.height > vh - 8) y = vh - rect.height - 8;
  if (x < 8) x = 8; if (y < 8) y = 8;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.style.visibility = '';
  return true;
}

function hideElemCtxMenu() {
  document.getElementById('elemCtxMenu')?.classList.remove('open');
  _ctxSavedSel = null;
}

// ── 등록 취소: 이미 등록된 요소를 제거 ─────────────────────────────
function cancelElemFromCtx() {
  const saved = _ctxSavedSel;
  hideElemCtxMenu();
  if (!saved || !saved.existingType) return;
  const { text, snum, existingType: type, elemSpan } = saved;
  const FIELD = { costume:'costumeItems', makeup:'makeupItems', charProp:'charPropItems', setProp:'setPropItems', vfx:'vfxItems', etc:'etcItems', location:'locationItems' };
  const field = FIELD[type];
  if (!field) return; // char 타입은 이 경로 미사용

  pushUndo();
  if (snum) _deletionLog.addElem(snum, field, text); // Firestore merge 시 복원 방지
  if (snum && sceneExtras[snum]?.[field]) {
    const idx = sceneExtras[snum][field].findIndex(i => getItemText(i) === text);
    if (idx >= 0) sceneExtras[snum][field].splice(idx, 1);
  }
  if (snum && type !== 'location') removeFromListField(snum, ITEMS_TO_LIST[field], text);

  // 에디터에서 하이라이트 제거
  if (elemSpan) {
    if (window.DPEditor?.isReady()) {
      window.DPEditor.removeElemTagSpan(elemSpan);
    } else {
      elemSpan.replaceWith(...elemSpan.childNodes);
    }
  } else if (snum) {
    removeElemSpanFromEditor(snum, type, text);
  }

  if (type === 'charProp' || type === 'setProp') {
    removePropFromList(text, type);
    if (document.getElementById('tab-proplist')?.classList.contains('on')) renderPropList();
  }
  if (type === 'costume' || type === 'makeup') removeCostumeFromList(text, type);
  save();
  refreshElementLinkedViews(type);
}

function registerElemFromCtx(type) {
  const saved = _ctxSavedSel;
  hideElemCtxMenu();
  if (!saved || !saved.text) return;
  const { text, snum, pmSel, savedRange } = saved;

  // ── 인물 등록 ──────────────────────────────────────────────
  if (type === 'char') {
    if (text.length > 20) { alert('선택한 텍스트가 너무 깁니다. 인물 이름만 선택해주세요.'); return; }
    pushUndo();
    if (!charInfo[text]) charInfo[text] = {};
    if (!globalChars.includes(text)) globalChars.push(text);
    hiddenChars = hiddenChars.filter(n => n !== text);
    if (snum) {
      if (!manualCharsByScene[snum]) manualCharsByScene[snum] = [];
      if (!manualCharsByScene[snum].includes(text)) manualCharsByScene[snum].push(text);
    }
    save();
    renderCharTab();
    renderSidebar();
    if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
    return;
  }

  // ── 기타 요소 등록 (의상/분장/소품/효과/기타) ────────────────────
  const FIELD = { costume:'costumeItems', makeup:'makeupItems', charProp:'charPropItems', setProp:'setPropItems', vfx:'vfxItems', etc:'etcItems', location:'locationItems' };

  if (!snum) { alert('씬 안의 텍스트를 선택해주세요.'); return; }
  if (!sceneExtras[snum]) sceneExtras[snum] = {};
  const field = FIELD[type];
  if (!sceneExtras[snum][field]) sceneExtras[snum][field] = [];

  // 토글: 이미 동일 타입으로 등록 → 제거
  const existingIdx = sceneExtras[snum][field].findIndex(i => getItemText(i) === text);
  if (existingIdx >= 0) {
    pushUndo();
    _deletionLog.addElem(snum, field, text); // Firestore merge 시 복원 방지
    sceneExtras[snum][field].splice(existingIdx, 1);
    if (type !== 'location') removeFromListField(snum, ITEMS_TO_LIST[field], text);
    removeElemSpanFromEditor(snum, type, text);
    if (type === 'charProp' || type === 'setProp') {
      removePropFromList(text, type);
      if (document.getElementById('tab-proplist')?.classList.contains('on')) renderPropList();
    }
    if (type === 'costume' || type === 'makeup') removeCostumeFromList(text, type);
    save();
    refreshElementLinkedViews(type);
    return;
  }

  // 신규 등록
  pushUndo();
  _lastElemRegTime = Date.now();
  // 재등록 시 삭제 로그 항목 제거 — Firestore merge가 방금 추가한 항목을 필터링하지 않도록
  _deletionLog.elem.delete(`${snum}::${field}::${text}`);
  _deletionLog.elemGlobal.delete(`${field}::${text}`);
  if (type === 'charProp' || type === 'setProp') _deletionLog.prop.delete(`${text}::${type}`);
  if (type === 'costume'  || type === 'makeup')  _deletionLog.costume.delete(`${text}::${type}`);
  const item = { text, fromEditor: !window.DPEditor?.isReady() };
  sceneExtras[snum][field].push(item);
  if (type !== 'location') appendToListField(snum, ITEMS_TO_LIST[field], text);

  if (type === 'charProp' || type === 'setProp') {
    syncPropToList(text, type, snum);
    if (type === 'setProp') autoFillPropLocation(text, snum);
    if (document.getElementById('tab-proplist')?.classList.contains('on')) renderPropList();
  }
  if (type === 'costume' || type === 'makeup') {
    syncCostumeToList(text, type, snum, { text, fromEditor: true });
    if (document.getElementById('tab-costumelist')?.classList.contains('on')) renderCostumeList();
  }
  if (type === 'location' && !locationInfo[text]) {
    locationInfo[text] = { address: '', setPropItems: [] };
  }
  if (type === 'setProp') {
    const scene = scenes.find(s => s.number === snum);
    const sceneLocs = new Set();
    if (scene?.loc) sceneLocs.add(scene.loc);
    (sceneExtras[snum]?.locationItems || []).forEach(it => { const n = getItemText(it); if (n) sceneLocs.add(n); });
    sceneLocs.forEach(loc => {
      if (!locationInfo[loc]) locationInfo[loc] = { address: '', setPropItems: [] };
      if (!locationInfo[loc].setPropItems) locationInfo[loc].setPropItems = [];
      if (!locationInfo[loc].setPropItems.some(i => getItemText(i) === text))
        locationInfo[loc].setPropItems.push(text);
    });
  }

  // 하이라이트 적용 (저장된 선택 범위 사용)
  let highlighted = false;
  if (pmSel) {
    window.DPEditor.applyElemTag(type, pmSel.from, pmSel.to);
    highlighted = true;
  } else if (!window.DPEditor?.isReady() && savedRange) {
    try {
      const span = document.createElement('span');
      span.className = `elem-tag elem-${type}`;
      span.dataset.elemType = type;
      span.appendChild(savedRange.extractContents());
      savedRange.insertNode(span);
      highlighted = true;
    } catch(e) { /* 단락 경계 걸친 선택 — 무시 */ }
  }
  if (!highlighted && !window.DPEditor?.isReady()) item.fromEditor = false;
  save();
  if (document.getElementById('tab-scenebd')?.classList.contains('on'))   renderSceneBd();
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
  if (document.getElementById('tab-loclist')?.classList.contains('on'))   renderLocList();
  renderSidebar();
}

// 컨텍스트 메뉴 트리거 (에디터 내 우클릭)
document.addEventListener('contextmenu', function(e) {
  const edEl = document.getElementById('scriptEditor');
  if (!edEl) return;
  if (!edEl.contains(e.target)) return; // 에디터 밖이면 기본 메뉴 허용
  hideElemCtxMenu();
  const showed = _openElemCtxMenu(e);
  if (showed) e.preventDefault();
});

// 외부 클릭 시 컨텍스트 메뉴 닫기
document.addEventListener('click', function(e) {
  if (!e.target.closest('#elemCtxMenu')) hideElemCtxMenu();
});

function getSceneNumFromSelection(sel) {
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  let node = range.startContainer;
  let para = getTopLevelEditorPara(node);
  if (!para && range.commonAncestorContainer !== range.startContainer) {
    para = getTopLevelEditorPara(range.commonAncestorContainer);
  }
  if (!para) {
    const parasInSelection = getSelectedEditorParas(range);
    para = parasInSelection[0] || null;
  }
  node = para;
  if (!node) return null;

  // 인서트 씬 단락 우선 처리
  if (node.dataset.insertId) {
    const snum = node.dataset.sceneNum || _insertIdToSceneNum[node.dataset.insertId];
    if (snum) {
      const sc = scenes.find(s => String(s.number) === String(snum));
      return sc ? sc.number : snum;
    }
  }
  if (node.dataset.sceneNum) {
    const sc = scenes.find(s => String(s.number) === String(node.dataset.sceneNum));
    if (sc) return sc.number;
  }

  const paras = [...ed().querySelectorAll('p')];
  const idx = paras.indexOf(node);
  if (idx < 0) return null;
  for (let i = idx; i >= 0; i--) {
    // 인서트 씬 단락: _insertIdToSceneNum 로 씬 번호 조회
    if (paras[i].dataset.insertId) {
      const snum = paras[i].dataset.sceneNum || _insertIdToSceneNum[paras[i].dataset.insertId];
      if (snum) {
        const sc = scenes.find(s => String(s.number) === String(snum));
        return sc ? sc.number : snum;
      }
    }
    const t = paras[i].dataset.type || guessType(paras[i].textContent);
    if (t === 'heading' || t === 'insert') {
      const sceneNum = paras[i].dataset.sceneNum;
      if (sceneNum != null) {
        const sc = scenes.find(s => String(s.number) === String(sceneNum));
        return sc ? sc.number : null;
      }
      const dispNum = extractSceneNum(paras[i].textContent);
      const sc = scenes.find(s => s.displayNum === dispNum);
      return sc ? sc.number : null;
    }
  }
  return null;
}

// 스크립트에서 드래그 선택 후 요소 등록
function flashBtn(btn) {
  if (!btn) return;
  btn.classList.add('btn-reg-flash');
  setTimeout(() => btn.classList.remove('btn-reg-flash'), 100); // 클래스 제거 → transition으로 자연스럽게 복원
}

function refreshElementLinkedViews(type) {
  if (type === 'charProp' || type === 'setProp') {
    if (document.getElementById('tab-proplist')?.classList.contains('on')) renderPropList();
  }
  if (type === 'costume' || type === 'makeup') {
    if (document.getElementById('tab-costumelist')?.classList.contains('on')) renderCostumeList();
  }
  if (document.getElementById('tab-scenebd')?.classList.contains('on'))   renderSceneBd();
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
  if (document.getElementById('tab-loclist')?.classList.contains('on'))   renderLocList();
  renderSidebar();
}

function addSceneElement(type, btn) {
  const LABEL = { costume:'의상', makeup:'분장', charProp:'인물소품', setProp:'공간소품', vfx:'효과', etc:'기타', location:'장소' };
  const FIELD = { costume:'costumeItems', makeup:'makeupItems', charProp:'charPropItems', setProp:'setPropItems', vfx:'vfxItems', etc:'etcItems', location:'locationItems' };
  const sel  = window.getSelection();
  const activeSpan = getSelectionElemSpan();
  if (activeSpan?.dataset.elemType === type) {
    const spanText = activeSpan.textContent.trim();
    const snum = getSceneNumFromSelection(sel);
    const field = FIELD[type];
    if (!spanText || !snum || !field) return;

    pushUndo();
    _deletionLog.addElem(snum, field, spanText); // Firestore merge 시 복원 방지
    if (sceneExtras[snum]?.[field]) {
      const idx = sceneExtras[snum][field].findIndex(i => getItemText(i) === spanText);
      if (idx >= 0) sceneExtras[snum][field].splice(idx, 1);
    }
    if (type !== 'location') removeFromListField(snum, ITEMS_TO_LIST[field], spanText);
    if (type === 'charProp' || type === 'setProp') removePropFromList(spanText, type);
    if (type === 'makeup' || type === 'costume') removeCostumeFromList(spanText, type);
    if (window.DPEditor?.isReady()) {
      window.DPEditor.removeElemTagSpan(activeSpan);
    } else {
      activeSpan.replaceWith(...activeSpan.childNodes);
    }
    sel?.removeAllRanges();
    flashBtn(btn);
    save();
    refreshElementLinkedViews(type);
    return;
  }

  const text = sel ? sel.toString().trim() : '';
  if (!text) { alert((LABEL[type]||type) + '으로 등록할 텍스트를 드래그하여 선택해주세요.'); return; }
  const snum = getSceneNumFromSelection(sel);
  if (!snum) { alert('씬 안의 텍스트를 선택해주세요.'); return; }
  // PM 모드: 선택 범위를 미리 저장 (이후 조작에서 선택이 풀리기 전)
  const pmSel = window.DPEditor?.isReady() ? window.DPEditor.pmSelectionRange?.() : null;
  // 레거시 모드: 하이라이트용 range 미리 저장
  const savedRange = (!pmSel && sel.rangeCount > 0 && !sel.isCollapsed) ? sel.getRangeAt(0).cloneRange() : null;
  if (!sceneExtras[snum]) sceneExtras[snum] = {};
  const field = FIELD[type];
  if (!sceneExtras[snum][field]) sceneExtras[snum][field] = [];

  // ── 토글: 이미 등록된 경우 → 제거 후 종료 ─────────────────
  const existingIdx = sceneExtras[snum][field].findIndex(i => getItemText(i) === text);
  if (existingIdx >= 0) {
    pushUndo();
    _deletionLog.addElem(snum, field, text); // Firestore merge 시 복원 방지
    sceneExtras[snum][field].splice(existingIdx, 1);
    if (type !== 'location') removeFromListField(snum, ITEMS_TO_LIST[field], text);
    removeElemSpanFromEditor(snum, type, text);
    if (type === 'charProp' || type === 'setProp') {
      removePropFromList(text, type);
      if (document.getElementById('tab-proplist')?.classList.contains('on')) renderPropList();
    }
    if (type === 'costume' || type === 'makeup') {
      removeCostumeFromList(text, type);
    }
    flashBtn(btn);
    save();
    refreshElementLinkedViews(type);
    return;
  }

  // ── 신규 등록 ────────────────────────────────────────────
  pushUndo();
  _lastElemRegTime = Date.now(); // syncElemTagsFromEditor 오탐 방지
  // 재등록 시 삭제 로그 항목 제거 — Firestore merge가 방금 추가한 항목을 필터링하지 않도록
  _deletionLog.elem.delete(`${snum}::${field}::${text}`);
  _deletionLog.elemGlobal.delete(`${field}::${text}`);
  if (type === 'charProp' || type === 'setProp') _deletionLog.prop.delete(`${text}::${type}`);
  if (type === 'costume'  || type === 'makeup')  _deletionLog.costume.delete(`${text}::${type}`);
  // PM 모드에서는 fromEditor: false — PM 마크는 하이라이트용이고 데이터는 sceneExtras에서 독립 관리
  // 레거시 contentEditable 모드에서만 fromEditor: true (span 삭제 시 자동 제거)
  const item = { text, fromEditor: !window.DPEditor?.isReady() };
  sceneExtras[snum][field].push(item);
  if (type !== 'location') appendToListField(snum, ITEMS_TO_LIST[field], text);

  // 소품리스트 동기화 (charProp/setProp 추가 시)
  if (type === 'charProp' || type === 'setProp') {
    syncPropToList(text, type, snum);
    if (type === 'setProp') autoFillPropLocation(text, snum);
    if (document.getElementById('tab-proplist')?.classList.contains('on')) renderPropList();
  }
  // 의상/분장 동기화
  if (type === 'costume' || type === 'makeup') {
    syncCostumeToList(text, type, snum, { text, fromEditor: true });
    if (document.getElementById('tab-costumelist')?.classList.contains('on')) renderCostumeList();
  }
  // 장소 등록 시 locationInfo에 자동 생성
  if (type === 'location' && !locationInfo[text]) {
    locationInfo[text] = { address: '', setPropItems: [] };
  }
  // 공간소품 추가 시 해당 씬의 장소 locationInfo에도 자동 등록
  if (type === 'setProp') {
    const scene = scenes.find(s => s.number === snum);
    const sceneLocs = new Set();
    if (scene?.loc) sceneLocs.add(scene.loc);
    (sceneExtras[snum]?.locationItems || []).forEach(item => { const n = getItemText(item); if (n) sceneLocs.add(n); });
    sceneLocs.forEach(loc => {
      if (!locationInfo[loc]) locationInfo[loc] = { address: '', setPropItems: [] };
      if (!locationInfo[loc].setPropItems) locationInfo[loc].setPropItems = [];
      if (!locationInfo[loc].setPropItems.some(i => getItemText(i) === text))
        locationInfo[loc].setPropItems.push(text);
    });
  }
  // 선택 텍스트에 컬러 하이라이트 적용
  let highlighted = false;
  if (pmSel) {
    // PM 모드: addMark 트랜잭션으로 elemTag 마크 적용
    window.DPEditor.applyElemTag(type, pmSel.from, pmSel.to);
    highlighted = true;
  } else if (!window.DPEditor?.isReady() && savedRange) {
    // 레거시 모드 전용: 직접 span 삽입 (PM 모드에서는 DOM 직접 조작 안 함)
    try {
      const span = document.createElement('span');
      span.className = `elem-tag elem-${type}`;
      span.dataset.elemType = type;
      span.appendChild(savedRange.extractContents());
      savedRange.insertNode(span);
      highlighted = true;
    } catch(e) { /* 단락 경계 걸친 선택 — 무시 */ }
  }
  // 레거시 모드에서만 하이라이트 실패 시 fromEditor: false (PM은 이미 false로 설정됨)
  if (!highlighted && !window.DPEditor?.isReady()) item.fromEditor = false;
  flashBtn(btn);
  save();
  if (document.getElementById('tab-scenebd')?.classList.contains('on')) renderSceneBd();
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
  if (document.getElementById('tab-loclist')?.classList.contains('on')) renderLocList();
  renderSidebar();
}

// 아이템 텍스트/인물 추출 헬퍼 (string 또는 {text,char} 객체 모두 지원)
const getItemText = item => (item && typeof item === 'object') ? (item.text || '') : (item || '');
const getItemChar = item => (item && typeof item === 'object') ? (item.char || '') : '';

// 씬리스트 통합 텍스트 필드 맵: 배열 필드명 → costumeList/propList/etcList
const ITEMS_TO_LIST = {
  costumeItems:'costumeList', makeupItems:'costumeList',
  charPropItems:'propList',   setPropItems:'propList',
  vfxItems:'etcList',         etcItems:'etcList',
};

// 씬리스트 텍스트 필드에 항목 추가 (중복 제외)
function appendToListField(snum, listField, text) {
  if (!listField || !text) return;
  if (!sceneExtras[snum]) sceneExtras[snum] = {};
  const extra = sceneExtras[snum];
  const cur = extra[listField];
  if (cur == null || cur === '') {
    extra[listField] = text;
  } else if (!cur.split(',').map(s => s.trim()).includes(text.trim())) {
    extra[listField] = cur + ', ' + text;
  }
}

// 씬리스트 텍스트 필드에서 항목 제거
function removeFromListField(snum, listField, text) {
  if (!listField) return;
  const extra = sceneExtras[snum];
  if (!extra || extra[listField] == null) return;
  const items = extra[listField].split(',').map(s => s.trim()).filter(s => s && s !== text.trim());
  extra[listField] = items.join(', ');
}

// field명 → 요소 타입 매핑 (span 클래스 제거용)
const FIELD_TO_TYPE = {
  costumeItems:'costume', makeupItems:'makeup', charPropItems:'charProp',
  setPropItems:'setProp', vfxItems:'vfx', etcItems:'etc', locationItems:'location'
};

let _elemTagSyncTimer = null;
let _lastElemRegTime  = 0; // addSceneElement() 마지막 호출 시각 (syncElemTagsFromEditor 오탐 방지)
function scheduleElemTagSync() {
  clearTimeout(_elemTagSyncTimer);
  _elemTagSyncTimer = setTimeout(syncElemTagsFromEditor, 400);
}

// 에디터 내 elem-tag span 현황을 sceneExtras와 동기화
// fromEditor: true 항목 중 span이 사라진 것을 자동 제거
function syncElemTagsFromEditor() {
  // 요소 등록 직후 3초 이내에는 실행하지 않음 (PM/Yjs 안정화 대기)
  if (Date.now() - _lastElemRegTime < 3000) return;
  // 1. 에디터에 현재 존재하는 span 수집: { snum -> { type -> Set<text> } }
  const present = {};
  const paras   = [...ed().querySelectorAll('p')];
  let curSnum   = null;
  for (const p of paras) {
    // data-scene-num이 직접 설정된 경우 우선 사용,
    // 인서트 씬 단락은 _insertIdToSceneNum 매핑으로 보완
    if (p.dataset.sceneNum !== undefined) {
      curSnum = p.dataset.sceneNum;
    } else if (p.dataset.insertId) {
      const mapped = _insertIdToSceneNum[p.dataset.insertId];
      if (mapped) curSnum = mapped;
    }
    if (curSnum == null) continue;
    for (const span of p.querySelectorAll('span.elem-tag[data-elem-type]')) {
      const type = span.dataset.elemType;
      if (!type || type === 'insert') continue;
      const text = span.textContent.trim();
      if (!text) continue;
      if (!present[curSnum]) present[curSnum] = {};
      if (!present[curSnum][type]) present[curSnum][type] = new Set();
      present[curSnum][type].add(text);
    }
  }

  // 2. sceneExtras에서 span이 사라진 fromEditor 항목 제거
  let anyRemoved = false;
  for (const [snumKey, extra] of Object.entries(sceneExtras)) {
    for (const [field, type] of Object.entries(FIELD_TO_TYPE)) {
      if (!extra[field]?.length) continue;
      const before = extra[field].length;
      extra[field] = extra[field].filter(item => {
        if (!(typeof item === 'object' && item.fromEditor)) return true; // "+" 등록 항목은 보존
        const text = getItemText(item);
        return present[snumKey]?.[type]?.has(text) ?? false;
      });
      if (extra[field].length < before) {
        anyRemoved = true;
        // 삭제된 항목을 씬리스트 텍스트 필드에서도 제거
        const listField = ITEMS_TO_LIST[field];
        if (listField) {
          const removed = [];
          // 어떤 텍스트가 사라졌는지 파악하기 위해 before 목록 재구성
        }
      }
    }
  }
  // 씬리스트 텍스트 필드 전체 재동기화 (간단하게 재구성)
  if (anyRemoved) {
    for (const [snumKey, extra] of Object.entries(sceneExtras)) {
      for (const [field, listField] of Object.entries(ITEMS_TO_LIST)) {
        if (!extra[field]) continue;
        extra[listField] = extra[field].map(getItemText).filter(Boolean).join(', ');
      }
    }
    save();
    renderSidebar();
    if (document.getElementById('tab-scenebd')?.classList.contains('on'))   renderSceneBd();
    if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
    if (document.getElementById('tab-loclist')?.classList.contains('on'))       renderLocList();
    if (document.getElementById('tab-proplist')?.classList.contains('on'))      renderPropList();
    if (document.getElementById('tab-costumelist')?.classList.contains('on'))   renderCostumeList();
  }
}

// 에디터에서 특정 씬의 elem-tag span 제거
function removeElemSpanFromEditor(snum, type, text) {
  const edEl = ed();
  if (!edEl) return;

  if (window.DPEditor?.isReady()) {
    // PM 모드: 1차 — DOM span 탐색
    const snumStr = String(snum);
    const isInsertScene = snumStr.includes('_ins');
    const paras = [...edEl.querySelectorAll('p')];
    let headingCount = 0;
    let inScene = false;
    let foundByDOM = false;

    // 인서트 씬인 경우: _insertIdToSceneNum 역매핑으로 insertId 찾기
    let insertIdForScene = null;
    if (isInsertScene) {
      for (const [iid, sn] of Object.entries(_insertIdToSceneNum)) {
        if (String(sn) === snumStr) { insertIdForScene = iid; break; }
      }
    }

    for (const p of paras) {
      const pType = p.dataset.type || guessType(p.textContent);
      if (pType === 'heading') {
        headingCount++;
        if (!isInsertScene) inScene = (headingCount === +snum);
        continue;
      }
      // 인서트 씬: insertId 일치 여부로 판단
      if (isInsertScene) {
        inScene = insertIdForScene
          ? (p.dataset.insertId === insertIdForScene)
          : (String(p.dataset.sceneNum) === snumStr ||
             _insertIdToSceneNum[p.dataset.insertId] === snumStr);
      }
      if (!inScene) continue;
      for (const span of p.querySelectorAll(`span.elem-${type}`)) {
        if (span.textContent.trim() === text.trim()) {
          window.DPEditor.removeElemTagSpan(span);
          foundByDOM = true;
          break;
        }
      }
      if (foundByDOM) break;
    }
    // 2차 fallback — PM 문서 직접 순회 (DOM에서 못 찾은 엣지케이스 대응)
    if (!foundByDOM) {
      window.DPEditor.removeElemMarkByText(type, text, isInsertScene ? null : snum);
    }
    return;
  }

  // 레거시 모드: 직접 DOM 조작
  const paras = [...edEl.querySelectorAll('p')];
  let inScene = false;
  for (const p of paras) {
    if (String(p.dataset.sceneNum) === String(snum)) {
      for (const span of [...p.querySelectorAll(`span.elem-${type}`)]) {
        if (span.textContent.trim() === text.trim()) {
          span.replaceWith(span.textContent);
          return;
        }
      }
    }
    const pType = p.dataset.type || guessType(p.textContent);
    if (pType === 'heading') {
      inScene = (String(p.dataset.sceneNum) === String(snum));
      continue;
    }
    if (!inScene) continue;
    for (const span of [...p.querySelectorAll(`span.elem-${type}`)]) {
      if (span.textContent.trim() === text.trim()) {
        span.replaceWith(span.textContent);
        return;
      }
    }
  }
}

// 요소 삭제 (씬브레이크다운 → 스크립트 하이라이트도 동시 제거)
function removeSceneElement(snum, field, idx) {
  if (sceneExtras[snum] && sceneExtras[snum][field]) {
    const text = getItemText(sceneExtras[snum][field][idx]);
    const type = FIELD_TO_TYPE[field];
    _deletionLog.addElem(snum, field, text); // Firestore merge 시 복원 방지
    sceneExtras[snum][field].splice(idx, 1);
    removeFromListField(snum, ITEMS_TO_LIST[field], text);
    if (type) removeElemSpanFromEditor(snum, type, text);
    if (type === 'charProp' || type === 'setProp') {
      removePropFromList(text, type);
      if (document.getElementById('tab-proplist')?.classList.contains('on')) renderPropList();
    }
    if (type === 'costume' || type === 'makeup') {
      removeCostumeFromList(text, type);
      if (document.getElementById('tab-costumelist')?.classList.contains('on')) renderCostumeList();
    }
    save();
    if (document.getElementById('tab-scenebd')?.classList.contains('on'))   renderSceneBd();
    if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
    if (document.getElementById('tab-loclist')?.classList.contains('on'))   renderLocList();
    renderSidebar();
  }
}

// 씬브레이크다운 아이템 텍스트 수정 — 비우면 삭제
function updateSceneElementText(snum, field, idx, newText) {
  newText = newText.trim();
  if (!newText) { removeSceneElement(snum, field, idx); return; }
  if (!sceneExtras[snum]?.[field]) return;
  const oldItem  = sceneExtras[snum][field][idx];
  const oldText  = getItemText(oldItem);
  const charName = getItemChar(oldItem);
  const fromEd   = typeof oldItem === 'object' && oldItem.fromEditor;
  if (oldText === newText) return;
  sceneExtras[snum][field][idx] = charName
    ? { text: newText, char: charName, ...(fromEd ? { fromEditor: true } : {}) }
    : (fromEd ? { text: newText, fromEditor: true } : newText);
  // 소품리스트 연동
  const type = FIELD_TO_TYPE[field];
  if (type === 'charProp' || type === 'setProp') {
    const prop = propList.find(p => p.name === oldText && p.category === type);
    if (prop) prop.name = newText;
    if (document.getElementById('tab-proplist')?.classList.contains('on')) renderPropList();
  }
  if (type === 'costume' || type === 'makeup') {
    const cos = costumeList.find(c => c.name === oldText && c.category === type);
    if (cos) cos.name = newText;
    if (document.getElementById('tab-costumelist')?.classList.contains('on')) renderCostumeList();
  }
  save();
  if (document.getElementById('tab-scenebd')?.classList.contains('on'))   renderSceneBd();
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
  renderSidebar();
}

// 씬브레이크다운 아이템에 인물 배정/변경
function setItemChar(snum, field, idx, charName) {
  const extra = sceneExtras[snum];
  if (!extra || !extra[field]) return;
  const oldItem   = extra[field][idx];
  const text      = getItemText(oldItem);
  const fromEd    = typeof oldItem === 'object' && oldItem.fromEditor;
  extra[field][idx] = charName
    ? { text, char: charName, ...(fromEd ? { fromEditor: true } : {}) }
    : (fromEd ? { text, fromEditor: true } : text);
  save();
  if (document.getElementById('tab-scenebd')?.classList.contains('on')) renderSceneBd();
  renderSidebar();
}

// 씬브레이크다운 항목 추가 인박스 토글
function toggleSbdAddRow(id) {
  const row = document.getElementById(id);
  if (!row) return;
  const opening = !row.classList.contains('open');
  row.classList.toggle('open', opening);
  if (opening) row.querySelector('.sbd-add-input')?.focus();
}

// 씬브레이크다운 내 직접 항목 추가 (인물 연결 지원)
function addItemFromBdRow(rowId, snum, field) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const inputEl  = row.querySelector('.sbd-add-input');
  const charSel  = row.querySelector('.sbd-add-char-sel');
  const text     = inputEl ? inputEl.value.trim() : '';
  const charName = charSel ? charSel.value : '';
  if (!text) return;
  pushUndo();
  const item = charName ? {text, char: charName} : text;
  if (!sceneExtras[snum]) sceneExtras[snum] = {};
  if (!sceneExtras[snum][field]) sceneExtras[snum][field] = [];
  if (!sceneExtras[snum][field].some(i => getItemText(i) === text)) {
    sceneExtras[snum][field].push(item);
    appendToListField(snum, ITEMS_TO_LIST[field], text);
    const bdType = FIELD_TO_TYPE[field];
    if (bdType === 'charProp' || bdType === 'setProp') {
      syncPropToList(text, bdType, snum, item);
      if (bdType === 'charProp') autoFillPropCharacter(text, snum);
      if (bdType === 'setProp') autoFillPropLocation(text, snum);
      if (document.getElementById('tab-proplist')?.classList.contains('on')) renderPropList();
    }
    if (bdType === 'costume' || bdType === 'makeup') {
      syncCostumeToList(text, bdType, snum, item);
      if (document.getElementById('tab-costumelist')?.classList.contains('on')) renderCostumeList();
    }
  }
  if (inputEl) inputEl.value = '';
  save();
  if (document.getElementById('tab-scenebd')?.classList.contains('on')) renderSceneBd();
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
  renderSidebar();
}

// +직접등록 모달 열기
function showDirectRegister() {
  const sel   = document.getElementById('drScene');
  const snum  = getSceneNumFromSelection(window.getSelection());
  sel.innerHTML = scenes.map(s =>
    `<option value="${s.number}" ${s.number===snum?'selected':''}>${'S#'+(s.displayNum||s.number)} ${esc(s.loc)}</option>`
  ).join('');
  document.getElementById('drText').value = '';
  document.getElementById('drModal').classList.add('open');
  setTimeout(() => document.getElementById('drText').focus(), 100);
}
function closeDirectRegister() {
  document.getElementById('drModal').classList.remove('open');
}
function submitDirectRegister() {
  const snum  = +document.getElementById('drScene').value;
  const field = document.getElementById('drType').value;
  const text  = document.getElementById('drText').value.trim();
  if (!text) { alert('내용을 입력해주세요.'); return; }
  pushUndo();
  if (!sceneExtras[snum]) sceneExtras[snum] = {};
  if (!sceneExtras[snum][field]) sceneExtras[snum][field] = [];
  if (!sceneExtras[snum][field].some(i => getItemText(i) === text)) {
    sceneExtras[snum][field].push(text);
    appendToListField(snum, ITEMS_TO_LIST[field], text);
    const drType = FIELD_TO_TYPE[field];
    if (drType === 'charProp' || drType === 'setProp') {
      syncPropToList(text, drType, snum);
      if (drType === 'setProp') autoFillPropLocation(text, snum);
    }
    if (drType === 'costume' || drType === 'makeup') {
      syncCostumeToList(text, drType, snum);
    }
  }
  save();
  closeDirectRegister();
  if (document.getElementById('tab-scenebd')?.classList.contains('on')) renderSceneBd();
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
  if (document.getElementById('tab-proplist')?.classList.contains('on')) renderPropList();
  if (document.getElementById('tab-costumelist')?.classList.contains('on')) renderCostumeList();
}

// 씬의 스크립트 라인 추출 (action / char / dialogue)
function getSceneLines(scene) {
  const paras = [...ed().querySelectorAll('p')];
  const lines = [];
  let inScene = false;
  for (const p of paras) {
    const type = p.dataset.type || guessType(p.textContent);
    const text = p.textContent;
    if (type === 'heading') {
      if (extractSceneNum(text) === scene.displayNum) { inScene = true; continue; }
      else if (inScene) break;
    }
    if (inScene) lines.push({ type: type || 'action', text });
  }
  return lines;
}

// 씬브레이크다운 (페이지뷰) 렌더링
function renderSceneBd() {
  const wrap = document.getElementById('sbdPages');
  if (!scenes.length) {
    wrap.innerHTML = `<div class="empty" style="padding:60px 24px">
      <div class="empty-icon">🎬</div>
      <div>스크립트 탭에서 스크립트를 입력해주세요</div></div>`;
    return;
  }
  const _toDN = t => ({day:'낮',night:'밤',dawn:'새벽',eve:'저녁'}[t]||t);
  const _toIE = ie => ({INT:'실내(INT)',EXT:'실외(EXT)','INT/EXT':'실내외','EXT/INT':'실외내'}[ie]||ie);
  wrap.innerHTML = scenes.map(s => {
    const extra   = sceneExtras[s.number] || {};
    const synopsis = sceneNotes[s.number] || '';
    const allChars = getAllChars(s);
    const cosItems  = extra.costumeItems  || [];
    const mkItems   = extra.makeupItems   || [];
    const cpItems   = extra.charPropItems || [];
    const spItems   = extra.setPropItems  || [];
    const vfxItems  = extra.vfxItems      || [];
    const etcItems  = extra.etcItems      || [];
    const lines = getSceneLines(s);
    const scriptHtml = lines.length
      ? lines.map(l => {
          if (!l.text.trim()) return `<p class="sbd-s-empty"></p>`;
          const cls = {action:'sbd-s-action', char:'sbd-s-char', dialogue:'sbd-s-dialogue'}[l.type]||'sbd-s-action';
          return `<p class="${cls}">${esc(l.text)}</p>`;
        }).join('')
      : `<p style="color:var(--text-dim);font-size:12px">스크립트 내용 없음</p>`;

    // 현재 활성 인물만 포함 (스크립트에서 삭제된 인물은 제외)
    const allKnownChars = [...new Set([...allChars, ...allSceneChars()])];

    const itemsHtml = (arr, field) => arr.map((item, i) => {
      const text     = getItemText(item);
      const charName = getItemChar(item);
      const color    = charName ? (charInfo[charName] || {}).color : null;
      const chipSt   = color ? `background:${color}22;border-color:${color}88;` : '';
      const selSt    = color ? `color:${color};font-weight:700;` : '';
      // 이미 배정된 인물이 목록에 없으면 항상 추가 (이름 변경 후에도 표시)
      const optChars = charName && !allKnownChars.includes(charName)
        ? [...allKnownChars, charName]
        : allKnownChars;
      const charOpts = ['', ...optChars].map(c =>
        `<option value="${esc(c)}" ${c === charName ? 'selected' : ''}>${c ? esc(c) : '— 인물 —'}</option>`
      ).join('');
      return `<div class="sbd-item" style="${chipSt}">` +
        `<select class="sbd-item-char-sel" style="${selSt}" onchange="setItemChar(${s.number},'${field}',${i},this.value)">${charOpts}</select>` +
        `<input class="sbd-item-inp" value="${esc(text)}" onchange="updateSceneElementText(${s.number},'${field}',${i},this.value)">` +
        `<button class="sbd-item-del" onclick="removeSceneElement(${s.number},'${field}',${i})">✕</button>` +
        `</div>`;
    }).join('');

    const colHdr = (label, snum, field) =>
      `<div class="sbd-col-hdr">
        <div class="sbd-col-title">${label}</div>
        <button class="sbd-col-toggle-btn" onclick="toggleSbdAddRow('sbd-add-${snum}-${field}')" title="항목 추가">+</button>
      </div>`;

    const addRow = (snum, field) => {
      const rowId   = `sbd-add-${snum}-${field}`;
      const charOpts = allKnownChars.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      return `<div class="sbd-add-row" id="${rowId}">
        <select class="sbd-add-char-sel">
          <option value="">— 인물 —</option>${charOpts}
        </select>
        <input class="sbd-add-input" placeholder="항목 추가..."
          onkeydown="if(event.key==='Enter'){addItemFromBdRow('${rowId}',${snum},'${field}');event.preventDefault()}else if(event.key==='Escape'){toggleSbdAddRow('${rowId}')}">
        <button class="sbd-add-btn" onclick="addItemFromBdRow('${rowId}',${snum},'${field}')">✓</button>
      </div>`;
    };

    return `<div class="sbd-page" id="sbdp-${s.number}">
      <div class="sbd-hdr">
        <div class="sbd-hdr-main">
          <span class="sbd-snum">S#${esc(s.displayNum||s.number)}</span>
          ${s.ie   ? `<span class="badge ${ieBadge(s.ie)}">${esc(s.ie)}</span>` : ''}
          ${s.time ? `<span class="badge ${timeBadge(s.time)}">${_toDN(s.time)}</span>` : ''}
          <span class="sbd-loc">${esc(s.loc)}</span>
        </div>
        <div class="sbd-hdr-sub">
          ${s.schedDate
            ? `<div class="sbd-date">📅 ${s.schedDate}</div>`
            : `<div class="sbd-date" style="background:transparent;color:var(--text-dim)">미배정</div>`}
          <button class="sbd-script-toggle-btn" onclick="toggleSbdScript(${s.number},this)">📄 스크립트</button>
        </div>
      </div>
      <div class="sbd-grid">
        <div class="sbd-left">
          <div>
            <div class="sbd-sec-title">장면 내용</div>
            <textarea class="sbd-synopsis-ta" data-snum="${s.number}"
              oninput="saveSceneNote(${s.number},this.value)"
              placeholder="장면 내용을 입력하세요...">${esc(synopsis)}</textarea>
          </div>
          <div>
            <div class="sbd-sec-title">등장인물</div>
            <div class="sbd-chars">
              ${allChars.length
                ? allChars.map(c => {
                    const col = (charInfo[c]||{}).color;
                    const st  = col ? `background:${col}22;border-color:${col}88;` : '';
                    return `<span class="sbd-char-tag" style="cursor:pointer;${st}" onclick="goToChar('${esc(c)}')" title="인물설정으로 이동">${esc(c)}</span>`;
                  }).join('')
                : '<span style="color:var(--text-dim);font-size:12px">없음</span>'}
            </div>
          </div>
          <div class="sbd-3col">
            <div class="sbd-col-box">
              ${colHdr('의상', s.number, 'costumeItems')}
              <div class="sbd-items">${itemsHtml(cosItems,'costumeItems')}</div>
              ${addRow(s.number,'costumeItems')}
            </div>
            <div class="sbd-col-box">
              ${colHdr('분장', s.number, 'makeupItems')}
              <div class="sbd-items">${itemsHtml(mkItems,'makeupItems')}</div>
              ${addRow(s.number,'makeupItems')}
            </div>
            <div class="sbd-col-box">
              ${colHdr('인물 소품', s.number, 'charPropItems')}
              <div class="sbd-items">${itemsHtml(cpItems,'charPropItems')}</div>
              ${addRow(s.number,'charPropItems')}
            </div>
          </div>
          <div class="sbd-3col">
            <div class="sbd-col-box">
              ${colHdr('공간 소품', s.number, 'setPropItems')}
              <div class="sbd-items">${itemsHtml(spItems,'setPropItems')}</div>
              ${addRow(s.number,'setPropItems')}
            </div>
            <div class="sbd-col-box">
              ${colHdr('효과', s.number, 'vfxItems')}
              <div class="sbd-items">${itemsHtml(vfxItems,'vfxItems')}</div>
              ${addRow(s.number,'vfxItems')}
            </div>
            <div class="sbd-col-box">
              ${colHdr('기타', s.number, 'etcItems')}
              <div class="sbd-items">${itemsHtml(etcItems,'etcItems')}</div>
              ${addRow(s.number,'etcItems')}
            </div>
          </div>
          <div>
            <div class="sbd-sec-title">메모</div>
            <textarea class="sbd-col-ta" data-field="memo" data-snum="${s.number}"
              oninput="onBdInput(event)" placeholder="씬 메모...">${esc(extra.memo||'')}</textarea>
          </div>
        </div>
        <div class="sbd-right">
          <div class="sbd-sec-title">스크립트</div>
          <div class="sbd-script-wrap">
            <div class="sbd-script">${scriptHtml}</div>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// 씬리스트 PDF 출력
function printBreakdown() {
  const project = document.getElementById('projectName')?.value || '씬리스트';
  const _toDN = t => ({ day:'낮', night:'밤', dawn:'새벽', eve:'저녁' }[t] || t || '');
  const _toIE = ie => ({ INT:'실내', EXT:'실외', 'INT/EXT':'실내외', 'EXT/INT':'실외내' }[ie] || ie || '');
  const E = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  const Ei = items => (items||[]).map(i=>E(getItemText(i))).join(', ') || '-';

  const cs  = `border:1px solid #bbb;padding:5px 7px;font-size:10px;vertical-align:top;word-break:break-all;`;
  const hs  = `${cs}background:#1a1a2e;color:#fff;font-weight:700;font-size:9px;text-align:center;white-space:nowrap;`;

  // 현재 필터 적용
  let list = filter === 'all' ? scenes
    : scenes.filter(s => (filter==='INT'||filter==='EXT') ? s.ie===filter : s.time===filter);

  const rowsHtml = list.map(s => {
    const extra    = sceneExtras[s.number] || {};
    const synopsis = sceneNotes[s.number]  || '';
    const chars    = getAllChars(s).join(', ');
    const snumLabel = s.isInsert ? E(s.displayNum) : 'S#'+E(s.displayNum||s.number);

    return `<tr${s.isInsert?' style="background:#fff8f5"':''}>
      <td style="${cs}text-align:center;font-weight:700;color:${s.isInsert?'#c2410c':'inherit'}">${snumLabel}</td>
      <td style="${cs}text-align:center">${E(_toDN(s.time))}</td>
      <td style="${cs}text-align:center">${E(_toIE(s.ie))}</td>
      <td style="${cs}">${E(s.loc)}</td>
      <td style="${cs}">${E(synopsis)}</td>
      <td style="${cs}">${E(chars)}</td>
      <td style="${cs}">${Ei(extra.costumeItems)}</td>
      <td style="${cs}">${Ei(extra.makeupItems)}</td>
      <td style="${cs}">${Ei(extra.charPropItems)}</td>
      <td style="${cs}">${Ei(extra.setPropItems)}</td>
      <td style="${cs}">${Ei(extra.vfxItems)}</td>
      <td style="${cs}">${Ei(extra.etcItems)}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${E(project)} — 씬리스트</title>
<style>
  @page { size: A4 landscape; margin: 12mm 10mm; }
  body { font-family: 'Malgun Gothic','Apple SD Gothic Neo',sans-serif; font-size:10px; margin:0; }
  h2  { font-size:13px; margin:0 0 8px; }
  table { width:100%; border-collapse:collapse; table-layout:fixed; }
  col.c-snum  { width:5%;  } col.c-dn    { width:4%;  } col.c-ie    { width:4%;  }
  col.c-loc   { width:9%;  } col.c-syn   { width:16%; } col.c-chars { width:10%; }
  col.c-cos   { width:9%;  } col.c-mkp   { width:9%;  } col.c-cprop { width:9%;  }
  col.c-sprop { width:9%;  } col.c-vfx   { width:8%;  } col.c-etc   { width:8%;  }
  @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
<h2>${E(project)} — 씬리스트</h2>
<table>
  <colgroup>
    <col class="c-snum"><col class="c-dn"><col class="c-ie">
    <col class="c-loc"><col class="c-syn"><col class="c-chars">
    <col class="c-cos"><col class="c-mkp"><col class="c-cprop">
    <col class="c-sprop"><col class="c-vfx"><col class="c-etc">
  </colgroup>
  <thead><tr>
    ${['S#','D/N','I/E','촬영장소','장면내용','주요등장인물','의상','분장','인물소품','공간소품','효과','기타']
      .map(h=>`<th style="${hs}">${h}</th>`).join('')}
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { alert('팝업이 차단되어 있습니다. 팝업을 허용해주세요.'); return; }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 600);
}

// 장소리스트 PDF 출력
function printPropList() {
  const project = document.getElementById('projectName')?.value || '소품리스트';
  const E = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');

  // 씬브레이크다운에서 소품+씬 수집
  const autoMap = { charProp: {}, setProp: {} };
  Object.entries(sceneExtras).forEach(([snum, extra]) => {
    const sn = parseInt(snum);
    const sc = scenes.find(s => s.number === sn);
    const lbl = sc ? sc.displayNum : 'S#' + snum;
    (extra.charPropItems || []).forEach(item => {
      const n = getItemText(item); if (!n) return;
      if (!autoMap.charProp[n]) autoMap.charProp[n] = [];
      if (!autoMap.charProp[n].find(x => x.num === sn)) autoMap.charProp[n].push({ num: sn, label: lbl });
    });
    (extra.setPropItems || []).forEach(item => {
      const n = getItemText(item); if (!n) return;
      if (!autoMap.setProp[n]) autoMap.setProp[n] = [];
      if (!autoMap.setProp[n].find(x => x.num === sn)) autoMap.setProp[n].push({ num: sn, label: lbl });
    });
  });

  // propList + 자동감지 병합
  const merge = (category, autoSrc) => {
    const reg = propList.filter(p => p.category === category);
    const extra = [];
    Object.keys(autoSrc).forEach(name => {
      if (!reg.find(p => p.name === name))
        extra.push({ id: '_a', name, category, character: '', location: '', desc: '' });
    });
    return [...reg, ...extra];
  };
  const charProps = merge('charProp', autoMap.charProp);
  const setProps  = merge('setProp',  autoMap.setProp);

  if (!charProps.length && !setProps.length) { alert('소품 정보가 없습니다.'); return; }

  const cs  = `border:1px solid #bbb;padding:5px 8px;font-size:10px;vertical-align:top;word-break:break-word;`;
  const hs  = `${cs}background:#1a1a2e;color:#fff;font-weight:700;font-size:9px;text-align:center;white-space:nowrap;`;
  const shs = `padding:6px 10px;font-size:11px;font-weight:700;background:#2a2a3e;color:#fff;`;

  const makeSection = (props, category, autoSrc, sectionTitle) => {
    if (!props.length) return '';
    const assocKey = category === 'charProp' ? 'character' : 'location';
    const assocHdr = category === 'charProp' ? '인물' : '장소';
    const rows = props.map(p => {
      const scList = (autoSrc[p.name] || []).slice().sort((a,b) => a.num - b.num);
      const scTxt  = scList.map(s => s.label).join(', ') || '-';
      return `<tr>
        <td style="${cs}font-weight:600">${E(p[assocKey] || '-')}</td>
        <td style="${cs}">${E(scTxt)}</td>
        <td style="${cs}">${E(p.name)}</td>
        <td style="${cs}">${E(p.desc || '')}</td>
      </tr>`;
    }).join('');

    return `<tr><td colspan="4" style="${shs}">${sectionTitle}</td></tr>
    <tr>${[assocHdr,'씬','소품명','설명'].map(h=>`<th style="${hs}">${h}</th>`).join('')}</tr>
    ${rows}
    <tr><td colspan="4" style="height:10px;border:none"></td></tr>`;
  };

  const bodyRows =
    makeSection(charProps, 'charProp', autoMap.charProp, '👤 인물소품') +
    makeSection(setProps,  'setProp',  autoMap.setProp,  '🏠 공간소품');

  const docHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${E(project)} — 소품리스트</title>
<style>
  @page { size: A4 landscape; margin: 12mm 10mm; }
  body { font-family: 'Malgun Gothic','Apple SD Gothic Neo',sans-serif; font-size:10px; margin:0; color:#111; }
  h2   { font-size:13px; margin:0 0 10px; }
  table { width:100%; border-collapse:collapse; table-layout:fixed; }
  col.c-assoc { width:14%; } col.c-sc { width:22%; }
  col.c-name  { width:20%; } col.c-desc { width:44%; }
  @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
<h2>${E(project)} — 소품리스트</h2>
<table>
  <colgroup>
    <col class="c-assoc"><col class="c-sc"><col class="c-name"><col class="c-desc">
  </colgroup>
  <tbody>${bodyRows}</tbody>
</table>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { alert('팝업이 차단되어 있습니다. 팝업을 허용해주세요.'); return; }
  w.document.write(docHtml);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 600);
}

function printLocList() {
  const project = document.getElementById('projectName')?.value || '장소리스트';
  const E = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');

  const cs = `border:1px solid #bbb;padding:6px 8px;font-size:10px;vertical-align:top;word-break:break-all;`;
  const hs = `${cs}background:#1a1a2e;color:#fff;font-weight:700;font-size:9px;text-align:center;white-space:nowrap;`;

  const locSet = new Set();
  scenes.forEach(s => { if (s.loc) locSet.add(s.loc); });
  Object.values(sceneExtras).forEach(extra => {
    (extra.locationItems||[]).forEach(item => { const n = getItemText(item); if (n) locSet.add(n); });
  });

  const locScenes = {};
  scenes.forEach(s => {
    const locs = new Set();
    if (s.loc) locs.add(s.loc);
    (sceneExtras[s.number]?.locationItems||[]).forEach(item => { const n = getItemText(item); if (n) locs.add(n); });
    locs.forEach(loc => {
      if (!locScenes[loc]) locScenes[loc] = [];
      if (!locScenes[loc].includes(s)) locScenes[loc].push(s);
    });
  });

  if (!locSet.size) { alert('장소 정보가 없습니다.'); return; }

  // 장소 순서 반영
  const locOrdered = locationOrder.filter(l => locSet.has(l));
  locSet.forEach(l => { if (!locOrdered.includes(l)) locOrdered.push(l); });
  const DN_KO = { day:'낮', night:'밤', dawn:'새벽', eve:'저녁' };
  const IE_KO = { INT:'INT', EXT:'EXT', 'INT/EXT':'I/E', 'EXT/INT':'E/I' };
  const ns = `border:1px solid #bbb;padding:5px 7px;font-size:10px;vertical-align:top;word-break:break-word;`;

  const rowsHtml = locOrdered.map(loc => {
    const info   = locationInfo[loc] || {};
    const scList = (locScenes[loc]  || []).slice().sort((a,b) => a.number - b.number);
    const span   = Math.max(scList.length, 1);
    if (!scList.length) {
      return `<tr>
        <td style="${ns}font-weight:700" rowspan="1">${E(loc)}</td>
        <td style="${ns}text-align:center">-</td><td style="${ns}text-align:center">-</td>
        <td style="${ns}text-align:center">-</td><td style="${ns}">-</td>
        <td style="${ns}">${E(info.description||'')}</td>
        <td style="${ns}">${E(info.address||'')}</td>
      </tr>`;
    }
    return scList.map((s, i) => {
      const dn = DN_KO[s.time] || s.time || '-';
      const ie = IE_KO[s.ie]  || s.ie  || '-';
      const synopsis = sceneNotes[s.number] || '';
      const locCells = i === 0
        ? `<td style="${ns}font-weight:700;border-right:2px solid #888" rowspan="${span}">${E(loc)}</td>`
        : '';
      const sharedCells = i === 0
        ? `<td style="${ns}" rowspan="${span}">${E(info.description||'')}</td>
           <td style="${ns}" rowspan="${span}">${E(info.address||'')}</td>`
        : '';
      return `<tr>
        ${locCells}
        <td style="${ns}text-align:center;font-weight:700">S#${E(String(s.displayNum||s.number))}</td>
        <td style="${ns}text-align:center">${E(dn)}</td>
        <td style="${ns}text-align:center">${E(ie)}</td>
        <td style="${ns}">${E(synopsis)}</td>
        ${sharedCells}
      </tr>`;
    }).join('');
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${E(project)} — 장소리스트</title>
<style>
  @page { size: A4 landscape; margin: 12mm 10mm; }
  body { font-family: 'Malgun Gothic','Apple SD Gothic Neo',sans-serif; font-size:10px; margin:0; }
  h2  { font-size:13px; margin:0 0 8px; }
  table { width:100%; border-collapse:collapse; table-layout:fixed; }
  col.c-loc  { width:13%; } col.c-sc  { width:8%;  }
  col.c-dn   { width:7%;  } col.c-ie  { width:7%;  }
  col.c-cont { width:20%; } col.c-desc{ width:22%; } col.c-addr{ width:23%; }
  @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
<h2>${E(project)} — 장소리스트</h2>
<table>
  <colgroup>
    <col class="c-loc"><col class="c-sc"><col class="c-dn"><col class="c-ie">
    <col class="c-cont"><col class="c-desc"><col class="c-addr">
  </colgroup>
  <thead><tr>
    ${['장소명','씬#','D/N','I/E','장면내용','장소설명','실제 촬영지']
      .map(h=>`<th style="${hs}">${h}</th>`).join('')}
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { alert('팝업이 차단되어 있습니다. 팝업을 허용해주세요.'); return; }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 600);
}

// 씬브레이크다운 PDF 출력
function printSceneBd() {
  const project = document.getElementById('projectName')?.value || '씬브레이크다운';
  const _toDN   = t => ({day:'낮',night:'밤',dawn:'새벽',eve:'저녁'}[t]||t||'');
  const _toIE   = ie => ({INT:'실내',EXT:'실외','INT/EXT':'실내외','EXT/INT':'실외내'}[ie]||ie||'');
  const E = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');

  const colStyle = `border:1px solid #ccc;padding:5px 7px;font-size:10px;vertical-align:top;`;
  const hdrStyle = `${colStyle}background:#222;color:#fff;font-weight:700;font-size:9px;text-align:center;white-space:nowrap;`;

  const headers = ['S#','촬영날짜','D/N','I/E','촬영장소','장면내용','등장인물','의상','분장','인물소품','공간소품','효과','기타','비고'];

  const rowsHtml = scenes.map(s => {
    const extra    = sceneExtras[s.number] || {};
    const synopsis = sceneNotes[s.number]  || extra.synopsis || '';
    const allChars = getAllChars(s);

    const joinItems = (items, memo) => {
      const parts = [];
      if (items && items.length) parts.push(items.join(', '));
      if (memo) parts.push(`<em style="color:#555">${E(memo)}</em>`);
      return parts.join('<br>');
    };

    return `<tr>
      <td style="${colStyle}text-align:center;font-weight:700;">${E(s.displayNum||s.number)}</td>
      <td style="${colStyle}text-align:center;">${E(s.schedDate||'미배정')}</td>
      <td style="${colStyle}text-align:center;">${E(_toDN(s.time))}</td>
      <td style="${colStyle}text-align:center;">${E(_toIE(s.ie))}</td>
      <td style="${colStyle}">${E(s.loc)}</td>
      <td style="${colStyle}">${E(synopsis)}</td>
      <td style="${colStyle}">${E(allChars.join(', '))}</td>
      <td style="${colStyle}">${joinItems(extra.costumeItems, extra.costume)}</td>
      <td style="${colStyle}">${joinItems(extra.makeupItems,  extra.makeup)}</td>
      <td style="${colStyle}">${joinItems(extra.charPropItems, extra.charProps)}</td>
      <td style="${colStyle}">${joinItems(extra.setPropItems, extra.setProps)}</td>
      <td style="${colStyle}">${joinItems(extra.vfxItems, extra.vfx)}</td>
      <td style="${colStyle}">${joinItems(extra.etcItems, extra.etc)}</td>
      <td style="${colStyle}">${E(extra.memo)}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>${E(project)} — 씬브레이크다운</title>
<style>
  @page { size: A4 landscape; margin: 12mm 10mm; }
  body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; font-size: 10px; margin: 0; }
  h2 { font-size: 13px; margin: 0 0 8px 0; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  td, th { word-break: break-all; }
  col.c-snum   { width: 4%; }
  col.c-date   { width: 6%; }
  col.c-dn     { width: 3%; }
  col.c-ie     { width: 3%; }
  col.c-loc    { width: 8%; }
  col.c-syn    { width: 12%; }
  col.c-chars  { width: 7%; }
  col.c-cos    { width: 7%; }
  col.c-mk     { width: 7%; }
  col.c-cp     { width: 7%; }
  col.c-sp     { width: 7%; }
  col.c-vfx    { width: 7%; }
  col.c-etc    { width: 7%; }
  col.c-memo   { width: 6%; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head><body>
<h2>${E(project)} — 씬 브레이크다운</h2>
<table>
  <colgroup>
    <col class="c-snum"><col class="c-date"><col class="c-dn"><col class="c-ie">
    <col class="c-loc"><col class="c-syn"><col class="c-chars">
    <col class="c-cos"><col class="c-mk"><col class="c-cp"><col class="c-sp">
    <col class="c-vfx"><col class="c-etc"><col class="c-memo">
  </colgroup>
  <thead><tr>${headers.map(h=>`<th style="${hdrStyle}">${E(h)}</th>`).join('')}</tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { alert('팝업이 차단되어 있습니다. 팝업을 허용해주세요.'); return; }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { w.print(); }, 600);
}

function saveSceneNote(sceneNum, text) {
  sceneNotes[sceneNum] = text;
  // 일촬표 해당 씬 행의 synopsis 동기화
  const scene = scenes.find(s => s.number === sceneNum);
  if (scene) {
    callSheets.forEach(cs => {
      const row = cs.rows.find(r => r.sNum === scene.displayNum);
      if (row) row.synopsis = text;
    });
    if (document.getElementById('tab-callsheet')?.classList.contains('on')) renderCS();
  }
  save();
}

// textarea 내용에 맞게 높이 자동 조절
function bdAutoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// 씬 브레이크다운 표 입력 핸들러
function onBdInput(e) {
  const ta    = e.target;
  const field = ta.dataset.field;
  const snumRaw = ta.dataset.snum;
  const snum  = isNaN(+snumRaw) ? snumRaw : +snumRaw;
  const val   = ta.value;

  // 장면내용은 기존 saveSceneNote 경로 (일촬표 synopsis와 양방향 동기화)
  if (field === 'synopsis') { saveSceneNote(snum, val); return; }

  // 나머지 필드는 sceneExtras에 저장
  if (!sceneExtras[snum]) sceneExtras[snum] = {};
  sceneExtras[snum][field] = val;

  // 인물소품 → 일촬표 props, 비고 → 일촬표 note 단방향 동기화
  const scene = scenes.find(s => s.number === snum);
  if (scene) {
    callSheets.forEach(cs => {
      const row = cs.rows.find(r => r.sNum === scene.displayNum);
      if (!row) return;
      if (field === 'charProps') row.props = val;
      if (field === 'memo')      row.note  = val;
    });
    if (document.getElementById('tab-callsheet')?.classList.contains('on')) renderCS();
  }
  save();
}

// 인서트 씬 D/N · I/E 수동 변경 저장
function onBdInsertSelect(sel) {
  const snumRaw = sel.dataset.snum;
  const snum    = isNaN(+snumRaw) ? snumRaw : +snumRaw;
  const field   = sel.dataset.field;
  if (!sceneExtras[snum]) sceneExtras[snum] = {};
  sceneExtras[snum][field] = sel.value;
  // 씬 객체에도 즉시 반영
  const s = scenes.find(sc => String(sc.number) === String(snum));
  if (s) s[field] = sel.value;
  save();
}

function renderStats() {
  const n = scenes.length;
  const intN = scenes.filter(s=>s.ie==='INT').length;
  const extN = scenes.filter(s=>s.ie==='EXT').length;
  const dayN = scenes.filter(s=>s.time==='day').length;
  const nitN = scenes.filter(s=>s.time==='night').length;
  const allCharSet = new Set(scenes.flatMap(s=>getAllChars(s)));
  document.getElementById('statsBar').innerHTML = `
    <div class="stat"><div class="stat-v">${n}</div><div class="stat-l">전체 씬</div></div>
    <div class="stat"><div class="stat-v" style="color:#60a5fa">${intN}</div><div class="stat-l">실내</div></div>
    <div class="stat"><div class="stat-v" style="color:#34d399">${extN}</div><div class="stat-l">실외</div></div>
    <div class="stat"><div class="stat-v" style="color:#fbbf24">${dayN}</div><div class="stat-l">주간</div></div>
    <div class="stat"><div class="stat-v" style="color:#a5b4fc">${nitN}</div><div class="stat-l">야간</div></div>
    <div class="stat"><div class="stat-v" style="color:#f472b6">${allCharSet.size}</div><div class="stat-l">등장인물</div></div>`;
}

function setFilter(f, btn) {
  filter = f;
  document.querySelectorAll('.f-btn').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  renderBreakdown();
}

// ══════════════════════════════════════════════════
// 인물설정
// ══════════════════════════════════════════════════

// 모든 인물 목록 (스크립트 + 수동 추가 포함)
function allSceneChars() {
  return [...new Set([...scenes.flatMap(s => getAllChars(s)), ...globalChars])];
}

// charOrder 기반 정렬 — 새 인물은 자동으로 끝에 추가, hiddenChars 제외
function getOrderedChars() {
  const all = allSceneChars().filter(n => !hiddenChars.includes(n));
  all.forEach(n => { if (!charOrder.includes(n)) charOrder.push(n); });
  return charOrder.filter(n => all.includes(n));
}

// 인물 목록 드래그 핸들러
function charDragStart(e, name) {
  charDragName = name;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.style.opacity = '.45';
}
function charDragEnd(e) { e.currentTarget.style.opacity = ''; }
function charDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
function charDrop(e, targetName) {
  e.preventDefault();
  if (!charDragName || charDragName === targetName) { charDragName = null; return; }
  const fromIdx = charOrder.indexOf(charDragName);
  const toIdx   = charOrder.indexOf(targetName);
  if (fromIdx === -1 || toIdx === -1) { charDragName = null; return; }
  charOrder.splice(fromIdx, 1);
  charOrder.splice(toIdx, 0, charDragName);
  charDragName = null;
  save();
  renderCharTab();
}

function renderCharTab() {
  const all   = getOrderedChars();
  const strip = document.getElementById('charCardStrip');

  if (!all.length) {
    strip.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:100%;padding:20px 0;color:var(--text-dim)"><div style="font-size:28px">👤</div><div style="font-size:12px">스크립트를 먼저 입력하세요</div></div>`;
    document.getElementById('charsDetailPanel').innerHTML =
      `<div class="empty"><div class="empty-icon">👤</div><div>스크립트를 먼저 입력하세요</div></div>`;
    return;
  }

  // 성별 기본 이모지 (커스텀 이모지 없을 때)
  const genderEmoji = (g, custom) => custom || ({ '남': '🧑', '여': '👩', 'X': '🧑' }[g] || '👤');

  strip.innerHTML = all.map(name => {
    const info       = charInfo[name] || {};
    const sub        = [info.gender, info.age].filter(Boolean).join(' · ');
    const colorBar   = info.color
      ? `<div class="char-card-color-bar" style="background:${info.color}"></div>` : '';
    const isOn       = name === selectedChar ? ' on' : '';
    return `<div class="char-card${isOn}"
      data-char="${esc(name)}"
      draggable="true"
      onclick="selectChar(this.dataset.char)"
      ondragstart="charDragStart(event,this.dataset.char)"
      ondragend="charDragEnd(event)"
      ondragover="charDragOver(event)"
      ondrop="charDrop(event,this.dataset.char)">
      ${colorBar}
      <div class="char-card-emoji" title="이모지 변경"
        onclick="event.stopPropagation();openCharEmojiPicker('${esc(name)}',this)"
      >${genderEmoji(info.gender, info.emoji)}</div>
      <div class="char-card-name">${esc(name)}</div>
      ${sub ? `<div class="char-card-sub">${esc(sub)}</div>` : ''}
    </div>`;
  }).join('');

  if (selectedChar && all.includes(selectedChar)) renderCharDetail(selectedChar);
  else { selectedChar = all[0]; renderCharDetail(all[0]); }
}

function selectChar(name) {
  selectedChar = name;
  renderCharTab();
  renderCharDetail(name);
}

function renderCharDetail(name) {
  const info       = charInfo[name] || {};
  const charScenes = scenes.filter(s => getAllChars(s).includes(name));
  const note       = charNotes[name] || '';
  const setting    = info.setting || '';
  const t          = _charDetailTab;

  const scenesHtml = charScenes.length
    ? charScenes.map(s => {
        const num   = s.displayNum || s.number;
        const loc   = s.loc || '';
        const ie    = s.ie  || '';
        const time  = TIME_LABEL[s.time] || s.time || '';
        const parts = [loc, ie, time].filter(Boolean).join(' · ');
        return `<div class="char-scene-chip">
          <span class="char-scene-chip-num">S#${num}</span>
          ${parts ? `<span class="char-scene-chip-loc">${esc(parts)}</span>` : ''}
        </div>`;
      }).join('')
    : `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">등장 씬 없음</div>`;

  document.getElementById('charsDetailPanel').innerHTML = `
    <div class="char-detail-inner">

      <!-- 이름 + 삭제 -->
      <div style="display:flex;align-items:center;gap:8px">
        <div class="char-detail-name" style="margin-bottom:0;flex:1">${esc(name)}</div>
        <button onclick="deleteChar('${esc(name)}')" style="padding:3px 10px;border-radius:5px;border:1px solid #f87171;background:rgba(248,113,113,.1);color:#f87171;font-size:11px;cursor:pointer;font-family:inherit;white-space:nowrap">삭제</button>
      </div>

      <!-- 성별 / 나이 / 인물 색상 -->
      <div class="char-meta-row">
        <div class="char-meta-field">
          <div class="char-meta-label">성별</div>
          <div class="gender-btns">
            <button class="gender-btn ${info.gender==='남'?'on':''}" onclick="setCharGender('${esc(name)}','남')">남</button>
            <button class="gender-btn ${info.gender==='여'?'on':''}" onclick="setCharGender('${esc(name)}','여')">여</button>
            <button class="gender-btn ${info.gender==='X'?'on':''}"  onclick="setCharGender('${esc(name)}','X')">X</button>
          </div>
        </div>
        <div class="char-meta-field">
          <div class="char-meta-label">나이 ${info._autoAge?'<span style="font-size:10px;color:var(--accent)">(자동감지)</span>':''}</div>
          <input class="char-age-input" type="text"
            value="${esc(info.age||'')}"
            placeholder="예: 30대, 25세"
            oninput="setCharAge('${esc(name)}',this.value)">
        </div>
        <div class="char-meta-field">
          <div class="char-meta-label">인물 색상</div>
          <div class="char-color-wrap">
            <div class="char-color-swatch ${info.color?'':'no-color'}"
              style="${info.color?'background:'+info.color:''}"
              title="색상 선택"
              onclick="document.getElementById('colorPk-${esc(name)}').click()"></div>
            <input type="color" id="colorPk-${esc(name)}"
              value="${info.color||'#7c8cf8'}"
              style="position:absolute;opacity:0;pointer-events:none;width:0;height:0"
              oninput="previewCharColor('${esc(name)}',this.value)"
              onchange="setCharColor('${esc(name)}',this.value)">
            ${info.color ? `<button class="char-color-reset" onclick="clearCharColor('${esc(name)}')">초기화</button>` : ''}
          </div>
        </div>
      </div>

      <!-- 탭 바 -->
      <div class="char-detail-tabs">
        <button class="char-tab-btn${t==='setting'?' on':''}" onclick="switchCharDetailTab('setting')">캐릭터 설정</button>
        <button class="char-tab-btn${t==='scenes'?' on':''}" onclick="switchCharDetailTab('scenes')">등장씬 <span class="char-tab-count">${charScenes.length}</span></button>
        <button class="char-tab-btn${t==='memo'?' on':''}"    onclick="switchCharDetailTab('memo')">메모</button>
      </div>

      <!-- 캐릭터 설정 패널 -->
      <div class="char-tab-panel${t==='setting'?' on':''}" data-tab="setting">
        <textarea class="char-memo" id="charSettingArea"
          placeholder="외모, 성격, 배경, 감정선 등 자유롭게 입력하세요..."
          oninput="saveCharSetting('${esc(name)}')"
        >${esc(setting)}</textarea>
      </div>

      <!-- 등장씬 패널 -->
      <div class="char-tab-panel${t==='scenes'?' on':''}" data-tab="scenes">
        <div class="char-scene-chips">
          ${scenesHtml}
        </div>
      </div>

      <!-- 메모 패널 -->
      <div class="char-tab-panel${t==='memo'?' on':''}" data-tab="memo">
        <textarea class="char-memo" id="charMemoArea"
          placeholder="메모..."
          oninput="saveCharNote('${esc(name)}')"
        >${esc(note)}</textarea>
      </div>

    </div>`;
}

function setCharGender(name, gender) {
  pushUndo();
  if (!charInfo[name]) charInfo[name] = {};
  charInfo[name].gender = gender;
  charInfo[name]._manualGender = true;
  save(); renderCharTab(); renderCharDetail(name);
}
// 인물 이름 변경 — 데이터만 이전, 렌더 없음 (onEditorInput 자동 감지 전용)
function renameCharSilent(oldName, newName) {
  if (!newName || newName === oldName) return;
  if (!charInfo[newName]) charInfo[newName] = {};
  const old = charInfo[oldName] || {};
  ['gender','age','actor','phone','color','emoji','_manualGender','_manualAge','_autoAge'].forEach(k => {
    if (old[k] !== undefined && charInfo[newName][k] === undefined)
      charInfo[newName][k] = old[k];
  });
  delete charInfo[oldName];
  if (charNotes[oldName]) {
    charNotes[newName] = charNotes[newName] || charNotes[oldName];
    delete charNotes[oldName];
  }
  const gi = globalChars.indexOf(oldName);
  if (gi !== -1) globalChars[gi] = newName;
  const co = charOrder.indexOf(oldName);
  if (co !== -1) charOrder[co] = newName;
  const hi = hiddenChars.indexOf(oldName);
  if (hi !== -1) hiddenChars[hi] = newName;
  for (const snum of Object.keys(manualCharsByScene))
    manualCharsByScene[snum] = (manualCharsByScene[snum]||[]).map(n => n===oldName?newName:n);
  const ITEM_FIELDS = ['costumeItems','makeupItems','charPropItems','setPropItems','vfxItems','etcItems'];
  for (const snum of Object.keys(sceneExtras)) {
    const extra = sceneExtras[snum];
    for (const f of ITEM_FIELDS) {
      if (!extra[f]) continue;
      extra[f] = extra[f].map(item =>
        getItemChar(item) === oldName ? {text: getItemText(item), char: newName} : item
      );
    }
  }
  if (selectedChar === oldName) selectedChar = newName;
}

// 인물 이름 변경 프롬프트
function promptRenameChar(oldName) {
  const newName = prompt(`"${oldName}"의 새 이름을 입력하세요.\n(색상·설정·요소 배정이 모두 새 이름으로 이전됩니다)`, oldName);
  if (!newName) return;
  renameChar(oldName, newName.trim());
}

// 인물 이름 변경 — 색상·설정·요소 배정 모두 이전
function renameChar(oldName, newName) {
  if (!newName || newName === oldName) return;

  // charInfo 이전 (newName이 이미 있으면 색상 등 병합)
  if (!charInfo[newName]) charInfo[newName] = {};
  const old = charInfo[oldName] || {};
  // 기존 데이터가 없는 필드만 이전
  ['gender','age','actor','phone','color','emoji','_manualGender','_manualAge','_autoAge'].forEach(k => {
    if (old[k] !== undefined && charInfo[newName][k] === undefined) charInfo[newName][k] = old[k];
  });
  delete charInfo[oldName];

  // charNotes 이전
  if (charNotes[oldName]) { charNotes[newName] = charNotes[newName] || charNotes[oldName]; delete charNotes[oldName]; }

  // globalChars 이전
  const gi = globalChars.indexOf(oldName);
  if (gi !== -1) globalChars[gi] = newName;

  // manualCharsByScene 이전
  for (const snum of Object.keys(manualCharsByScene)) {
    manualCharsByScene[snum] = (manualCharsByScene[snum] || []).map(n => n === oldName ? newName : n);
  }

  // sceneExtras 아이템 char 이전
  const ITEM_FIELDS = ['costumeItems','makeupItems','charPropItems','setPropItems','vfxItems','etcItems'];
  for (const snum of Object.keys(sceneExtras)) {
    const extra = sceneExtras[snum];
    for (const f of ITEM_FIELDS) {
      if (!extra[f]) continue;
      extra[f] = extra[f].map(item => {
        if (getItemChar(item) === oldName) return {text: getItemText(item), char: newName};
        return item;
      });
    }
  }

  selectedChar = newName;
  save();
  renderCharTab();
  renderCharDetail(newName);
  if (document.getElementById('tab-scenebd')?.classList.contains('on'))   renderSceneBd();
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
}

// 색상 피커 드래그 중 실시간 미리보기 (save/undo 없이 DOM만 업데이트)
// renderCharDetail()을 호출하면 피커가 재생성되어 닫히므로 DOM을 직접 수정합니다.
function previewCharColor(name, color) {
  if (!charInfo[name]) charInfo[name] = {};
  charInfo[name].color = color;
  // 디테일 패널의 색상 스와치 직접 업데이트
  const swatch = document.querySelector('#charsDetailPanel .char-color-swatch');
  if (swatch) { swatch.style.background = color; swatch.classList.remove('no-color'); }
  // 인물 목록의 컬러 dot 직접 업데이트
  const listItem = document.querySelector(`.char-list-item[data-char="${CSS.escape(name)}"]`);
  if (listItem) {
    let dot = listItem.querySelector('.char-color-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'char-color-dot';
      const nameEl = listItem.querySelector('.char-list-name');
      if (nameEl) nameEl.prepend(dot);
    }
    dot.style.background = color;
  }
  // 사이드바·씬브레이크다운·브레이크다운 탭 갱신
  renderSidebar();
  if (document.getElementById('tab-scenebd')?.classList.contains('on'))   renderSceneBd();
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
}

function setCharColor(name, color) {
  pushUndo();
  if (!charInfo[name]) charInfo[name] = {};
  charInfo[name].color = color;
  save(); renderCharTab(); renderCharDetail(name); renderSidebar();
  if (document.getElementById('tab-scenebd')?.classList.contains('on'))   renderSceneBd();
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
}
function clearCharColor(name) {
  pushUndo();
  if (charInfo[name]) delete charInfo[name].color;
  save(); renderCharTab(); renderCharDetail(name); renderSidebar();
  if (document.getElementById('tab-scenebd')?.classList.contains('on'))   renderSceneBd();
  if (document.getElementById('tab-breakdown')?.classList.contains('on')) renderBreakdown();
}
function setCharAge(name, age) {
  if (!charInfo[name]) charInfo[name] = {};
  charInfo[name].age = age;
  charInfo[name]._manualAge = true;
  delete charInfo[name]._autoAge;
  save();
  // 목록 sub 업데이트
  const el = document.querySelector(`.char-list-item[data-char="${CSS.escape(name)}"] .char-list-sub`);
  if (el) { const info = charInfo[name]||{}; const sub=[info.gender,info.age].filter(Boolean).join(', '); el.textContent = `${sub?sub+' · ':''}${scenes.filter(s=>getAllChars(s).includes(name)).length}개 씬`; }
}
function saveCharNote(name) {
  const el = document.getElementById('charMemoArea');
  if (el) { charNotes[name] = el.value; save(); }
}
function setCharActor(name, val) {
  if (!charInfo[name]) charInfo[name] = {};
  charInfo[name].actor = val;
  syncCharActorToCallsheets(name);
  save();
}
function setCharPhone(name, val) {
  if (!charInfo[name]) charInfo[name] = {};
  charInfo[name].phone = val;
  save();
}
// 인물의 배우 이름이 설정되면 해당 인물이 등장하는 모든 일촬표 actorRows에 반영
function syncCharActorToCallsheets(charName) {
  const actorName = (charInfo[charName] || {}).actor || '';
  callSheets.forEach(cs => {
    // 이 일촬표에 해당 인물이 등장하는 씬이 있는지 확인
    const appears = cs.rows.some(row => {
      const scene = scenes.find(s => s.displayNum === row.sNum);
      return scene && getAllChars(scene).includes(charName);
    });
    if (!appears) return;
    // 이미 해당 배역으로 등록된 행 찾기
    let row = cs.actorRows.find(r => r.role === charName);
    if (!row) {
      // 빈 행 찾기
      row = cs.actorRows.find(r => !r.role && !r.actor);
    }
    if (!row) {
      // 빈 행 없으면 새 행 추가
      row = { role: '', actor: '', arrival: '', place: '', manager: '' };
      cs.actorRows.push(row);
    }
    row.role  = charName;
    row.actor = actorName;
  });
  if (document.getElementById('tab-callsheet')?.classList.contains('on')) renderCS();
}

// ── 인물 이모지 변경 ─────────────────────────────
// { label, emojis[] } 형식으로 카테고리 구분
const CHAR_EMOJI_GROUPS = [
  {
    label: '연령대',
    emojis: [
      '👶','🧒','👧','👦','🧑','👩','👨',
      '🧑‍🦱','👩‍🦱','👨‍🦱','👱','👱‍♀️','👱‍♂️',
      '🧑‍🦰','👩‍🦰','👨‍🦰','🧑‍🦳','👩‍🦳','👨‍🦳','🧑‍🦲',
      '🧓','👴','👵','🤰','👩‍🍼',
    ],
  },
  {
    label: '직업·역할',
    emojis: [
      '👮','👮‍♀️','🕵️','🕵️‍♀️','💂','💂‍♀️',
      '🧑‍⚕️','👩‍⚕️','👨‍⚕️','🧑‍🏫','👩‍🏫','🧑‍🍳','👩‍🍳',
      '🧑‍🎨','👩‍🎤','🧑‍💼','👩‍💼','🧑‍🔬','👩‍🔬',
      '🧑‍🚀','👩‍🚒','🧑‍🌾','🧑‍🏭','👷','👷‍♀️',
    ],
  },
  {
    label: '특수·판타지',
    emojis: [
      '🥷','🤺','🧙','🧙‍♀️','🧛','🧛‍♀️','🧟','🧟‍♀️',
      '🧜','🧜‍♀️','🧝','🧝‍♀️','🤴','👸','🤵','👰',
      '🦸','🦸‍♀️','🦹','🦹‍♀️','🎅','🤶','🧞','🧞‍♀️',
    ],
  },
  {
    label: '표정·감정',
    emojis: [
      '😀','😎','🥸','🤠','🤓','🧐','😈','👿','🤡','💀','👻','🎭',
    ],
  },
  {
    label: '동물 — 포유류',
    emojis: [
      '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯',
      '🦁','🐮','🐷','🐸','🐵','🙈','🦝','🐺','🦌','🦄',
      '🐗','🦍','🦧','🐘','🦏','🦛','🦒','🦓','🐪','🦬',
    ],
  },
  {
    label: '동물 — 조류',
    emojis: [
      '🐔','🐧','🦅','🦆','🦉','🦜','🐦','🦢','🦩','🕊️','🦚','🦃',
    ],
  },
  {
    label: '동물 — 해양·파충류·기타',
    emojis: [
      '🐬','🐳','🦈','🐙','🦭','🐠','🦀','🦑','🐢','🦎',
      '🐍','🦕','🐲','🐉','🦋','🐝','🐛','🦗','🦟','🕷️',
    ],
  },
];
// 하위 호환용 flat 배열 (외부에서 참조 가능)
const CHAR_EMOJIS = CHAR_EMOJI_GROUPS.flatMap(g => g.emojis);

function openCharEmojiPicker(name, anchorEl) {
  // 기존 피커 닫기
  document.getElementById('charEmojiPicker')?.remove();

  const picker = document.createElement('div');
  picker.id = 'charEmojiPicker';
  picker.className = 'char-emoji-picker';

  // 카테고리별 렌더링
  picker.innerHTML = CHAR_EMOJI_GROUPS.map(group =>
    `<div class="char-emoji-section-label">${esc(group.label)}</div>` +
    group.emojis.map(e =>
      `<span class="char-emoji-opt" onclick="setCharEmoji('${esc(name)}','${e}')">${e}</span>`
    ).join('')
  ).join('') +
  `<div class="char-emoji-reset" onclick="setCharEmoji('${esc(name)}','')">기본값으로</div>`;

  // 위치: 앵커 아래쪽, 화면 밖으로 나가지 않도록 보정
  const rect = anchorEl.getBoundingClientRect();
  picker.style.cssText = `position:fixed;top:${rect.bottom+6}px;left:${rect.left}px;visibility:hidden`;
  document.body.appendChild(picker);

  // 화면 경계 보정 (렌더 후 크기 계산)
  const pw = picker.offsetWidth, ph = picker.offsetHeight;
  let top  = rect.bottom + 6, left = rect.left;
  if (left + pw > window.innerWidth - 8)  left  = Math.max(8, window.innerWidth - pw - 8);
  if (top  + ph > window.innerHeight - 8) top   = Math.max(8, rect.top - ph - 6);
  picker.style.cssText = `position:fixed;top:${top}px;left:${left}px`;

  // 바깥 클릭 시 닫기
  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); }
    });
  }, 0);
}

function setCharEmoji(name, emoji) {
  if (!charInfo[name]) charInfo[name] = {};
  charInfo[name].emoji = emoji || undefined;
  if (!emoji) delete charInfo[name].emoji;
  document.getElementById('charEmojiPicker')?.remove();
  save(); renderCharTab();
}

// ── 등장씬 접기/펼치기 ───────────────────────────
function switchCharDetailTab(tab) {
  _charDetailTab = tab;
  document.querySelectorAll('.char-tab-btn').forEach((btn, i) => {
    const tabs = ['setting', 'scenes', 'memo'];
    btn.classList.toggle('on', tabs[i] === tab);
  });
  document.querySelectorAll('.char-tab-panel').forEach(panel => {
    panel.classList.toggle('on', panel.dataset.tab === tab);
  });
}

function saveCharSetting(name) {
  const el = document.getElementById('charSettingArea');
  if (!el) return;
  if (!charInfo[name]) charInfo[name] = {};
  charInfo[name].setting = el.value;
  save();
}

function toggleCharScenes() {
  _charScenesOpen = !_charScenesOpen;
  const list    = document.getElementById('charSceneList');
  const chevron = document.querySelector('.char-scenes-chevron');
  if (list)    list.style.display = _charScenesOpen ? 'block' : 'none';
  if (chevron) chevron.textContent = _charScenesOpen ? '▲' : '▼';
}

function deleteChar(name) {
  const inScript = scenes.flatMap(s => getAllChars(s)).includes(name);
  if (inScript) {
    if (!confirm(`'${name}'은(는) 스크립트에 있는 인물입니다.\n그래도 지울까요?`)) return;
    if (!hiddenChars.includes(name)) hiddenChars.push(name); // 스크립트 재감지 방지
  } else {
    if (!confirm(`'${name}'을(를) 인물 목록에서 삭제하시겠습니까?`)) return;
  }
  charOrder   = charOrder.filter(n => n !== name);
  globalChars = globalChars.filter(n => n !== name);
  Object.keys(manualCharsByScene).forEach(k => {
    manualCharsByScene[k] = manualCharsByScene[k].filter(n => n !== name);
  });
  delete charInfo[name];
  delete charNotes[name];
  if (selectedChar === name) selectedChar = null;
  save();
  renderCharTab();
  renderSidebar();
  if (document.getElementById('tab-breakdown').classList.contains('on')) renderBreakdown();
  document.getElementById('charsDetailPanel').innerHTML = '';
}

// 브레이크다운에서 인물 클릭 → 인물설정 이동
function goToChar(name) {
  switchTab('chars', document.querySelectorAll('.nav-btn')[2]);
  selectedChar = name;
  renderCharTab();
}

// ══════════════════════════════════════════════════
// 촬영 스케줄
// ══════════════════════════════════════════════════
function renderSchedule() { renderCalendar(); renderUnsched(); }

function setMonTitle() {
  const y=calMonth.getFullYear(), m=calMonth.getMonth()+1;
  document.getElementById('monTitle').textContent=`${y}년 ${m}월`;
}
function moveMon(d) { calMonth.setMonth(calMonth.getMonth()+d); setMonTitle(); renderCalendar(); }

function renderCalendar() {
  const y=calMonth.getFullYear(), m=calMonth.getMonth();
  const first=new Date(y,m,1), last=new Date(y,m+1,0);
  const dow=first.getDay();
  const today=new Date().toISOString().slice(0,10);
  const days=['일','월','화','수','목','금','토'];

  let html='<div class="cal-grid">';
  days.forEach(d=>html+=`<div class="cal-day-head">${d}</div>`);

  for(let i=0;i<dow;i++) html+=`<div class="cal-cell empty-cell"></div>`;

  for(let d=1;d<=last.getDate();d++){
    const ds=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isT=ds===today;
    const dayScenes=(sched[ds]||[]).map(n=>scenes.find(s=>String(s.number)===String(n))).filter(Boolean);
    html+=`<div class="cal-cell${isT?' today-cell':''}" data-date="${ds}"
      ondragover="calDragOver(event,'${ds}')"
      ondragleave="calDragLeave(event)"
      ondrop="calDrop(event,'${ds}')">
      <div class="cal-date-row">
        <span class="cal-date${isT?' today-dot':''}">${d}</span>
        <input class="cal-cs-input${schedDays[ds]?' has-val':''}" type="text" placeholder="회차"
               value="${schedDays[ds] ? schedDays[ds]+'회차' : ''}"
               onfocus="this.value=this.value.replace('회차','')"
               onblur="calCsInputBlur(event,'${ds}')"
               onclick="event.stopPropagation()"
               title="이 날짜의 촬영 회차 번호">
      </div>
      ${dayScenes.map(s=>chipHTML(s,ds)).join('')}
    </div>`;
  }

  const total=dow+last.getDate();
  const rem=total%7;
  if(rem!==0) for(let i=0;i<7-rem;i++) html+=`<div class="cal-cell empty-cell"></div>`;
  html+='</div>';
  document.getElementById('calGrid').innerHTML=html;
}

// 씬 번호를 HTML onclick 속성에 안전하게 삽입하는 헬퍼
// 숫자 → 그대로, 문자열("1_ins1") → 작은따옴표 감쌈 (큰따옴표 속성 충돌 방지)
function _snAttr(num) {
  return typeof num === 'number' ? num : `'${num}'`;
}

function chipHTML(s, dateStr) {
  const sel = selectedNums.has(s.number) ? ' selected' : '';
  const sn  = _snAttr(s.number);
  const label = s.isInsert
    ? `INS · ${esc(s.loc)}`
    : `S#${esc(s.displayNum || s.number)}`;
  return `<div class="chip${sel}${s.isInsert?' chip-insert':''}" data-num="${s.number}" data-date="${dateStr}"
    draggable="true"
    onclick="chipClick(event,${sn})"
    ondragstart="chipDragStart(event,${sn},'${dateStr}')"
    style="flex-wrap:wrap;gap:2px">
    <span style="font-weight:700">${label}</span>
    <span class="badge ${ieBadge(s.ie)}" style="font-size:9px;padding:1px 4px">${s.ie}</span>
    ${!s.isInsert ? `<span style="color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(s.loc)}</span>` : ''}
    ${s.time?`<span class="badge ${timeBadge(s.time)}" style="font-size:9px;padding:1px 4px">${TIME_LABEL[s.time]||''}</span>`:''}
    <span class="chip-x" onclick="event.stopPropagation();removeFromSched(${sn},'${dateStr}')">✕</span>
  </div>`;
}

function renderUnsched() {
  const scheduled=new Set(Object.values(sched).flat());
  const list=scenes.filter(s=>!scheduled.has(s.number));
  const el=document.getElementById('unschedScroll');
  if(!list.length){
    el.innerHTML=`<div class="empty" style="height:70px"><div>✅</div><div>모두 배치됨</div></div>`;
    return;
  }
  el.innerHTML=list.map(s=>{
    const sn    = _snAttr(s.number);
    const label = s.isInsert
      ? `INS · ${esc(s.loc)}`
      : `S#${esc(s.displayNum || s.number)}`;
    return `
    <div class="chip${selectedNums.has(s.number)?' selected':''}${s.isInsert?' chip-insert':''}" data-num="${s.number}"
      draggable="true"
      onclick="chipClick(event,${sn})"
      ondragstart="chipDragStart(event,${sn},null)"
      style="margin-bottom:5px;flex-wrap:wrap;gap:2px">
      <span style="font-weight:700">${label}</span>
      <span class="badge ${ieBadge(s.ie)}" style="font-size:9px;padding:1px 4px">${s.ie}</span>
      ${!s.isInsert?`<span style="color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(s.loc)}</span>`:''}
      ${s.time?`<span class="badge ${timeBadge(s.time)}" style="font-size:9px;padding:1px 4px">${TIME_LABEL[s.time]||''}</span>`:''}
    </div>`;
  }).join('');
}

function chipClick(e, num) {
  if(e.ctrlKey||e.metaKey){ if(selectedNums.has(num)) selectedNums.delete(num); else selectedNums.add(num); }
  else { selectedNums.clear(); selectedNums.add(num); }
  renderCalendar(); renderUnsched();
}

function chipDragStart(e, num, fromDate) {
  if(!selectedNums.has(num)){ selectedNums.clear(); selectedNums.add(num); }
  dragging={nums:[...selectedNums], fromDate};
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain', num);
}

function calDragOver(e, dateStr) {
  e.preventDefault(); lastDragY=e.clientY;
  e.currentTarget.classList.add('drag-over');
  showDropLine(e.currentTarget, e.clientY);
}
function calDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
  e.currentTarget.querySelectorAll('.drop-line').forEach(el=>el.remove());
}
function calDrop(e, dateStr) {
  e.preventDefault();
  const cell=e.currentTarget;
  cell.classList.remove('drag-over');
  cell.querySelectorAll('.drop-line').forEach(el=>el.remove());
  if(!dragging) return;

  const {nums, fromDate}=dragging;
  const insertIdx=getInsertIndex(cell, e.clientY, dateStr, nums);

  // 기존 날짜에서 씬 제거 → 해당 회차 일촬표에서도 제거
  if (fromDate && fromDate !== dateStr) {
    const oldCsNum = schedDays[fromDate];
    if (oldCsNum) {
      const oldCS = callSheets.find(c => c.csNum === oldCsNum);
      if (oldCS) {
        nums.forEach(n => {
          const s = scenes.find(x => String(x.number) === String(n));
          if (s) oldCS.rows = oldCS.rows.filter(r => r.sNum !== s.displayNum);
        });
      }
    }
  }

  const numsStr = new Set(nums.map(String));
  for(const [d,arr] of Object.entries(sched)) sched[d]=arr.filter(n=>!numsStr.has(String(n)));
  if(!sched[dateStr]) sched[dateStr]=[];
  sched[dateStr].splice(insertIdx,0,...nums);
  nums.forEach(n=>{ const s=scenes.find(x=>String(x.number)===String(n)); if(s) s.schedDate=dateStr; });

  // 드롭된 날짜의 회차 일촬표에 씬 자동 추가
  const newCsNum = schedDays[dateStr];
  if (newCsNum) {
    const newCS = callSheets.find(c => c.csNum === newCsNum);
    if (newCS) {
      nums.forEach(n => {
        const s = scenes.find(x => String(x.number) === String(n));
        if (!s) return;
        if (!newCS.rows.some(r => r.sNum === s.displayNum)) {
          newCS.rows.push({
            sNum: s.displayNum, place: s.loc, shootLoc: '',
            dn: toDN(s.time), sol: ({INT:'I',EXT:'E','INT/EXT':'I/E','EXT/INT':'E/I'}[s.ie]||''), shots: '', setupTime: '',
            synopsis: sceneNotes[s.number] || '', cast: s.chars.join(', '), props: '', note: '',
          });
        }
      });
    }
  }

  dragging=null; selectedNums.clear();
  save(); renderCalendar(); renderUnsched();
}

function getInsertIndex(cell, y, dateStr, excludeNums) {
  // dataset.num은 숫자("1") 또는 인서트씬 문자열("1_ins1") 모두 가능 — String 비교로 통일
  const exSet = new Set(excludeNums.map(String));
  const chips = [...cell.querySelectorAll('.chip')].filter(c => !exSet.has(c.dataset.num));
  for (let i = 0; i < chips.length; i++) {
    const rect = chips[i].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      const chipNum = chips[i].dataset.num; // 문자열 그대로 사용
      const arr = sched[dateStr] || [];
      const idx = arr.findIndex(n => String(n) === chipNum);
      return idx >= 0 ? idx : i;
    }
  }
  return (sched[dateStr] || []).filter(n => !exSet.has(String(n))).length;
}

function showDropLine(cell, y) {
  cell.querySelectorAll('.drop-line').forEach(el=>el.remove());
  const chips=[...cell.querySelectorAll('.chip')];
  const line=document.createElement('div');
  line.className='drop-line';
  let inserted=false;
  for(const chip of chips){
    const rect=chip.getBoundingClientRect();
    if(y<rect.top+rect.height/2){ cell.insertBefore(line,chip); inserted=true; break; }
  }
  if(!inserted) cell.appendChild(line);
}

function dragOverUnsched(e) { e.preventDefault(); document.getElementById('unschedScroll').classList.add('drag-over'); }
function dragLeaveUnsched(e) { document.getElementById('unschedScroll').classList.remove('drag-over'); }
function dropToUnsched(e) {
  e.preventDefault();
  document.getElementById('unschedScroll').classList.remove('drag-over');
  if(!dragging) return;
  const {nums, fromDate}=dragging;
  // fromDate 회차 일촬표에서도 제거
  if (fromDate) {
    const csNum = schedDays[fromDate];
    if (csNum) {
      const cs = callSheets.find(c => c.csNum === csNum);
      if (cs) {
        nums.forEach(n => {
          const s = scenes.find(x => x.number === n);
          if (s) cs.rows = cs.rows.filter(r => r.sNum !== s.displayNum);
        });
      }
    }
  }
  const numsStr2 = new Set(nums.map(String));
  for(const [d,arr] of Object.entries(sched)) sched[d]=arr.filter(n=>!numsStr2.has(String(n)));
  nums.forEach(n=>{ const s=scenes.find(x=>String(x.number)===String(n)); if(s) s.schedDate=null; });
  dragging=null; selectedNums.clear();
  save(); renderCalendar(); renderUnsched();
}

function calCsInputBlur(e, ds) {
  const v = e.target.value.trim().replace('회차', '');
  const num = parseInt(v);
  const oldNum = schedDays[ds];
  if (v && !isNaN(num) && num >= 1) {
    // 중복 회차 체크 — 다른 날짜에 이미 같은 회차가 있으면 취소
    const dupEntry = Object.entries(schedDays).find(([d, n]) => n === num && d !== ds);
    if (dupEntry) {
      alert(`${num}회차는 이미 있습니다.`);
      if (oldNum) {
        e.target.value = oldNum + '회차';
        e.target.classList.add('has-val');
      } else {
        e.target.value = '';
        e.target.classList.remove('has-val');
      }
      return;
    }
    // 회차 번호가 바뀌었으면 기존 회차 정리
    if (oldNum && oldNum !== num) removeSchedDayCS(ds, oldNum);
    setSchedDay(ds, String(num));
    e.target.value = num + '회차';
    e.target.classList.add('has-val');
  } else {
    setSchedDay(ds, '');
    e.target.value = '';
    e.target.classList.remove('has-val');
  }
}

// 날짜에서 회차를 제거할 때: 해당 CS 삭제 + 씬 미배치
function removeSchedDayCS(date, csNum) {
  // 씬 미배치
  const scenesOnDate = (sched[date] || []);
  scenesOnDate.forEach(n => {
    const s = scenes.find(x => x.number === n);
    if (s) s.schedDate = null;
  });
  delete sched[date];
  // callSheet 삭제
  const csIdx = callSheets.findIndex(c => c.csNum === csNum);
  if (csIdx >= 0) {
    callSheets.splice(csIdx, 1);
    currentCSIdx = Math.max(0, Math.min(currentCSIdx, callSheets.length - 1));
  }
}

// 날짜에 이미 배치된 씬을 CS에 동기화
function syncScenesToCS(csNum, date) {
  const cs = callSheets.find(c => c.csNum === csNum);
  if (!cs) return;
  (sched[date] || []).forEach(n => {
    const s = scenes.find(x => x.number === n);
    if (!s) return;
    if (!cs.rows.some(r => r.sNum === s.displayNum)) {
      cs.rows.push({
        sNum: s.displayNum, place: s.loc, shootLoc: '',
        dn: toDN(s.time), sol: ({INT:'I',EXT:'E','INT/EXT':'I/E','EXT/INT':'E/I'}[s.ie]||''), shots: '', setupTime: '',
        synopsis: sceneNotes[s.number] || '', cast: s.chars.join(', '), props: '', note: '',
      });
    }
  });
}

function setSchedDay(date, numStr) {
  const num = parseInt(numStr);
  if (!numStr || isNaN(num) || num < 1) {
    const oldNum = schedDays[date];
    if (oldNum) removeSchedDayCS(date, oldNum);
    delete schedDays[date];
  } else {
    schedDays[date] = num;
    ensureCallSheet(num, date);
    // 이미 배치된 씬이 있으면 CS에도 추가
    syncScenesToCS(num, date);
    // 일촬표 탭이 열려 있으면 즉시 갱신
    if (document.getElementById('tab-callsheet').classList.contains('on')) {
      renderCSSelect(); renderCS();
    }
  }
  save(); renderCalendar(); renderUnsched();
}

function ensureCallSheet(csNum, date) {
  let cs = callSheets.find(c => c.csNum === csNum);
  function applyDate(cs, date) {
    const d  = new Date(date + 'T00:00:00');
    const wd = ['일','월','화','수','목','금','토'];
    cs.date     = date;
    cs.year     = String(d.getFullYear());
    cs.month    = String(d.getMonth() + 1);
    cs.day      = String(d.getDate());
    cs.weekday  = wd[d.getDay()];
    cs.monthday = `${d.getMonth()+1}.${d.getDate()}`;
  }
  if (!cs) {
    cs = defaultCS(csNum);
    applyDate(cs, date);
    callSheets.push(cs);
    callSheets.sort((a,b) => a.csNum - b.csNum);
  } else if (!cs.date) {
    applyDate(cs, date);
  }
  currentCSIdx = callSheets.findIndex(c => c.csNum === csNum);
}

function removeFromSched(num, dateStr) {
  if(sched[dateStr]) sched[dateStr]=sched[dateStr].filter(n=>String(n)!==String(num));
  const s=scenes.find(x=>String(x.number)===String(num));
  if(s) {
    // 해당 날짜 회차 일촬표에서도 제거
    const csNum = schedDays[dateStr];
    if (csNum) {
      const cs = callSheets.find(c => c.csNum === csNum);
      if (cs) cs.rows = cs.rows.filter(r => r.sNum !== s.displayNum);
    }
    s.schedDate=null;
  }
  selectedNums.delete(num);
  save(); renderCalendar(); renderUnsched();
}

// ══════════════════════════════════════════════════
// 일촬표 (Call Sheet)
// ══════════════════════════════════════════════════
let callSheets    = [];
let currentCSIdx  = 0;

function csGet() { return callSheets[currentCSIdx] || null; }

function toDN(t) { return { day:'D', night:'N', dawn:'D', eve:'N' }[t] || 'D'; }

function defaultCS(num) {
  return {
    csNum: num, date: '', weekday: '', year: '', month: '', day: '',
    sunrise: '', sunset: '', weather: '', temp: '', rainProb: '',
    callTime: '', callPlace: '', adPhone: projectAdPhone||'', pdPhone: projectPdPhone||'',
    remark: '',
    rows: [],
    dirNote: '', artNote: '', propsNote: '',
    ttRows: [
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
      { time: '', event: '' },
    ],
    actorRows: [
      { role: '', actor: '', arrival: '', place: '', manager: '' },
      { role: '', actor: '', arrival: '', place: '', manager: '' },
      { role: '', actor: '', arrival: '', place: '', manager: '' },
      { role: '', actor: '', arrival: '', place: '', manager: '' },
      { role: '', actor: '', arrival: '', place: '', manager: '' },
      { role: '', actor: '', arrival: '', place: '', manager: '' },
    ],
    partRows: [
      { dept: '연출부', role: '', phone: '' },
      { dept: '연출부', role: '', phone: '' },
      { dept: '연출부', role: '', phone: '' },
      { dept: '제작부', role: '', phone: '' },
      { dept: '제작부', role: '', phone: '' },
      { dept: '제작부', role: '', phone: '' },
      { dept: '제작부', role: '', phone: '' },
    ],
    lightNote: '', costumeNote: '', makeupNote: '',
    labels: {},   // 섹션 헤더 커스텀 텍스트
  };
}

function addCS() {
  callSheets.push(defaultCS(callSheets.length + 1));
  currentCSIdx = callSheets.length - 1;
  renderCSSelect(); renderCS(); save();
}

function switchCS(idx) {
  currentCSIdx = idx;
  renderCSSelect();
  renderCS();
}

function deleteCS() {
  if (!callSheets.length) return;
  const cs = csGet();
  if (!confirm(`${cs.csNum}회차 일촬표를 삭제하시겠습니까?`)) return;
  // 이 회차의 날짜를 schedDays에서도 제거 + 씬 미배치
  if (cs.date) {
    const d = cs.date;
    if (schedDays[d] === cs.csNum) {
      delete schedDays[d];
      (sched[d] || []).forEach(n => { const s=scenes.find(x=>x.number===n); if(s) s.schedDate=null; });
      delete sched[d];
    }
  }
  callSheets.splice(currentCSIdx, 1);
  currentCSIdx = Math.max(0, currentCSIdx - 1);
  renderCSSelect(); renderCS(); renderCalendar(); renderUnsched(); save();
}

function renderCSSelect() {
  // 툴바 네비게이션 업데이트
  const nav = document.getElementById('csNavLabel');
  if (nav) {
    if (!callSheets.length) {
      nav.textContent = '회차 없음';
    } else {
      const cs = csGet();
      nav.textContent = `${cs.csNum}회차 (${currentCSIdx+1}/${callSheets.length})`;
    }
  }
}

function prevCS() {
  if (!callSheets.length) return;
  currentCSIdx = (currentCSIdx - 1 + callSheets.length) % callSheets.length;
  renderCSSelect(); renderCS();
}
function nextCS() {
  if (!callSheets.length) return;
  currentCSIdx = (currentCSIdx + 1) % callSheets.length;
  renderCSSelect(); renderCS();
}
function jumpToCSNum(num) {
  if (!num || isNaN(num)) return;
  const idx = callSheets.findIndex(c => c.csNum === num);
  if (idx < 0) { alert(`${num}회차가 없습니다.`); return; }
  currentCSIdx = idx;
  document.getElementById('csJumpInput').value = '';
  renderCSSelect(); renderCS();
}

function openCsPicker() {
  if (!callSheets.length) { alert('먼저 "+ 새 회차"를 눌러 회차를 만들어주세요.'); return; }
  const list = document.getElementById('csPickerList');
  if (!scenes.length) {
    list.innerHTML = '<div style="color:var(--text-dim);padding:12px;text-align:center">스크립트에 씬이 없습니다.</div>';
  } else {
    const existing = new Set(csGet().rows.map(r => r.sNum));
    list.innerHTML = scenes.map(s => {
      const added = existing.has(s.displayNum);
      return `<div class="cs-picker-row">
        <input type="checkbox" id="csp_${s.displayNum}" value="${s.displayNum}"
               ${added ? 'disabled checked' : ''}>
        <label for="csp_${s.displayNum}">
          <b>S#${esc(s.displayNum)}</b> &nbsp;
          <span>${esc(s.loc)}</span> &nbsp;
          <span style="color:var(--text-dim)">[${s.ie}][${toDN(s.time)}]</span>
          ${added ? '<span style="color:var(--text-dim);font-size:10px"> — 이미 추가됨</span>' : ''}
        </label>
      </div>`;
    }).join('');
  }
  document.getElementById('csPicker').style.display = 'flex';
}

function closeCsPicker() { document.getElementById('csPicker').style.display = 'none'; }

function applyCSPicker() {
  const checked = [...document.querySelectorAll('#csPickerList input[type=checkbox]:checked:not(:disabled)')];
  const cs = csGet();
  checked.forEach(cb => {
    const s = scenes.find(x => x.displayNum === cb.value);
    if (!s) return;
    cs.rows.push({
      sNum: s.displayNum, place: s.loc, shootLoc: '',
      dn: toDN(s.time), sol: ({INT:'I',EXT:'E','INT/EXT':'I/E','EXT/INT':'E/I'}[s.ie]||''), shots: '', setupTime: '',
      synopsis: sceneNotes[s.number] || '', cast: s.chars.join(', '), props: '', note: '',
    });
  });
  closeCsPicker(); renderCS(); save();
}

function addCSRowManual() {
  if (!callSheets.length) { alert('먼저 "+ 새 회차"를 눌러 회차를 만들어주세요.'); return; }
  csGet().rows.push({ sNum: '', place: '', shootLoc: '', dn: '', sol: '',
    shots: '', setupTime: '', synopsis: '', cast: '', props: '', note: '' });
  renderCS(); save();
}

function deleteCSRow(ri) {
  const cs = csGet();
  if (!cs || ri >= cs.rows.length) return;
  const row = cs.rows[ri];
  // 촬영 스케줄에서도 제거
  if (row.sNum) {
    const s = scenes.find(x => x.displayNum === row.sNum);
    if (s && cs.date) {
      if (sched[cs.date]) sched[cs.date] = sched[cs.date].filter(n => n !== s.number);
      s.schedDate = null;
    }
  }
  cs.rows.splice(ri, 1);
  renderCS(); renderCalendar(); renderUnsched(); save();
}
function addTTRow()       { csGet().ttRows.push({time:'',event:''}); renderCS(); }
function deleteTTRow(ri)  { if (ri < csGet().ttRows.length) { csGet().ttRows.splice(ri,1); renderCS(); save(); } }
function addActorRow()    { csGet().actorRows.push({role:'',arrival:'',place:'',done:'',manager:''}); renderCS(); }
function deleteActorRow(ri){ csGet().actorRows.splice(ri,1); renderCS(); save(); }

// contenteditable 입력 → 상태 반영
function onCSInput(e) {
  const el = e.target.closest('[data-cs]');
  if (!el) return;
  const cs = csGet();
  if (!cs) return;
  const key  = el.dataset.cs;
  const val  = el.textContent;
  const parts = key.split('.');
  if (parts.length === 1) {
    cs[parts[0]] = val;
  } else if (parts.length === 2 && parts[0] === 'labels') {
    // 헤더 커스텀 라벨 → 전역 csLabels에 저장 (모든 회차 공유)
    csLabels[parts[1]] = val;
  } else if (parts.length === 3) {
    const arr = cs[parts[0]];
    const idx = +parts[1];
    // 패딩된 빈 행에 입력 시 실제 데이터로 확장
    while (arr.length <= idx) {
      if (parts[0] === 'rows')       arr.push({ sNum:'', place:'', shootLoc:'', dn:'', sol:'', shots:'', setupTime:'', synopsis:'', cast:'', props:'', note:'' });
      else if (parts[0] === 'ttRows')  arr.push({ time:'', event:'' });
      else if (parts[0] === 'actorRows') arr.push({ role:'', actor:'', arrival:'', place:'', manager:'' });
      else if (parts[0] === 'partRows')  arr.push({ dept:'', role:'', phone:'' });
      else arr.push({});
    }
    // synopsis 변경 → 씬브레이크다운 장면내용 역방향 동기화
    if (parts[0]==='rows' && parts[2]==='synopsis') {
      const row = cs.rows[idx] || arr[idx];
      if (row && row.sNum) {
        const scene = scenes.find(s => s.displayNum === row.sNum);
        if (scene) {
          sceneNotes[scene.number] = val;
          const ta = document.querySelector(`.bd-ta[data-field="synopsis"][data-snum="${scene.number}"]`);
          if (ta && ta.value !== val) ta.value = val;
        }
      }
    }
    // props 변경 → 씬브레이크다운 인물소품 역방향 동기화
    if (parts[0]==='rows' && parts[2]==='props') {
      const row = cs.rows[idx] || arr[idx];
      if (row && row.sNum) {
        const scene = scenes.find(s => s.displayNum === row.sNum);
        if (scene) {
          if (!sceneExtras[scene.number]) sceneExtras[scene.number] = {};
          sceneExtras[scene.number].charProps = val;
          const ta = document.querySelector(`.bd-ta[data-field="charProps"][data-snum="${scene.number}"]`);
          if (ta && ta.value !== val) ta.value = val;
        }
      }
    }
    // note 변경 → 씬브레이크다운 비고 역방향 동기화
    if (parts[0]==='rows' && parts[2]==='note') {
      const row = cs.rows[idx] || arr[idx];
      if (row && row.sNum) {
        const scene = scenes.find(s => s.displayNum === row.sNum);
        if (scene) {
          if (!sceneExtras[scene.number]) sceneExtras[scene.number] = {};
          sceneExtras[scene.number].memo = val;
          const ta = document.querySelector(`.bd-ta[data-field="memo"][data-snum="${scene.number}"]`);
          if (ta && ta.value !== val) ta.value = val;
        }
      }
    }
    // E/I 셀 자동 정규화: INT→I, EXT→E
    if (parts[0]==='rows' && parts[2]==='sol') {
      const _solMap = {INT:'I',int:'I',EXT:'E',ext:'E','INT/EXT':'I/E','int/ext':'I/E','EXT/INT':'E/I'};
      const _norm = _solMap[val] ?? val;
      arr[idx][parts[2]] = _norm;
      if (_norm !== val) el.textContent = _norm;
    } else {
      arr[idx][parts[2]] = val;
    }
  }
  save();
}

function renderCS() {
  const body = document.getElementById('csBody');
  if (!body) return;
  if (!callSheets.length) {
    body.innerHTML = `<div class="cs-empty-msg">촬영 스케쥴과 자동으로 연동됩니다.<br><span style="font-size:12px;color:#aaa">(제작 중...)</span></div>`;
    return;
  }
  const cs = csGet();

  // 배열 패딩
  const rows = [...cs.rows];
  while (rows.length < 8) rows.push({sNum:'',place:'',shootLoc:'',dn:'',sol:'',shots:'',synopsis:'',cast:'',props:'',note:''});
  const tt = [...(cs.ttRows||[])];
  while (tt.length < 21) tt.push({time:'',event:''});
  const actors = [...(cs.actorRows||[])];
  while (actors.length < 9) actors.push({actor:'',role:'',arrival:''});
  const parts = [...(cs.partRows||[])];
  while (parts.length < 7) parts.push({role:'',phone:''});

  // 헬퍼
  const C = (key,val='',ph='',cls='') => `<div class="cs-xcell${cls?' '+cls:''}" contenteditable="true" data-cs="${key}" data-ph="${ph}">${esc(val)}</div>`;
  const solDisp = s => ({'INT':'I','int':'I','EXT':'E','ext':'E','INT/EXT':'I/E','int/ext':'I/E','EXT/INT':'E/I'}[s] ?? s);
  const TH  = (txt,attr='') => `<td class="xth" ${attr}>${txt}</td>`;
  // THL: 수동 수정 가능한 헤더 셀 (전역 csLabels에 저장 → 모든 회차 공유)
  const THL = (key,def,attr='') => {
    const val = csLabels[key] || def;
    return `<td class="xth xth-editable" ${attr}><div class="cs-xcell" contenteditable="true" data-cs="labels.${key}" data-ph="${def}">${esc(val)}</div></td>`;
  };
  const TD = (key,val='',attr='') => `<td class="xtd" ${attr}>${C(key,val)}</td>`;

  // 씬 행
  let sceneHtml = '';
  for (let i=0; i<rows.length; i++) {
    const r=rows[i];
    sceneHtml += `<tr style="height:20px">
      <td class="xm"></td>
      <td class="xtd" colspan="3" style="text-align:center">${C('rows.'+i+'.sNum',r.sNum,'','tc')}</td>
      <td class="xtd" colspan="6">${C('rows.'+i+'.place',r.place)}</td>
      <td class="xtd" colspan="3">${C('rows.'+i+'.shootLoc',r.shootLoc)}</td>
      <td class="xtd" style="text-align:center">${C('rows.'+i+'.dn',r.dn,'','tc')}</td>
      <td class="xtd" style="text-align:center">${C('rows.'+i+'.sol',solDisp(r.sol),'','tc')}</td>
      <td class="xtd">${C('rows.'+i+'.shots',r.shots)}</td>
      <td class="xtd" colspan="16">${C('rows.'+i+'.synopsis',r.synopsis)}</td>
      <td class="xtd" colspan="6">${C('rows.'+i+'.cast',r.cast)}</td>
      <td class="xtd" colspan="6">${C('rows.'+i+'.props',r.props)}</td>
      <td class="xtd" colspan="3">${C('rows.'+i+'.note',r.note)}</td>
    </tr>`;
  }

  // 섹션1 행 (rows 17-26): dirNote/artNote/propsNote rowspan=10, TT[0-9], 배우헤더+데이터
  let sec1 = `<tr style="height:20px">
    <td class="xm"></td>
    <td class="xtd" colspan="9" rowspan="10" style="vertical-align:top">${C('dirNote',cs.dirNote||'')}</td>
    <td class="xtd" colspan="6" rowspan="10" style="vertical-align:top">${C('artNote',cs.artNote||'')}</td>
    <td class="xtd" colspan="10" rowspan="10" style="vertical-align:top">${C('propsNote',cs.propsNote||'')}</td>
    <td class="xtd" colspan="3">${C('ttRows.0.time',tt[0].time,'07:00')}</td>
    <td class="xtd" colspan="9">${C('ttRows.0.event',tt[0].event,'집합 및 촬영 준비')}</td>
    ${THL('role','배역','colspan="3"')}${THL('actor','배우','colspan="3"')}${THL('time','시간','colspan="3"')}
  </tr>`;
  for (let i=1; i<=9; i++) {
    const a=actors[i-1]||{actor:'',role:'',arrival:''};
    const _tph = i===1 ? '09:00' : '';
    const _eph = i===1 ? '촬영 시작' : '';
    sec1 += `<tr style="height:20px">
      <td class="xm"></td>
      <td class="xtd" colspan="3">${C('ttRows.'+i+'.time',tt[i].time,_tph)}</td>
      <td class="xtd" colspan="9">${C('ttRows.'+i+'.event',tt[i].event,_eph)}</td>
      <td class="xtd" colspan="3">${C('actorRows.'+(i-1)+'.role',a.role)}</td>
      <td class="xtd" colspan="3">${C('actorRows.'+(i-1)+'.actor',a.actor)}</td>
      <td class="xtd" colspan="3">${C('actorRows.'+(i-1)+'.arrival',a.arrival)}</td>
    </tr>`;
  }

  // 섹션2 행 (rows 28-37): lightNote/costumeNote/makeupNote rowspan=10, TT[11-20], 연락처
  let sec2 = `<tr style="height:20px">
    <td class="xm"></td>
    <td class="xtd" colspan="9" rowspan="10" style="vertical-align:top">${C('lightNote',cs.lightNote||'')}</td>
    <td class="xtd" colspan="6" rowspan="10" style="vertical-align:top">${C('costumeNote',cs.costumeNote||'')}</td>
    <td class="xtd" colspan="10" rowspan="10" style="vertical-align:top">${C('makeupNote',cs.makeupNote||'')}</td>
    <td class="xtd" colspan="3">${C('ttRows.11.time',tt[11].time)}</td>
    <td class="xtd" colspan="9">${C('ttRows.11.event',tt[11].event)}</td>
    ${THL('dirept','연출부','colspan="2" rowspan="3"')}
    <td class="xtd" colspan="4">${C('partRows.0.role',parts[0].role,'인물 담당')}</td>
    <td class="xtd" colspan="3">${C('partRows.0.phone',parts[0].phone)}</td>
  </tr>
  <tr style="height:20px">
    <td class="xm"></td>
    <td class="xtd" colspan="3">${C('ttRows.12.time',tt[12].time)}</td>
    <td class="xtd" colspan="9">${C('ttRows.12.event',tt[12].event)}</td>
    <td class="xtd" colspan="4">${C('partRows.1.role',parts[1].role,'미술 담당')}</td>
    <td class="xtd" colspan="3">${C('partRows.1.phone',parts[1].phone)}</td>
  </tr>
  <tr style="height:20px">
    <td class="xm"></td>
    <td class="xtd" colspan="3">${C('ttRows.13.time',tt[13].time)}</td>
    <td class="xtd" colspan="9">${C('ttRows.13.event',tt[13].event)}</td>
    <td class="xtd" colspan="4">${C('partRows.2.role',parts[2].role)}</td>
    <td class="xtd" colspan="3">${C('partRows.2.phone',parts[2].phone)}</td>
  </tr>
  <tr style="height:20px">
    <td class="xm"></td>
    <td class="xtd" colspan="3">${C('ttRows.14.time',tt[14].time)}</td>
    <td class="xtd" colspan="9">${C('ttRows.14.event',tt[14].event)}</td>
    ${THL('prodept','제작부','colspan="2" rowspan="4"')}
    <td class="xtd" colspan="4">${C('partRows.3.role',parts[3].role,'식사 담당')}</td>
    <td class="xtd" colspan="3">${C('partRows.3.phone',parts[3].phone)}</td>
  </tr>`;
  for (let i=4; i<=6; i++) {
    const ti=11+i;
    const _rph = i===4 ? '숙소 담당' : '';
    sec2 += `<tr style="height:20px">
      <td class="xm"></td>
      <td class="xtd" colspan="3">${C('ttRows.'+ti+'.time',tt[ti].time)}</td>
      <td class="xtd" colspan="9">${C('ttRows.'+ti+'.event',tt[ti].event)}</td>
      <td class="xtd" colspan="4">${C('partRows.'+i+'.role',parts[i]?.role||'',_rph)}</td>
      <td class="xtd" colspan="3">${C('partRows.'+i+'.phone',parts[i]?.phone||'')}</td>
    </tr>`;
  }
  sec2 += `<tr style="height:20px">
    <td class="xm"></td>
    <td class="xtd" colspan="3">${C('ttRows.18.time',tt[18].time)}</td>
    <td class="xtd" colspan="9">${C('ttRows.18.event',tt[18].event)}</td>
    ${THL('remark_lbl','비고','colspan="2" rowspan="3"')}
    <td class="xtd" colspan="7" rowspan="3" style="vertical-align:top">${C('remark',cs.remark||'')}</td>
  </tr>
  <tr style="height:20px">
    <td class="xm"></td>
    <td class="xtd" colspan="3">${C('ttRows.19.time',tt[19].time)}</td>
    <td class="xtd" colspan="9">${C('ttRows.19.event',tt[19].event)}</td>
  </tr>
  <tr style="height:24px">
    <td class="xm"></td>
    <td class="xtd" colspan="3">${C('ttRows.20.time',tt[20].time)}</td>
    <td class="xtd" colspan="9">${C('ttRows.20.event',tt[20].event)}</td>
  </tr>`;

  body.innerHTML = `<div class="cs-sheet" id="csSheet"><table>
  <colgroup>
    <!-- A(margin) | B-D(연도 34×3=102) | E(월 66≈2×34) | F(일 100) | G-H(요일 34×2) | I-J(일출/일몰) -->
    <!-- '1회차 중'(B-E)=168 = '1회차'(F-H)=168 -->
    <col style="width:25px"><col style="width:34px"><col style="width:34px"><col style="width:34px">
    <col style="width:66px"><col style="width:100px"><col style="width:34px"><col style="width:34px">
    <col style="width:22px"><col style="width:23px">
    <!-- K-M(촬영지/세트/내외) | N(D/N) | O(E/I) | P(컷수) — 미술 381px -->
    <col style="width:70px"><col style="width:45px"><col style="width:100px">
    <col style="width:50px"><col style="width:50px"><col style="width:66px">
    <!-- Q-Y(집합시간 27×9=243px) | Z(집합장소 start 138px) — 소품 381px -->
    <col style="width:27px"><col style="width:27px"><col style="width:27px"><col style="width:27px">
    <col style="width:27px"><col style="width:27px"><col style="width:27px"><col style="width:27px">
    <col style="width:27px"><col style="width:138px">
    <!-- AA-AL (TIME TABLE 12cols, 437px) -->
    <col style="width:25px"><col style="width:27px"><col style="width:36px"><col style="width:27px">
    <col style="width:64px"><col style="width:64px"><col style="width:32px"><col style="width:30px">
    <col style="width:36px"><col style="width:32px"><col style="width:30px"><col style="width:34px">
    <!-- AM-AU (연기자/연락처 9cols, 507px) -->
    <col style="width:25px"><col style="width:64px"><col style="width:64px"><col style="width:64px">
    <col style="width:64px"><col style="width:22px"><col style="width:64px"><col style="width:64px">
    <col style="width:76px">
  </colgroup>
  <tbody>
  <tr style="height:20px"><td class="xm"></td><td colspan="46"></td></tr>
  <tr style="height:26px">
    <td class="xm" rowspan="2"></td>
    <td class="xth" colspan="4" rowspan="2" style="font-size:16pt;font-weight:900">${callSheets.length}회차 중</td>
    <td class="xth" colspan="3" rowspan="2" style="font-size:16pt;font-weight:900">${cs.csNum}회차</td>
    ${TH('날씨','colspan="2" rowspan="2"')}
    <td class="xtd" colspan="3" rowspan="2">${C('weather',cs.weather||'','맑음')}</td>
    ${TH('온도','rowspan="2"')}
    <td class="xtd" colspan="2" rowspan="2">${C('temp',cs.temp||'','0도')}</td>
    ${TH('집 합 시 간  및  장 소','colspan="22" rowspan="2" style="font-size:16pt;font-weight:900"')}
    ${TH('조감독 연락처','colspan="4" rowspan="2"')}
    <td class="xtd" colspan="5" rowspan="2">${C('adPhone',cs.adPhone||'',projectAdPhone||'000-0000-0000')}</td>
  </tr>
  <tr style="height:20px"></tr>
  <tr style="height:20px">
    <td class="xm"></td>
    ${TH('연  도','colspan="3"')}${TH('월')}${TH('일')}${TH('요일','colspan="2"')}
    ${TH('일출','colspan="2"')}
    <td class="xtd" colspan="3">${C('sunrise',cs.sunrise||'','06:00')}</td>
    ${TH('비올 확률','colspan="3"')}
    ${TH('집합 시간','colspan="9"')}
    ${TH('집합 장소','colspan="13"')}
    ${TH('PD 연락처','colspan="4" rowspan="2"')}
    <td class="xtd" colspan="5" rowspan="2">${C('pdPhone',cs.pdPhone||'',projectPdPhone||'000-0000-0000')}</td>
  </tr>
  <tr style="height:25px">
    <td class="xm"></td>
    <td class="xtd" colspan="3">${C('year',cs.year||'','2026')}</td>
    <td class="xtd">${C('month',cs.month||'','1')}</td>
    <td class="xtd">${C('day',cs.day||'','1')}</td>
    <td class="xtd" colspan="2">${C('weekday',cs.weekday||'','월')}</td>
    ${TH('일몰','colspan="2"')}
    <td class="xtd" colspan="3">${C('sunset',cs.sunset||'','19:00')}</td>
    <td class="xtd" colspan="3">${C('rainProb',cs.rainProb||'','0%')}</td>
    <td class="xtd" colspan="9">${C('callTime',cs.callTime||'','07:00')}</td>
    <td class="xtd" colspan="13">${C('callPlace',cs.callPlace||'','서울시 서대문구 ㅇㅇ동')}</td>
  </tr>
  <tr style="height:20px">
    <td class="xm" rowspan="2"></td>
    ${TH('S#','colspan="3" rowspan="2"')}${TH('장       소','colspan="6" rowspan="2"')}
    ${TH('촬 영 지','colspan="3" rowspan="2"')}${TH('D/N','rowspan="2"')}${TH('E/I','rowspan="2"')}${TH('컷수','rowspan="2"')}
    ${TH('장       면       내       용','colspan="16" rowspan="2"')}
    ${TH('등장인물','colspan="6" rowspan="2"')}${TH('소품','colspan="6" rowspan="2"')}${TH('비고','colspan="3" rowspan="2"')}
  </tr>
  <tr style="height:20px"></tr>
  ${sceneHtml}
  <tr style="height:20px">
    <td class="xm"></td>
    ${THL('dept1','연 출 / 제 작 부','colspan="9"')}${THL('art1','미술/공간소품','colspan="6"')}${THL('props1','인물소품','colspan="10"')}
    ${THL('timetable','TIME TABLE','colspan="12"')}${THL('actors','연 기 자','colspan="9"')}
  </tr>
  ${sec1}
  <tr style="height:20px">
    <td class="xm"></td>
    ${THL('dept2','촬영 / 조명','colspan="9"')}${THL('art2','의    상','colspan="6"')}${THL('makeup','분  장 / 헤  어','colspan="10"')}
    <td class="xtd" colspan="3">${C('ttRows.10.time',tt[10].time)}</td>
    <td class="xtd" colspan="9">${C('ttRows.10.event',tt[10].event)}</td>
    ${THL('contacts','파트별 연락처','colspan="9"')}
  </tr>
  ${sec2}
  <tr style="height:20px"><td class="xm"></td><td colspan="46"></td></tr>
  </tbody></table></div>`;

  document.getElementById('csSheet').addEventListener('input', onCSInput);
  requestAnimationFrame(scaleCSSheet);
}

// 일촬표 — zoom으로 축소 (레이아웃 공간도 함께 줄어들어 잘림 없음)
const CS_NATURAL_W = 2112;
function scaleCSSheet() {
  const sheet = document.getElementById('csSheet');
  if (!sheet) return;
  // 모바일에서는 zoom 없이 스크롤로 탐색
  if (window.innerWidth <= 1024) {
    sheet.style.zoom = 1;
    return;
  }
  const scroll = sheet.closest('.cs-scroll');
  if (!scroll) return;
  const padH = 32; // .cs-scroll padding 16px × 2
  const availW = scroll.clientWidth - padH;
  sheet.style.zoom = Math.min(1, availW / CS_NATURAL_W);
}
window.addEventListener('resize', () => {
  if (document.getElementById('tab-callsheet')?.classList.contains('on')) scaleCSSheet();
  updatePageBreaks(); // 창 크기 변경 시 페이지 구분선 재계산
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (document.getElementById('tab-callsheet')?.classList.contains('on')) scaleCSSheet();
    updatePageBreaks();
  }, 350); // 회전 완료 후 재계산
});

function printCS() {
  document.body.classList.add('print-callsheet');
  window.print();
  document.body.classList.remove('print-callsheet');
}

// ══════════════════════════════════════════════════
// 예시 시나리오 삽입
// ══════════════════════════════════════════════════
function insertExample() {
  if ([...ed().querySelectorAll('p')].some(p => p.textContent.trim())) {
    if (!confirm('현재 내용이 예시로 교체됩니다. 계속할까요?')) return;
  }
  const lines = [
    { type: 'heading',  text: 'S#1. INT. 카페 - 낮' },
    { type: 'action',   text: '좁고 아늑한 카페. 창가 자리에 준호(남, 30대)가 노트북을 펼쳐놓고 있다.' },
    { type: 'action',   text: '' },
    { type: 'char',     text: '준호' },
    { type: 'dialogue', text: '(혼잣말로) 시나리오는 다 썼는데, 촬영계획은 언제 짜지...' },
    { type: 'action',   text: '' },
    { type: 'action',   text: '그때 문이 열리며 수연(여, 30대)이 들어온다.' },
    { type: 'action',   text: '' },
    { type: 'char',     text: '수연' },
    { type: 'dialogue', text: '촬영계획 다 짰어?' },
    { type: 'action',   text: '' },
    { type: 'char',     text: '준호' },
    { type: 'dialogue', text: '아니. 아직.' },
    { type: 'action',   text: '' },
    { type: 'action',   text: '수연이 자리에 앉는다. 둘 사이에 잠시 어색한 침묵이 흐른다.' },
    { type: 'action',   text: '' },
    { type: 'heading',  text: 'S#2. EXT. 골목길 - 밤' },
    { type: 'action',   text: '두 사람이 골목길을 걷고 있다.' },
    { type: 'action',   text: '' },
    { type: 'char',     text: '수연' },
    { type: 'dialogue', text: '진정해. Don\'t panic.' },
    { type: 'action',   text: '' },
    { type: 'action',   text: '준호의 표정이 밝아진다.' },
    { type: 'action',   text: '' },
    { type: 'char',     text: '준호' },
    { type: 'dialogue', text: '그래. 우리에겐 Don\'t panic pre가 있었지!' },
  ];
  sched     = {};
  schedDays = {};
  const html = lines.map(l =>
    `<p class="${LINE_TYPES[l.type]?.cls || 'l-action'}" data-type="${l.type}">${esc(l.text)}</p>`
  ).join('');
  if (window.DPEditor?.isReady()) DPEditor.setContent(html);
  else { ed().innerHTML = ''; ed().innerHTML = html; }
  onEditorInput();
  save();
}

// ══════════════════════════════════════════════════
// 출력 드롭다운
// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// 프로젝트 연락처 → 전체 일촬표 동기화
// ══════════════════════════════════════════════════
function syncProjectPhone(type, val) {
  if (type === 'ad') {
    projectAdPhone = val;
    callSheets.forEach(cs => { cs.adPhone = val; });
  } else {
    projectPdPhone = val;
    callSheets.forEach(cs => { cs.pdPhone = val; });
  }
  if (document.getElementById('tab-callsheet')?.classList.contains('on')) renderCS();
  save();
}

// ══════════════════════════════════════════════════
// 헤더 프로젝트 이름 표시 업데이트
// ══════════════════════════════════════════════════
function updateHeaderDisplay() {
  // headerProjectDisplay 제거됨 — 필요 시 재사용 가능하도록 null 체크 유지
  const el = document.getElementById('headerProjectDisplay');
  if (el) el.textContent = document.getElementById('projectName').value.trim() || '새 프로젝트';
}

// ══════════════════════════════════════════════════
// 탭 전환
// ══════════════════════════════════════════════════
function switchTab(id, btn) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('on'));
  document.getElementById('tab-'+id).classList.add('on');
  if(btn) btn.classList.add('on');
  if(id==='breakdown' || id==='loclist' || id==='proplist' || id==='costumelist') {
    document.getElementById('listNavBtn')?.classList.add('on');
  }
  if(id==='schedule' || id==='callsheet') {
    document.getElementById('schedNavBtn')?.classList.add('on');
  }
  if(id==='stafflist' || id==='actorlist') {
    document.getElementById('crewNavBtn')?.classList.add('on');
  }
  if(id==='breakdown')    renderBreakdown();
  if(id==='scenebd')      renderSceneBd();
  if(id==='chars')        renderCharTab();
  if(id==='stafflist')    renderStaffList();
  if(id==='actorlist')    renderActorList();
  if(id==='schedule')     renderSchedule();
  if(id==='callsheet')    { renderCSSelect(); renderCS(); requestAnimationFrame(scaleCSSheet); }
  if(id==='loclist')      renderLocList();
  if(id==='proplist')     renderPropList();
  if(id==='costumelist')  renderCostumeList();
  if(id==='info')         refreshSettingsTab();
  if(id==='projinfo')     refreshProjInfoSection();
  // 스크립트 탭으로 복귀 시 페이지 구분선 재계산 (탭 전환 중 레이아웃 변동 대응)
  if(id==='editor')       requestAnimationFrame(updatePageBreaks);
}
function refreshSettingsTab() {
  const bc = document.getElementById('stgBreadcrumb');
  if (!bc) return;
  const sep = `<span class="stg-bc-sep">›</span>`;
  const fbIcon = `<svg class="stg-bc-icon" width="14" height="14" viewBox="0 0 192 192"><path fill="#FFA000" d="M108.5 36.5l-50 86.7H0L50 36.5z"/><path fill="#F57F17" d="M108.5 36.5l50 86.7H58.5z"/><path fill="#FFCA28" d="M0 123.2l50 32.3 50-32.3-50-86.7z"/><path fill="#FFA000" d="M50 155.5l50-32.3h92l-92 32.3z"/><path fill="#F57F17" d="M142 123.2l-92 32.3 50-86.7z"/></svg>`;
  const parts = [`<span class="stg-bc-item">${fbIcon}Firebase</span>`];
  if (_currentFileName) {
    const fileIcon = `<svg class="stg-bc-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
    parts.push(`<span class="stg-bc-item stg-bc-file">${fileIcon}${_currentFileName}</span>`);
  } else {
    parts.push(`<span class="stg-bc-item stg-bc-empty">프로젝트 없음</span>`);
  }
  bc.innerHTML = parts.join(sep);
  renderVersionHistory();
}

// ── 프로젝트 정보 탭 섹션 ──────────────────────────────────────────────────
let _piPresenceUnsub = null;
let _piCurrentProj   = null;
let _piIsOwner       = false;
let _piPresenceData  = {};

async function refreshProjInfoSection() {
  const noEl  = document.getElementById('piNoProject');
  const conEl = document.getElementById('piContent');
  if (!_currentProjectId) {
    if (noEl)  noEl.style.display  = '';
    if (conEl) conEl.style.display = 'none';
    if (_piPresenceUnsub) { _piPresenceUnsub(); _piPresenceUnsub = null; }
    return;
  }
  if (noEl)  noEl.style.display  = 'none';
  if (conEl) conEl.style.display = '';

  try {
    const proj = await fsStoreGetProject(_currentProjectId);
    const user = auth.currentUser;
    _piCurrentProj = proj;
    _piIsOwner = proj.owner === user.uid;

    // 이름 입력
    const nameInput = document.getElementById('piNameInput');
    if (nameInput) nameInput.value = proj.name;

    // 소유자 행 — _piRenderMembers()에서 presence 기반으로 렌더링

    // 소유자 전용 UI
    const inviteSection = document.getElementById('piInviteSection');
    const ownerActions  = document.getElementById('piOwnerActions');
    const memberActions = document.getElementById('piMemberActions');
    const nameInput2    = document.getElementById('piNameInput');
    if (inviteSection) inviteSection.style.display = (_piIsOwner || _myRole === 'editor') ? '' : 'none';
    if (ownerActions)  ownerActions.style.display  = _piIsOwner ? '' : 'none';
    if (memberActions) memberActions.style.display = !_piIsOwner ? '' : 'none';
    if (nameInput2)    nameInput2.disabled          = !_piIsOwner;

    // 공유 코드 표시
    const codeEl = document.getElementById('piShareCode');
    if (codeEl) codeEl.textContent = proj.shareCode || '—';
    const viewerCodeEl = document.getElementById('piViewerCode');
    if (viewerCodeEl) viewerCodeEl.textContent = proj.viewerCode || '—';

    // 초대 탭 기본값
    piSwitchInviteTab('editor');

    _piRenderMembers();

    // presence 실시간 구독
    if (_piPresenceUnsub) _piPresenceUnsub();
    _piPresenceUnsub = db.collection('presence').doc(_currentProjectId).onSnapshot(snap => {
      _piPresenceData = snap.exists ? snap.data() : {};
      _piRenderMembers();
    });
  } catch(e) {
    const conEl2 = document.getElementById('piContent');
    if (conEl2) conEl2.innerHTML = `<div style="opacity:.6;font-size:12px;padding:8px">불러오기 오류: ${esc(e.message)}</div>`;
  }
}

function _piRenderMembers() {
  const proj = _piCurrentProj;
  if (!proj) return;
  const user   = auth.currentUser;
  const now    = Date.now();

  const gridEl = document.getElementById('piMemberGrid');
  if (!gridEl) return;

  const presenceByEmail = {};
  Object.values(_piPresenceData).forEach(v => {
    if (v.email) presenceByEmail[v.email.toLowerCase()] = v;
  });

  function _mkCard(email, type, removeFn) {
    const pData    = presenceByEmail[email.toLowerCase()];
    const isOnline = pData && (now - pData.updatedAt < 120000);
    const profileKey = email.toLowerCase().replace(/\./g, '_');
    const profile  = proj.memberProfiles?.[profileKey];
    const isMe     = email.toLowerCase() === (user.email || '').toLowerCase();
    const name  = isMe ? getProfileName() : (profile?.name || pData?.name || email.split('@')[0]);
    const emoji = isMe ? (localStorage.getItem(PROFILE_EMOJI_KEY()) || DEFAULT_EMOJI)
                       : (profile?.emoji || pData?.emoji || '👤');
    const removeBtn = _piIsOwner && removeFn && !isMe
      ? `<button class="mc-remove-btn" title="제거" onclick="${removeFn}('${esc(email)}')">×</button>`
      : '';
    return `<div class="mc-card ${type}">
      ${removeBtn}
      <span class="mc-card-dot ${type} ${isOnline ? 'online' : ''}"></span>
      <span class="mc-emoji">${emoji}</span>
      <div class="mc-name">${esc(name)}</div>
      <div class="mc-email">${esc(email)}</div>
      ${isMe ? '<span class="mc-me-badge">나</span>' : ''}
    </div>`;
  }

  // 소유자 카드
  const op = _piPresenceData[proj.owner];
  const ownerOnline = op && (now - op.updatedAt < 120000);
  const ownerProfileKey = (proj.ownerEmail || '').toLowerCase().replace(/\./g, '_');
  const ownerProfile = proj.memberProfiles?.[ownerProfileKey];
  const ownerEmoji = (proj.owner === user.uid)
    ? (localStorage.getItem(PROFILE_EMOJI_KEY()) || ownerProfile?.emoji || '👤')
    : (ownerProfile?.emoji || op?.emoji || '👤');
  const ownerName = (proj.owner === user.uid)
    ? getProfileName()
    : (ownerProfile?.name || op?.name || proj.ownerName || proj.ownerEmail || '소유자');
  const ownerIsMe = proj.owner === user.uid;
  const ownerCard = `<div class="mc-card owner">
    <span class="mc-card-dot owner ${ownerOnline ? 'online' : ''}"></span>
    <span class="mc-emoji">${ownerEmoji}</span>
    <div class="mc-name">${esc(ownerName)}</div>
    <div class="mc-email">${esc(proj.ownerEmail || '')}</div>
    ${ownerIsMe ? '<span class="mc-me-badge">나</span>' : ''}
  </div>`;

  const ownerEmailLower = (proj.ownerEmail || '').toLowerCase();
  const memberCards = (proj.memberEmails || [])
    .filter(e => e.toLowerCase() !== ownerEmailLower)
    .map(e => _mkCard(e, 'member', 'piRemoveMember')).join('');
  const viewerCards = (proj.viewerEmails || [])
    .filter(e => e.toLowerCase() !== ownerEmailLower)
    .map(e => _mkCard(e, 'viewer', 'piRemoveViewer')).join('');

  gridEl.innerHTML = ownerCard + memberCards + viewerCards;
}

async function piSaveName() {
  if (!_piCurrentProj || !_piIsOwner) return;
  const input = document.getElementById('piNameInput');
  const newName = (input?.value || '').trim();
  if (!newName || newName === _piCurrentProj.name) return;
  try {
    await fsStoreRenameProject(_currentProjectId, newName);
    _piCurrentProj.name = newName;
    _currentFileName = newName;
    showToast('이름 변경 완료');
  } catch(e) { showToast('이름 변경 오류: ' + e.message); }
}

// _piCurrentProj를 Firestore에서 재조회하고 UI 갱신
async function _piRefresh() {
  if (!_currentProjectId) return;
  try {
    _piCurrentProj = await fsStoreGetProject(_currentProjectId);
    const codeEl = document.getElementById('piShareCode');
    if (codeEl) codeEl.textContent = _piCurrentProj.shareCode || '—';
    const viewerCodeEl = document.getElementById('piViewerCode');
    if (viewerCodeEl) viewerCodeEl.textContent = _piCurrentProj.viewerCode || '—';
    _piRenderMembers();
  } catch(e) {}
}

async function piInviteMember() {
  const input = document.getElementById('piInviteEmail');
  const email = (input?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) { showToast('올바른 이메일을 입력하세요'); return; }
  if (email === (auth.currentUser.email || '').toLowerCase()) { showToast('본인은 이미 참여 중입니다'); return; }
  if ((_piCurrentProj?.memberEmails || []).includes(email)) { showToast('이미 초대된 참여자입니다'); return; }
  try {
    // 열람자 목록에 있으면 먼저 제거 후 참여자로 전환
    if ((_piCurrentProj?.viewerEmails || []).includes(email)) {
      await fsStoreRemoveViewer(_currentProjectId, email);
    }
    await fsStoreInviteMember(_currentProjectId, email);
    if (input) input.value = '';
    showToast(`${email} 참여자 초대 완료`);
    await _piRefresh();
  } catch(e) { showToast('초대 실패: ' + e.message); }
}

async function piRemoveMember(email) {
  if (!confirm(`"${email}" 참여자를 제거하시겠습니까?`)) return;
  try {
    await fsStoreRemoveMember(_currentProjectId, email);
    showToast('참여자 제거 완료');
    await _piRefresh();
  } catch(e) { showToast('제거 실패: ' + e.message); }
}

async function piDeleteProject() {
  if (!_piCurrentProj || !_piIsOwner) return;
  if (!confirm(`"${_piCurrentProj.name}" 프로젝트를 삭제할까요?\n버전 히스토리도 모두 삭제됩니다.`)) return;
  try {
    const pid = _currentProjectId;
    clearCurrentProjectMemory();
    _currentProjectId = null; _currentFileName = null; _dataLoaded = false;
    _piCurrentProj = null;
    if (_piPresenceUnsub) { _piPresenceUnsub(); _piPresenceUnsub = null; }
    await fsStoreDeleteProject(pid);
    showToast('프로젝트 삭제 완료');
    showProjectsOverlay();
  } catch(e) { showToast('삭제 오류: ' + e.message); }
}

async function piLeaveProject() {
  if (!_piCurrentProj) return;
  if (!confirm(`"${_piCurrentProj.name}" 프로젝트에서 나가시겠습니까?`)) return;
  try {
    clearCurrentProjectMemory();
    await fsStoreRemoveMember(_currentProjectId, auth.currentUser.email);
    _currentProjectId = null; _currentFileName = null; _dataLoaded = false;
    _piCurrentProj = null;
    if (_piPresenceUnsub) { _piPresenceUnsub(); _piPresenceUnsub = null; }
    showToast('프로젝트에서 나갔습니다');
    showProjectsOverlay();
  } catch(e) { showToast('오류: ' + e.message); }
}

async function piGenerateShareCode() {
  if (!_currentProjectId || !_piIsOwner) return;
  const code = _genShareCode();
  try {
    await fsStoreSetShareCode(_currentProjectId, code);
    if (_piCurrentProj) _piCurrentProj.shareCode = code;
    const codeEl = document.getElementById('piShareCode');
    if (codeEl) codeEl.textContent = code;
    showToast('공유 코드가 생성됐습니다');
  } catch(e) { showToast('오류: ' + e.message); }
}

function _piGetCode() {
  const codeEl = document.getElementById('piShareCode');
  return (_piCurrentProj?.shareCode || codeEl?.textContent || '').trim();
}

async function _copyText(text, successMsg) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); showToast(successMsg); return; } catch(_) {}
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    showToast(successMsg);
  } catch(e) { showToast('복사 실패 — 직접 선택해 복사하세요'); }
}

async function piCopyShareCode() {
  const code = _piGetCode();
  if (!code || code === '—') { showToast('먼저 코드를 생성하세요'); return; }
  await _copyText(code, '코드가 복사됐습니다');
}

async function piShareCode() {
  const code = _piGetCode();
  if (!code || code === '—') { showToast('먼저 코드를 생성하세요'); return; }
  const text = `Don't Panic Pre 참여 코드: ${code}\n\n앱에서 "코드로 참여하기"에 입력하세요.\n\nhttps://dontpanicpre.web.app`;
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch(e) {
      if (e.name === 'AbortError') return; // 사용자가 취소
    }
  }
  // Web Share API 미지원 시 클립보드에 전체 메시지 복사
  await _copyText(text, '초대 메시지가 복사됐습니다');
}

// ── 초대 탭 전환 ─────────────────────────────────────
function piSwitchInviteTab(tab) {
  document.querySelectorAll('.pi-invite-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.pi-invite-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tab));
}

// ── 열람자 초대 ──────────────────────────────────────
async function piInviteViewer() {
  const input = document.getElementById('piInviteViewerEmail');
  const email = (input?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) { showToast('올바른 이메일을 입력하세요'); return; }
  if (email === (auth.currentUser.email || '').toLowerCase()) { showToast('본인은 이미 소유자입니다'); return; }
  if ((_piCurrentProj?.viewerEmails || []).includes(email)) { showToast('이미 초대된 열람자입니다'); return; }
  try {
    // 참여자 목록에 있으면 먼저 제거 후 열람자로 전환
    if ((_piCurrentProj?.memberEmails || []).includes(email)) {
      await fsStoreRemoveMember(_currentProjectId, email);
    }
    await fsStoreInviteViewer(_currentProjectId, email);
    if (input) input.value = '';
    showToast(`${email} 열람자 초대 완료`);
    await _piRefresh();
  } catch(e) { showToast('초대 실패: ' + e.message); }
}

async function piRemoveViewer(email) {
  if (!confirm(`"${email}" 열람자를 제거하시겠습니까?`)) return;
  try {
    await fsStoreRemoveViewer(_currentProjectId, email);
    showToast('열람자 제거 완료');
    await _piRefresh();
  } catch(e) { showToast('제거 실패: ' + e.message); }
}

async function piGenerateViewerCode() {
  if (!_currentProjectId || !_piIsOwner) return;
  const code = _genShareCode();
  try {
    await fsStoreSetViewerCode(_currentProjectId, code);
    if (_piCurrentProj) _piCurrentProj.viewerCode = code;
    const codeEl = document.getElementById('piViewerCode');
    if (codeEl) codeEl.textContent = code;
    showToast('열람자 공유 코드가 생성됐습니다');
  } catch(e) { showToast('오류: ' + e.message); }
}

function _piGetViewerCode() {
  const codeEl = document.getElementById('piViewerCode');
  return (_piCurrentProj?.viewerCode || codeEl?.textContent || '').trim();
}

async function piCopyViewerCode() {
  const code = _piGetViewerCode();
  if (!code || code === '—') { showToast('먼저 코드를 생성하세요'); return; }
  await _copyText(code, '열람자 코드가 복사됐습니다');
}

async function piShareViewerCode() {
  const code = _piGetViewerCode();
  if (!code || code === '—') { showToast('먼저 코드를 생성하세요'); return; }
  const text = `Don't Panic Pre 열람자 코드: ${code}\n\n앱에서 "코드로 참여하기"에 입력하세요.\n\nhttps://dontpanicpre.web.app`;
  if (navigator.share) {
    try { await navigator.share({ text }); return; }
    catch(e) { if (e.name === 'AbortError') return; }
  }
  await _copyText(text, '열람자 초대 메시지가 복사됐습니다');
}

function toggleListNav(e) { e.stopPropagation(); closeSchedNav(); closeCrewNav(); document.getElementById('listNavDropdown').classList.toggle('open'); }
function closeListNav() { document.getElementById('listNavDropdown')?.classList.remove('open'); }
function switchListTab(id) { closeListNav(); switchTab(id, null); document.getElementById('listNavBtn')?.classList.add('on'); }

function toggleSchedNav(e) { e.stopPropagation(); closeListNav(); closeCrewNav(); document.getElementById('schedNavDropdown').classList.toggle('open'); }
function closeSchedNav() { document.getElementById('schedNavDropdown')?.classList.remove('open'); }
function switchSchedTab(id) { closeSchedNav(); switchTab(id, null); document.getElementById('schedNavBtn')?.classList.add('on'); }

function toggleCrewNav(e) { e.stopPropagation(); closeListNav(); closeSchedNav(); document.getElementById('crewNavDropdown').classList.toggle('open'); }
function closeCrewNav() { document.getElementById('crewNavDropdown')?.classList.remove('open'); }
function switchCrewTab(id) { closeCrewNav(); switchTab(id, null); document.getElementById('crewNavBtn')?.classList.add('on'); }

document.addEventListener('click', () => { closeListNav(); closeSchedNav(); closeCrewNav(); });

function openPageInsertModal() {
  const modal = document.getElementById('pageInsertModal');
  if (!modal) return;
  const style = pageNumberStyle || 'single';
  document.querySelectorAll('#pageNumStyleGroup .hm-chip').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.val === style);
  });
  modal.classList.remove('hidden');
}

function closePageInsertModal() {
  document.getElementById('pageInsertModal')?.classList.add('hidden');
}

function selectPageNumberStyle(btn) {
  document.querySelectorAll('#pageNumStyleGroup .hm-chip').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
}

function confirmPageInsert() {
  const selected = document.querySelector('#pageNumStyleGroup .hm-chip.on');
  pageNumberStyle = selected?.dataset.val || 'single';
  updatePageBreaks();
  save();
  closePageInsertModal();
}

function toggleInsertDrop(e) { e.stopPropagation(); document.getElementById('insertDropdown').classList.toggle('open'); }
function closeInsertDrop() { document.getElementById('insertDropdown')?.classList.remove('open'); }
document.addEventListener('click', () => { closeInsertDrop(); closeZoomDrop(); });

// ── 화면 확대/축소 ──
let _editorZoom = 1.0;

function toggleZoomDrop(e) {
  e.stopPropagation();
  document.getElementById('zoomDropdown').classList.toggle('open');
}
function closeZoomDrop() { document.getElementById('zoomDropdown')?.classList.remove('open'); }

function setZoom(factor, customLabel) {
  _editorZoom = factor;
  const wrap = document.querySelector('.editor-page-wrap');
  if (wrap) wrap.style.zoom = factor;
  const lbl = document.getElementById('zoomLabel');
  if (lbl) lbl.textContent = customLabel || (Math.round(factor * 100) + '%');
  document.querySelectorAll('#zoomDropdown .zoom-item').forEach(btn => {
    btn.classList.toggle('zoom-checked', Math.abs(parseFloat(btn.dataset.zoom) - factor) < 0.001);
  });
  closeZoomDrop();
}

function setZoomFitWidth() {
  const scrollWrap = document.querySelector('.editor-scroll-wrap');
  if (!scrollWrap) return closeZoomDrop();
  const naturalW = 210 * 96 / 25.4;
  const available = scrollWrap.clientWidth - 48;
  const factor = Math.round(available / naturalW * 100) / 100;
  setZoom(Math.max(0.1, Math.min(4, factor)), '너비 맞춤');
}

function setZoomFitPage() {
  const scrollWrap = document.querySelector('.editor-scroll-wrap');
  if (!scrollWrap) return closeZoomDrop();
  const naturalH = 297 * 96 / 25.4;
  const available = scrollWrap.clientHeight - 56;
  const factor = Math.round(available / naturalH * 100) / 100;
  setZoom(Math.max(0.1, Math.min(4, factor)), '페이지 맞춤');
}

// ══════════════════════════════════════════════════
// 장소리스트
// ══════════════════════════════════════════════════
function _getLocOrdered() {
  const locSet = new Set();
  scenes.forEach(s => { if (s.loc) locSet.add(s.loc); });
  Object.values(sceneExtras).forEach(extra => {
    (extra.locationItems||[]).forEach(item => { const n = getItemText(item); if (n) locSet.add(n); });
  });
  const ordered = locationOrder.filter(l => locSet.has(l));
  locSet.forEach(l => { if (!ordered.includes(l)) ordered.push(l); });
  return ordered;
}

let _locDragging = null;
// 테이블 행 드래그 (장소리스트) — 같은 data-loc 행 그룹 전체 하이라이트
function _locGroupRows(loc) {
  return [...document.querySelectorAll(`#loclistWrap tr[data-loc="${loc.replace(/"/g,'&quot;')}"]`)];
}
function locRowDragStart(e, loc) {
  _locDragging = loc;
  e.dataTransfer.effectAllowed = 'move';
  e.stopPropagation();
  _locGroupRows(loc).forEach(r => r.style.opacity = '0.4');
}
function locRowDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  const targetLoc = e.currentTarget.dataset.loc;
  if (targetLoc && targetLoc !== _locDragging) {
    _locGroupRows(targetLoc).forEach(r => r.classList.add('loc-drag-over'));
  }
}
function locRowDragLeave(e) {
  const targetLoc = e.currentTarget.dataset.loc;
  // relatedTarget이 같은 그룹 내부면 무시
  if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(`[data-loc="${(targetLoc||'').replace(/"/g,'&quot;')}"]`)) return;
  if (targetLoc) _locGroupRows(targetLoc).forEach(r => r.classList.remove('loc-drag-over'));
}
function locRowDrop(e, targetLoc) {
  e.preventDefault();
  e.stopPropagation();
  _locGroupRows(targetLoc).forEach(r => r.classList.remove('loc-drag-over'));
  if (_locDragging) _locGroupRows(_locDragging).forEach(r => r.style.opacity = '');
  if (!_locDragging || _locDragging === targetLoc) { _locDragging = null; return; }
  const ordered = _getLocOrdered();
  const fi = ordered.indexOf(_locDragging);
  const ti = ordered.indexOf(targetLoc);
  if (fi < 0 || ti < 0) { _locDragging = null; return; }
  ordered.splice(fi, 1);
  ordered.splice(ti, 0, _locDragging);
  locationOrder = ordered;
  _locDragging = null;
  save();
  renderLocList();
}
// 호환성 유지 (구버전 카드 이벤트 — 미사용)
function locDragStart(e,loc){} function locDragOver(e){} function locDragLeave(e){} function locDrop(e,loc){}

// ══════════ 소품리스트 ↔ 브레이크다운 동기화 헬퍼 ══════════

// 브레이크다운에 소품이 추가될 때 → propList에 없으면 신규 등록, 있으면 빈 필드 자동 보완
// 씬 번호로 씬 조회 (int/string 타입 불일치 대응)
const _findSceneByNum = n => scenes.find(s => String(s.number) === String(n));

// setProp 장소명 스캔: 해당 소품이 등장하는 씬들의 loc를 순서대로 탐색
function _locFromSceneExtras(name) {
  for (const [sn, extra] of Object.entries(sceneExtras)) {
    if ((extra.setPropItems || []).some(i => getItemText(i) === name)) {
      const sc = _findSceneByNum(sn);
      if (sc?.loc) return sc.loc;
    }
  }
  return '';
}

function syncPropToList(name, category, snum, item) {
  if (!name || (category !== 'charProp' && category !== 'setProp')) return;
  normalizeListState();
  const existing = propList.find(p => p.name === name && p.category === category);
  if (existing) {
    if (category === 'charProp' && !existing.character && item) {
      const ch = getItemChar(item); if (ch) existing.character = ch;
    }
    if (category === 'setProp' && !existing.location) {
      const sc = snum != null ? _findSceneByNum(snum) : null;
      existing.location = sc?.loc || _locFromSceneExtras(name);
    }
    return;
  }
  let character = '';
  let location = '';
  if (category === 'charProp' && item) character = getItemChar(item) || '';
  if (category === 'setProp') {
    const sc = snum != null ? _findSceneByNum(snum) : null;
    location = sc?.loc || _locFromSceneExtras(name);
  }
  propList.push({
    id: 'prop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name, category, character, location, status: '미보유', desc: ''
  });
}

// 브레이크다운에서 소품이 제거될 때 → 어느 씬에도 없으면 propList에서 삭제
function removePropFromList(name, category) {
  normalizeListState();
  const field = category === 'charProp' ? 'charPropItems' : 'setPropItems';
  const stillExists = Object.values(sceneExtras).some(extra =>
    (extra[field] || []).some(i => getItemText(i) === name)
  );
  if (!stillExists) {
    propList = propList.filter(p => !(p.name === name && p.category === category));
    // 다른 계정 _mergeList 2단계에서 로컬 항목을 복원하지 않도록 삭제 로그에 기록
    _deletionLog.addProp(name, category);
  }
}

// 공간소품의 장소명을 씬의 장소로 자동 업데이트
function autoFillPropLocation(name, snum) {
  normalizeListState();
  const prop = propList.find(p => p.name === name && p.category === 'setProp');
  if (!prop || prop.location) return;
  const sc = snum != null ? _findSceneByNum(snum) : null;
  prop.location = sc?.loc || _locFromSceneExtras(name);
}

// 인물소품의 인물명을 sceneExtras에서 자동 업데이트
function autoFillPropCharacter(name, snum) {
  normalizeListState();
  const prop = propList.find(p => p.name === name && p.category === 'charProp');
  if (!prop || prop.character) return;
  const extra = sceneExtras[snum];
  if (!extra) return;
  const item = (extra.charPropItems || []).find(i => getItemText(i) === name);
  if (item) { const ch = getItemChar(item); if (ch) prop.character = ch; }
}

// 초기 로드 시 sceneExtras의 모든 소품을 propList에 반영 (누락분 추가)
function syncAllPropsFromBreakdown() {
  Object.entries(sceneExtras).forEach(([snum, extra]) => {
    const sn = parseInt(snum);
    (extra.charPropItems || []).forEach(item => {
      const n = getItemText(item); if (n) {
        syncPropToList(n, 'charProp', sn, item);
        autoFillPropCharacter(n, sn);
      }
    });
    (extra.setPropItems || []).forEach(item => {
      const n = getItemText(item);
      if (n) {
        syncPropToList(n, 'setProp', sn, item);
        autoFillPropLocation(n, sn);
      }
    });
  });
}

// ══════════════════════════════════════════════════
// 의상/분장 리스트 ↔ 브레이크다운 동기화 헬퍼
// ══════════════════════════════════════════════════
function syncCostumeToList(name, category, snum, item) {
  if (!name || (category !== 'costume' && category !== 'makeup')) return;
  normalizeListState();
  const existing = costumeList.find(c => c.name === name && c.category === category);
  if (existing) {
    if (!existing.character && item) { const ch = getItemChar(item); if (ch) existing.character = ch; }
    return;
  }
  const character = (item ? getItemChar(item) : '') || '';
  costumeList.push({
    id: 'cos_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name, category, character,
    status: category === 'costume' ? '미보유' : '',
    desc: ''
  });
}

function removeCostumeFromList(name, category) {
  normalizeListState();
  const field = category === 'costume' ? 'costumeItems' : 'makeupItems';
  const stillExists = Object.values(sceneExtras).some(extra =>
    (extra[field] || []).some(i => getItemText(i) === name)
  );
  if (!stillExists) {
    costumeList = costumeList.filter(c => !(c.name === name && c.category === category));
    // 다른 계정 _mergeList 2단계에서 로컬 항목을 복원하지 않도록 삭제 로그에 기록
    _deletionLog.addCostume(name, category);
  }
}

function syncAllCostumesFromBreakdown() {
  Object.entries(sceneExtras).forEach(([snum, extra]) => {
    const sn = parseInt(snum);
    (extra.costumeItems || []).forEach(item => { const n = getItemText(item); if (n) syncCostumeToList(n, 'costume', sn, item); });
    (extra.makeupItems  || []).forEach(item => { const n = getItemText(item); if (n) syncCostumeToList(n, 'makeup',  sn, item); });
  });
}

// ══════════════════════════════════════════════════
// 소품리스트
// ══════════════════════════════════════════════════
function renderPropList() {
  const wrap = document.getElementById('proplistWrap');
  if (!wrap) return;

  // 씬브레이크다운에서 씬 정보 수집 (표시용)
  const sceneMap = { charProp: {}, setProp: {} };
  Object.entries(sceneExtras).forEach(([snum, extra]) => {
    const sn = parseInt(snum);
    const sc = scenes.find(s => s.number === sn);
    const lbl = sc ? 'S#' + sc.displayNum : 'S#' + snum;
    (extra.charPropItems || []).forEach(item => {
      const n = getItemText(item); if (!n) return;
      if (!sceneMap.charProp[n]) sceneMap.charProp[n] = [];
      if (!sceneMap.charProp[n].find(x => x.num === sn)) sceneMap.charProp[n].push({ num: sn, label: lbl });
    });
    (extra.setPropItems || []).forEach(item => {
      const n = getItemText(item); if (!n) return;
      if (!sceneMap.setProp[n]) sceneMap.setProp[n] = [];
      if (!sceneMap.setProp[n].find(x => x.num === sn)) sceneMap.setProp[n].push({ num: sn, label: lbl });
    });
  });

  // propList에서 category별 분리 (순서 유지)
  const charProps = propList.filter(p => p.category === 'charProp');
  const setProps  = propList.filter(p => p.category === 'setProp');
  const esc2 = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const makePropRow = (p, category, srcMap, draggable) => {
    const scList = (srcMap[p.name] || []).slice().sort((a,b) => a.num - b.num);
    const chips  = scList.map(s => `<span class="prop-scene-chip prop-scene-chip-manual">${esc2(s.label)}<button class="prop-scene-chip-del" onclick="removePropSceneLink('${p.id}',${s.num})" title="씬 연결 해제">✕</button></span>`).join('');
    const scChips = `<div class="prop-scene-chips">${chips}<button class="prop-scene-add-btn" onclick="openScenePicker('prop','${p.id}')" title="씬 추가">+</button></div>`;
    const assocKey = category === 'charProp' ? 'character' : 'location';
    const assocPh  = category === 'charProp' ? '인물명' : '장소명';
    const assocVal = esc2(p[assocKey] || '');
    const nameVal  = esc2(p.name || '');
    const st  = p.status || '미보유';
    const cls = st==='보유'?'s-ready':st==='제작중'?'s-making':'s-none';
    const dragAttrs = draggable
      ? `draggable="true" ondragstart="propDragStart(event,'${p.id}')" ondragover="propDragOver(event,'${p.id}')" ondragleave="propDragLeave(event,'${p.id}')" ondrop="propDrop(event,'${p.id}')" ondragend="propDragEnd(event)"`
      : '';
    const dragCell = draggable
      ? `<td style="width:32px;text-align:center;padding:4px 2px"><span class="prop-drag-handle" title="드래그하여 순서 변경">⠿</span></td>`
      : `<td style="width:32px"></td>`;
    return `<tr id="prop-row-${p.id}" data-prop-id="${p.id}" data-prop-name="${nameVal}" ${dragAttrs}>
      ${dragCell}
      <td style="min-width:40px"><input class="prop-inp" value="${assocVal}" placeholder="${assocPh}"
          onchange="updatePropField('${p.id}','${assocKey}',this.value)"></td>
      <td style="min-width:200px">${scChips}</td>
      <td style="min-width:60px"><input class="prop-inp" value="${nameVal}" placeholder="소품명"
          onchange="updatePropField('${p.id}','name',this.value)"></td>
      <td style="width:72px;text-align:center;padding:4px 6px">
        <select class="prop-status-sel ${cls}" onchange="updatePropStatus('${p.id}',this)">
          <option value="미보유" ${st==='미보유'?'selected':''}>미보유</option>
          <option value="제작중" ${st==='제작중'?'selected':''}>제작중</option>
          <option value="보유"   ${st==='보유'  ?'selected':''}>보유</option>
        </select>
      </td>
      <td style="min-width:280px"><input class="prop-inp" value="${esc2(p.desc||'')}" placeholder="설명"
          onchange="updatePropField('${p.id}','desc',this.value)"></td>
      <td style="width:40px;text-align:center">
        <button class="prop-del-btn" onclick="deleteProp('${p.id}')" title="삭제">✕</button>
      </td>
    </tr>`;
  };

  const makeRows = (props, category, srcMap) => {
    if (!props.length) return `<tr class="prop-empty-row"><td colspan="7">소품이 없습니다. 씬브레이크다운에서 소품을 추가하거나 직접 추가해 주세요.</td></tr>`;
    const sort = propSort[category] || 'default';
    if (sort === 'default') {
      return props.map(p => makePropRow(p, category, srcMap, true)).join('');
    }
    // 그룹별 정렬
    const getGroupKey = p => {
      if (sort === 'char')   return p.character || '(미지정)';
      if (sort === 'loc')    return p.location   || '(미지정)';
      if (sort === 'status') return p.status     || '미보유';
      return '';
    };
    const statusOrder = { '미보유': 0, '제작중': 1, '보유': 2 };
    const groups = {};
    props.forEach(p => {
      const k = getGroupKey(p);
      if (!groups[k]) groups[k] = [];
      groups[k].push(p);
    });
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (sort === 'status') return (statusOrder[a] ?? 9) - (statusOrder[b] ?? 9);
      if (a === '(미지정)') return 1;
      if (b === '(미지정)') return -1;
      return a.localeCompare(b, 'ko');
    });
    return sortedKeys.map(key => {
      const groupRows = groups[key].map(p => makePropRow(p, category, srcMap, false)).join('');
      const hdr = `<tr class="prop-group-hdr"><td colspan="7">
        <span class="prop-group-label">${esc2(key)}</span>
        <span class="prop-group-count">${groups[key].length}개</span>
      </td></tr>`;
      return hdr + groupRows;
    }).join('');
  };

  const sortBtns = (category, sorts) => sorts.map(([val, lbl]) => {
    const on = (propSort[category] || 'default') === val ? ' on' : '';
    return `<button class="prop-sort-btn${on}" onclick="setPropSort('${category}','${val}')">${lbl}</button>`;
  }).join('');

  wrap.innerHTML = `
    <div class="prop-section">
      <div class="prop-section-header">
        <span class="prop-section-title" style="color:#60a5fa">👤 인물소품</span>
        <span class="prop-count">${charProps.length}개</span>
        <div style="display:flex;gap:5px;margin-left:8px">
          ${sortBtns('charProp',[['default','기본'],['char','인물별'],['status','상태별']])}
        </div>
        <button class="prop-add-btn" onclick="addProp('charProp')">+ 직접 추가</button>
      </div>
      <table class="prop-table">
        <thead><tr>
          <th style="width:32px"></th>
          <th style="min-width:40px">인물</th>
          <th style="min-width:200px">씬</th>
          <th style="min-width:60px">소품명</th>
          <th style="width:72px;text-align:center">상태</th>
          <th style="min-width:280px">설명</th>
          <th style="width:40px"></th>
        </tr></thead>
        <tbody>${makeRows(charProps, 'charProp', sceneMap.charProp)}</tbody>
      </table>
    </div>
    <div class="prop-section">
      <div class="prop-section-header">
        <span class="prop-section-title" style="color:#34d399">🏠 공간소품</span>
        <span class="prop-count">${setProps.length}개</span>
        <div style="display:flex;gap:5px;margin-left:8px">
          ${sortBtns('setProp',[['default','기본'],['loc','장소별'],['status','상태별']])}
        </div>
        <button class="prop-add-btn" onclick="addProp('setProp')">+ 직접 추가</button>
      </div>
      <table class="prop-table">
        <thead><tr>
          <th style="width:32px"></th>
          <th style="min-width:40px">장소</th>
          <th style="min-width:200px">씬</th>
          <th style="min-width:60px">소품명</th>
          <th style="width:72px;text-align:center">상태</th>
          <th style="min-width:280px">설명</th>
          <th style="width:40px"></th>
        </tr></thead>
        <tbody>${makeRows(setProps, 'setProp', sceneMap.setProp)}</tbody>
      </table>
    </div>`;
}

function setPropSort(category, sort) {
  propSort[category] = sort;
  renderPropList();
}

function addProp(category) {
  const newProp = {
    id: 'prop_' + Date.now(),
    name: '',
    category,
    character: '',
    location: '',
    status: '미보유',
    desc: ''
  };
  propList.push(newProp);
  save();
  renderPropList();
  // 새로 추가된 행의 이름 입력창에 포커스
  requestAnimationFrame(() => {
    const row = document.getElementById('prop-row-' + newProp.id);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.querySelector('.prop-inp')?.focus();
    }
  });
}

function deleteProp(id) {
  const prop = propList.find(p => p.id === id);
  if (!prop) return;

  const field = prop.category === 'charProp' ? 'charPropItems' : 'setPropItems';
  const type  = FIELD_TO_TYPE[field]; // 'charProp' | 'setProp'

  // sceneExtras에서 해당 소품 항목 제거 + 에디터 span 언래핑
  _deletionLog.addElemGlobal(field, prop.name); // 모든 씬에서 Firestore merge 복원 방지
  for (const [snumKey, extra] of Object.entries(sceneExtras)) {
    if (!extra[field]) continue;
    const idx = extra[field].findIndex(i => getItemText(i) === prop.name);
    if (idx < 0) continue;
    extra[field].splice(idx, 1);
    _deletionLog.addElem(snumKey, field, prop.name); // 씬 단위 merge 복원 방지
    removeFromListField(snumKey, ITEMS_TO_LIST[field], prop.name);
    removeElemSpanFromEditor(snumKey, type, prop.name);
  }
  _deletionLog.addProp(prop.name, prop.category); // propList merge 시 복원 방지

  propList = propList.filter(p => p.id !== id);
  save();
  renderPropList();
  renderSidebar();
  renderSceneBd();
  renderBreakdown();
  if (document.getElementById('tab-loclist')?.classList.contains('on'))   renderLocList();
}

function moveProp(id, dir) {
  const idx = propList.findIndex(p => p.id === id);
  if (idx < 0) return;
  const category = propList[idx].category;
  // 같은 category 내에서만 이동
  const catIndices = propList.reduce((acc, p, i) => { if (p.category === category) acc.push(i); return acc; }, []);
  const pos = catIndices.indexOf(idx);
  if (dir === 'up'   && pos <= 0) return;
  if (dir === 'down' && pos >= catIndices.length - 1) return;
  const swapIdx = dir === 'up' ? catIndices[pos - 1] : catIndices[pos + 1];
  [propList[idx], propList[swapIdx]] = [propList[swapIdx], propList[idx]];
  save();
  renderPropList();
  // 이동 후 해당 행으로 스크롤
  requestAnimationFrame(() => {
    const row = document.getElementById('prop-row-' + id);
    if (row) row.scrollIntoView({ block: 'nearest' });
  });
}

function updatePropField(id, field, value) {
  const prop = propList.find(p => p.id === id);
  if (!prop) return;
  const oldName = prop.name;
  prop[field] = value;
  // 이름이 바뀌면 sceneExtras 안의 항목명도 동기화
  if (field === 'name' && value && value !== oldName) {
    const itemField = prop.category === 'charProp' ? 'charPropItems' : 'setPropItems';
    for (const extra of Object.values(sceneExtras)) {
      if (!extra[itemField]) continue;
      extra[itemField].forEach(item => {
        if (typeof item === 'object' && getItemText(item) === oldName) item.text = value;
        // (string 형태는 splice-and-replace 필요)
      });
      // string 형태 항목 교체
      extra[itemField] = extra[itemField].map(item =>
        (typeof item === 'string' && item === oldName) ? value : item
      );
      // 텍스트 요약 필드 재계산
      extra[ITEMS_TO_LIST[itemField]] = extra[itemField].map(getItemText).filter(Boolean).join(', ');
    }
    renderSceneBd();
    renderBreakdown();
  }
  save();
}

function updatePropStatus(id, sel) {
  const cls = sel.value==='보유'?'s-ready':sel.value==='제작중'?'s-making':'s-none';
  sel.className = 'prop-status-sel ' + cls;
  updatePropField(id, 'status', sel.value);
}

function removePropSceneLink(id, snum) {
  const p = propList.find(p => p.id === id); if (!p) return;
  const field = p.category === 'charProp' ? 'charPropItems' : 'setPropItems';
  const type  = FIELD_TO_TYPE[field];
  if (sceneExtras[snum]?.[field]) {
    const idx = sceneExtras[snum][field].findIndex(i => getItemText(i) === p.name);
    if (idx >= 0) sceneExtras[snum][field].splice(idx, 1);
  }
  _deletionLog.addElem(snum, field, p.name); // Firestore merge 시 복원 방지
  removeFromListField(snum, ITEMS_TO_LIST[field], p.name);
  removeElemSpanFromEditor(snum, type, p.name);
  save(); renderPropList(); renderSidebar();
  renderBreakdown();
  renderSceneBd();
}

// ── 씬 선택 팝업 (소품·의상분장 공용) ──────────────────────
let _spType = null, _spId = null;

function openScenePicker(type, itemId) {
  _spType = type; _spId = itemId;

  let name, field;
  if (type === 'prop') {
    const p = propList.find(p => p.id === itemId); if (!p) return;
    name  = p.name;
    field = p.category === 'charProp' ? 'charPropItems' : 'setPropItems';
  } else {
    const c = costumeList.find(c => c.id === itemId); if (!c) return;
    name  = c.name;
    field = c.category === 'costume' ? 'costumeItems' : 'makeupItems';
  }

  // sceneExtras 기준으로 연결된 씬 수집
  const linkedNums = new Set();
  Object.entries(sceneExtras).forEach(([sn, ex]) => {
    if ((ex[field] || []).some(i => getItemText(i) === name)) linkedNums.add(+sn);
  });

  const list = document.getElementById('scenePickerList');
  if (!scenes.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px">씬이 없습니다.</div>';
  } else {
    list.innerHTML = scenes.map(s => {
      const linked = linkedNums.has(s.number);
      const lbl = `S#${esc(String(s.displayNum))}${s.loc ? ' · ' + esc(s.loc) : ''}`;
      return `<label class="scene-picker-item"><input type="checkbox" value="${s.number}" ${linked ? 'checked data-was="1"' : ''}><span>${lbl}</span></label>`;
    }).join('');
  }
  document.getElementById('scenePickerOverlay').classList.add('open');
}

function closeScenePicker() {
  document.getElementById('scenePickerOverlay').classList.remove('open');
  _spType = null; _spId = null;
}

function confirmScenePicker() {
  const items = document.querySelectorAll('#scenePickerList input[type=checkbox]:not(:disabled)');
  const toAdd = [], toRemove = [];
  items.forEach(cb => {
    const n = +cb.value, was = cb.dataset.was === '1';
    if (cb.checked && !was) toAdd.push(n);
    if (!cb.checked && was) toRemove.push(n);
  });

  let name, char, field, listField, renderFn;
  if (_spType === 'prop') {
    const p = propList.find(p => p.id === _spId); if (!p) { closeScenePicker(); return; }
    name = p.name;
    char = p.character || '';
    field = p.category === 'charProp' ? 'charPropItems' : 'setPropItems';
    listField = 'propList';
    renderFn = renderPropList;
  } else {
    const c = costumeList.find(c => c.id === _spId); if (!c) { closeScenePicker(); return; }
    name = c.name;
    char = c.character || '';
    field = c.category === 'costume' ? 'costumeItems' : 'makeupItems';
    listField = 'costumeList';
    renderFn = renderCostumeList;
  }

  toAdd.forEach(snum => {
    if (!sceneExtras[snum]) sceneExtras[snum] = {};
    if (!sceneExtras[snum][field]) sceneExtras[snum][field] = [];
    if (!sceneExtras[snum][field].some(i => getItemText(i) === name)) {
      const entry = char ? { text: name, char } : name;
      sceneExtras[snum][field].push(entry);
    }
    appendToListField(snum, listField, name);
  });

  toRemove.forEach(snum => {
    if (!sceneExtras[snum]?.[field]) return;
    const idx = sceneExtras[snum][field].findIndex(i => getItemText(i) === name);
    if (idx >= 0) sceneExtras[snum][field].splice(idx, 1);
    _deletionLog.addElem(snum, field, name); // Firestore merge 시 복원 방지
    removeFromListField(snum, listField, name);
    // 에디터 하이라이트도 제거
    const removeType = FIELD_TO_TYPE[field];
    if (removeType) removeElemSpanFromEditor(snum, removeType, name);
  });

  if (toAdd.length || toRemove.length) {
    save();
    renderFn();
    renderSidebar();
    renderBreakdown();
    renderSceneBd();
  }
  closeScenePicker();
}

// ── 소품리스트 드래그앤드롭 ──────────────────────────────
let _propDragId = null;

function propDragStart(e, id) {
  _propDragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.style.opacity = '0.45';
}

function propDragOver(e, id) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!_propDragId || _propDragId === id) return;
  const fromCat = propList.find(p => p.id === _propDragId)?.category;
  const toCat   = propList.find(p => p.id === id)?.category;
  if (fromCat !== toCat) return;
  document.getElementById('prop-row-' + id)?.classList.add('prop-drag-over');
}

function propDragLeave(e, id) {
  if (e.currentTarget.contains(e.relatedTarget)) return;
  document.getElementById('prop-row-' + id)?.classList.remove('prop-drag-over');
}

function propDrop(e, id) {
  e.preventDefault();
  document.querySelectorAll('.prop-table tr.prop-drag-over').forEach(r => r.classList.remove('prop-drag-over'));
  if (!_propDragId || _propDragId === id) { _propDragId = null; return; }
  const fromIdx = propList.findIndex(p => p.id === _propDragId);
  const toIdx   = propList.findIndex(p => p.id === id);
  if (fromIdx < 0 || toIdx < 0) { _propDragId = null; return; }
  if (propList[fromIdx].category !== propList[toIdx].category) { _propDragId = null; return; }
  const [moved] = propList.splice(fromIdx, 1);
  const newTo   = propList.findIndex(p => p.id === id);
  propList.splice(newTo, 0, moved);
  _propDragId = null;
  save();
  renderPropList();
}

function propDragEnd(e) {
  document.querySelectorAll('.prop-table tr').forEach(r => {
    r.classList.remove('prop-drag-over');
    r.style.opacity = '';
  });
  _propDragId = null;
}

// 씬브레이크다운 소품 칩 클릭 → 소품리스트로 이동 + 하이라이트
function linkToProp(name, category) {
  // 소품리스트 탭으로 전환
  switchListTab('proplist');

  requestAnimationFrame(() => {
    renderPropList();
    requestAnimationFrame(() => {
      // 1) propList에 등록된 항목 먼저 검색
      let row = document.querySelector(`#proplistWrap tr[data-prop-name="${name.replace(/"/g,'&quot;')}"]`);
      // 2) _auto 항목도 포함해서 검색
      if (!row) {
        document.querySelectorAll('#proplistWrap tr[data-prop-name]').forEach(r => {
          if (r.dataset.propName === name) row = r;
        });
      }
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('prop-highlighted', 'prop-pulse');
        setTimeout(() => row.classList.remove('prop-highlighted', 'prop-pulse'), 2000);
      }
    });
  });
}

// ══════════════════════════════════════════════════
// 의상/분장 리스트
// ══════════════════════════════════════════════════
function renderCostumeList() {
  const wrap = document.getElementById('costumelistWrap');
  if (!wrap) return;

  // 씬 정보 수집 (표시용)
  const sceneMap = { costume: {}, makeup: {} };
  Object.entries(sceneExtras).forEach(([snum, extra]) => {
    const sn  = parseInt(snum);
    const sc  = scenes.find(s => s.number === sn);
    const lbl = sc ? 'S#' + sc.displayNum : 'S#' + snum;
    (extra.costumeItems || []).forEach(item => {
      const n = getItemText(item); if (!n) return;
      if (!sceneMap.costume[n]) sceneMap.costume[n] = [];
      if (!sceneMap.costume[n].find(x => x.num === sn)) sceneMap.costume[n].push({ num: sn, label: lbl });
    });
    (extra.makeupItems || []).forEach(item => {
      const n = getItemText(item); if (!n) return;
      if (!sceneMap.makeup[n]) sceneMap.makeup[n] = [];
      if (!sceneMap.makeup[n].find(x => x.num === sn)) sceneMap.makeup[n].push({ num: sn, label: lbl });
    });
  });

  const esc2 = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const makeCosRow = (c, draggable) => {
    const catMap = { costume: sceneMap.costume, makeup: sceneMap.makeup };
    const scList = (catMap[c.category][c.name] || []).slice().sort((a,b) => a.num - b.num);
    const chips  = scList.map(s => `<span class="prop-scene-chip prop-scene-chip-manual">${esc2(s.label)}<button class="prop-scene-chip-del" onclick="removeCostumeSceneLink('${c.id}',${s.num})" title="씬 연결 해제">✕</button></span>`).join('');
    const scChips = `<div class="prop-scene-chips">${chips}<button class="prop-scene-add-btn" onclick="openScenePicker('costume','${c.id}')" title="씬 추가">+</button></div>`;
    const st  = c.status || '';
    const cls = st==='보유'?'s-ready':st==='제작중'?'s-making':'s-none';
    const dragAttrs = draggable
      ? `draggable="true" ondragstart="cosDragStart(event,'${c.id}')" ondragover="cosDragOver(event,'${c.id}')" ondragleave="cosDragLeave(event,'${c.id}')" ondrop="cosDrop(event,'${c.id}')" ondragend="cosDragEnd(event)"`
      : '';
    const dragCell = draggable
      ? `<td style="width:32px;text-align:center;padding:4px 2px"><span class="prop-drag-handle" title="드래그하여 순서 변경">⠿</span></td>`
      : `<td style="width:32px"></td>`;
    const statusCell = c.category === 'costume'
      ? `<select class="prop-status-sel ${cls}" onchange="updateCostumeStatus('${c.id}',this)">
          <option value="미보유" ${st==='미보유'?'selected':''}>미보유</option>
          <option value="제작중" ${st==='제작중'?'selected':''}>제작중</option>
          <option value="보유"   ${st==='보유'  ?'selected':''}>보유</option>
        </select>`
      : `<span style="color:var(--text-dim);font-size:11px">-</span>`;
    return `<tr id="cos-row-${c.id}" data-cos-id="${c.id}" data-cos-name="${esc2(c.name)}" ${dragAttrs}>
      ${dragCell}
      <td style="min-width:40px"><input class="prop-inp" value="${esc2(c.character||'')}" placeholder="인물명"
          onchange="updateCostumeField('${c.id}','character',this.value)"></td>
      <td style="min-width:200px">${scChips}</td>
      <td style="min-width:80px"><input class="prop-inp" value="${esc2(c.name||'')}" placeholder="의상/분장명"
          onchange="updateCostumeField('${c.id}','name',this.value)"></td>
      <td style="width:70px;text-align:center;padding:4px 6px">
        <select class="prop-status-sel s-none" style="font-size:11px;font-weight:700;font-family:inherit;border-radius:12px;padding:2px 7px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);cursor:pointer;outline:none;"
            onchange="updateCostumeField('${c.id}','category',this.value);renderCostumeList()">
          <option value="costume" ${c.category==='costume'?'selected':''}>의상</option>
          <option value="makeup"  ${c.category==='makeup' ?'selected':''}>분장</option>
        </select>
      </td>
      <td style="width:72px;text-align:center;padding:4px 6px">${statusCell}</td>
      <td style="min-width:280px"><input class="prop-inp" value="${esc2(c.desc||'')}" placeholder="설명"
          onchange="updateCostumeField('${c.id}','desc',this.value)"></td>
      <td style="width:40px;text-align:center">
        <button class="prop-del-btn" onclick="deleteCostume('${c.id}')" title="삭제">✕</button>
      </td>
    </tr>`;
  };

  const sortBtns = [['default','기본'],['char','인물별'],['category','구분별'],['status','상태별']].map(([val,lbl]) => {
    const on = costumeSort === val ? ' on' : '';
    return `<button class="prop-sort-btn${on}" onclick="setCostumeSort('${val}')">${lbl}</button>`;
  }).join('');

  const makeRows = () => {
    if (!costumeList.length) return `<tr class="prop-empty-row"><td colspan="8">의상/분장 정보가 없습니다. 씬브레이크다운에서 의상/분장을 추가하거나 직접 추가해 주세요.</td></tr>`;
    if (costumeSort === 'default') return costumeList.map(c => makeCosRow(c, true)).join('');

    const getKey = c => {
      if (costumeSort === 'char')     return c.character || '(미지정)';
      if (costumeSort === 'category') return c.category === 'costume' ? '의상' : '분장';
      if (costumeSort === 'status')   return c.category === 'makeup' ? '(분장)' : (c.status || '미보유');
      return '';
    };
    const statusOrder = { '미보유': 0, '제작중': 1, '보유': 2, '(분장)': 3 };
    const groups = {};
    costumeList.forEach(c => { const k = getKey(c); if (!groups[k]) groups[k] = []; groups[k].push(c); });
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (costumeSort === 'status') return (statusOrder[a] ?? 9) - (statusOrder[b] ?? 9);
      if (a === '(미지정)') return 1; if (b === '(미지정)') return -1;
      return a.localeCompare(b, 'ko');
    });
    return sortedKeys.map(key => {
      const rows = groups[key].map(c => makeCosRow(c, false)).join('');
      return `<tr class="prop-group-hdr"><td colspan="8">
        <span class="prop-group-label">${esc2(key)}</span>
        <span class="prop-group-count">${groups[key].length}개</span>
      </td></tr>` + rows;
    }).join('');
  };

  wrap.innerHTML = `
    <div class="prop-section">
      <div class="prop-section-header">
        <span class="prop-section-title" style="color:#a78bfa">👗 의상/분장</span>
        <span class="prop-count">${costumeList.length}개</span>
        <div style="display:flex;gap:5px;margin-left:8px">${sortBtns}</div>
        <button class="prop-add-btn" onclick="addCostume('costume')">+ 의상 추가</button>
        <button class="prop-add-btn" onclick="addCostume('makeup')" style="margin-left:4px">+ 분장 추가</button>
      </div>
      <table class="prop-table">
        <thead><tr>
          <th style="width:32px"></th>
          <th style="min-width:40px">인물</th>
          <th style="min-width:200px">씬</th>
          <th style="min-width:80px">의상/분장명</th>
          <th style="width:70px;text-align:center">구분</th>
          <th style="width:72px;text-align:center">상태</th>
          <th style="min-width:280px">설명</th>
          <th style="width:40px"></th>
        </tr></thead>
        <tbody>${makeRows()}</tbody>
      </table>
    </div>`;
}

function setCostumeSort(sort) { costumeSort = sort; renderCostumeList(); }

function addCostume(category) {
  const newCos = {
    id: 'cos_' + Date.now(),
    name: '', category,
    character: '',
    status: category === 'costume' ? '미보유' : '',
    desc: ''
  };
  costumeList.push(newCos);
  save();
  renderCostumeList();
  requestAnimationFrame(() => {
    const row = document.getElementById('cos-row-' + newCos.id);
    if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.querySelector('.prop-inp')?.focus(); }
  });
}

function deleteCostume(id) {
  const c = costumeList.find(c => c.id === id);
  if (!c) return;

  const field = c.category === 'costume' ? 'costumeItems' : 'makeupItems';
  const type  = FIELD_TO_TYPE[field]; // 'costume' | 'makeup'

  // sceneExtras에서 항목 제거 + 에디터 span 언래핑 (deleteProp와 동일 패턴)
  _deletionLog.addElemGlobal(field, c.name); // 모든 씬에서 Firestore merge 복원 방지
  for (const [snumKey, extra] of Object.entries(sceneExtras)) {
    if (!extra[field]) continue;
    const idx = extra[field].findIndex(i => getItemText(i) === c.name);
    if (idx < 0) continue;
    extra[field].splice(idx, 1);
    _deletionLog.addElem(snumKey, field, c.name); // 씬 단위 merge 복원 방지
    removeFromListField(snumKey, ITEMS_TO_LIST[field], c.name);
    removeElemSpanFromEditor(snumKey, type, c.name);
  }
  _deletionLog.addCostume(c.name, c.category); // costumeList merge 시 복원 방지

  costumeList = costumeList.filter(c => c.id !== id);
  save();
  renderCostumeList();
  renderSidebar();
  renderSceneBd();
  renderBreakdown();
}

function updateCostumeField(id, field, value) {
  const cos = costumeList.find(c => c.id === id);
  if (!cos) return;
  const oldName = cos.name;
  cos[field] = value;
  // 이름이 바뀌면 sceneExtras 안의 항목명도 동기화
  if (field === 'name' && value && value !== oldName) {
    const itemField = cos.category === 'costume' ? 'costumeItems' : 'makeupItems';
    for (const extra of Object.values(sceneExtras)) {
      if (!extra[itemField]) continue;
      extra[itemField].forEach(item => {
        if (typeof item === 'object' && getItemText(item) === oldName) item.text = value;
      });
      extra[itemField] = extra[itemField].map(item =>
        (typeof item === 'string' && item === oldName) ? value : item
      );
      extra[ITEMS_TO_LIST[itemField]] = extra[itemField].map(getItemText).filter(Boolean).join(', ');
    }
    renderSceneBd();
    renderBreakdown();
  }
  save();
}

function updateCostumeStatus(id, sel) {
  const cls = sel.value==='보유'?'s-ready':sel.value==='제작중'?'s-making':'s-none';
  sel.className = 'prop-status-sel ' + cls;
  updateCostumeField(id, 'status', sel.value);
}

function removeCostumeSceneLink(id, snum) {
  const c = costumeList.find(c => c.id === id); if (!c) return;
  const field = c.category === 'costume' ? 'costumeItems' : 'makeupItems';
  const type  = FIELD_TO_TYPE[field];
  if (sceneExtras[snum]?.[field]) {
    const idx = sceneExtras[snum][field].findIndex(i => getItemText(i) === c.name);
    if (idx >= 0) sceneExtras[snum][field].splice(idx, 1);
  }
  _deletionLog.addElem(snum, field, c.name); // Firestore merge 시 복원 방지
  removeFromListField(snum, ITEMS_TO_LIST[field], c.name);
  removeElemSpanFromEditor(snum, type, c.name);
  save(); renderCostumeList(); renderSidebar();
  renderBreakdown();
  renderSceneBd();
}

// 의상/분장 드래그앤드롭
let _cosDragId = null;
function cosDragStart(e, id) { _cosDragId = id; e.dataTransfer.effectAllowed = 'move'; e.currentTarget.style.opacity = '0.45'; }
function cosDragOver(e, id) {
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  if (!_cosDragId || _cosDragId === id) return;
  document.getElementById('cos-row-' + id)?.classList.add('prop-drag-over');
}
function cosDragLeave(e, id) {
  if (e.currentTarget.contains(e.relatedTarget)) return;
  document.getElementById('cos-row-' + id)?.classList.remove('prop-drag-over');
}
function cosDrop(e, id) {
  e.preventDefault();
  document.querySelectorAll('.prop-table tr.prop-drag-over').forEach(r => r.classList.remove('prop-drag-over'));
  if (!_cosDragId || _cosDragId === id) { _cosDragId = null; return; }
  const fromIdx = costumeList.findIndex(c => c.id === _cosDragId);
  const toIdx   = costumeList.findIndex(c => c.id === id);
  if (fromIdx < 0 || toIdx < 0) { _cosDragId = null; return; }
  const [moved] = costumeList.splice(fromIdx, 1);
  const newTo   = costumeList.findIndex(c => c.id === id);
  costumeList.splice(newTo, 0, moved);
  _cosDragId = null;
  save();
  renderCostumeList();
}
function cosDragEnd(e) {
  document.querySelectorAll('.prop-table tr').forEach(r => { r.classList.remove('prop-drag-over'); r.style.opacity = ''; });
  _cosDragId = null;
}

// 의상/분장 리스트 PDF 출력
function printCostumeList() {
  const project = document.getElementById('projectName')?.value || '의상분장리스트';
  const E = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  if (!costumeList.length) { alert('의상/분장 정보가 없습니다.'); return; }

  const cs  = `border:1px solid #bbb;padding:5px 8px;font-size:10px;vertical-align:top;word-break:break-word;`;
  const hs  = `${cs}background:#1a1a2e;color:#fff;font-weight:700;font-size:9px;text-align:center;white-space:nowrap;`;

  // 씬 수집
  const sceneMapPrint = { costume: {}, makeup: {} };
  Object.entries(sceneExtras).forEach(([snum, extra]) => {
    const sn = parseInt(snum); const sc = scenes.find(s => s.number === sn);
    const lbl = sc ? sc.displayNum : 'S#' + snum;
    (extra.costumeItems || []).forEach(item => { const n = getItemText(item); if (!n) return; if (!sceneMapPrint.costume[n]) sceneMapPrint.costume[n]=[]; if (!sceneMapPrint.costume[n].find(x=>x.num===sn)) sceneMapPrint.costume[n].push({num:sn,label:lbl}); });
    (extra.makeupItems  || []).forEach(item => { const n = getItemText(item); if (!n) return; if (!sceneMapPrint.makeup[n])  sceneMapPrint.makeup[n]=[]; if (!sceneMapPrint.makeup[n].find(x=>x.num===sn))  sceneMapPrint.makeup[n].push({num:sn,label:lbl}); });
  });

  const rows = costumeList.map(c => {
    const srcMap = c.category === 'costume' ? sceneMapPrint.costume : sceneMapPrint.makeup;
    const scTxt  = (srcMap[c.name] || []).slice().sort((a,b)=>a.num-b.num).map(s=>s.label).join(', ') || '-';
    const catLbl = c.category === 'costume' ? '의상' : '분장';
    const stLbl  = c.category === 'costume' ? E(c.status || '미보유') : '-';
    return `<tr>
      <td style="${cs}font-weight:600">${E(c.character||'-')}</td>
      <td style="${cs}">${E(scTxt)}</td>
      <td style="${cs}font-weight:600">${E(c.name||'-')}</td>
      <td style="${cs};text-align:center">${catLbl}</td>
      <td style="${cs};text-align:center">${stLbl}</td>
      <td style="${cs}">${E(c.desc||'')}</td>
    </tr>`;
  }).join('');

  const docHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${E(project)} — 의상/분장 리스트</title>
<style>
  @page { size: A4 landscape; margin: 12mm 10mm; }
  body { font-family: 'Malgun Gothic','Apple SD Gothic Neo',sans-serif; font-size:10px; margin:0; color:#111; }
  h2   { font-size:13px; margin:0 0 10px; }
  table { width:100%; border-collapse:collapse; table-layout:fixed; }
  @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head><body>
<h2>${E(project)} — 의상/분장 리스트</h2>
<table>
  <thead><tr>${['인물','씬','의상/분장명','구분','상태','설명'].map(h=>`<th style="${hs}">${h}</th>`).join('')}</tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
  const w = window.open('', '_blank');
  w.document.write(docHtml);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 600);
}

function renderLocList() {
  const wrap = document.getElementById('loclistWrap');
  if (!wrap) return;

  const locs = _getLocOrdered();

  // 장소별 등장 씬 수집
  const locScenes = {};
  scenes.forEach(s => {
    const lsn = new Set();
    if (s.loc) lsn.add(s.loc);
    (sceneExtras[s.number]?.locationItems || []).forEach(item => {
      const n = getItemText(item); if (n) lsn.add(n);
    });
    lsn.forEach(loc => {
      if (!locScenes[loc]) locScenes[loc] = [];
      if (!locScenes[loc].includes(s)) locScenes[loc].push(s);
    });
  });

  // 장소 통계 계산 및 표시
  const _locStat = () => {
    const total   = locs.length;
    const intLocs = locs.filter(l => (locScenes[l]||[]).some(s => s.ie === 'INT')).length;
    const extLocs = locs.filter(l => (locScenes[l]||[]).some(s => s.ie === 'EXT')).length;
    const dayLocs = locs.filter(l => (locScenes[l]||[]).some(s => s.time === 'day' || s.time === 'dawn')).length;
    const nitLocs = locs.filter(l => (locScenes[l]||[]).some(s => s.time === 'night' || s.time === 'eve')).length;
    const sb = document.getElementById('locStatsBar');
    if (sb) sb.innerHTML = `
      <div class="stat"><div class="stat-v">${total}</div><div class="stat-l">전체 장소</div></div>
      <div class="stat"><div class="stat-v" style="color:#60a5fa">${intLocs}</div><div class="stat-l">실내 장소</div></div>
      <div class="stat"><div class="stat-v" style="color:#34d399">${extLocs}</div><div class="stat-l">실외 장소</div></div>
      <div class="stat"><div class="stat-v" style="color:#fbbf24">${dayLocs}</div><div class="stat-l">주간 장소</div></div>
      <div class="stat"><div class="stat-v" style="color:#a5b4fc">${nitLocs}</div><div class="stat-l">야간 장소</div></div>`;
  };
  _locStat();

  if (!locs.length) {
    wrap.innerHTML = `<div class="empty" style="padding:60px 24px">
      <div class="empty-icon">📍</div>
      <div>스크립트를 입력하면 씬 헤딩의 장소가 표시됩니다<br>
      스크립트에서 텍스트를 선택 후 <b>+장소</b>를 클릭하면 직접 추가할 수도 있습니다</div></div>`;
    return;
  }

  const DN_KO = { day:'낮', night:'밤', dawn:'새벽', eve:'저녁' };
  const IE_KO = { INT:'INT', EXT:'EXT', 'INT/EXT':'I/E', 'EXT/INT':'E/I' };

  const allRows = locs.map(loc => {
    const info   = locationInfo[loc] || {};
    const scList = (locScenes[loc] || []).slice().sort((a, b) => a.number - b.number);
    const span   = Math.max(scList.length, 1);
    const locEsc = esc(loc);

    // 장소 rowspan 셀 (첫 행에만)
    const handleCell = `<td class="loc-drag-cell" rowspan="${span}" style="border-right:1px solid var(--border2)">
        <span class="loc-drag-handle" draggable="true"
          ondragstart="locRowDragStart(event,'${locEsc}')" title="드래그하여 순서 변경">⠿</span>
      </td>`;
    const nameCell = `<td class="loc-name-cell" rowspan="${span}" style="border-right:2px solid var(--border2)">
        📍 ${locEsc}
      </td>`;
    const descCell = `<td rowspan="${span}" style="min-width:140px;border-left:1px solid var(--border2);padding:0;height:1px">
        <textarea class="loc-ta" placeholder="장소 설명..."
          style="height:100%;min-height:48px;resize:none;border-radius:0;border-color:transparent"
          onchange="setLocDesc('${locEsc}',this.value)">${esc(info.description||'')}</textarea>
      </td>`;
    const addrCell = `<td rowspan="${span}" style="min-width:150px;padding:0;height:1px">
        <textarea class="loc-ta" placeholder="실제 촬영지..."
          style="height:100%;min-height:48px;resize:none;border-radius:0;border-color:transparent"
          onchange="setLocAddress('${locEsc}',this.value)">${esc(info.address||'')}</textarea>
      </td>`;

    if (!scList.length) {
      // 씬 없는 장소: 한 행으로
      return `<tr data-loc="${locEsc}" id="loc-row-${encodeURIComponent(loc)}"
          ondragover="locRowDragOver(event)" ondragleave="locRowDragLeave(event)" ondrop="locRowDrop(event,'${locEsc}')">
        ${handleCell}${nameCell}
        <td style="color:var(--text-dim);font-size:11px;text-align:center">-</td>
        <td style="color:var(--text-dim);font-size:11px;text-align:center">-</td>
        <td style="color:var(--text-dim);font-size:11px;text-align:center">-</td>
        <td style="color:var(--text-dim);font-size:11px;text-align:center">-</td>
        ${descCell}${addrCell}
      </tr>`;
    }

    return scList.map((s, i) => {
      const dn = DN_KO[s.time] || s.time || '-';
      const ie = IE_KO[s.ie]  || s.ie  || '-';
      const synopsis = esc(sceneNotes[s.number] || '');
      const isFirst  = i === 0;
      const dnBg = { '낮':'rgba(251,191,36,.12)', '밤':'rgba(99,102,241,.12)',
                     '새벽':'rgba(96,165,250,.1)', '저녁':'rgba(251,146,60,.1)' }[dn] || '';
      const ieBg = { 'INT':'rgba(52,211,153,.08)', 'EXT':'rgba(248,113,113,.08)',
                     'I/E':'rgba(148,163,184,.1)', 'E/I':'rgba(148,163,184,.1)' }[ie] || '';
      return `<tr data-loc="${locEsc}"
          ${isFirst ? `id="loc-row-${encodeURIComponent(loc)}"` : ''}
          ondragover="locRowDragOver(event)" ondragleave="locRowDragLeave(event)" ondrop="locRowDrop(event,'${locEsc}')">
        ${isFirst ? handleCell + nameCell : ''}
        <td style="text-align:center;font-weight:700;color:#fff;white-space:nowrap">
          S#${esc(String(s.displayNum||s.number))}
        </td>
        <td style="text-align:center;background:${dnBg}">
          <span class="loc-dn-chip">${esc(dn)}</span>
        </td>
        <td style="text-align:center;background:${ieBg}">
          <span class="loc-dn-chip">${esc(ie)}</span>
        </td>
        <td style="min-width:140px;color:var(--text-muted);font-size:12.5px;line-height:1.5">
          ${synopsis || `<span style="color:var(--text-dim);font-size:11px">씬브레이크다운에서 자동 입력</span>`}
        </td>
        ${isFirst ? descCell + addrCell : ''}
      </tr>`;
    }).join('');
  }).join('');

  wrap.innerHTML = `<div class="loc-table-wrap">
    <table class="loc-table">
      <thead><tr>
        <th style="width:28px"></th>
        <th style="min-width:110px">장소명</th>
        <th style="width:70px;text-align:center">씬#</th>
        <th style="width:65px;text-align:center">D/N</th>
        <th style="width:65px;text-align:center">I/E</th>
        <th style="min-width:160px">장면내용</th>
        <th style="min-width:140px">장소설명</th>
        <th style="min-width:150px">실제 촬영지</th>
      </tr></thead>
      <tbody>${allRows}</tbody>
    </table>
  </div>`;
}

function setLocAddress(loc, val) {
  if (!locationInfo[loc]) locationInfo[loc] = { address: '', setPropItems: [] };
  locationInfo[loc].address = val;
  save();
}

function setLocDesc(loc, val) {
  if (!locationInfo[loc]) locationInfo[loc] = { address: '', setPropItems: [] };
  locationInfo[loc].description = val;
  save();
}

function setLocSceneContent(loc, val) {
  if (!locationInfo[loc]) locationInfo[loc] = { address: '', setPropItems: [] };
  locationInfo[loc].sceneContent = val;
  save();
}

function addLocProp(loc) {
  const input = document.getElementById('lpi-' + encodeURIComponent(loc));
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!locationInfo[loc]) locationInfo[loc] = { address: '', setPropItems: [] };
  if (!locationInfo[loc].setPropItems) locationInfo[loc].setPropItems = [];
  if (!locationInfo[loc].setPropItems.some(i => getItemText(i) === text)) {
    locationInfo[loc].setPropItems.push(text);
  }
  input.value = '';
  save();
  renderLocList();
}

// ── 확인 모달 ─────────────────────────────────────
function showConfirmModal(msg, onYes) {
  document.getElementById('confirmModalMsg').textContent = msg;
  const yesBtn = document.getElementById('confirmModalYes');
  yesBtn.onclick = () => { closeConfirmModal(); onYes(); };
  document.getElementById('confirmModal').classList.add('open');
}
function closeConfirmModal() {
  document.getElementById('confirmModal').classList.remove('open');
}

// ── 씬리스트 소품 칩 삭제 (charProp/setProp 완전 연동) ──────
function bdRemoveProp(snum, text) {
  removeFromListField(snum, 'propList', text);
  const extra = sceneExtras[snum] || {};
  const ci = (extra.charPropItems || []).findIndex(i => getItemText(i) === text);
  if (ci >= 0) {
    extra.charPropItems.splice(ci, 1);
    removeElemSpanFromEditor(snum, 'charProp', text);
  }
  const si = (extra.setPropItems || []).findIndex(i => getItemText(i) === text);
  if (si >= 0) {
    extra.setPropItems.splice(si, 1);
    removeElemSpanFromEditor(snum, 'setProp', text);
    const scene = scenes.find(s => s.number === snum);
    const locSet = new Set();
    if (scene?.loc) locSet.add(scene.loc);
    (extra.locationItems || []).forEach(item => { const n = getItemText(item); if (n) locSet.add(n); });
    locSet.forEach(loc => {
      if (!locationInfo[loc]?.setPropItems) return;
      const li = locationInfo[loc].setPropItems.findIndex(i => getItemText(i) === text);
      if (li >= 0) locationInfo[loc].setPropItems.splice(li, 1);
    });
  }
  save();
  renderBreakdown();
  if (document.getElementById('tab-scenebd')?.classList.contains('on')) renderSceneBd();
  if (document.getElementById('tab-loclist')?.classList.contains('on'))  renderLocList();
}

// ── 씬리스트 소품 수동 추가 (경고 팝업) ──────────────────────
function bdAddProp(snum) {
  const input = document.getElementById(`bdpi-${snum}`);
  const text = input?.value.trim();
  if (!text) return;
  input.value = '';
  showConfirmModal(
    '씬리스트에서 수동 추가된 항목은 씬브레이크다운과 장소리스트에는 추가되지 않습니다.\n그래도 추가하시겠습니까?',
    () => {
      appendToListField(snum, 'propList', text);
      save();
      renderBreakdown();
    }
  );
}

// ── 장소리스트 소품 삭제 (씬브레이크다운 + 스크립트 연동) ────
function removeLocPropFull(loc, idx) {
  if (!locationInfo[loc]?.setPropItems) return;
  const text = getItemText(locationInfo[loc].setPropItems[idx]);
  locationInfo[loc].setPropItems.splice(idx, 1);
  scenes.forEach(s => {
    const snum  = s.number;
    const extra = sceneExtras[snum] || {};
    const locSet = new Set();
    if (s.loc) locSet.add(s.loc);
    (extra.locationItems || []).forEach(item => { const n = getItemText(item); if (n) locSet.add(n); });
    if (!locSet.has(loc)) return;
    const pi = (extra.setPropItems || []).findIndex(i => getItemText(i) === text);
    if (pi >= 0) {
      extra.setPropItems.splice(pi, 1);
      removeFromListField(snum, 'propList', text);
      removeElemSpanFromEditor(snum, 'setProp', text);
    }
  });
  save();
  renderLocList();
  renderBreakdown();
  if (document.getElementById('tab-scenebd')?.classList.contains('on')) renderSceneBd();
}

function removeLocProp(loc, idx) {
  if (!locationInfo[loc]?.setPropItems) return;
  locationInfo[loc].setPropItems.splice(idx, 1);
  save();
  renderLocList();
}

// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// 컬럼 리사이즈 (스태프·배우 공용)
// ══════════════════════════════════════════════════
function applyColResize(tableEl, storageKey) {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
  const ths = [...tableEl.querySelectorAll('thead th')];
  ths.forEach((th, idx) => {
    // 드래그 열·삭제 열은 제외
    if (th.style.width === '32px' || th.style.width === '28px') return;
    // 저장된 너비 복원
    if (saved[idx]) th.style.width = saved[idx] + 'px';
    // 핸들 생성
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = th.offsetWidth;
      handle.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      const onMove = ev => {
        const newW = Math.max(50, startW + ev.clientX - startX);
        th.style.width = newW + 'px';
      };
      const onUp = ev => {
        const newW = Math.max(50, startW + ev.clientX - startX);
        saved[idx] = newW;
        localStorage.setItem(storageKey, JSON.stringify(saved));
        handle.classList.remove('resizing');
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// 제작진 — 스태프 리스트
// ══════════════════════════════════════════════════
let _staffDragSrcIdx = null;

function renderStaffList() {
  const wrap = document.getElementById('stafflistWrap');
  if (!wrap) return;
  const esc2 = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  if (!staffList.length) {
    wrap.innerHTML = `<div class="empty" style="padding:40px 0"><div class="empty-icon">👥</div><div>스태프가 없습니다</div></div>`;
    return;
  }
  const rows = staffList.map((s, i) => `
    <tr class="crew-row" data-idx="${i}" draggable="true"
      ondragstart="staffDragStart(event,${i})" ondragover="staffDragOver(event,${i})"
      ondragleave="staffDragLeave(event,${i})" ondrop="staffDrop(event,${i})"
      ondragend="staffDragEnd(event)">
      <td class="crew-td crew-td-drag"><span class="crew-drag-handle">⠿</span></td>
      <td class="crew-td crew-td-dept"><input class="crew-inp" value="${esc2(s.dept)}" placeholder="부서" onchange="updateStaff(${i},'dept',this.value)"></td>
      <td class="crew-td crew-td-role"><input class="crew-inp" value="${esc2(s.role)}" placeholder="역할" onchange="updateStaff(${i},'role',this.value)"></td>
      <td class="crew-td crew-td-detail-role"><input class="crew-inp" value="${esc2(s.detailRole)}" placeholder="세부역할" onchange="updateStaff(${i},'detailRole',this.value)"></td>
      <td class="crew-td crew-td-name"><input class="crew-inp" value="${esc2(s.name)}" placeholder="이름" onchange="updateStaff(${i},'name',this.value)"></td>
      <td class="crew-td crew-td-phone"><input class="crew-inp" value="${esc2(s.phone)}" placeholder="연락처" onchange="updateStaff(${i},'phone',this.value)"></td>
      <td class="crew-td crew-td-email"><input class="crew-inp" value="${esc2(s.email)}" placeholder="이메일" onchange="updateStaff(${i},'email',this.value)"></td>
      <td class="crew-td"><input class="crew-inp" value="${esc2(s.note)}" placeholder="메모" onchange="updateStaff(${i},'note',this.value)"></td>
      <td class="crew-td crew-td-del"><button class="crew-del-btn" onclick="deleteStaff(${i})" title="삭제">✕</button></td>
    </tr>`).join('');
  wrap.innerHTML = `<table class="crew-table">
    <thead><tr>
      <th class="crew-th" style="width:32px"></th>
      <th class="crew-th">부서</th><th class="crew-th">역할</th><th class="crew-th">세부역할</th>
      <th class="crew-th">이름</th><th class="crew-th">연락처</th><th class="crew-th">이메일</th>
      <th class="crew-th">메모</th><th class="crew-th" style="width:32px"></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  const tbl = wrap.querySelector('.crew-table');
  if (tbl) applyColResize(tbl, 'staffColWidths');
}
function resetStaffToDefault() {
  if (!confirm('스태프 리스트를 기본값으로 초기화하시겠습니까?\n이름·연락처·이메일·메모 등 입력된 내용이 모두 삭제됩니다.')) return;
  staffList = _defaultStaff();
  save(); renderStaffList();
}
function addStaffRow() {
  staffList.push({ id: _crewId(), dept: '', role: '', detailRole: '', name: '', phone: '', email: '', note: '' });
  save(); renderStaffList();
  setTimeout(() => {
    const rows = document.querySelectorAll('#stafflistWrap .crew-row');
    rows[rows.length-1]?.querySelector('.crew-inp')?.focus();
  }, 50);
}
function deleteStaff(idx) { staffList.splice(idx, 1); save(); renderStaffList(); }
function updateStaff(idx, field, val) { if (staffList[idx]) { staffList[idx][field] = val; save(); } }
function staffDragStart(e, idx) { _staffDragSrcIdx = idx; e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('drag-moving'); }
function staffDragOver(e, idx)  { e.preventDefault(); if (_staffDragSrcIdx === null || _staffDragSrcIdx === idx) return; e.currentTarget.classList.add('drag-over'); }
function staffDragLeave(e)      { e.currentTarget.classList.remove('drag-over'); }
function staffDragEnd(e)        { e.currentTarget.classList.remove('drag-moving'); document.querySelectorAll('#stafflistWrap .crew-row').forEach(r=>r.classList.remove('drag-over','drag-moving')); _staffDragSrcIdx = null; }
function staffDrop(e, toIdx) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  if (_staffDragSrcIdx === null || _staffDragSrcIdx === toIdx) return;
  const [item] = staffList.splice(_staffDragSrcIdx, 1);
  staffList.splice(toIdx, 0, item);
  _staffDragSrcIdx = null; save(); renderStaffList();
}

// ══════════════════════════════════════════════════
// 제작진 — 배우 리스트
// ══════════════════════════════════════════════════
let _actorDragSrcIdx = null;

function renderActorList() {
  const wrap = document.getElementById('actorlistWrap');
  if (!wrap) return;
  const esc2 = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  if (!actorList.length) {
    wrap.innerHTML = `<div class="empty" style="padding:40px 0"><div class="empty-icon">🎭</div><div>배우가 없습니다<br><span style="font-size:12px;color:var(--text-dim)">+ 행 추가로 등록하세요</span></div></div>`;
    return;
  }
  const rows = actorList.map((a, i) => `
    <tr class="crew-row" data-idx="${i}" draggable="true"
      ondragstart="actorDragStart(event,${i})" ondragover="actorDragOver(event,${i})"
      ondragleave="actorDragLeave(event,${i})" ondrop="actorDrop(event,${i})"
      ondragend="actorDragEnd(event)">
      <td class="crew-td crew-td-drag"><span class="crew-drag-handle">⠿</span></td>
      <td class="crew-td crew-td-actor-char"><input class="crew-inp" value="${esc2(a.character)}" placeholder="배역명" onchange="updateActor(${i},'character',this.value)"></td>
      <td class="crew-td crew-td-actor-name"><input class="crew-inp" value="${esc2(a.name)}" placeholder="배우명" onchange="updateActor(${i},'name',this.value)"></td>
      <td class="crew-td crew-td-actor-agency"><input class="crew-inp" value="${esc2(a.agency)}" placeholder="소속사" onchange="updateActor(${i},'agency',this.value)"></td>
      <td class="crew-td crew-td-phone"><input class="crew-inp" value="${esc2(a.phone)}" placeholder="연락처1" onchange="updateActor(${i},'phone',this.value)"></td>
      <td class="crew-td crew-td-phone"><input class="crew-inp" value="${esc2(a.phone2)}" placeholder="연락처2" onchange="updateActor(${i},'phone2',this.value)"></td>
      <td class="crew-td"><input class="crew-inp" value="${esc2(a.note)}" placeholder="메모" onchange="updateActor(${i},'note',this.value)"></td>
      <td class="crew-td crew-td-del"><button class="crew-del-btn" onclick="deleteActor(${i})" title="삭제">✕</button></td>
    </tr>`).join('');
  wrap.innerHTML = `<table class="crew-table">
    <thead><tr>
      <th class="crew-th" style="width:32px"></th>
      <th class="crew-th">배역명</th><th class="crew-th">배우명</th>
      <th class="crew-th">소속사</th><th class="crew-th">연락처1</th>
      <th class="crew-th">연락처2</th><th class="crew-th">메모</th>
      <th class="crew-th" style="width:32px"></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  const tbl = wrap.querySelector('.crew-table');
  if (tbl) applyColResize(tbl, 'actorColWidths');
}
function addActorRow() {
  actorList.push({ id: _crewId(), character: '', name: '', agency: '', phone: '', phone2: '', note: '' });
  save(); renderActorList();
  setTimeout(() => {
    const rows = document.querySelectorAll('#actorlistWrap .crew-row');
    rows[rows.length-1]?.querySelector('.crew-inp')?.focus();
  }, 50);
}
function deleteActor(idx) { actorList.splice(idx, 1); save(); renderActorList(); }
function updateActor(idx, field, val) { if (actorList[idx]) { actorList[idx][field] = val; save(); } }
function actorDragStart(e, idx) { _actorDragSrcIdx = idx; e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('drag-moving'); }
function actorDragOver(e, idx)  { e.preventDefault(); if (_actorDragSrcIdx === null || _actorDragSrcIdx === idx) return; e.currentTarget.classList.add('drag-over'); }
function actorDragLeave(e)      { e.currentTarget.classList.remove('drag-over'); }
function actorDragEnd(e)        { e.currentTarget.classList.remove('drag-moving'); document.querySelectorAll('#actorlistWrap .crew-row').forEach(r=>r.classList.remove('drag-over','drag-moving')); _actorDragSrcIdx = null; }
function actorDrop(e, toIdx) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  if (_actorDragSrcIdx === null || _actorDragSrcIdx === toIdx) return;
  const [item] = actorList.splice(_actorDragSrcIdx, 1);
  actorList.splice(toIdx, 0, item);
  _actorDragSrcIdx = null; save(); renderActorList();
}

// ══════════════════════════════════════════════════
// PDF 출력
// ══════════════════════════════════════════════════
function printScript() {
  const project   = document.getElementById('projectName').value || '스크립트';
  const author    = document.getElementById('authorName').value;
  const date      = document.getElementById('projectDate').value || new Date().toLocaleDateString('ko-KR');
  const editorHTML = ed().innerHTML;   // 실제 DOM 그대로 복사
  const escAttr   = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const pageNumberContent = pageNumberStyle === 'total'
    ? 'counter(page) "/" counter(pages)'
    : pageNumberStyle === 'single'
      ? 'counter(page)'
      : 'none';

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>${escAttr(project)}</title>
    <style>
      @page {
        size: A4;
        margin: 25mm 30mm;
        @bottom-center {
          content: ${pageNumberContent};
          color: #555;
          font-family: '맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;
          font-size: 9pt;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; padding: 25mm 30mm; background: #fff; color: #000;
        font-family: '맑은 고딕','Malgun Gothic','Apple SD Gothic Neo',sans-serif;
        font-size: 10pt; line-height: 1.8;
        max-width: 210mm;
      }
      @media print {
        body { padding: 0; max-width: none; }
      }
      /* 타이틀 페이지 */
      .title-page { text-align: center; padding-top: 35vh; page-break-after: always; }
      .title-page h1 { font-size: 18pt; font-weight: bold; margin: 0 0 .4em; }
      .title-page .sub { font-size: 11pt; color: #555; margin: .2em 0; }

      /* 스크립트 본문 — 화면 CSS와 동일한 값 적용 */
      .script-body * { color: #000 !important; }   /* 글씨색 모두 검정 */
      .script-body p { margin: 0; min-height: 1.8em; }
      .l-heading  { font-weight: 700; text-decoration: underline;
                    page-break-after: avoid; break-after: avoid; }
      .l-action   { }
      .l-char     { padding-left: 35%; font-weight: 600;
                    page-break-after: avoid; break-after: avoid; }
      .l-dialogue { padding-left: 20%; padding-right: 15%;
                    page-break-inside: avoid; break-inside: avoid;
                    page-break-before: avoid; break-before: avoid; }
    </style>
  </head><body>
    <div class="title-page">
      <h1>${escAttr(project)}</h1>
      ${author ? `<div class="sub">${escAttr(author)}</div>` : ''}
      <div class="sub">${escAttr(date)}</div>
    </div>
    <div class="script-body">${editorHTML}</div>
  </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

// ══════════════════════════════════════════════════
// Word 출력
// ══════════════════════════════════════════════════
function exportWord() {
  const project = document.getElementById('projectName').value || '스크립트';
  const author  = document.getElementById('authorName').value;
  const date    = document.getElementById('projectDate').value || new Date().toLocaleDateString('ko-KR');
  const paras   = ed().querySelectorAll('p');

  const esc2 = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  let body = '';
  paras.forEach(p => {
    const type = p.dataset.type || 'action';
    const text = p.textContent.trim();
    if (!text) { body += '<p style="margin:0;font-size:10pt;line-height:1.8;">&nbsp;</p>'; return; }
    const styles = {
      heading:  'font-weight:bold;text-decoration:underline;margin:0;',
      action:   'margin:0;',
      char:     'text-align:center;font-weight:bold;margin:0;',
      dialogue: 'margin-left:24%;margin-right:16%;margin-top:0;margin-bottom:0;',
    };
    body += `<p style="font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10pt;line-height:1.8;${styles[type]||''}">${esc2(text)}</p>`;
  });

  const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset="utf-8">
<style>@page{size:A4;margin:25mm 30mm;}body{font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10pt;color:#000;background:#fff;}</style>
</head><body>
<div style="text-align:center;padding-top:35vh;page-break-after:always">
  <h1 style="font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:14pt;font-weight:bold">${esc2(project)}</h1>
  ${author?`<p style="font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10pt">${esc2(author)}</p>`:''}
  <p style="font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:10pt;color:#555">${esc2(date)}</p>
</div>
${body}
</body></html>`;

  const blob = new Blob(['\ufeff' + html], { type: 'application/msword' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${project}.doc`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ══════════════════════════════════════════════════
// 데이터관리 드롭다운
// ══════════════════════════════════════════════════
function toggleDataMgmt(e) {
  e.stopPropagation();
  document.getElementById('dataMgmtDropdown')?.classList.toggle('open');
}
function closeDataMgmt() {
  document.getElementById('dataMgmtDropdown')?.classList.remove('open');
}
document.addEventListener('click', function() { closeDataMgmt(); });

// ══════════════════════════════════════════════════
// 백업 / 복원
// ══════════════════════════════════════════════════
function backupProject() {
  normalizeListState();
  const project = document.getElementById('projectName').value || '스크립트';
  const data = {
    version: 1,
    scriptHtml:        ed().innerHTML,
    projectName:       document.getElementById('projectName').value,
    authorName:        document.getElementById('authorName').value,
    projectDate:       document.getElementById('projectDate').value,
    sched:             sched,
    schedDays:         schedDays,
    charNotes:         charNotes,
    charInfo:          charInfo,
    manualCharsByScene:manualCharsByScene,
    sceneNotes:        sceneNotes,
    sceneExtras:       sceneExtras,
    csLabels:          csLabels,
    globalChars:       globalChars,
    charOrder:         charOrder,
    hiddenChars:       hiddenChars,
    callSheets:        callSheets,
    lastCSNum:         csGet()?.csNum ?? null,
    calMonth:          calMonth.getTime(),
    locationInfo:      locationInfo,
    locationOrder:     locationOrder,
    propList:          propList,
    costumeList:       costumeList,
    pageNumberStyle:   pageNumberStyle
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${project}_backup.json`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function restoreProject(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      const htmlContent = data.scriptHtml || data.html || '';
      if (!htmlContent) { alert('올바른 백업 파일이 아닙니다.\n(scriptHtml 또는 html 필드 없음)'); return; }
      if (window.DPEditor?.isReady()) {
        DPEditor.setContent(htmlContent);
      } else {
        ed().innerHTML = htmlContent;
        ed().querySelectorAll('.l-heading,.l-action,.l-char,.l-dialogue').forEach(el => {
          el.style.fontFamily = '';
          el.style.fontSize   = '';
          el.style.fontWeight = '';
          el.style.lineHeight = '';
          el.style.textAlign  = '';
          el.style.marginTop  = '';
          el.style.marginBottom = '';
        });
      }
	      sched                       = data.sched             || {};
	      schedDays                   = data.schedDays         || {};
	      charNotes                   = data.charNotes         || {};
	      charInfo                    = data.charInfo          || {};
	      manualCharsByScene          = data.manualCharsByScene|| data.manualChars || {};
	      sceneNotes                  = data.sceneNotes        || {};
	      sceneExtras                 = data.sceneExtras       || {};
	      csLabels                    = data.csLabels          || {};
	      globalChars                 = data.globalChars       || [];
	      charOrder                   = data.charOrder         || [];
	      hiddenChars                 = data.hiddenChars       || [];
	      callSheets                  = data.callSheets        || [];
	      locationInfo                = data.locationInfo      || {};
      locationOrder               = data.locationOrder     || [];
      propList                    = ensureArray(data.propList);
      costumeList                 = ensureArray(data.costumeList);
      pageNumberStyle             = data.pageNumberStyle   || null;
      if (data.calMonth)    calMonth = new Date(data.calMonth);
      if (data.month)       calMonth = new Date(data.month);
      if (data.projectName || data.project) document.getElementById('projectName').value = data.projectName || data.project || '';
      if (data.authorName  || data.author)  document.getElementById('authorName').value  = data.authorName  || data.author  || '';
      if (data.projectDate || data.date)    document.getElementById('projectDate').value  = data.projectDate || data.date   || '';
      onEditorInput();
      updateHeaderDisplay();
      refreshTypeUI();
      checkEditorEmpty();
      _currentFileName = document.getElementById('projectName').value || _currentFileName || '새 프로젝트';
      if (!_currentProjectId) _myRole = 'owner';
      updateSidebarRoleBadge();
      document.getElementById('projectsOverlay')?.classList.add('hidden');
      switchTab('editor', document.querySelector('.nav-btn'));
      _dataLoaded = true;
      // Firestore 저장 후 최근 목록 등록 (doSave 내부에서 _currentProjectId 확정됨)
      doSave().then(() => {
        addRecentProject(_currentFileName, _currentProjectId);
      }).catch(() => {});
      closeSidebarUserPopup();
      alert('백업 파일을 성공적으로 불러왔습니다.');
    } catch(err) {
      alert('파일을 읽는 중 오류가 발생했습니다: ' + err.message);
    }
    input.value = '';
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════════════════
// 저장 / 로드 (Firestore)
// ══════════════════════════════════════════════════
let _saveTimer = null;
let _dataLoaded = false; // load() 완료 전에는 절대 저장하지 않음

// 저장 횟수 카운터 — 프로젝트별로 localStorage에 유지 (세션 간 누적)
function _getSaveCountKey() {
  return `dpre-savecount-${_currentFileName || 'default'}`;
}
function _getSaveCount() {
  return parseInt(localStorage.getItem(_getSaveCountKey()) || '0', 10);
}
function _incSaveCount() {
  const v = _getSaveCount() + 1;
  localStorage.setItem(_getSaveCountKey(), String(v));
  return v;
}

// 타이핑할 때마다 즉시 저장하면 Firestore 쓰기 횟수가 많아지므로
// 마지막 입력 후 1.5초 뒤에 한 번만 저장합니다
function save() {
  if (!auth.currentUser || !_dataLoaded || _suppressSave) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(doSave, 1500);
}

// ── 페이지 이탈·새로고침 직전 즉시 저장 ──────────
// 디바운스 타이머가 남아 있을 때 새로고침하면 데이터가 유실될 수 있으므로
// beforeunload와 visibilitychange(탭 숨김) 시점에 즉시 doSave() 를 호출합니다.
// Firebase Persistence(IndexedDB)가 활성화되어 있어, 네트워크 완료 전
// 페이지가 닫혀도 다음 세션에서 자동으로 재전송됩니다.
window.addEventListener('beforeunload', () => {
  if (!auth.currentUser) return;
  clearTimeout(_saveTimer);
  _saveTimer = null;
  doSave();
  presenceLeave().catch(() => {});
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && auth.currentUser) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    doSave();
  }
});

async function doSave() {
  if (!auth.currentUser || !_dataLoaded) return;
  normalizeListState();

  const data = {
    html:        window.DPEditor?.isReady() ? DPEditor.getContent() : ed().innerHTML,
    sched, schedDays,
    project:     document.getElementById('projectName').value,
    author:      document.getElementById('authorName').value,
    date:        document.getElementById('projectDate').value,
    adPhone:     projectAdPhone,
    pdPhone:     projectPdPhone,
    charNotes, charInfo, manualChars: manualCharsByScene,
    sceneNotes, sceneExtras, csLabels, globalChars, charOrder, hiddenChars,
    callSheets,  lastCSNum: csGet()?.csNum ?? null,
    locationInfo, locationOrder, propList, costumeList,
    staffList, actorList,
    pageNumberStyle,
    month:       calMonth.getTime(),
    savedAt:     new Date().toISOString(),
    _deletions:  _deletionLog.toFirestore(), // 다른 계정이 삭제 로그를 수신해 복원 방지
  };

  try {
    await fsStoreSave(_currentFileName || '새 프로젝트', data);
    rememberCurrentProject(_currentFileName || data.project || '새 프로젝트', _currentProjectId);
  } catch(e) {
    showToast('저장 실패: ' + e.message);
    console.error('Firestore 저장 오류:', e);
    return;
  }
  const cnt = _incSaveCount();
  if (cnt % VERSION_SAVE_INTERVAL === 0) saveVersionSnapshot(data).catch(e => console.warn('버전 저장 오류:', e));
}

// ── 최근 프로젝트 관리 ──────────────────────────
function _recentKey() {
  const u = auth.currentUser;
  return u ? `dpre-recent-${u.uid}` : 'dpre-recent';
}
function getRecentProjects() {
  try { return JSON.parse(localStorage.getItem(_recentKey()) || '[]'); } catch { return []; }
}
function addRecentProject(name, projectId = null) {
  const list = getRecentProjects().filter(p => p.projectId !== projectId);
  list.unshift({ name, projectId, openedAt: new Date().toISOString() });
  localStorage.setItem(_recentKey(), JSON.stringify(list.slice(0, 15)));
}
function _currentProjectMemoryKey() {
  const u = auth.currentUser;
  return u ? `dpre-current-project-${u.uid}` : 'dpre-current-project';
}
function rememberCurrentProject(name, projectId) {
  if (!auth.currentUser || !projectId) return;
  localStorage.setItem(_currentProjectMemoryKey(), JSON.stringify({
    name: name || '프로젝트',
    projectId,
    openedAt: new Date().toISOString()
  }));
}
function getCurrentProjectMemory() {
  try { return JSON.parse(localStorage.getItem(_currentProjectMemoryKey()) || 'null'); } catch { return null; }
}
function clearCurrentProjectMemory() {
  localStorage.removeItem(_currentProjectMemoryKey());
}
function removeRecentProject(idx) {
  const list = getRecentProjects();
  list.splice(idx, 1);
  localStorage.setItem(_recentKey(), JSON.stringify(list));
  renderRecentProjects();
}
let _recentExpanded = false;

async function openProjectById(projectId, fallbackName = '프로젝트') {
  const proj = await fsStoreGetProject(projectId);
  const name = proj.name || fallbackName || '프로젝트';
  _myRole = _getMyRole(proj);
  updateSidebarRoleBadge();
  _currentProjectId = projectId;
  _currentFileName  = name;
  document.getElementById('projectsOverlay')?.classList.add('hidden');
  switchTab('editor', document.querySelector('.nav-btn'));
  await applyLoadedData(proj.data || {});
  addRecentProject(name, projectId);
  rememberCurrentProject(name, projectId);
  _syncProfileToProject(projectId);
  return true;
}

async function restoreCurrentProjectOnBoot() {
  const saved = getCurrentProjectMemory() || getRecentProjects().find(p => p?.projectId);
  if (!saved?.projectId) return false;
  try {
    await openProjectById(saved.projectId, saved.name);
    return true;
  } catch(e) {
    clearCurrentProjectMemory();
    console.warn('최근 프로젝트 자동 복원 실패:', e);
    return false;
  }
}

function renderRecentProjects() {
  const el = document.getElementById('recentProjectsList');
  if (!el) return;
  const allList = getRecentProjects().slice(0, 3);
  if (!allList.length) {
    el.innerHTML = '<div class="recent-empty">아직 열어 본 프로젝트가 없습니다.</div>';
    return;
  }
  const showList = _recentExpanded ? allList : allList.slice(0, 1);
  const items = showList.map((p, i) => {
    const dateStr = p.openedAt ? _fmtModified(new Date(p.openedAt).getTime()) : '';
    return `
    <div class="recent-project-item" onclick="openRecentProject(${i})">
      <div class="recent-project-row">
        <div class="recent-project-name">${esc(p.name)}</div>
        ${dateStr ? `<div class="recent-project-date">${dateStr}</div>` : ''}
      </div>
      <div class="recent-project-path">🎬 Firebase</div>
    </div>`;
  }).join('');
  const moreCount = allList.length - 1;
  const toggleBtn = moreCount > 0
    ? `<button class="recent-toggle-btn" onclick="toggleRecentExpand()">
        ${_recentExpanded
          ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg> 접기`
          : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg> 더 보기 (${moreCount})`}
       </button>` : '';
  el.innerHTML = items + toggleBtn;
}

function toggleRecentExpand() {
  _recentExpanded = !_recentExpanded;
  renderRecentProjects();
}

async function openRecentProject(idx) {
  const list = getRecentProjects();
  const p = list[idx];
  if (!p) return;
  if (!p.projectId) { removeRecentProject(idx); return; }
  const itemEl = document.querySelectorAll('.recent-project-item')[idx];
  if (itemEl) { itemEl.style.opacity = '0.5'; itemEl.style.pointerEvents = 'none'; }
  const resetEl = () => { if (itemEl) { itemEl.style.opacity = ''; itemEl.style.pointerEvents = ''; } };
  showToast('불러오는 중...');
  try {
    await openProjectById(p.projectId, p.name);
    resetEl();
  } catch(e) {
    resetEl();
    showToast('불러오기 실패: ' + e.message);
    removeRecentProject(idx);
  }
}


/** modifiedTime(ms) → "26.11.05 오후 2:00" */
function _fmtModified(ms) {
  if (!ms) return '';
  const d   = new Date(ms);
  const yy  = String(d.getFullYear()).slice(2);
  const mm  = String(d.getMonth() + 1).padStart(2, '0');
  const dd  = String(d.getDate()).padStart(2, '0');
  const h24 = d.getHours();
  const ampm = h24 < 12 ? '오전' : '오후';
  const h12  = String(h24 % 12 || 12).padStart(2, '0');
  const min  = String(d.getMinutes()).padStart(2, '0');
  return `${yy}.${mm}.${dd} ${ampm} ${h12}:${min}`;
}


async function saveVersionSnapshot(data) {
  if (!_currentProjectId) return;
  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');
  const ts   = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const name = `${ts}_${_currentFileName || '프로젝트'}`;
  await fsStoreSaveVersion(name, data);
}

async function loadVersionList() {
  return await fsStoreListVersions();
}


async function restoreVersion(versionId) {
  if (!confirm(`이 버전으로 복구하시겠습니까?\n현재 작업 내용은 덮어씌워집니다.`)) return;
  try {
    const data = await fsStoreLoadVersion(versionId);
    await applyLoadedData(data);
    await doSave();
    showToast('복구 완료되었습니다.');
    refreshSettingsTab();
  } catch(e) {
    alert('복구 중 오류가 발생했습니다: ' + e.message);
  }
}


async function renderVersionHistory() {
  const el = document.getElementById('versionHistoryList');
  if (!el) return;
  if (!_currentProjectId) {
    el.innerHTML = '<div class="stg-version-empty">프로젝트를 열면 버전 목록이 표시됩니다.</div>';
    return;
  }
  el.innerHTML = '<div class="stg-version-empty">불러오는 중...</div>';
  const list = await loadVersionList();
  if (!list.length) {
    el.innerHTML = `<div class="stg-version-empty">저장된 버전이 없습니다. (${VERSION_SAVE_INTERVAL}번 저장마다 자동 생성, 최대 ${VERSION_MAX}개 유지)</div>`;
    return;
  }
  el.innerHTML = list.map((item) => {
    const name = item.name || '';
    const m = name.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_/);
    const label = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : name;
    return `<div class="stg-version-item">
      <span class="stg-version-label">${label}</span>
      <button class="stg-version-restore-btn" onclick="restoreVersion('${item.id}')">복구</button>
    </div>`;
  }).join('');
}



// ── 프로젝트 목록 UI ────────────────────────────
let _projectsHomeTab = 'mine';

function switchProjectsHomeTab(tab) {
  _projectsHomeTab = tab || 'mine';
  document.querySelectorAll('.projects-home-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.homeTab === _projectsHomeTab);
  });
  document.querySelectorAll('.projects-home-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.dataset.homePanel !== _projectsHomeTab);
  });
  if (_projectsHomeTab === 'recent') renderRecentProjects();
}

async function showProjectsOverlay() {
  if (document.body?.classList.contains('app-booting')) return;
  presenceLeave().catch(() => {});

  const overlay = document.getElementById('projectsOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');

  const nameEl = document.getElementById('projectsUserName');
	  if (nameEl) {
	    const name = getProfileName();
	    nameEl.textContent = name ? `안녕하세요, ${name}님` : '';
	  }
  switchProjectsHomeTab(_projectsHomeTab || 'mine');

  const listEl  = document.getElementById('folderBrowseList');
  const section = document.getElementById('folderBrowseSection');
  if (listEl)  listEl.innerHTML = '<div style="opacity:.5;padding:8px;font-size:12px">불러오는 중...</div>';
  if (section) section.style.display = 'block';
  try {
    const projects = await fsStoreListProjects();
    _renderFsProjectList(projects);
  } catch(e) {
    if (listEl) listEl.innerHTML = `<div style="opacity:.6;padding:8px;font-size:12px">불러오기 오류: ${e.message}</div>`;
  }
  renderRecentProjects();
}



// ── 새 프로젝트 모달 ──────────────────────────────
function showNewProjectModal() {
  const pathEl = document.getElementById('newProjectSavePath');
  if (pathEl) {
    const fbIcon = `<svg width="13" height="13" viewBox="0 0 192 192" style="vertical-align:-2px;margin-right:5px"><path fill="#FFA000" d="M108.5 36.5l-50 86.7H0L50 36.5z"/><path fill="#F57F17" d="M108.5 36.5l50 86.7H58.5z"/><path fill="#FFCA28" d="M0 123.2l50 32.3 50-32.3-50-86.7z"/><path fill="#FFA000" d="M50 155.5l50-32.3h92l-92 32.3z"/><path fill="#F57F17" d="M142 123.2l-92 32.3 50-86.7z"/></svg>`;
    pathEl.innerHTML = `${fbIcon}<strong>Firebase에 저장됩니다</strong>`;
    pathEl.style.cursor = 'default';
    pathEl.onclick = null;
  }
  const input = document.getElementById('newProjectNameInput');
  if (input) input.value = '';
  document.getElementById('newProjectModal')?.classList.remove('hidden');
  setTimeout(() => input?.focus(), 80);
}


function closeNewProjectModal() {
  document.getElementById('newProjectModal')?.classList.add('hidden');
}

async function confirmNewProject() {
  const name = document.getElementById('newProjectNameInput')?.value.trim() || '새 프로젝트';


  closeNewProjectModal();
  document.getElementById('projectsOverlay')?.classList.add('hidden');

  _currentFileName   = name;
  _currentProjectId = null;
  _myRole = 'owner';
  updateSidebarRoleBadge();
  _dataLoaded = false;

  switchTab('editor', document.querySelector('.nav-btn'));
  if (window.DPEditor?.isReady()) {
    DPEditor.setContent('<p data-type="heading" class="l-heading"><br></p>');
    DPEditor.setReadOnly(false);
  } else {
    const editor = ed();
    if (editor) {
      editor.innerHTML = '<p class="l-heading"><br></p>';
      editor.style.minHeight = '';
      editor.contentEditable = 'true';
    }
  }
  document.getElementById('projectName').value = name;
  document.getElementById('authorName').value  = '';
  document.getElementById('projectDate').value = '';
  sched = {}; schedDays = {}; scenes = [];
  charNotes = {}; charInfo = {}; manualCharsByScene = {};
  sceneNotes = {}; sceneExtras = {}; globalChars = [];
  charOrder = []; hiddenChars = []; locationInfo = {};
  locationOrder = []; propList = []; costumeList = [];
  staffList = _defaultStaff(); actorList = [];
  callSheets = []; currentCSIdx = 0;
  renderLeftSidebar();
  _dataLoaded = true;
  updatePageBreaks();

  await doSave();
  addRecentProject(name, _currentProjectId);
  rememberCurrentProject(name, _currentProjectId);
}

// load()에서 Drive 데이터 적용 시 공통 함수
async function applyLoadedData(d) {
  // 이전 Yjs 연결 먼저 해제 — setContent 중 _ytype이 남아 있으면
  // Y.XmlFragment가 비워지고 PM 상태가 오염되는 버그 방지
  window.DPEditor?.disconnect();
  _suppressSave = true;
  _deletionLog.clear(); // 새 프로젝트 로드 시 삭제 로그 초기화
  // 촬영 스케줄 — 항상 복원 (빈 값도 반영)
  sched      = d.sched      || {};
  schedDays  = d.schedDays  || {};
  // 일촬표 복원 — 누락 시 새로고침 후 사라지는 버그 방지
  callSheets = d.callSheets || [];
  if (d.lastCSNum != null && callSheets.length) {
    const idx = callSheets.findIndex(c => c.csNum === d.lastCSNum);
    currentCSIdx = idx >= 0 ? idx : 0;
  } else {
    currentCSIdx = 0;
  }

  if (d.charNotes)     charNotes          = d.charNotes;
  if (d.charInfo)      charInfo           = d.charInfo;
  if (d.manualChars)   manualCharsByScene = d.manualChars;
  if (d.sceneNotes)    sceneNotes         = d.sceneNotes;
  if (d.sceneExtras)   sceneExtras        = d.sceneExtras;
  if (d.csLabels)      csLabels           = d.csLabels;
  if (csLabels.art1   === '미    술') csLabels.art1   = '미술/공간소품';
  if (csLabels.props1 === '소   품')  csLabels.props1 = '인물소품';
  if (d.globalChars)   globalChars        = d.globalChars;
  if (d.charOrder)     charOrder          = d.charOrder;
  if (d.hiddenChars)   hiddenChars        = d.hiddenChars;
  if (d.locationInfo)  locationInfo       = d.locationInfo;
  if (d.locationOrder) locationOrder      = d.locationOrder;
  propList      = ensureArray(d.propList);
  costumeList   = ensureArray(d.costumeList);
  staffList     = d.staffList !== undefined ? ensureArray(d.staffList) : _defaultStaff();
  actorList     = ensureArray(d.actorList);
  pageNumberStyle = d.pageNumberStyle || null;
  if (d.month)         calMonth           = new Date(d.month);

  const pn = d.project || d.projectName || '';
  if (pn) document.getElementById('projectName').value = pn;
  if (d.author)   document.getElementById('authorName').value  = d.author;
  if (d.date)     document.getElementById('projectDate').value  = d.date;
  if (d.adPhone)  { projectAdPhone = d.adPhone; document.getElementById('projectAdPhone').value = d.adPhone; }
  if (d.pdPhone)  { projectPdPhone = d.pdPhone; document.getElementById('projectPdPhone').value = d.pdPhone; }

  const scriptHtml = d.html || d.scriptHtml || '';
  if (scriptHtml) {
    if (window.DPEditor?.isReady()) {
      DPEditor.setContent(scriptHtml);
    } else {
      ed().innerHTML = scriptHtml;
    }
    ed().querySelectorAll('.l-heading,.l-action,.l-char,.l-dialogue').forEach(el => {
      ['fontFamily','fontSize','fontWeight','lineHeight','textAlign','marginTop','marginBottom']
        .forEach(p => el.style[p] = '');
    });
    onEditorInput();
    syncAllPropsFromBreakdown();
    syncAllCostumesFromBreakdown();
    scenes.forEach(s => {
      s.schedDate = null;
      const sn = String(s.number);
      for (const [date, nums] of Object.entries(sched))
        if (nums.some(n => String(n) === sn)) { s.schedDate = date; break; }
    });
    renderSidebar();
  }
  _dataLoaded = true;
  setMonTitle();
  updateHeaderDisplay();
  refreshTypeUI();
  updateSidebarRoleBadge();
  checkEditorEmpty();
  // 열람자 → 에디터 읽기 전용
  const edEl = document.getElementById('scriptEditor');
  if (window.DPEditor?.isReady()) {
    DPEditor.setReadOnly(_myRole === 'viewer');
  } else if (edEl) {
    edEl.contentEditable = _myRole === 'viewer' ? 'false' : 'true';
  }
  presenceJoin().catch(() => {});
  _suppressSave = false;  // 이후 사용자 입력은 정상 저장되도록 해제

  // 오늘 날짜 스냅샷이 없으면 프로젝트 열 때 즉시 1회 백업
  setTimeout(async () => {
    if (!_currentProjectId) return;
    try {
      const today = new Date();
      const pad = n => String(n).padStart(2, '0');
      const todayPrefix = `${today.getFullYear()}${pad(today.getMonth()+1)}${pad(today.getDate())}`;
      const list = await loadVersionList();
      const hasToday = list.some(item => {
        const n = item.name || '';
        return n.startsWith(todayPrefix);
      });
      if (!hasToday) {
        const data = {
          html: ed().innerHTML, sched, schedDays,
          project: document.getElementById('projectName').value,
          author: document.getElementById('authorName').value,
          date: document.getElementById('projectDate').value,
          adPhone: projectAdPhone, pdPhone: projectPdPhone,
          charNotes, charInfo, manualChars: manualCharsByScene,
          sceneNotes, sceneExtras, csLabels, globalChars, charOrder, hiddenChars,
          callSheets, lastCSNum: csGet()?.csNum ?? null,
          locationInfo, locationOrder, propList, costumeList,
          pageNumberStyle, month: calMonth.getTime(),
          savedAt: new Date().toISOString(),
        };
        await saveVersionSnapshot(data);
      }
    } catch(e) { console.warn('초기 버전 스냅샷 오류:', e); }
  }, 2000);
}

// ══════════════════════════════════════════════════
// 헬퍼
// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// 접속자 Presence (Firestore)
// ══════════════════════════════════════════════════
let _presenceFileKey      = null;
let _presenceListener     = null;
let _presenceTimer        = null;
let _projectDataListener  = null; // sceneExtras/propList 등 실시간 동기화
let _conflictWarned       = false;

function _makeFileKey(folderName, fileName) {
  return btoa(encodeURIComponent(folderName + '/' + fileName)).replace(/=/g, '');
}

async function presenceJoin() {
  const user = auth.currentUser;
  if (!user || !_currentProjectId) return;
  await presenceLeave(); // 이전 리스너 정리

  _presenceFileKey = _currentProjectId;
  const emoji = localStorage.getItem(PROFILE_EMOJI_KEY()) || DEFAULT_EMOJI;
  const name  = getProfileName();
  const role  = _myRole;

  const docRef = db.collection('presence').doc(_presenceFileKey);

  // 내 세션 등록 (역할 + 커서 오프셋 포함)
  await docRef.set({
    [user.uid]: { name, emoji, email: user.email || '', role, cursorOffset: -1, updatedAt: Date.now() }
  }, { merge: true });

  // 실시간 리스너
  _presenceListener = docRef.onSnapshot(snap => {
    if (!snap.exists) return;
    const now = Date.now();
    const users = Object.entries(snap.data())
      .filter(([, v]) => now - v.updatedAt < 120000) // 2분 이내
      .map(([uid, v]) => ({ uid, ...v, isMe: uid === user.uid }));

    renderPresenceChips(users);
    _drawCursors(users);

    // 동시 접속 에디터 8명 제한 (열람자 제외)
    if (_myRole !== 'viewer') {
      const editors = users.filter(u => u.role !== 'viewer');
      // 나의 순서가 8번째(index 7)를 초과하면 편집 불가
      const myEditorIndex = editors.findIndex(u => u.isMe);
      const isOver = myEditorIndex >= 8;
      const editorEl = document.getElementById('scriptEditor');
      if (editorEl) {
        const wasEditable = editorEl.contentEditable === 'true';
        editorEl.contentEditable = isOver ? 'false' : 'true';
        if (isOver && wasEditable) {
          showToast('⚠️ 동시 접속 편집자가 8명을 초과하여 편집이 제한됩니다.', 5000);
        }
      }
    }
  });

  // heartbeat (매 30초, 최신 정보 반영 — cursorOffset은 덮어쓰지 않음)
  _presenceTimer = setInterval(async () => {
    try {
      const currentEmoji = localStorage.getItem(PROFILE_EMOJI_KEY()) || DEFAULT_EMOJI;
      const currentName  = getProfileName();
      await docRef.set({
        [user.uid]: { name: currentName, emoji: currentEmoji, email: user.email || '', role: _myRole, updatedAt: Date.now() }
      }, { merge: true });
    } catch(e) {}
  }, 30000);

  // 채팅도 같이 시작
  chatJoin(_presenceFileKey);

  // Yjs WebSocket 실시간 협업 연결
  window.DPEditor?.connect(_currentProjectId);

  // ── 프로젝트 데이터 실시간 리스너 (sceneExtras·propList 등 협업 동기화)
  if (_projectDataListener) { _projectDataListener(); _projectDataListener = null; }

  // ── 내부 merge 헬퍼 ──────────────────────────────────────────────────────
  // 상대방 데이터와 내 로컬 데이터를 합칠 때 요소 등록 배열을 보존하는 MERGE
  function _mergeSceneExtras(local, remote) {
    const ITEM_FIELDS = ['costumeItems','makeupItems','charPropItems','setPropItems','vfxItems','etcItems','locationItems'];
    const result = JSON.parse(JSON.stringify(remote || {}));

    // 삭제 여부 판정 헬퍼 (씬 단위 OR 전체 글로벌)
    const isDeleted = (snum, field, text) =>
      _deletionLog.hasElem(snum, field, text) || _deletionLog.hasElemGlobal(field, text);

    // 1단계: 원격 데이터에서 최근 삭제된 항목 제거 (Firestore에 아직 반영 안 된 경우)
    for (const [snum, extra] of Object.entries(result)) {
      for (const field of ITEM_FIELDS) {
        if (!extra[field]?.length) continue;
        extra[field] = extra[field].filter(i => !isDeleted(snum, field, getItemText(i)));
      }
    }

    // 2단계: 로컬에만 있는 항목 보존 (단, 삭제 로그에 있는 항목은 제외)
    for (const [snum, localExtra] of Object.entries(local || {})) {
      if (!result[snum]) result[snum] = {};
      for (const field of ITEM_FIELDS) {
        if (!localExtra[field]?.length) continue;
        if (!result[snum][field]) result[snum][field] = [];
        for (const localItem of localExtra[field]) {
          const text = getItemText(localItem);
          if (isDeleted(snum, field, text)) continue; // 삭제된 항목은 복원 방지
          if (!result[snum][field].some(i => getItemText(i) === text)) {
            result[snum][field].push(localItem); // 로컬에만 있는 항목 보존
          }
        }
      }
      // 텍스트 요약 필드(costumeList, propList 등)는 병합 후 재계산
      for (const [field, listField] of Object.entries(ITEMS_TO_LIST)) {
        if (!result[snum]?.[field]) continue;
        result[snum][listField] = result[snum][field].map(getItemText).filter(Boolean).join(', ');
      }
    }
    return result;
  }

  // propList / costumeList: 서버 기준, 로컬에만 있는 항목 추가 (단, 삭제 로그 항목 제외)
  function _mergeList(local, remote, keyFields) {
    // 1단계: 원격 데이터에서 최근 삭제된 항목 제거
    let result = JSON.parse(JSON.stringify(remote || []));
    result = result.filter(r => {
      if (keyFields.includes('category')) {
        // propList or costumeList 구분
        if (r.category === 'charProp' || r.category === 'setProp') {
          return !_deletionLog.hasProp(r.name, r.category);
        } else if (r.category === 'costume' || r.category === 'makeup') {
          return !_deletionLog.hasCostume(r.name, r.category);
        }
      }
      return true;
    });
    // 2단계: 로컬에만 있는 항목 추가 (삭제 로그 항목 제외)
    for (const localItem of (local || [])) {
      if (keyFields.includes('category')) {
        if (localItem.category === 'charProp' || localItem.category === 'setProp') {
          if (_deletionLog.hasProp(localItem.name, localItem.category)) continue;
        } else if (localItem.category === 'costume' || localItem.category === 'makeup') {
          if (_deletionLog.hasCostume(localItem.name, localItem.category)) continue;
        }
      }
      const already = result.some(r => keyFields.every(k => r[k] === localItem[k]));
      if (!already) result.push(JSON.parse(JSON.stringify(localItem)));
    }
    return result;
  }

  _projectDataListener = db.collection('projects').doc(_currentProjectId)
    .onSnapshot(snap => {
      if (!snap.exists) return;
      const d = snap.data();
      // 내가 저장한 변경은 이미 로컬에 반영돼 있으므로 건너뜀
      // (merge 방식이므로 로컬 항목은 항상 보존됨)
      if (d.updatedBy === auth.currentUser?.uid) return;
      const rd = d.data || {};
      // 다른 계정의 삭제 로그를 먼저 내 로컬 로그에 병합 (삭제 동기화 핵심)
      // — 이 작업이 선행돼야 아래 _mergeSceneExtras에서 올바르게 필터링됨
      if (rd._deletions) _deletionLog.mergeFromFirestore(rd._deletions);
      // 스크립트 텍스트(html)는 Yjs가 처리하므로 제외하고 메타 데이터만 동기화
      // sceneExtras의 요소 등록 배열은 MERGE (덮어쓰지 않음 — 로컬 등록 항목 보존)
      sceneExtras        = _mergeSceneExtras(sceneExtras, rd.sceneExtras);
      propList           = _mergeList(propList,     ensureArray(rd.propList),     ['name','category']);
      costumeList        = _mergeList(costumeList,  ensureArray(rd.costumeList),  ['name','category']);
      if (rd.staffList !== undefined) staffList = ensureArray(rd.staffList);
      if (rd.actorList !== undefined) actorList = ensureArray(rd.actorList);
      charNotes          = rd.charNotes          || {};
      charInfo           = rd.charInfo           || {};
      manualCharsByScene = rd.manualCharsByScene  || {};
      sceneNotes         = rd.sceneNotes         || {};
      locationInfo       = rd.locationInfo       || {};
      locationOrder      = rd.locationOrder      || [];
      csLabels           = rd.csLabels           || {};
      globalChars        = rd.globalChars        || [];
      charOrder          = rd.charOrder          || [];
      hiddenChars        = rd.hiddenChars        || [];
      // 촬영스케줄 동기화
      if (rd.sched)     sched     = rd.sched;
      if (rd.schedDays) schedDays = rd.schedDays;
      // 일촬표 동기화
      if (rd.callSheets) {
        callSheets = rd.callSheets;
        currentCSIdx = Math.min(currentCSIdx, callSheets.length - 1);
        if (currentCSIdx < 0) currentCSIdx = 0;
      }
      // 프로젝트 이름 동기화 (사이드바 실시간 반영)
      if (d.name && d.name !== _currentFileName) {
        _currentFileName = d.name;
        const projInput = document.getElementById('projectName');
        if (projInput) projInput.value = d.name;
        // 현재 편집 중이 아닐 때만 사이드바 레이블 갱신
        const labelEl = document.getElementById('sidebarProjectLabel');
        if (labelEl && !labelEl.isContentEditable) labelEl.textContent = d.name;
      }
      // 현재 열려 있는 탭 리렌더링
      // 씬브레이크다운·브레이크다운·리스트는 삭제 동기화 반영을 위해 항상 재렌더
      renderSidebar();
      renderLeftSidebar();
      renderSceneBd();
      renderBreakdown();
      updatePageBreaks(); // Firestore 업데이트 후 페이지 구분선 재계산
      const onTab = id => document.getElementById(id)?.classList.contains('on');
      if (onTab('tab-chars'))       renderChars();
      if (onTab('tab-loclist'))     renderLocList();
      if (onTab('tab-proplist'))    renderPropList();
      if (onTab('tab-costumelist')) renderCostumeList();
      if (onTab('tab-stafflist'))   renderStaffList();
      if (onTab('tab-actorlist'))   renderActorList();
      if (onTab('tab-schedule'))    renderSchedule();
      if (onTab('tab-callsheet'))   renderCS();
    }, () => {});
}

async function presenceLeave() {
  if (_presenceTimer)          { clearInterval(_presenceTimer); _presenceTimer = null; }
  if (_presenceListener)       { _presenceListener(); _presenceListener = null; }
  if (_projectDataListener)    { _projectDataListener(); _projectDataListener = null; }
  const user = auth.currentUser;
  if (user && _presenceFileKey) {
    try {
      await db.collection('presence').doc(_presenceFileKey).update({
        [user.uid]: firebase.firestore.FieldValue.delete()
      });
    } catch(e) {}
  }
  _presenceFileKey = null;
  renderPresenceChips([]);
  chatLeave();
  // Yjs WebSocket 연결 해제
  window.DPEditor?.disconnect();
}

// ── 커서 공유 헬퍼 ───────────────────────────────────
function _getCaretTextOffset() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return -1;
  const range = sel.getRangeAt(0);
  const editorEl = document.getElementById('scriptEditor');
  if (!editorEl || !editorEl.contains(range.startContainer)) return -1;
  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) return offset + range.startOffset;
    offset += node.textContent.length;
  }
  return offset;
}

function _getOffsetRect(editorEl, textOffset) {
  if (textOffset < 0) return null;
  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT);
  let remaining = textOffset;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (remaining <= len) {
      try {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, remaining);
        const rects = range.getClientRects();
        return rects.length ? rects[0] : null;
      } catch(e) { return null; }
    }
    remaining -= len;
  }
  return null;
}

function _drawCursors(users) {
  const editorEl  = document.getElementById('scriptEditor');
  const scrollWrap = document.getElementById('editorScrollWrap');
  if (!editorEl || !scrollWrap) return;

  let overlay = document.getElementById('cursorOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cursorOverlay';
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;pointer-events:none;z-index:10;';
    if (getComputedStyle(scrollWrap).position === 'static') scrollWrap.style.position = 'relative';
    scrollWrap.appendChild(overlay);
  }

  const others = users.filter(u => !u.isMe && typeof u.cursorOffset === 'number' && u.cursorOffset >= 0);
  if (!others.length) { overlay.innerHTML = ''; return; }

  const wrapRect = scrollWrap.getBoundingClientRect();
  let colorIdx = 0;
  overlay.innerHTML = others.map(u => {
    const rect = _getOffsetRect(editorEl, u.cursorOffset);
    if (!rect) return '';
    const top   = rect.top  - wrapRect.top  + scrollWrap.scrollTop;
    const left  = rect.left - wrapRect.left + scrollWrap.scrollLeft;
    const h     = rect.height || 20;
    const color = CURSOR_COLORS[colorIdx++ % CURSOR_COLORS.length];
    return `<div style="position:absolute;top:${top}px;left:${left}px;width:2px;height:${h}px;background:${color};border-radius:1px;">
      <div style="position:absolute;bottom:calc(100% + 2px);left:0;background:${color};color:#fff;font-size:10px;padding:1px 6px;border-radius:3px;white-space:nowrap;line-height:18px;font-family:sans-serif;">${esc(u.name)}</div>
    </div>`;
  }).join('');
}

function _sendCursorPosition() {
  if (_cursorTimer) clearTimeout(_cursorTimer);
  _cursorTimer = setTimeout(async () => {
    const user = auth.currentUser;
    if (!user || !_presenceFileKey) return;
    const offset = _getCaretTextOffset();
    if (offset < 0) return;
    try {
      await db.collection('presence').doc(_presenceFileKey).set(
        { [user.uid]: { cursorOffset: offset, updatedAt: Date.now(), editingAt: Date.now() } },
        { merge: true }
      );
    } catch(e) {}
  }, 200);
}

const PRESENCE_MAX_CHIPS = 8;

function renderPresenceChips(users) {
  if (users !== _lastPresenceUsers && users.length) _lastPresenceUsers = users; // 캐시 갱신
  const wrap = document.getElementById('presenceChips');
  if (!wrap) return;
  const list = users.length ? users : _lastPresenceUsers;
  if (!list.length) { wrap.innerHTML = ''; return; }

  // 내 칩은 항상 맨 앞에
  const sorted  = [...list.filter(u => u.isMe), ...list.filter(u => !u.isMe)];
  const visible  = sorted.slice(0, PRESENCE_MAX_CHIPS);
  const overflow = sorted.slice(PRESENCE_MAX_CHIPS);

  const chips = visible.map(u => {
    if (u.isMe) {
      return `<div class="presence-chip presence-chip-me" title="${esc(u.name)}">${u.emoji}</div>`;
    }
    const unread = _dmUnreadCounts[u.uid] || 0;
    const badge  = unread > 0
      ? `<span class="dm-unread-badge">${unread > 9 ? '9+' : unread}</span>` : '';
    return `<div class="presence-chip presence-chip-other" title="${esc(u.name)}에게 메시지 보내기"
      onclick="openDM('${esc(u.uid)}','${esc(u.name)}','${esc(u.emoji)}')">${u.emoji}${badge}</div>`;
  }).join('');

  const moreChip = overflow.length > 0
    ? `<div class="presence-chip presence-chip-more" title="${overflow.map(u => u.name).join(', ')}">+${overflow.length}</div>`
    : '';

  wrap.innerHTML = `<span class="presence-label">현재 접속자</span>` + chips + moreChip;
  // 타인 접속 or DM 안읽음 있으면 채팅 버튼 표시
  const hasOthers  = list.some(u => !u.isMe);
  const hasDmUnread = Object.values(_dmUnreadCounts).some(n => n > 0);
  const btn = document.getElementById('chatToggleBtn');
  if (btn) btn.classList.toggle('hidden', !hasOthers && _chatUnread === 0 && !hasDmUnread);
}

// ══════════════════════════════════════════════════
// 채팅 (Firestore 실시간)
// ══════════════════════════════════════════════════
let _chatListener = null;
let _chatFileKey  = null;
let _chatUnread   = 0;
let _chatOpen     = false;

// DM 상태
let _dmMode          = false;   // true = DM 패널 표시 중
let _dmPartner       = null;    // { uid, name, emoji }
let _dmKey           = null;    // sorted uid join
let _dmListener      = null;
let _dmUnreadCounts  = {};      // { partnerUid: unreadCount }
let _lastGroupMsgs   = null;    // 그룹 메시지 캐시 (DM 복귀 시 즉시 재렌더링용)
let _lastPresenceUsers = [];    // 칩 재렌더링용 캐시

// DM 읽음 타임스탬프 (localStorage)
function _dmLastReadKey(k)  { return `dpre-dm-read-${k}`; }
function _dmGetLastRead(k)  { return parseInt(localStorage.getItem(_dmLastReadKey(k)) || '0', 10); }
function _dmSetLastRead(k)  { localStorage.setItem(_dmLastReadKey(k), String(Date.now())); }

function _chatLastReadKey(fileKey) { return `dpre-chat-read-${fileKey}`; }
function _chatGetLastRead(fileKey) { return parseInt(localStorage.getItem(_chatLastReadKey(fileKey)) || '0', 10); }
function _chatSetLastRead(fileKey) { localStorage.setItem(_chatLastReadKey(fileKey), String(Date.now())); }

function chatJoin(fileKey) {
  if (_chatListener) { _chatListener(); _chatListener = null; }
  _chatFileKey = fileKey;

  // 30일 이상 된 메시지 정리 (비동기, 무시 가능)
  pruneOldChatMessages(fileKey).catch(() => {});

  // 실시간 리스너 (최근 100개)
  _chatListener = db.collection('chats').doc(fileKey).collection('messages')
    .orderBy('sentAt', 'asc').limitToLast(100)
    .onSnapshot(snap => {
      const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderChatMessages(msgs);
      updateChatBadge(msgs);
    }, () => {});
}

function chatLeave() {
  if (_chatListener) { _chatListener(); _chatListener = null; }
  _chatFileKey = null;
  _chatUnread  = 0;
  _chatOpen    = false;
  _closeDmListener();
  _dmMode         = false;
  _dmPartner      = null;
  _dmKey          = null;
  _dmUnreadCounts = {};
  _lastGroupMsgs  = null;
  _lastPresenceUsers = [];
  const panel = document.getElementById('chatPanel');
  if (panel) panel.classList.add('hidden');
  const btn = document.getElementById('chatToggleBtn');
  if (btn) btn.classList.add('hidden');
  updateChatBadge([]);
}

function _closeDmListener() {
  if (_dmListener) { _dmListener(); _dmListener = null; }
}

async function chatSend() {
  if (_dmMode) { await dmSend(); return; }
  const input = document.getElementById('chatInput');
  const text  = (input?.value || '').trim();
  if (!text || !_chatFileKey) return;
  const user  = auth.currentUser;
  if (!user) return;
  const emoji = localStorage.getItem(PROFILE_EMOJI_KEY()) || DEFAULT_EMOJI;
  const name  = getProfileName();
  input.value = '';
  try {
    await db.collection('chats').doc(_chatFileKey).collection('messages').add({
      uid: user.uid, name, emoji, text, sentAt: Date.now()
    });
  } catch(e) { input.value = text; showToast('메시지 전송 실패. 다시 시도해주세요.'); }
}

function toggleChatPanel() {
  const panel = document.getElementById('chatPanel');
  const btn   = document.getElementById('chatToggleBtn');
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  _chatOpen = willOpen;
  btn?.classList.toggle('active', _chatOpen);
  if (!_chatOpen && _dmMode) {
    // 패널 닫을 때 DM 모드 종료
    closeDM();
  }
  if (_chatOpen && _chatFileKey && !_dmMode) {
    _chatSetLastRead(_chatFileKey);
    _chatUnread = 0;
    updateChatBadge(null);
    setTimeout(() => {
      const msgs = document.getElementById('chatMessages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      document.getElementById('chatInput')?.focus();
    }, 50);
  }
}

function renderChatMessages(msgs) {
  _lastGroupMsgs = msgs; // 항상 캐시
  if (_dmMode) return;   // DM 패널 표시 중이면 DOM 건드리지 않음
  const wrap = document.getElementById('chatMessages');
  if (!wrap) return;
  const user = auth.currentUser;
  if (!msgs.length) {
    wrap.innerHTML = `<div class="chat-empty"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>아직 메시지가 없습니다</span></div>`;
    return;
  }
  const pad = n => String(n).padStart(2, '0');
  let lastDay = '';
  wrap.innerHTML = msgs.map(m => {
    const isMe = m.uid === user?.uid;
    const d    = new Date(m.sentAt);
    const day  = `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    let divider = '';
    if (day !== lastDay) { lastDay = day; divider = `<div class="chat-day-divider"><span>${day}</span></div>`; }
    const nameRow = !isMe ? `<div class="chat-msg-name">${esc(m.name)}</div>` : '';
    return `${divider}
    <div class="chat-msg${isMe ? ' chat-msg-me' : ''}">
      <div class="chat-msg-avatar">${m.emoji || '😊'}</div>
      <div class="chat-msg-body">
        ${nameRow}
        <div class="chat-msg-bubble">${esc(m.text)}</div>
        <div class="chat-msg-time">${time}</div>
      </div>
    </div>`;
  }).join('');
  // 패널 열려있으면 스크롤 유지
  if (_chatOpen) {
    wrap.scrollTop = wrap.scrollHeight;
    if (_chatFileKey) { _chatSetLastRead(_chatFileKey); _chatUnread = 0; updateChatBadge(null); }
  }
}

function updateChatBadge(msgs) {
  const btn   = document.getElementById('chatToggleBtn');
  const badge = document.getElementById('chatBadge');
  if (!badge) return;
  if (!msgs || _chatOpen) {
    _chatUnread = 0;
    badge.classList.add('hidden');
    return;
  }
  const lastRead = _chatFileKey ? _chatGetLastRead(_chatFileKey) : 0;
  const uid      = auth.currentUser?.uid;
  _chatUnread    = msgs.filter(m => m.uid !== uid && m.sentAt > lastRead).length;
  if (_chatUnread > 0) {
    badge.textContent = _chatUnread > 9 ? '9+' : String(_chatUnread);
    badge.classList.remove('hidden');
    // 배지 있으면 버튼도 표시
    if (btn) btn.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

async function pruneOldChatMessages(fileKey) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30일
  try {
    const snap = await db.collection('chats').doc(fileKey).collection('messages').get();
    if (snap.empty) return;
    const batch = db.batch();
    let count = 0;
    snap.docs.forEach(doc => {
      if (doc.data().sentAt < cutoff) { batch.delete(doc.ref); count++; }
    });
    if (count > 0) await batch.commit();
  } catch(e) {}
}

// ── 1:1 DM ───────────────────────────────────────

function openDM(partnerUid, partnerName, partnerEmoji) {
  const user = auth.currentUser;
  if (!user || partnerUid === user.uid) return;

  const newDmKey = [user.uid, partnerUid].sort().join('-');

  // 다른 상대로 전환할 때만 리스너 교체
  if (_dmKey !== newDmKey) {
    _closeDmListener();
    _dmKey = newDmKey;
    _dmListener = db.collection('dms').doc(_dmKey).collection('messages')
      .orderBy('sentAt', 'asc').limitToLast(100)
      .onSnapshot(snap => {
        const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const isViewing = _dmMode && _dmPartner?.uid === partnerUid;
        if (isViewing) {
          // 현재 이 DM을 보고 있으면 렌더링 + 읽음 처리
          renderDmMessages(msgs);
          _dmUnreadCounts[partnerUid] = 0;
          _dmSetLastRead(_dmKey);
        } else {
          // 백그라운드: 안읽음 수 갱신 후 칩 뱃지만 업데이트
          const lastRead = _dmGetLastRead(_dmKey);
          _dmUnreadCounts[partnerUid] = msgs.filter(m => m.uid === partnerUid && m.sentAt > lastRead).length;
          renderPresenceChips(_lastPresenceUsers);
        }
      }, () => {});
  }

  _dmPartner = { uid: partnerUid, name: partnerName, emoji: partnerEmoji };
  _dmMode    = true;

  // 안읽음 초기화
  _dmUnreadCounts[partnerUid] = 0;
  _dmSetLastRead(_dmKey);
  renderPresenceChips(_lastPresenceUsers);

  // 헤더 타이틀 교체 (이모티콘 + 이름)
  document.getElementById('chatGroupDesc')?.classList.add('hidden');
  const titleEl = document.getElementById('chatPanelTitle');
  if (titleEl) titleEl.innerHTML =
    `<span class="chat-dm-title">${partnerEmoji} ${esc(partnerName)}</span>`;

  // 입력창 placeholder 변경
  const input = document.getElementById('chatInput');
  if (input) input.placeholder = `${partnerName}님에게 메시지…`;

  // 패널 열기
  const panel = document.getElementById('chatPanel');
  if (panel) panel.classList.remove('hidden');
  _chatOpen = true;
  document.getElementById('chatToggleBtn')?.classList.add('active');

  setTimeout(() => {
    const wrap = document.getElementById('chatMessages');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
    input?.focus();
  }, 50);
}

function closeDM() {
  // _dmListener는 닫지 않음 — 백그라운드에서 안읽음 계속 추적
  _dmMode    = false;
  _dmPartner = null;
  // _dmKey 유지 (같은 상대 다시 열 때 리스너 재사용)

  // 헤더 타이틀 복원
  document.getElementById('chatGroupDesc')?.classList.remove('hidden');
  const titleEl = document.getElementById('chatPanelTitle');
  if (titleEl) titleEl.innerHTML =
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
     공유 채팅방`;

  // 입력창 placeholder 복원
  const input = document.getElementById('chatInput');
  if (input) input.placeholder = '메시지 입력…';

  // 그룹 메시지 즉시 복원 (캐시 사용)
  if (_lastGroupMsgs !== null) {
    renderChatMessages(_lastGroupMsgs);
  } else {
    const wrap = document.getElementById('chatMessages');
    if (wrap) wrap.innerHTML = '';
  }
  input?.focus();
}

async function dmSend() {
  const input = document.getElementById('chatInput');
  const text  = (input?.value || '').trim();
  if (!text || !_dmKey) return;
  const user = auth.currentUser;
  if (!user) return;
  const emoji = localStorage.getItem(PROFILE_EMOJI_KEY()) || DEFAULT_EMOJI;
  const name  = getProfileName();
  input.value = '';
  try {
    await db.collection('dms').doc(_dmKey).collection('messages').add({
      uid: user.uid, name, emoji, text, sentAt: Date.now()
    });
    // 30일 오래된 DM 정리 (비동기)
    pruneOldDmMessages(_dmKey).catch(() => {});
  } catch(e) { input.value = text; showToast('메시지 전송 실패. 다시 시도해주세요.'); }
}

function renderDmMessages(msgs) {
  const wrap = document.getElementById('chatMessages');
  if (!wrap) return;
  const user = auth.currentUser;
  if (!msgs.length) {
    const partnerName = _dmPartner?.name || '상대방';
    wrap.innerHTML = `<div class="chat-empty"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>${esc(partnerName)}님과 대화를 시작해보세요</span></div>`;
    return;
  }
  const pad = n => String(n).padStart(2, '0');
  let lastDay = '';
  wrap.innerHTML = msgs.map(m => {
    const isMe = m.uid === user?.uid;
    const d    = new Date(m.sentAt);
    const day  = `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    let divider = '';
    if (day !== lastDay) { lastDay = day; divider = `<div class="chat-day-divider"><span>${day}</span></div>`; }
    const nameRow = !isMe ? `<div class="chat-msg-name">${esc(m.name)}</div>` : '';
    return `${divider}
    <div class="chat-msg${isMe ? ' chat-msg-me' : ''}">
      <div class="chat-msg-avatar">${m.emoji || '😊'}</div>
      <div class="chat-msg-body">
        ${nameRow}
        <div class="chat-msg-bubble">${esc(m.text)}</div>
        <div class="chat-msg-time">${time}</div>
      </div>
    </div>`;
  }).join('');
  wrap.scrollTop = wrap.scrollHeight;
}

async function pruneOldDmMessages(dmKey) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  try {
    const snap = await db.collection('dms').doc(dmKey).collection('messages').get();
    if (snap.empty) return;
    const batch = db.batch();
    let count = 0;
    snap.docs.forEach(doc => {
      if (doc.data().sentAt < cutoff) { batch.delete(doc.ref); count++; }
    });
    if (count > 0) await batch.commit();
  } catch(e) {}
}

function dismissLanding() {
  localStorage.setItem('dpre-landing-v1', '1');
  const overlay = document.getElementById('landingOverlay');
  if (!overlay) return;

  // 1) 목표 화면을 먼저 보여줌 (랜딩이 위에서 덮고 있으므로 즉시 표시해도 안 보임)
  finishInitialOverlayGate();
  if (auth?.currentUser) {
    showProjectsOverlay();
  } else {
    document.getElementById('loginOverlay')?.classList.remove('hidden');
  }

  // 2) 랜딩을 위로 슬라이드아웃 (opacity 변화 없음 → 뒤쪽 절대 비치지 않음)
  overlay.classList.add('lp-out');
  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('lp-out');
  }, 440);
}

function backToLanding() {
  localStorage.removeItem('dpre-landing-v1');
  _authSetError('');
  hideResetPanel();
  document.getElementById('loginOverlay')?.classList.add('hidden');
  showLanding();
}

function showLanding() {
  // 항상 index.html에 있는 기존 overlay를 재사용
  const overlay = document.getElementById('landingOverlay');
  if (!overlay) return;
  _bootGateDone = false; // boot gate 재활성화 (dismissLanding에서 다시 해제)
  document.body?.classList.add('app-booting');
  if (!document.getElementById('bootOverlayGate')) {
    const style = document.createElement('style');
    style.id = 'bootOverlayGate';
    style.textContent = 'body.app-booting #projectsOverlay{display:none!important;visibility:hidden!important;pointer-events:none!important}';
    document.head.appendChild(style);
  }
  document.getElementById('loginOverlay')?.classList.add('hidden');
  document.getElementById('projectsOverlay')?.classList.add('hidden');
  _setupLandingOverlay(overlay);
}

function showToast(msg, duration = 3000) {
  let toast = document.getElementById('dpToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dpToast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('dp-toast-show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('dp-toast-show'), duration);
}

function ieBadge(ie){ return{INT:'b-int',EXT:'b-ext','INT/EXT':'b-ie'}[ie]||'b-int'; }
function timeBadge(t){ return{day:'b-day',night:'b-night',dawn:'b-dawn',eve:'b-eve'}[t]||'b-day'; }

/* ── 프로필 닉네임 + 이모지 ──────────────────────────── */
// 계정별 프로필 키 — UID로 구분
function PROFILE_NICK_KEY()  { const u = auth.currentUser; return u ? `dpre-profile-nick-${u.uid}`  : 'dpre-profile-nick'; }
function PROFILE_EMOJI_KEY() { const u = auth.currentUser; return u ? `dpre-profile-emoji-${u.uid}` : 'dpre-profile-emoji'; }

/** 표시 이름: 저장된 닉네임 우선, 없으면 displayName/email */
function getProfileName() {
  const saved = localStorage.getItem(PROFILE_NICK_KEY());
  if (saved) return saved;
  const user = auth.currentUser;
  if (!user) return '사용자';
  return (user.displayName || user.email || '').split('@')[0] || '사용자';
}

/** 이름 행 클릭 → 인라인 편집 모드 */
function startEditName() {
  const row = document.getElementById('myInfoNameRow');
  if (!row || row.querySelector('.myinfo-name-input')) return; // 이미 편집 중
  const current = getProfileName();

  // 이름 행을 input으로 교체
  row.innerHTML = `
    <input id="myInfoNameInput" class="myinfo-name-input"
      type="text" maxlength="20" value="${esc(current)}"
      placeholder="별명 입력" autocomplete="off"
      onblur="saveProfileName()"
      onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}
                 else if(event.key==='Escape'){cancelEditName()}">
  `;
  const input = document.getElementById('myInfoNameInput');
  input?.focus();
  input?.select();
}

/** 별명 저장 (blur / Enter) */
function saveProfileName() {
  const input = document.getElementById('myInfoNameInput');
  if (!input) return;
  const newName = input.value.trim() || getProfileName();
  localStorage.setItem(PROFILE_NICK_KEY(), newName);
  _restoreNameRow(newName);
  _syncNameToPresence(newName);
  // 사이드바 이름도 업데이트
  document.querySelectorAll('#sidebarUserName,#sidebarPopupName').forEach(el => {
    if (el) el.textContent = newName;
  });
  updateSidebarRoleBadge();
  // 홈화면 인사말 업데이트
  const greetEl = document.getElementById('projectsUserName');
  if (greetEl) greetEl.textContent = `안녕하세요, ${newName}님`;
  // 프로젝트 문서에 변경된 별명 저장
  if (_currentProjectId) _syncProfileToProject(_currentProjectId);
}

/** 별명 편집 취소 (Escape) */
function cancelEditName() {
  _restoreNameRow(getProfileName());
}

function _restoreNameRow(name) {
  const row = document.getElementById('myInfoNameRow');
  if (!row) return;
  row.innerHTML = `
    <span class="myinfo-profile-name" id="myInfoName">${esc(name)}</span>
    <span class="myinfo-name-edit-icon">✏️</span>
  `;
}

function _syncNameToPresence(name) {
  const user = auth.currentUser;
  if (!user || !_presenceFileKey) return;
  const emoji = localStorage.getItem(PROFILE_EMOJI_KEY()) || DEFAULT_EMOJI;
  db.collection('presence').doc(_presenceFileKey)
    .set({ [user.uid]: { name, emoji, email: user.email || '', updatedAt: Date.now() } }, { merge: true })
    .catch(() => {});
}
const PROFILE_EMOJIS = [
  '😀','😎','🤩','😇','🥳','🤗','😏','🧐',
  '🐱','🐶','🦊','🐻','🐼','🐨','🐯','🦁',
  '🌟','⚡','🔥','🌈','🎬','🎭','🎥','🎞',
  '🚀','✈️','🎸','🎹','🎨','✏️','📖','💡',
  '🍎','🍕','☕','🍀','🌸','🌻','🌙','⭐',
];

const DEFAULT_EMOJI = '😊';

function applyProfileEmoji() {
  const emoji = localStorage.getItem(PROFILE_EMOJI_KEY()) || DEFAULT_EMOJI;
  const avatarEl  = document.getElementById('sidebarUserAvatar');
  const popupEl   = document.getElementById('sidebarPopupAvatar');
  const previewEl = document.getElementById('myInfoAvatarPreview');

  [avatarEl, popupEl].forEach(el => {
    if (!el) return;
    el.textContent   = emoji;
    el.style.fontSize   = '';
    el.style.fontWeight = '400';
    el.style.color      = '';
    el.style.textShadow = '';
  });
  if (previewEl) {
    previewEl.textContent   = emoji;
    previewEl.style.fontSize   = '26px';
    previewEl.style.fontWeight = '400';
    previewEl.style.color      = '';
    previewEl.style.textShadow = '';
  }
}

function initEmojiPicker() {
  const grid = document.getElementById('myInfoEmojiGrid');
  if (!grid) return;
  const current = localStorage.getItem(PROFILE_EMOJI_KEY()) || DEFAULT_EMOJI;
  grid.innerHTML = PROFILE_EMOJIS.map(e =>
    `<button class="myinfo-emoji-btn${e === current ? ' selected' : ''}" onclick="selectProfileEmoji('${e}')" title="${e}">${e}</button>`
  ).join('');
}

function toggleEmojiPicker() {
  const popover = document.getElementById('myInfoEmojiPopover');
  if (!popover) return;
  const opening = !popover.classList.contains('open');
  popover.classList.toggle('open', opening);
  if (opening) initEmojiPicker();
}

function selectProfileEmoji(emoji) {
  localStorage.setItem(PROFILE_EMOJI_KEY(), emoji);
  applyProfileEmoji();
  document.querySelectorAll('.myinfo-emoji-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.textContent === emoji);
  });
  document.getElementById('myInfoEmojiPopover')?.classList.remove('open');

  // Presence 문서의 내 이모지도 즉시 업데이트 → 다른 접속자 화면에도 반영
  const user = auth.currentUser;
  if (user && _presenceFileKey) {
    const name = getProfileName();
    db.collection('presence').doc(_presenceFileKey)
      .set({ [user.uid]: { name, emoji, email: user.email || '', updatedAt: Date.now() } }, { merge: true })
      .catch(() => {});
  }

  // 프로젝트 정보 탭 / 홈 모달의 소유자·참여자 행 즉시 갱신
  _piRenderMembers();
  _pmRenderMembers();
  // 프로젝트 문서에 변경된 이모티콘 저장
  if (_currentProjectId) _syncProfileToProject(_currentProjectId);
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── About 모달 ──────────────────────────────────────
function showAbout() {
  document.getElementById('aboutModal').classList.remove('hidden');
}
function closeAbout() {
  document.getElementById('aboutModal').classList.add('hidden');
}

// ── 후원 모달 ──────────────────────────────────────
const DONATE_ACCOUNT = '1000-0172-1387';

function showDonate() {
  document.getElementById('donateModal').classList.remove('hidden');
}
function closeDonate() {
  document.getElementById('donateModal').classList.add('hidden');
}
function copyDonateAccount() {
  navigator.clipboard.writeText(DONATE_ACCOUNT).then(() => {
    const btn = document.getElementById('donateCopyBtn');
    btn.textContent = '복사됨';
    btn.style.color = '#34d399';
    setTimeout(() => { btn.textContent = '복사'; btn.style.color = ''; }, 1800);
  });
}

// ── 커스텀 툴팁 (브라우저 기본 딜레이 대신 빠른 표시) ──
(function() {
  const tip = document.createElement('div');
  tip.id = 'customTooltip';
  document.body.appendChild(tip);

  let timer = null;
  let curEl  = null;
  let lx = 0, ly = 0;

  document.addEventListener('mousemove', e => {
    lx = e.clientX; ly = e.clientY;
    if (tip.classList.contains('show')) moveTip();
  });

  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[title]');
    if (el === curEl) return;
    hide();
    if (!el) return;
    const text = el.getAttribute('title');
    if (!text) return;
    curEl = el;
    el._tt = text;
    el.removeAttribute('title'); // 브라우저 기본 툴팁 억제
    clearTimeout(timer);
    timer = setTimeout(show, 1200);
  });

  document.addEventListener('mouseout', e => {
    if (curEl && e.relatedTarget && curEl.contains(e.relatedTarget)) return;
    hide();
  });

  function show() {
    if (!curEl || !curEl._tt) return;
    tip.textContent = curEl._tt;
    tip.classList.add('show');
    moveTip();
  }
  function hide() {
    clearTimeout(timer);
    if (curEl && curEl._tt) { curEl.setAttribute('title', curEl._tt); delete curEl._tt; }
    curEl = null;
    tip.classList.remove('show');
  }
  function moveTip() {
    const x = lx + 14, y = ly + 22;
    tip.style.left = Math.min(x, window.innerWidth  - tip.offsetWidth  - 8) + 'px';
    tip.style.top  = Math.min(y, window.innerHeight - tip.offsetHeight - 8) + 'px';
  }
})();

/* ═══════════════════════════════════════════════════
   모바일 전용 함수 (dontpanicpre_m.html)
═══════════════════════════════════════════════════ */

// ── 모바일 내비 드로어 ──
function toggleMobileNav() {
  document.getElementById('mobileNavDrawer').classList.toggle('open');
  document.getElementById('mobileNavOverlay').classList.toggle('open');
}
function closeMobileNav() {
  document.getElementById('mobileNavDrawer').classList.remove('open');
  document.getElementById('mobileNavOverlay').classList.remove('open');
}
function mobileTab(id, btn) {
  switchTab(id, btn);
  document.querySelectorAll('.mobile-drawer-item[data-tab]').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  closeMobileNav();
}

// ── 씬브레이크다운 스크립트 패널 토글 (모바일) ──
function toggleSbdScript(snum, btn) {
  const page  = document.getElementById(`sbdp-${snum}`);
  if (!page) return;
  const right = page.querySelector('.sbd-right');
  if (!right) return;
  const open = right.classList.toggle('mobile-open');
  if (btn) btn.style.color = open ? 'var(--accent)' : '';
}

// ── 미배치씬 패널 접기/펼치기 ──
function toggleUnschedPanel() {
  const panel = document.getElementById('unschedPanel');
  const btn   = document.getElementById('unschedToggleBtn');
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  if (btn) btn.textContent = collapsed ? '▼' : '▲';
}

// ── 에디터 사이드바 토글 ──
function toggleMobileSidebar() {
  const sb = document.querySelector('.scene-sidebar');
  const ov = document.getElementById('sidebarOverlay');
  const isOpen = sb.classList.toggle('mobile-open');
  ov.classList.toggle('open', isOpen);
}
function closeMobileSidebar() {
  document.querySelector('.scene-sidebar').classList.remove('mobile-open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

// ── 터치 드래그앤드롭 (촬영 스케줄) ──
(function initTouchDnD() {
  let ghost = null;

  document.addEventListener('touchstart', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    // dataset.num은 일반 씬(숫자)과 인서트씬(문자열 "1_ins1") 둘 다 올 수 있음
    const rawNum = chip.dataset.num;
    const num = isNaN(rawNum) || rawNum === '' ? rawNum : +rawNum;
    const fromDate = chip.dataset.date || null;
    if (!selectedNums.has(num)) { selectedNums.clear(); selectedNums.add(num); }
    dragging = { nums: [...selectedNums], fromDate };
    // 고스트 생성
    ghost = chip.cloneNode(true);
    ghost.style.cssText = 'position:fixed;opacity:.7;pointer-events:none;z-index:9999;min-width:80px;';
    document.body.appendChild(ghost);
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!dragging || !ghost) return;
    e.preventDefault();
    const t = e.touches[0];
    ghost.style.left = (t.clientX - 30) + 'px';
    ghost.style.top  = (t.clientY - 20) + 'px';
    // drag-over 시각 피드백
    document.querySelectorAll('.cal-cell.drag-over').forEach(el => el.classList.remove('drag-over'));
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const cell = el?.closest('.cal-cell');
    if (cell && cell.dataset.date) cell.classList.add('drag-over');
  }, { passive: false });

  document.addEventListener('touchend', e => {
    if (!dragging || !ghost) return;
    const t = e.changedTouches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    ghost.remove(); ghost = null;
    document.querySelectorAll('.cal-cell.drag-over').forEach(el => el.classList.remove('drag-over'));
    const cell = el?.closest('.cal-cell');
    const dateStr = cell?.dataset.date;
    if (dateStr) {
      calDropTouch(dateStr);
    } else if (el?.closest('#unschedScroll')) {
      dropToUnsched({ preventDefault: () => {} });
    } else {
      dragging = null; selectedNums.clear();
    }
  });

  function calDropTouch(dateStr) {
    if (!dragging) return;
    const { nums, fromDate } = dragging;
    const numsStr = new Set(nums.map(String));
    // 기존 날짜에서 제거
    if (fromDate && fromDate !== dateStr) {
      const oldCS = callSheets.find(c => c.csNum === schedDays[fromDate]);
      if (oldCS) nums.forEach(n => {
        const s = scenes.find(x => String(x.number) === String(n));
        if (s) oldCS.rows = oldCS.rows.filter(r => r.sNum !== s.displayNum);
      });
    }
    for (const [d, arr] of Object.entries(sched)) sched[d] = arr.filter(n => !numsStr.has(String(n)));
    if (!sched[dateStr]) sched[dateStr] = [];
    sched[dateStr].push(...nums);
    nums.forEach(n => { const s = scenes.find(x => String(x.number) === String(n)); if (s) s.schedDate = dateStr; });
    // 일촬표에 추가
    const newCS = callSheets.find(c => c.csNum === schedDays[dateStr]);
    if (newCS) {
      nums.forEach(n => {
        const s = scenes.find(x => String(x.number) === String(n)); if (!s) return;
        if (!newCS.rows.some(r => r.sNum === s.displayNum))
          newCS.rows.push({
            sNum: s.displayNum, place: s.loc, shootLoc: '', dn: toDN(s.time),
            sol: ({ INT:'I', EXT:'E', 'INT/EXT':'I/E', 'EXT/INT':'E/I' }[s.ie] || ''),
            shots: '', setupTime: '', synopsis: sceneNotes[s.number] || '',
            cast: s.chars.join(', '), props: '', note: ''
          });
      });
    }
    dragging = null; selectedNums.clear();
    save(); renderCalendar(); renderUnsched();
  }
})();

// ══════════════════════════════════════════════════
// 사이드바
// ══════════════════════════════════════════════════
(function initSidebar() {
  if (localStorage.getItem('dpre-sidebar-collapsed') === 'true') {
    document.getElementById('sidebar')?.classList.add('collapsed');
  }
})();

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('dpre-sidebar-collapsed', sidebar.classList.contains('collapsed'));
}

function toggleSidebarUserPopup() {
  document.getElementById('sidebarUserPopup').classList.toggle('open');
}

function closeSidebarUserPopup() {
  document.getElementById('sidebarUserPopup').classList.remove('open');
}

// 외부 클릭 시 사용자 팝업 닫기
document.addEventListener('click', function(e) {
  const popup = document.getElementById('sidebarUserPopup');
  const btn   = document.getElementById('sidebarUserBtn');
  if (popup && !popup.contains(e.target) && btn && !btn.contains(e.target)) {
    popup.classList.remove('open');
  }
});

// 플라이아웃 hover — CSS :hover 대신 JS 딜레이 방식으로 처리
// (버튼→flyout 사이 공백을 지날 때 사라지는 문제 방지)
(function () {
  function initFlyouts() {
    document.querySelectorAll('.sidebar-popup-flyout-wrap').forEach(function (wrap) {
      let leaveTimer = null;
      wrap.addEventListener('mouseenter', function () {
        clearTimeout(leaveTimer);
        wrap.classList.add('flyout-open');
      });
      wrap.addEventListener('mouseleave', function () {
        leaveTimer = setTimeout(function () {
          wrap.classList.remove('flyout-open');
        }, 120); // 120ms 유예 — 공백 통과 시에도 닫히지 않음
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFlyouts);
  } else {
    initFlyouts();
  }
})();

// ══════════════════════════════════════════════════
// (서식 패널 제거됨)
// ══════════════════════════════════════════════════

// ══════════════════════════════════════════════════
// ProseMirror 에디터 초기화
// editor.js(ESM)가 로드 완료된 뒤 실행되도록 폴링.
// ══════════════════════════════════════════════════
(function initDPEditor() {
  function tryMount() {
    const el = document.getElementById('scriptEditor');
    if (!el || !window.DPEditor) {
      setTimeout(tryMount, 50);
      return;
    }
    DPEditor.mount(el);
    document.body.classList.add('pm-mode'); // PM 모드 CSS 분기용
    DPEditor.onChange(() => {
      if (typeof onEditorInput === 'function') onEditorInput();
    });
    DPEditor.onSelectionChange(() => {
      if (typeof refreshTypeUI === 'function') refreshTypeUI();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryMount);
  } else {
    tryMount();
  }
})();
