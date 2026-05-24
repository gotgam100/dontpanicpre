/**
 * Don't Panic Pre — ProseMirror + Yjs 협업 에디터
 * window.DPEditor 로 노출되어 app.js에서 사용.
 *
 * WebSocket 서버: wss://dontpanicpre-ws.fly.dev
 * 로컬 dev:       ws://localhost:8080
 */
import { Schema, DOMParser as PMDOMParser }              from 'prosemirror-model';
import { EditorState, Plugin, PluginKey, TextSelection }  from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet }          from 'prosemirror-view';
import { keymap }                                         from 'prosemirror-keymap';
import { baseKeymap }                                     from 'prosemirror-commands';
import { history, undo, redo }                           from 'prosemirror-history';
import * as Y                                             from 'yjs';
import { ySyncPlugin }                                    from 'y-prosemirror';
import { WebsocketProvider }                              from 'y-websocket';

// ── WebSocket 서버 URL ────────────────────────────
const WS_URL = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'ws://localhost:8080'
  : 'wss://dontpanicpre-ws.fly.dev';

// ── 1. Schema ────────────────────────────────────
// DOM 포맷을 기존 contentEditable과 동일하게 유지해
// parseFromEditor() 등 기존 파싱 함수가 그대로 동작합니다.

const LINE_CLASS = {
  heading:  'l-heading',
  action:   'l-action',
  char:     'l-char',
  dialogue: 'l-dialogue',
  insert:   'l-insert',
};

function blockSpec(typeName) {
  const cls = LINE_CLASS[typeName] || 'l-action';
  return {
    attrs: {
      insertId:        { default: null },
      insertIe:        { default: null },
      insertTime:      { default: null },
      insertLoc:       { default: null },
      insertParentSeq: { default: null },
    },
    content:  'inline*',
    group:    'block',
    defining: true,
    toDOM(node) {
      const a = { 'data-type': typeName, class: cls };
      if (node.attrs.insertId)        a['data-insert-id']         = node.attrs.insertId;
      if (node.attrs.insertParentSeq) a['data-insert-parent-seq'] = node.attrs.insertParentSeq;
      if (node.attrs.insertIe)        a['data-insert-ie']         = node.attrs.insertIe;
      if (node.attrs.insertTime)      a['data-insert-time']       = node.attrs.insertTime;
      if (node.attrs.insertLoc)       a['data-insert-loc']        = node.attrs.insertLoc;
      return ['p', a, 0];
    },
    parseDOM: [
      {
        tag: `p[data-type="${typeName}"]`,
        getAttrs(dom) {
          return {
            insertId:        dom.dataset.insertId        || null,
            insertParentSeq: dom.dataset.insertParentSeq || null,
            insertIe:        dom.dataset.insertIe        || null,
            insertTime:      dom.dataset.insertTime      || null,
            insertLoc:       dom.dataset.insertLoc       || null,
          };
        },
      },
      { tag: `p.${cls}` },
    ],
  };
}

const scriptSchema = new Schema({
  nodes: {
    doc:      { content: 'block+' },
    heading:  blockSpec('heading'),
    action:   blockSpec('action'),
    char:     blockSpec('char'),
    dialogue: blockSpec('dialogue'),
    insert:   blockSpec('insert'),
    text:     { inline: true, group: 'inline' },
  },
  marks: {
    // 요소 등록 하이라이트 (인물소품·공간소품·의상·분장·장소·효과·기타)
    elemTag: {
      attrs: { type: {} },
      spanning: false,
      toDOM(mark) {
        return ['span', {
          class: `elem-tag elem-${mark.attrs.type}`,
          'data-elem-type': mark.attrs.type,
        }, 0];
      },
      parseDOM: [{
        tag: 'span.elem-tag[data-elem-type]',
        getAttrs(dom) { return { type: dom.dataset.elemType }; },
      }],
    },
  },
});

// ── 2. Enter 키 동작 ──────────────────────────────
// heading → action, char → dialogue, dialogue → action, 나머지 → 같은 유형
const NEXT_TYPE = {
  heading: 'action',
  action:  'action',
  char:    'dialogue',
  dialogue:'action',
  insert:  'action',
};

