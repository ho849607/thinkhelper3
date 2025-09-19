// server.js (Hardened + Offline Fallback + i18n + Express 5 safe)
'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 5500;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// ───────────────────────── 기본 설정 ─────────────────────────
app.set('trust proxy', true);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS (개발 편의)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 간단 로거
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.ip}`);
  next();
});

// ──────────────────────── 보안/하드닝 ────────────────────────
// (1) 금지어/금칙 패턴 (자체 1차 차단)
const BANNED_WORDS = [
  '해킹','폭탄','살인','자살','음란','마약','테러', // KO
  'hack','hacking','bomb','explosive','kill','suicide','drugs','terror' // EN
];

// 위험한 조합(간단 예시) — 실제 서비스에서는 더 견고한 서버측 검증/분류기를 권장
const DISALLOWED_PATTERNS = [
  /\b(make|build|create|how to).{0,20}(bomb|explosive|weapon)\b/i,
  /\b(ddos|botnet|backdoor|ransomware)\b/i,
  /\b(credit\s*card|cc|cvv).{0,40}(steal|dump|generator)\b/i,
  /\b(child|minor).{0,20}(sex|porn|explicit)\b/i,
];

function filterPrompt(text) {
  if (!text || typeof text !== 'string') return true;
  const lower = text.toLowerCase();
  if (BANNED_WORDS.some(w => lower.includes(w))) return false;
  if (DISALLOWED_PATTERNS.some(rgx => rgx.test(text))) return false;
  return true;
}

// (2) 속도 제한 (메모리 기반 — 프로덕션은 Redis 등 권장)
const rateLimitStore = {};
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1분
const RATE_LIMIT_MAX_REQUESTS = 20;     // 1분 20회

const rateLimiter = (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const recent = (rateLimitStore[ip] || []).filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    console.warn(`[RateLimit] ${ip} blocked`);
    return res.status(429).json({ ok: false, error: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.' });
  }
  recent.push(now);
  rateLimitStore[ip] = recent;
  next();
};

// (3) 외부 네트워크 체크
async function checkInternet() {
  try {
    await axios.get('https://clients3.google.com/generate_204', { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────── 정적 파일 서빙 ────────────────────────
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const ALT = path.join(ROOT, 'index.html2');

app.use(express.static(ROOT,   { extensions: ['html'] }));
app.use(express.static(PUBLIC, { extensions: ['html'] }));
app.use(express.static(ALT,    { extensions: ['html'] }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// ──────────────────────── 유틸/LLM 프롬프트 ────────────────────────
function detectLang(txt = '') {
  if (/[가-힣]/.test(txt)) return 'ko';
  if (/[ぁ-んァ-ン]/.test(txt)) return 'ja';
  if (/[一-龥]/.test(txt)) return 'zh';
  if (/[A-Za-z]/.test(txt)) return 'en';
  return 'en';
}

function suggestLangsFromHeaders(req) {
  const header = String(req.headers['accept-language'] || '').toLowerCase();
  const prefer = [];
  if (header.includes('ko')) prefer.push('ko');
  if (header.includes('ja')) prefer.push('ja');
  if (header.includes('zh')) prefer.push('zh');
  if (header.includes('es')) prefer.push('es');
  if (header.includes('fr')) prefer.push('fr');
  // 영어 항상 포함
  prefer.push('en');
  const set = new Set(); const out = [];
  for (const l of prefer) { if (!set.has(l)) { set.add(l); out.push(l); if (out.length >= 6) break; } }
  return out;
}

function buildSummaryPrompt(lang, text) {
  if (lang === 'ko') return `다음 텍스트를 한국어로 간결하게 핵심만 요약해줘:\n---\n${text}\n---`;
  if (lang === 'ja') return `次の文章を日本語で簡潔に要点だけ要約してください:\n---\n${text}\n---`;
  if (lang === 'zh') return `请用中文简要概括下面文本的要点：\n---\n${text}\n---`;
  return `Summarize the following text concisely in English:\n---\n${text}\n---`;
}

function buildReviewPrompt(lang, text, mode = 'user') {
  let hint = '';
  if (mode === 'research') {
    hint = (lang === 'ko') ? '연구 관점에서 근거/인용/한계/추가 참고문헌 제안(불릿):'
      : (lang === 'ja') ? '研究の観点で根拠/引用/限界/参考文献を箇条書きで:'
      : (lang === 'zh') ? '从研究角度给出证据/引用/局限/参考文献（要点）:'
      : 'From a research view, suggest evidence/citations/limitations/references (bullets):';
  } else if (mode === 'developer') {
    hint = (lang === 'ko') ? '코드/기술문서 관점: 정확성/예외/예시/복잡도/테스트 항목(불릿):'
      : (lang === 'ja') ? 'コード/技術文書の観点：正確性/例外/例/複雑度/テスト項目:'
      : (lang === 'zh') ? '从代码/技术文档角度：准确性/异常/示例/复杂度/测试点:'
      : 'From a code/tech-doc view: accuracy/edge cases/examples/complexity/tests (bullets):';
  } else if (mode === 'legal') {
    hint = (lang === 'ko') ? '법률 관점: 쟁점/관련 법령/리스크/권고(법률 자문 아님):'
      : (lang === 'ja') ? '法的観点：争点/関連法令/リスク/推奨（法的助言ではありません）:'
      : (lang === 'zh') ? '法律角度：争点/相关法规/风险/建议（非法律意见）:'
      : 'Legal view: issues/statutes/risks/recommendations (not legal advice):';
  } else {
    hint = (lang === 'ko') ? '일반 글쓰기: 명확성/구조/톤/맞춤법 개선 포인트(불릿):'
      : (lang === 'ja') ? '一般文書：明確性/構成/トーン/誤字（箇条書き）:'
      : (lang === 'zh') ? '一般写作：清晰度/结构/语气/错别字（要点）:'
      : 'General writing: clarity/structure/tone/grammar (bullets):';
  }

  if (lang === 'ko') return `다음 텍스트를 검토해 개선 제안을 불릿으로 요약:\n---\n${text}\n---\n${hint}`;
  if (lang === 'ja') return `次の文章をレビューし、改善提案を箇条書きでまとめてください:\n---\n${text}\n---\n${hint}`;
  if (lang === 'zh') return `请审阅以下文本，并用要点列出改进建议：\n---\n${text}\n---\n${hint}`;
  return `Review the text and summarize improvement suggestions as bullets:\n---\n${text}\n---\n${hint}`;
}

function greetingBlock() {
  return [
    '안녕하세요! 무엇을 도와드릴까요?',
    'Hello! How can I help you?',
    'こんにちは！何をお手伝いできますか？',
    '你好！我能为你做些什么？',
    '¡Hola! ¿En qué puedo ayudarte?',
    'Bonjour ! Comment puis-je vous aider ?'
  ].join('\n');
}

// 키워드 → 링크
function keywordLinks(text = '', limit = 5) {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9가-힣一-龥ぁ-んァ-ン\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const freq = {};
  for (const w of words) if (w.length >= 2) freq[w] = (freq[w] || 0) + 1;
  const tops = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, limit);
  return tops.map(k => {
    const q = encodeURIComponent(k);
    return [
      { title: `Google: ${k}`, url: `https://www.google.com/search?q=${q}` },
      { title: `Wikipedia: ${k}`, url: `https://ko.wikipedia.org/wiki/${q}` },
    ];
  }).flat();
}

