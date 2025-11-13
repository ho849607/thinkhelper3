/* index.js — ThinkHelper front controller
 * - CKEditor 초기화
 * - 실시간 관찰 (/observe)
 * - 접두사 추천 (/suggest)
 * - 수락 강화 (/accept)
 * - VSCode 스타일 suggestionBox 렌더/키보드 제어
 */

/* ================== CONFIG ================== */
const API_BASE = location.origin; // 필요시 'http://127.0.0.1:8000'
const ENDPOINTS = {
  observe: `${API_BASE}/observe`,
  suggest: `${API_BASE}/suggest`,
  accept:  `${API_BASE}/accept`,
};

const DOC_ID = (() => {
  // URL ?doc=xxx 우선, 없으면 sessionStorage 유지, 마지막으로 시간기반 새로 생성
  const urlId = new URLSearchParams(location.search).get('doc');
  if (urlId) return urlId;
  const ss = sessionStorage.getItem('th.doc_id');
  if (ss) return ss;
  const gen = 'doc_' + Date.now();
  sessionStorage.setItem('th.doc_id', gen);
  return gen;
})();

/* ================== Utils ================== */
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function debounce(fn, wait = 600) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** HTML -> plain text */
function plain(html) {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 현재 캐럿 왼쪽의 접두사 추출 */
function getPrefixFromSelection() {
  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0) return '';
  const node = sel.getRangeAt(0).startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return '';
  const left = (node.textContent || '').slice(0, sel.getRangeAt(0).startOffset);
  const m = left.match(/[\p{L}\p{N}_\-]{1,32}$/u);
  return m ? m[0] : '';
}

/** 언어 추정 (간단) */
function guessLangFromPrefix(prefix) {
  if (/[가-힣]/.test(prefix)) return 'ko';
  return 'en';
}

/* ================== CKEditor Init ================== */
let editor = null;

async function initEditor() {
  editor = await ClassicEditor.create($('#editor'), {
    placeholder: '여기서 작성하세요… (예: 경쟁사 분석, 회의록, 보도자료)',
  });

  // 타이핑 -> 관찰(디바운스) -> 추천 트리거
  const onChange = debounce(async () => {
    const html = editor.getData();
    const text = plain(html);
    observeDocument(DOC_ID, text).catch(console.warn);
  }, 800);

  editor.model.document.on('change:data', onChange);

  // 오토컴플리트 구성
  setupAutocomplete(editor);
}

/* ================== Backend IO ================== */
async function observeDocument(docId, text) {
  // POST /observe {doc_id, text}
  const r = await fetch(ENDPOINTS.observe, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ doc_id: docId, text }),
  });
  if (!r.ok) throw new Error('observe failed');
}

async function fetchSuggestions(prefix, docId, topN = 8) {
  // GET /suggest?prefix=...&doc_id=...&top_n=8
  const url = new URL(ENDPOINTS.suggest);
  url.searchParams.set('prefix', prefix);
  url.searchParams.set('doc_id', docId);
  url.searchParams.set('top_n', String(topN));
  const r = await fetch(url.toString(), { method: 'GET' });
  if (!r.ok) throw new Error('suggest failed');
  const data = await r.json();
  return Array.isArray(data) ? data : (data.suggestions || []);
}

async function acceptSuggestion(docId, word) {
  // POST /accept {doc_id, word}
  const r = await fetch(ENDPOINTS.accept, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ doc_id: docId, word }),
  });
  if (!r.ok) throw new Error('accept failed');
}

/* ================== Suggestion Box ================== */
/*  index.html 에 아래 요소가 있거나, 없으면 동적 생성됨:
    <div id="suggestionBox" role="listbox" aria-label="자동완성"></div>
*/
let suggestionBox = null;
let selectedIndex = 0;
let currentCandidates = [];

function ensureSuggestionBox() {
  if (!suggestionBox) {
    suggestionBox = document.createElement('div');
    suggestionBox.id = 'suggestionBox';
    suggestionBox.setAttribute('role', 'listbox');
    suggestionBox.style.display = 'none';
    document.body.appendChild(suggestionBox);
  }
}

function renderList() {
  if (!currentCandidates.length) return;
  let html = '<ul>';
  currentCandidates.forEach((word, idx) => {
    const act = idx === selectedIndex ? 'active' : '';
    html += `<li class="${act}" data-idx="${idx}">${word}</li>`;
  });
  html += '</ul>';
  suggestionBox.innerHTML = html;

  // 마우스 클릭 수락
  suggestionBox.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const idx = Number(li.dataset.idx);
      applySuggestion(currentCandidates[idx]);
    });
  });
}