function handleEnter(state, dispatch) {
  const { $from, $to } = state.selection;
  if (!$from.parent || $from.depth === 0) return false;

  const curNode  = $from.parent;
  const curType  = curNode.type.name;
  const nextName = NEXT_TYPE[curType] || 'action';
  const nextType = scriptSchema.nodes[nextName];

  // 현재 커서부터 단락 끝까지의 텍스트를 새 단락으로 이동
  const endOfNode = $from.end();
  const tr = state.tr;

  if ($from.pos === endOfNode) {
    // 커서가 끝에 있음 → 빈 새 단락 삽입
    const newNode = nextType.create();
    tr.insert($from.pos + 1, newNode);
    tr.setSelection(TextSelection.create(tr.doc, $from.pos + 2));
  } else {
    // 커서가 중간 → 단락 분할 후 다음 단락 유형 변경
    tr.split($from.pos);
    const newPos  = $from.pos + 1;
    const newNode = tr.doc.nodeAt(newPos);
    if (newNode) {
      tr.setNodeMarkup(newPos, nextType);
    }
    tr.setSelection(TextSelection.create(tr.doc, newPos + 1));
  }

  dispatch(tr.scrollIntoView());
  return true;
}

// ── 3. 줄 유형 변경 커맨드 ───────────────────────
function setNodeType(typeName) {
  return function(state, dispatch) {
    const type = scriptSchema.nodes[typeName];
    if (!type) return false;
    const { $from, $to } = state.selection;
    const tr = state.tr;
    state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (node.isBlock && node.type !== scriptSchema.nodes.doc) {
        tr.setNodeMarkup(pos, type, node.attrs);
      }
    });
    if (dispatch) dispatch(tr);
    return true;
  };
}

// ── 4. 붙여넣기: 평문을 action 단락으로 변환 ─────
function buildPastePlugin() {
  return new Plugin({
    props: {
      transformPastedHTML(html) {
        // 외부 HTML에서 불필요한 서식 제거, data-type 없는 p는 action으로 처리
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        tmp.querySelectorAll('p:not([data-type])').forEach(p => {
          p.setAttribute('data-type', 'action');
          p.className = 'l-action';
        });
        // p가 아닌 블록 요소(div, h1~h6 등)를 action <p>로 변환
        tmp.querySelectorAll('div,h1,h2,h3,h4,h5,h6,li').forEach(el => {
          const p = document.createElement('p');
          p.setAttribute('data-type', 'action');
          p.className = 'l-action';
          p.textContent = el.textContent;
          el.replaceWith(p);
        });
        return tmp.innerHTML;
      },
      transformPastedText(text) {
        // 평문 붙여넣기: 줄마다 action 단락으로 변환
        return text
          .split(/\r?\n/)
          .filter(l => l.trim())
          .map(l => `<p data-type="action" class="l-action">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`)
          .join('');
      },
    },
  });
}

// ── 5. 페이지 브레이크 Decoration 플러그인 ──────────
// contentEditable의 adjustPageBreaks()를 PM Decoration으로 대체.
// DOM 측정 후 페이지 경계 밴드에 걸치는 블록 노드에 margin-top을 주입해
// 해당 단락이 다음 페이지로 밀려나도록 한다.
const A4_H  = 1123; // app.js의 A4_PAGE_H와 동일 (297mm @ 96dpi)
const BAND  = 95;   // 경계 위아래 95px (= 총 190px 오버레이 절반)

const pageBreakKey = new PluginKey('dpPageBreak');