// ──────────────────────── LLM 호출 ────────────────────────
async function callGemini(prompt) {
  if (!GEMINI_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    // 구글 안전 설정 (차단 임계 강화)
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',          threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',         threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',   threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',   threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };
  const { data } = await axios.post(url, body, { timeout: 20000 });

  // 차단 여부 체크
  if (data?.promptFeedback?.blockReason) {
    console.warn(`[Gemini Safety Block] Reason: ${data.promptFeedback.blockReason}`);
    throw new Error('Google Safety Policy Violation');
  }
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ──────────────────────── 오프라인 폴백 ────────────────────────
function fallbackAnswer(message) {
  // 매우 간단한 규칙 기반 응답(네트워크/LLM 불가 시)
  const L = detectLang(message);
  const base = (L === 'ko') ? '지금은 네트워크가 불안정하거나 AI 서버에 연결할 수 없습니다.'
    : (L === 'ja') ? '現在ネットワークが不安定、またはAIサーバーに接続できません。'
    : (L === 'zh') ? '当前网络不稳定或无法连接到AI服务器。'
    : 'The network is unstable or the AI server is unreachable.';
  const promptEcho = message.slice(0, 240);
  const follow = (L === 'ko') ? '간단 요약/키워드만 제안합니다:'
    : (L === 'ja') ? '簡単な要約/キーワードのみ提案します:'
    : (L === 'zh') ? '仅提供简单摘要/关键词建议：'
    : 'Providing a simple summary/keywords only:';
  const words = promptEcho.toLowerCase().replace(/[^a-z0-9가-힣一-龥ぁ-んァ-ン\s]/g,' ').split(/\s+/).filter(Boolean);
  const uniq = Array.from(new Set(words)).slice(0, 8).join(', ');
  return `${base}\n\n${follow}\n• ${uniq || '(키워드가 부족합니다)'}`;
}

// ───────────────────────── API ─────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

app.get('/api/netcheck', async (_req, res) => {
  const online = await checkInternet();
  res.json({ ok: true, online });
});

app.get('/api/ip', (req, res) => {
  const ip = req.headers['cf-connecting-ip']
    || (Array.isArray(req.headers['x-forwarded-for']) ? req.headers['x-forwarded-for'][0] : req.headers['x-forwarded-for'])
    || req.socket?.remoteAddress
    || req.ip;
  res.json({
    ip,
    ua: req.headers['user-agent'] || '',
    lang: req.headers['accept-language'] || '',
  });
});

app.get('/api/suggest-langs', (req, res) => {
  res.json({ ok: true, langs: suggestLangsFromHeaders(req) });
});

// 채팅 (필터 + 속도 제한 + LLM + 폴백)
app.post('/api/chat', rateLimiter, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    const langs = suggestLangsFromHeaders(req);
    const isGreeting = /^ *(hi|hello|hey|안녕|안녕하세요|ㅎㅇ|하이|こんにちわ|こんにちは|こんばんは|你好|您好|嗨|hola|bonjour)\b/i.test(message);

    if (!message || isGreeting) {
      const online = await checkInternet();
      return res.json({ ok: true, mode: 'greeting', reply: greetingBlock(), langs, internet: online, llm_online: !!GEMINI_KEY });
    }

    // 1차 자체 필터
    if (!filterPrompt(message)) {
      console.warn(`[Filter Block] ${req.ip} → "${message}"`);
      return res.status(400).json({ ok: false, error: '부적절한 내용이 포함되어 처리할 수 없습니다.' });
    }

    // LLM 호출 시도
    let answer = null;
    let errorMsg = null;
    const L = detectLang(message);
    const prompt =
      (L === 'ko') ? `다음 질문에 한국어로 명확하고 책임감 있게 답하세요(정책 위반/위험한 내용은 답변 거부):\nQ: ${message}`
    : (L === 'ja') ? `次の質問に日本語で明確かつ責任を持って回答してください（ポリシー違反・危険な内容は拒否）：\nQ: ${message}`
    : (L === 'zh') ? `请用中文清晰且负责任地回答以下问题（违反政策/危险内容应拒绝）：\nQ: ${message}`
    : `Answer clearly and responsibly in English (refuse unsafe/policy-violating content):\nQ: ${message}`;

    if (GEMINI_KEY) {
      try {
        answer = await callGemini(prompt);
      } catch (e) {
        errorMsg = e?.message || 'llm error';
      }
    }

    if (!answer) {
      const online = await checkInternet();
      return res.json({
        ok: true,
        mode: 'fallback',
        reply: fallbackAnswer(message),
        langs,
        internet: online,
        llm_online: false,
        error: errorMsg || 'offline'
      });
    }

    return res.json({
      ok: true,
      mode: 'llm',
      reply: answer,
      langs,
      internet: true,
      llm_online: true
    });
  } catch (e) {
    console.error(`Chat Error: ${e.message}`);
    if (e.message === 'Google Safety Policy Violation') {
      return res.status(400).json({ ok: false, error: '요청이 안전 정책에 의해 차단되었습니다.' });
    }
    res.status(500).json({ ok: false, error: 'chat failed' });
  }
});