/** CKEditor 뷰 selection -> DOM Range -> 좌표 계산 */
function placeSuggestionBox() {
  try {
    const domConverter = editor.editing.view.domConverter;
    const viewSelection = editor.editing.view.document.selection;
    const viewRange = viewSelection.getFirstRange();
    if (!viewRange) return;

    const domRange = domConverter.viewRangeToDom(viewRange);
    const rect = domRange.getBoundingClientRect();
    if (!rect || (rect.left === 0 && rect.top === 0)) return;

    suggestionBox.style.left = `${rect.left + window.scrollX}px`;
    suggestionBox.style.top  = `${rect.bottom + window.scrollY + 5}px`;
  } catch (e) {
    // 좌표 계산 실패시 숨김
    suggestionBox.style.display = 'none';
  }
}

function showSuggestion(cands) {
  currentCandidates = cands || [];
  if (!currentCandidates.length) return closeSuggestion();

  ensureSuggestionBox();
  selectedIndex = 0;
  renderList();
  suggestionBox.style.display = 'block';
  placeSuggestionBox();
}

function closeSuggestion() {
  if (!suggestionBox) return;
  suggestionBox.style.display = 'none';
  currentCandidates = [];
  selectedIndex = 0;
}

function applySuggestion(word) {
  if (!word) return;

  // 접두사 길이만큼 지우고 전체 단어 삽입
  const prefix = getPrefixFromSelection();
  editor.model.change(writer => {
    const sel = editor.model.document.selection;
    const pos = sel.getFirstPosition();
    if (!pos) return;

    if (prefix) {
      const delRange = writer.createRange(pos.getShiftedBy(-prefix.length), pos);
      writer.remove(delRange);
    }
    writer.insertText(word, editor.model.document.selection.getFirstPosition());
  });

  // 강화학습 신호 전송 (비동기)
  acceptSuggestion(DOC_ID, word).catch(console.warn);
  closeSuggestion();
}

/* ================== Autocomplete Wiring ================== */
function setupAutocomplete(ed) {
  ensureSuggestionBox();

  const viewDoc = ed.editing.view.document;

  // 키보드 내비게이션: ↑ ↓ Tab Enter Esc
  viewDoc.on('keydown', (evt, data) => {
    if (suggestionBox.style.display !== 'block') return;

    if (data.keyCode === 38) { // Up
      evt.stop(); data.preventDefault();
      selectedIndex = (selectedIndex > 0) ? selectedIndex - 1 : currentCandidates.length - 1;
      renderList(); placeSuggestionBox();
    } else if (data.keyCode === 40) { // Down
      evt.stop(); data.preventDefault();
      selectedIndex = (selectedIndex < currentCandidates.length - 1) ? selectedIndex + 1 : 0;
      renderList(); placeSuggestionBox();
    } else if (data.keyCode === 9 || data.keyCode === 13) { // Tab or Enter
      evt.stop(); data.preventDefault();
      applySuggestion(currentCandidates[selectedIndex]);
    } else if (data.keyCode === 27) { // Esc
      evt.stop(); data.preventDefault();
      closeSuggestion();
    }
  }, { priority: 'highest' });

  // 타이핑 후 추천 질의 (디바운스)
  const querySuggest = debounce(async () => {
    const prefix = getPrefixFromSelection();
    if (!prefix) return closeSuggestion();

    // UI 표시용 언어 갱신 (선택)
    const lang = guessLangFromPrefix(prefix);
    const langDisp = $('langGuess'); if (langDisp) langDisp.textContent = lang;

    try {
      const cands = await fetchSuggestions(prefix, DOC_ID, 8);
      if (Array.isArray(cands) && cands.length) {
        showSuggestion(cands);
      } else {
        closeSuggestion();
      }
    } catch (e) {
      console.warn(e);
      closeSuggestion();
    }
  }, 150);

  // 키업마다 접두사 체크 & 추천 호출
  viewDoc.on('keyup', () => {
    querySuggest();
  });

  // 에디터 스크롤/윈도우 리사이즈 시 위치 재계산
  ed.model.document.on('change:data', () => {
    if (suggestionBox.style.display === 'block') placeSuggestionBox();
  });
  document.addEventListener('scroll', () => {
    if (suggestionBox.style.display === 'block') placeSuggestionBox();
  }, true);
  window.addEventListener('resize', () => {
    if (suggestionBox.style.display === 'block') placeSuggestionBox();
  });
}

/* ================== Boot ================== */
document.addEventListener('DOMContentLoaded', initEditor);