function buildPageBreakPlugin() {
  return new Plugin({
    key: pageBreakKey,
    state: {
      init: () => ({ decos: DecorationSet.empty, marker: '' }),
      apply(tr, old, _oldState, newState) {
        const meta = tr.getMeta(pageBreakKey);
        if (meta) return meta;
        return { decos: old.decos.map(tr.mapping, newState.doc), marker: old.marker };
      },
    },
    props: {
      decorations(state) { return pageBreakKey.getState(state).decos; },
    },
    view(editorView) {
      let _rafId = null;
      let _debounceTimer = null;

      // ── 측정 단계: 데코가 없는 상태(자연 위치)에서 호출해야 정확
      function measure() {
        if (!editorView.dom.isConnected) return;

        const blocks = [];
        editorView.state.doc.forEach((node, offset, idx) => {
          const dom = editorView.nodeDOM(offset);
          if (!(dom instanceof HTMLElement)) return;
          // 데코 없으므로 offsetTop = 순수 자연 위치
          blocks.push({ pos: offset, size: node.nodeSize,
                        top: dom.offsetTop, bot: dom.offsetTop + dom.offsetHeight, idx });
        });

        const decos = [];
        const markerParts = [];
        const handled = new Set();
        let totalShift = 0; // 앞 데코의 캐스케이드 누적

        for (const blk of blocks) {
          const shiftedTop = blk.top + totalShift;
          const shiftedBot = blk.bot + totalShift;

          for (let pg = Math.floor(shiftedTop / A4_H) + 1; pg * A4_H - BAND < shiftedBot; pg++) {
            if (handled.has(pg)) continue;
            const bandTop = pg * A4_H - BAND;
            const bandBot = pg * A4_H + BAND;
            if (shiftedTop < bandBot && shiftedBot > bandTop) {
              const neededMargin = Math.ceil(bandBot - shiftedTop);
              decos.push(Decoration.node(blk.pos, blk.pos + blk.size,
                { style: `margin-top:${neededMargin}px` }));
              markerParts.push(`${blk.idx}:${neededMargin}`); // doc 인덱스 기반
              handled.add(pg);
              totalShift += neededMargin;
              break;
            }
          }
        }

        const marker = markerParts.join('|');
        const cur = pageBreakKey.getState(editorView.state);
        if (marker !== cur.marker) {
          editorView.dispatch(editorView.state.tr.setMeta(pageBreakKey,
            { decos: DecorationSet.create(editorView.state.doc, decos), marker }));
        }
      }

      // ── 단일 rAF 안에서: 클리어(동기) → 레이아웃 강제 → 측정·적용
      // paint가 없으므로 clear-flash 없음
      function recompute() {
        _rafId = null;
        if (!editorView.dom.isConnected) return;

        // 1) 데코 제거 — PM이 synchronously DOM에서 margin-top 제거
        const cur = pageBreakKey.getState(editorView.state);
        if (cur.marker !== '') {
          editorView.dispatch(editorView.state.tr.setMeta(pageBreakKey,
            { decos: DecorationSet.empty, marker: '' }));
        }

        // 2) offsetTop 읽기 → 브라우저 layout reflow 강제 → 자연 위치 확보
        //    이후 measure()에서 새 데코 계산·적용 (같은 rAF = 같은 프레임)
        measure();
      }

      // 300 ms 디바운스: 타이핑 중엔 데코를 건드리지 않고, 멈추면 한 번만 재계산
      function scheduleRecompute() {
        if (_rafId !== null) cancelAnimationFrame(_rafId);
        if (_debounceTimer !== null) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
          _debounceTimer = null;
          _rafId = requestAnimationFrame(recompute);
        }, 300);
      }

      // 초기 계산은 즉시
      _rafId = requestAnimationFrame(recompute);

      return {
        update(view, prevState) {
          if (!view.state.doc.eq(prevState.doc)) scheduleRecompute();
        },
        destroy() {
          if (_rafId !== null) cancelAnimationFrame(_rafId);
          if (_debounceTimer !== null) clearTimeout(_debounceTimer);
        },
      };
    },
  });
}

// ── 6. onChange / onSelectionChange 플러그인 ────
const callbackKey = new PluginKey('dpCallbacks');

function buildCallbackPlugin(cbs) {
  return new Plugin({
    key: callbackKey,
    view() {
      return {
        update(view, prevState) {
          if (!prevState.doc.eq(view.state.doc)) {
            cbs.onChange?.();
          }
          if (!prevState.selection.eq(view.state.selection)) {
            cbs.onSelectionChange?.();
          }
        },
      };
    },
  });
}

// ── 6. 내부 상태 ──────────────────────────────────
let _view     = null;   // EditorView
let _ydoc     = null;   // Y.Doc
let _provider = null;   // WebsocketProvider
let _ytype    = null;   // Y.XmlFragment

const _cbs = { onChange: null, onSelectionChange: null };

// ── 7. HTML → ProseMirror 문서 파싱 ──────────────
const _parser = PMDOMParser.fromSchema(scriptSchema);

function parseHTML(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '<p data-type="action" class="l-action"><br></p>';
  if (!tmp.querySelector('p[data-type], p[class^="l-"]')) {
    tmp.innerHTML = '<p data-type="action" class="l-action"><br></p>';
  }
  return _parser.parse(tmp);
}