// 요약 (필터 + 속도 제한 + LLM + 폴백)
app.post('/api/summarize', rateLimiter, async (req, res) => {
  try {
    const { text = '', lang } = req.body || {};
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' });

    if (!filterPrompt(text)) {
      console.warn(`[Filter Block] ${req.ip} (summarize)`);
      return res.status(400).json({ ok: false, error: '부적절한 내용이 포함되어 처리할 수 없습니다.' });
    }

    const L = lang || detectLang(text);
    const prompt = buildSummaryPrompt(L, text);

    let out = null; let errorMsg = null;
    if (GEMINI_KEY) {
      try { out = await callGemini(prompt); } catch (e) { errorMsg = e?.message || 'llm error'; }
    }
    if (!out) {
      // 간단 폴백 요약(문장 추출)
      const sents = (text.replace(/\s+/g, ' ').match(/[^.!?。！？]+[.!?。！？]?/g) || []).slice(0, 4);
      out = sents.join(' ') || text.slice(0, 500);
    }
    res.json({ ok: true, lang: L, summary: out, llm_online: !!GEMINI_KEY, error: errorMsg || null });
  } catch (e) {
    console.error(`Summarize Error: ${e.message}`);
    if (e.message === 'Google Safety Policy Violation') {
      return res.status(400).json({ ok: false, error: '요청이 안전 정책에 의해 차단되었습니다.' });
    }
    res.status(500).json({ ok: false, error: 'summarize failed' });
  }
});

// 검토 (필터 + 속도 제한 + LLM + 폴백)
app.post('/api/review', rateLimiter, async (req, res) => {
  try {
    const { text = '', mode = 'user', lang } = req.body || {};
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' });

    if (!filterPrompt(text)) {
      console.warn(`[Filter Block] ${req.ip} (review)`);
      return res.status(400).json({ ok: false, error: '부적절한 내용이 포함되어 처리할 수 없습니다.' });
    }

    const L = lang || detectLang(text);
    const prompt = buildReviewPrompt(L, text, mode);

    let out = null; let errorMsg = null;
    if (GEMINI_KEY) {
      try { out = await callGemini(prompt); } catch (e) { errorMsg = e?.message || 'llm error'; }
    }
    if (!out) {
      // 간단 폴백 불릿
      const bullets = [];
      if (text.length > 120) bullets.push('문단을 더 짧게 나눠 가독성 개선');
      if (!/[0-9]/.test(text)) bullets.push('핵심 주장에 수치/사례 추가');
      if (!/,/.test(text)) bullets.push('접속사/쉼표로 문장 흐름 정리');
      bullets.push('맞춤법/띄어쓰기 점검');
      out = bullets.map(b => `• ${b}`).join('\n');
    }
    res.json({ ok: true, lang: L, review: out, llm_online: !!GEMINI_KEY, error: errorMsg || null });
  } catch (e) {
    console.error(`Review Error: ${e.message}`);
    if (e.message === 'Google Safety Policy Violation') {
      return res.status(400).json({ ok: false, error: '요청이 안전 정책에 의해 차단되었습니다.' });
    }
    res.status(500).json({ ok: false, error: 'review failed' });
  }
});

// 자동 링크
app.post('/api/autolinks', (req, res) => {
  const { text = '' } = req.body || {};
  if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' });
  const links = keywordLinks(text, 5);
  res.json({ ok: true, links });
});

// (옵션) 비트코인 트랜잭션 상태 확인
app.post('/api/bitcoin/verify', async (req, res) => {
  try {
    const tx = String(req.body?.tx || '').trim();
    if (!tx) return res.status(400).json({ ok: false, error: 'tx required' });
    const { data } = await axios.get(`https://blockstream.info/api/tx/${tx}/status`, { timeout: 12000 });
    res.json({ ok: true, confirmed: !!data?.confirmed, data });
  } catch (e) {
    console.warn('bitcoin verify fail', e?.message);
    res.status(502).json({ ok: false, error: 'lookup failed or offline' });
  }
});

// API 404
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'unknown endpoint' }));

// ─────────────────── SPA Fallback (Express 5 안전형) ───────────────────
// 정적/API에 매치되지 않은 나머지는 index.html
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// ───────────────────────── 서버 시작 ─────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 ThinkHelper Fortress server listening on http://localhost:${PORT}`);
  if (!GEMINI_KEY) {
    console.warn('⚠️  GEMINI_API_KEY 미설정 — LLM 호출은 폴백(오프라인 규칙 기반)으로 대응합니다.');
  }
});