// ── 8. DPEditor 공개 API ─────────────────────────
window.DPEditor = {

  // 에디터를 DOM 요소에 마운트 (앱 시작 시 1회 호출)
  mount(el) {
    if (_view) return;

    // 기존 inline 핸들러 속성 제거 (PM이 모두 처리)
    ['onkeydown','oninput','onpaste','onmouseup','onkeyup'].forEach(attr => el.removeAttribute(attr));

    const state = EditorState.create({
      schema: scriptSchema,
      doc: parseHTML(el.innerHTML || ''),
      plugins: [
        history(),
        keymap({
          'Enter':       handleEnter,
          'Mod-z':       undo,
          'Mod-y':       redo,
          'Shift-Mod-z': redo,
          'Tab':         (state, dispatch) => { dispatch(state.tr); return true; },
        }),
        keymap(baseKeymap),
        buildPastePlugin(),
        buildPageBreakPlugin(),
        buildCallbackPlugin(_cbs),
      ],
    });

    _view = new EditorView({ mount: el }, { state });
  },

  // 프로젝트 열 때 Yjs WebSocket 연결
  connect(projectId) {
    if (!_view || !projectId) return;
    this.disconnect(); // 이전 연결 정리

    _ydoc  = new Y.Doc();
    _ytype = _ydoc.getXmlFragment('prosemirror');

    // ① 먼저 ySyncPlugin으로 PM 내용을 Y.XmlFragment에 초기화
    //    (Provider보다 먼저 해야 서버 상태가 덮어쓰는 것을 방지)
    const ySyncPlg = ySyncPlugin(_ytype);
    const newState = EditorState.create({
      schema: scriptSchema,
      doc:    _view.state.doc,
      plugins: [
        ySyncPlg,
        history(),
        keymap({
          'Enter':       handleEnter,
          'Mod-z':       undo,
          'Mod-y':       redo,
          'Shift-Mod-z': redo,
          'Tab':         (state, dispatch) => { dispatch(state.tr); return true; },
        }),
        keymap(baseKeymap),
        buildPastePlugin(),
        buildPageBreakPlugin(),
        buildCallbackPlugin(_cbs),
      ],
    });
    _view.updateState(newState);

    // ② 그 다음 서버에 연결 (Y.XmlFragment가 이미 초기화된 상태로 연결)
    _provider = new WebsocketProvider(WS_URL, `dpre-${projectId}`, _ydoc, { connect: true });
    _provider.on('status', ({ status }) => {
      document.getElementById('wsStatus')?.setAttribute('data-status', status);
    });
  },

  // 프로젝트 닫을 때 Yjs 연결 해제
  disconnect() {
    if (_provider) { _provider.destroy(); _provider = null; }
    if (_ydoc)     { _ydoc.destroy();     _ydoc     = null; }
    _ytype = null;
  },

  // HTML 문자열로 에디터 내용 교체 (applyLoadedData에서 호출)
  setContent(html) {
    if (!_view) return;
    const doc = parseHTML(html);

    if (_ytype) {
      // Yjs 모드: Y.XmlFragment를 직접 업데이트
      _ydoc.transact(() => {
        _ytype.delete(0, _ytype.length);
        // ProseMirror 노드를 Y.XmlFragment로 변환
        const { prosemirrorToY } = window.__yPM || {};
        if (prosemirrorToY) {
          prosemirrorToY(_ytype, doc, scriptSchema);
        }
      });
    } else {
      // 비-Yjs 모드: 트랜잭션으로 직접 교체
      const tr = _view.state.tr.replaceWith(
        0,
        _view.state.doc.content.size,
        doc.content
      );
      _view.dispatch(tr);
    }
  },

  // 현재 에디터 내용을 HTML로 반환 (doSave에서 호출)
  getContent() {
    if (!_view) return '';
    return _view.dom.innerHTML;
  },

  // 현재 커서가 있는 단락의 줄 유형 변경 (setLineType에서 호출)
  setNodeType(typeName) {
    if (!_view) return;
    setNodeType(typeName)(_view.state, _view.dispatch);
    _view.focus();
  },

  // 현재 커서 위치의 줄 유형 반환 (refreshTypeUI에서 호출)
  getCurrentType() {
    if (!_view) return 'action';
    const { $from } = _view.state.selection;
    return $from.parent?.type?.name || 'action';
  },

  // 읽기 전용 모드 전환 (열람자 역할)
  setReadOnly(bool) {
    if (!_view) return;
    _view.setProps({ editable: () => !bool });
  },

  // 문서 변경 콜백 등록
  onChange(fn) { _cbs.onChange = fn; },

  // 선택 변경 콜백 등록 (refreshTypeUI용)
  onSelectionChange(fn) { _cbs.onSelectionChange = fn; },

  // 에디터 포커스
  focus() { _view?.focus(); },

  // 마운트 여부
  isReady() { return !!_view; },

  // DOM 요소 기준으로 PM 커서 이동 (contentEditable 폴백용)
  moveCursorToDOM(el, selectAll) {
    if (!_view) return;
    try {
      const startPos = _view.posAtDOM(el, 0);
      let sel;
      if (selectAll) {
        const endPos = _view.posAtDOM(el, el.childNodes.length);
        sel = TextSelection.create(_view.state.doc, startPos, endPos);
      } else {
        sel = TextSelection.create(_view.state.doc, startPos);
      }
      _view.dispatch(_view.state.tr.setSelection(sel).scrollIntoView());
      _view.focus();
    } catch (_e) {
      _view.focus();
    }
  },

  // 현재 PM 선택 범위 반환 (선택 없으면 null)
  pmSelectionRange() {
    if (!_view) return null;
    const { from, to } = _view.state.selection;
    return from < to ? { from, to } : null;
  },

  // 선택 범위에 elemTag 마크 추가
  applyElemTag(type, from, to) {
    if (!_view || from >= to) return;
    const mark = _view.state.schema.marks.elemTag.create({ type });
    _view.dispatch(_view.state.tr.addMark(from, to, mark));
  },

  // span DOM 요소 기준으로 elemTag 마크 제거
  removeElemTagSpan(spanEl) {
    if (!_view || !spanEl) return;
    try {
      const from = _view.posAtDOM(spanEl, 0);
      const to   = _view.posAtDOM(spanEl, spanEl.childNodes.length);
      if (from >= to) return;
      _view.dispatch(_view.state.tr.removeMark(from, to, _view.state.schema.marks.elemTag));
    } catch (_e) {}
  },

  /**
   * PM 문서를 직접 순회해 type과 text가 일치하는 elemTag 마크를 모두 제거.
   * snum은 0-based heading 순번(씬 번호)으로 필터링, null이면 전체 문서 대상.
   * removeElemSpanFromEditor의 fallback / 직접 호출용.
   */
  removeElemMarkByText(type, text, snum) {
    if (!_view) return;
    const { state } = _view;
    const markType  = state.schema.marks.elemTag;
    const tr = state.tr;
    let removed = false;
    let headingCount = 0;

    state.doc.descendants((node, pos) => {
      // heading 블록을 만날 때마다 씬 카운터 증가
      if (node.isBlock && node.type.name === 'heading') {
        headingCount++;
        return true; // 자식(inline) 노드도 방문
      }
      // 인라인 텍스트 노드에 elemTag 마크가 있는지 확인
      if (!node.isText) return;
      const hasMark = node.marks.some(
        m => m.type === markType && m.attrs.type === type
      );
      if (!hasMark) return;
      if (node.text?.trim() !== text.trim()) return;
      // snum 필터: null이면 전체, 숫자면 해당 씬만
      if (snum !== null && snum !== undefined && headingCount !== +snum) return;

      tr.removeMark(pos, pos + node.nodeSize, markType);
      removed = true;
    });

    if (removed) _view.dispatch(tr);
  },

  /**
   * PM 문서에서 N번째 heading 노드를 찾아 커서 이동 + DOM 요소 반환.
   * sidebarGoToScene / scrollToScene 전용.
   * @param {number} seq  1-based heading 순번 (parseFromEditor의 seq와 동일)
   * @returns {Element|null}  해당 heading의 DOM 요소 (scrollToSceneHeading에 전달)
   */
  goToHeading(seq) {
    if (!_view) return null;
    let count = 0;
    let foundPos = -1;
    _view.state.doc.descendants((node, pos) => {
      if (foundPos >= 0) return false;
      if (node.type.name === 'heading') {
        count++;
        if (count === seq) { foundPos = pos; return false; }
      }
    });
    if (foundPos < 0) return null;
    try {
      // 커서 이동만 (scrollIntoView는 호출자가 담당)
      const sel = TextSelection.create(_view.state.doc, foundPos + 1);
      _view.dispatch(_view.state.tr.setSelection(sel));
      _view.focus();
      // PM이 렌더링한 DOM 요소 반환
      return _view.nodeDOM(foundPos);
    } catch (_e) {
      return null;
    }
  },
};

