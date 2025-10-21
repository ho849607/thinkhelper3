// server.js — ThinkHelper × LM Studio 어댑터 (Node >= 18)
// ------------------------------------------------------
// 기능 요약
// 1) OpenAI 호환: /  (논-스트림), /chat (SSE 스트림)
//    - 우선 /v1/chat/completions → 실패 시 /v1/responses 폴백
// 2) 학습/추천(경량): PII 스크러빙 후 키워드/바이그램만 메모리에 저장
//    - /learn           : 호출 시 기록 저장 + 현재 Top 추천 반환
//    - /learn/contextual: 에디터/채팅 문맥을 반영한 추천 반환
//    - /suggest         : 현 저장분으로 추천만 반환
// 3) 한국어/다국어 강제: system 프롬프트에 언어 고정 문구 주입
// 4) 액션 실행: /action (뉴스요약/목차/요약/리걸 양측/최저가 가이드 등)
// 5) CORS/프리플라이트/헬스체크: 로컬 + 배포 도메인 허용, /health 추가
// ------------------------------------------------------

import express from "express";
import cors from "cors";

// Node 18+: 글로벌 fetch 사용

/* ========= 환경 ========= */
const PORT      = process.env.PORT      || 5050;
// ⚠️ LM Studio 의 OpenAI 호환 서버 주소 (보통 127.0.0.1:1234 또는 127.0.0.1:5050)
const LM_BASE   = (process.env.LM_BASE  || "http://127.0.0.1:1234").replace(/\/$/, "");
const LM_MODEL  = process.env.LM_MODEL  || "mistralai/mathstral-7b-v0.1";
const NODE_ENV  = process.env.NODE_ENV  || "development";

// 배포 도메인 추가 (예: thinkhelper.store, Netlify 도메인 등)
const ALLOW_ORIGINS = [
  "http://127.0.0.1:3000", "http://localhost:3000",
  "http://127.0.0.1:5173", "http://localhost:5173",
  "http://127.0.0.1:5500", "http://localhost:5500",
  "http://127.0.0.1:5050", "http://localhost:5050",
  "https://thinkhelper.store",
  "https://www.thinkhelper.store",
  // "https://<배포-서브도메인>"  // 필요 시 추가
];

/* ========= 앱 ========= */
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

// CORS + 프리플라이트
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/서버-서버 허용
    if (ALLOW_ORIGINS.includes(origin)) return cb(null, true);
    // 서브도메인 와일드카드가 필요하면 아래처럼 확장 가능
    // if (/\.?thinkhelper\.store$/i.test(new URL(origin).hostname)) return cb(null, true);
    return cb(null, false);
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Accept","X-User","X-Mode","X-Lang"]
}));
app.options("*", (_req, res) => res.sendStatus(204)); // 프리플라이트 응답

/* ========= 유틸: PII 스크러빙/토크나이즈/랭귀지 ========= */
function scrubPII(s="") {
  return String(s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[card]")
    .replace(/\b\d{6}-\d{7}\b/g, "[rrn]")
    .replace(/\b(?:\+?\d{1,3}[-. ]?)?(?:\d{2,4}[-. ]?){2,4}\d{3,4}\b/g, "[phone]")
    .replace(/\bhttps?:\/\/[^\s]+/gi, "[url]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]")
    .replace(/(도로명|지번|아파트|동|호|구|군|시|도)\s*\S+/g, "[addr]")
    .replace(/계좌번호\s*[:\-]?\s*\d[\d -]{6,}/g, "[bank]");
}

function tokenize(s="") {
  const t = scrubPII(s).toLowerCase();
  const toks = t.match(/[a-zA-Z0-9가-힣]{2,}/g) || [];
  return toks.filter(w => w.length >= 2 && w.length <= 36);
}

function topK(arr, k=10) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x)||0) + 1);
  return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,k).map(([w])=>w);
}

function langOf(s="") {
  if (/[가-힣]/.test(s)) return "ko";
  if (/[ぁ-ゔァ-ヴー一-龠々〆ヵヶ]/.test(s)) return "ja";
  return "en";
}

/* ========= Mini Store (메모리, 사용자별 롤링) ========= */
const USAGE = new Map(); // user -> [{ts, mode, lang, keywords[], bigrams[], meta}]
const LIMIT_PER_USER = 500;

function loadUserUsage(user="anon") { return USAGE.get(user) || []; }
function saveUsage(rec) {
  const user = rec.user || "anon";
  const arr  = loadUserUsage(user);
  arr.push(rec);
  while (arr.length > LIMIT_PER_USER) arr.shift();
  USAGE.set(user, arr);
}

/* ========= 추천 스코어링 유틸 ========= */
function bigrams(arr) {
  const out = [];
  for (let i=0;i<arr.length-1;i++){
    const a = arr[i], b = arr[i+1];
    if (!a || !b) continue;
    if ((a+b).length < 4) continue;
    if (/^\d+$/.test(a+b)) continue;
    out.push(`${a} ${b}`);
  }
  return out;
}

const STEM_MAP = new Map([
  ["인공지능","ai"],["머신러닝","ml"],["딥러닝","dl"],
  ["검사","prosecutor"],["변호사","defense"],["양형","sentencing"],
  ["판례","precedent"],["위법수집증거","illegally obtained evidence"],
]);

function stemLite(w){ return STEM_MAP.get(w) || w.replace(/(이라는|들은|하는|하기|하다|했습니다|합니다|했다|했다가|했다면)$/,''); }
function recencyWeight(ts, now = Date.now()){ const days = Math.max(0, (now - ts) / 86400000); return 1 / Math.sqrt(1 + days/5); }
function modeBoost(term, mode){
  if (mode==="legal")    return /(판례|증거|검사|변호|위법|양형|공소|항소|쟁점)/.test(term) ? 1.25 : 1.0;
  if (mode==="research") return /(가격|최저가|뉴스|논문|시장|리뷰|비교|스펙)/.test(term) ? 1.2  : 1.0;
  return 1.0;
}

/* ========= 학습(수집) ========= */
function learnFromRequest(user, mode, lang, messages, replyText="") {
  try {
    const lastUser = [...(messages||[])].reverse().find(m=>m.role==="user")?.content || "";
    const blended  = scrubPII((lastUser + " " + replyText).slice(0, 6000));
    const toks     = tokenize(blended);
    const keys     = topK(toks, 16);
    const bi       = bigrams(toks).slice(0, 24);
    const biTop    = topK(bi, 10);

    const rec = {
      ts: Date.now(),
      user,
      mode,
      lang: ["ko","en","ja"].includes(lang)?lang:langOf(lastUser||replyText),
      keywords: keys,
      bigrams: biTop,
      meta: { len: blended.length, tokens: toks.length, hasQuestion: /[?？]\s*$/.test(lastUser) }
    };
    saveUsage(rec);
  } catch {}
}

/* ========= 추천 생성 ========= */
function buildSuggestions(user, mode, extraContext="") {
  const rows = loadUserUsage(user).slice(-400);
  const now = Date.now();
  const score = new Map(); // key -> {s, example}
  const upsert = (term, s, ex) => {
    const k = term.toLowerCase();
    const cur = score.get(k);
    if (!cur || s > cur.s) score.set(k, {s, example: ex});
  };

  for (const r of rows) {
    const wRec = recencyWeight(r.ts, now);
    for (const kw of (r.keywords||[]).slice(0,16)) {
      const root = stemLite(kw);
      upsert(root, (score.get(root)?.s||0) + 1.0*wRec*modeBoost(kw, mode), kw);
    }
    for (const bg of (r.bigrams||[]).slice(0,10)) {
      upsert(bg, (score.get(bg)?.s||0) + 1.35*wRec*modeBoost(bg, mode), bg);
    }
  }

  if (extraContext) {
    const ctxt = scrubPII(extraContext).slice(0, 4000);
    const toks = tokenize(ctxt);
    const bis  = bigrams(toks);
    for (const kw of topK(toks, 12)) upsert(stemLite(kw), (score.get(kw)?.s||0)+3.0*modeBoost(kw, mode), kw);
    for (const b of topK(bis, 8))    upsert(b, (score.get(b)?.s||0)+4.0*modeBoost(b, mode), b);
  }

  const sorted = [...score.entries()].sort((a,b)=> b[1].s - a[1].s);
  const picked = [];
  const seenStem = new Set();
  for (const [k, v] of sorted) {
    const root = stemLite(k.split(" ")[0]);
    if (seenStem.has(root)) continue;
    seenStem.add(root);
    picked.push({term:k, s:v.s});
    if (picked.length >= 12) break;
  }

  const out = [];
  for (const {term} of picked) {
    if (mode==="legal") {
      out.push(
        `${term} — 쟁점 정리(검사·변호 양측)`,
        `${term} — 관련 판례 3건 요약`,
        `${term} — 증거능력/배제 가능성 검토`
      );
    } else if (mode==="research") {
      out.push(
        `${term} — 최신 뉴스 요약 및 출처`,
        `${term} — 아마존/쿠팡 최저가 링크`,
        `${term} — 경쟁 제품 스펙 비교표`
      );
    } else {
      out.push(
        `${term} — 요약 먼저 쓰기`,
        `${term} — 목차 자동 생성`,
        `${term} — 장단점 표로 정리`
      );
    }
  }
  return [...new Set(out)].slice(0, 10);
}

/* ========= LM Studio 호출 ========= */
async function callChatCompletions({ model, messages, temperature, max_tokens, stream }) {
  const url = `${LM_BASE}/v1/chat/completions`;
  const payload = { model, messages, temperature, stream };
  if (typeof max_tokens === "number" && max_tokens > 0) payload.max_tokens = max_tokens;
  return fetch(url, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) });
}

async function callResponses({ model, input, temperature, max_output_tokens, stream }) {
  const url = `${LM_BASE}/v1/responses`;
  const payload = { model, input, temperature };
  if (typeof max_output_tokens === "number" && max_output_tokens > 0) payload.max_output_tokens = max_output_tokens;
  if (stream) payload.stream = true;
  return fetch(url, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) });
}

function sseWrite(res, data) { res.write(`data: ${data}\n\n`); }

async function pipeSSE(res, upstream) {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  res.flushHeaders?.();

  const handleLine = (line) => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw) return;
    if (raw === "[DONE]") { sseWrite(res, "[DONE]"); res.end(); return "END"; }
    try {
      const j = JSON.parse(raw);
      const delta1 = j?.choices?.[0]?.delta?.content;
      const delta2 = j?.choices?.[0]?.message?.content;
      const delta3 = j?.output_text || j?.response?.output_text;
      const delta4 = j?.delta || j?.response?.delta || j?.content || j?.response?.content;
      const out = delta1 ?? delta2 ?? delta4 ?? delta3 ?? "";
      if (out) sseWrite(res, JSON.stringify(out));
    } catch {
      sseWrite(res, JSON.stringify(raw));
    }
  };

  if (upstream.body && typeof upstream.body.getReader === "function") {
    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) if (handleLine(line) === "END") return;
    }
    sseWrite(res, "[DONE]"); res.end(); return;
  }

  const stream = upstream.body;
  stream.setEncoding?.("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const line of parts) if (handleLine(line) === "END") return;
  });
  stream.on("end", () => { sseWrite(res, "[DONE]"); res.end(); });
  stream.on("error", (err) => {
    sseWrite(res, JSON.stringify(`[upstream error] ${String(err.message||err)}`));
    sseWrite(res, "[DONE]"); res.end();
  });
}

/* ========= 프롬프트 주입 (언어 고정 등) ========= */
function injectSystemPrompt(messages=[], langHint="auto") {
  const msgs = Array.isArray(messages) ? [...messages] : [];
  const userText = msgs.find(m=>m.role==="user")?.content || "";
  const lang = ["ko","en","ja"].includes(langHint) ? langHint : langOf(userText);

  const sys = [
    "You are ThinkHelper's local assistant.",
    "Be concise and helpful.",
    "If the user's message is in Korean, NEVER answer in English unless explicitly asked.",
    "If the user's message is in Japanese, NEVER answer in English unless explicitly asked.",
  ];
  if (lang === "ko") sys.push("항상 한국어로 답변해 주세요.");
  if (lang === "ja") sys.push("常に日本語で回答してください。");
  if (lang === "en") sys.push("Always answer in English unless the user asked for another language.");

  return [{ role:"system", content: sys.join(" ") }, ...msgs];
}

/* ===== 액션 프롬프트 빌더 ===== */
function buildActionMessages({ intent, params = {}, mode = "normal", lang = "ko" }) {
  const langLine =
    lang === "ko" ? "항상 한국어로 답변하세요."
    : lang === "ja" ? "常に日本語で回答してください。"
    : "Always answer in English.";

  const sys = ["You are ThinkHelper's local assistant.","Be concise and structured.",langLine].join(" ");
  const msgs = [{ role: "system", content: sys }];

  switch (intent) {
    case "news_today": {
      if (!params.topics || !Array.isArray(params.topics) || params.topics.length === 0) {
        return { needs: { topics: ["IT/테크", "경제/비즈", "정치/사회", "과학/의학", "문화/엔터", "스포츠", "세계/국제"] } };
      }
      const topics = params.topics.join(", ");
      const region = params.region || "대한민국 중심, 중요하면 해외 이슈도 포함";
      const depth  = params.depth  || "핵심 3~6개 기사";
      const style  = params.style  || "한 줄 헤드라인 + 2~3줄 요약 + 출처 링크 목록";
      msgs.push({
        role: "user",
        content:
`오늘의 주요 뉴스 요약을 ${region} 기준으로 ${depth}만 엄선해 주세요.
관심 카테고리: ${topics}
형식: ${style}
요청사항:
- 중복/찌라시 배제, 사실 검증된 매체 우선
- 각 항목마다 소제목, 핵심 포인트 2~3개, 원문 출처 URL
- 마지막에 "더 깊게 볼만한 키워드" 3~5개 제안`
      });
      break;
    }

    case "outline": {
      const title = params.title || "주제";
      const body  = (params.body || "").slice(0, 5000);
      msgs.push({
        role: "user",
        content:
`아래 내용을 바탕으로 문서의 고급 목차(Heading 2~3 레벨)를 생성해 주세요.
- 제목: ${title}
- 본문 일부: """${body}"""
요청사항:
- 중복 없이 논리적으로 배열
- 각 항목에 한 줄 설명(괄호)
- 마지막에 예상 독자 질문 5개`
      });
      break;
    }

    case "summarize": {
      const body = (params.body || "").slice(0, 8000);
      msgs.push({
        role: "user",
        content:
`아래 텍스트를 목적지향 요약으로 압축해 주세요(5~8문장).
- 대상: 일반 독자
- 표가 필요한 경우 간단한 목록으로
본문: """${body}"""`}
      );
      break;
    }

    case "toc": {
      const body = (params.body || "").slice(0, 6000);
      msgs.push({ role: "user", content:`아래 내용을 바탕으로 자동 목차(번호+H2/H3)를 만들어 주세요.\n본문: """${body}"""` });
      break;
    }

    case "pros_cons": {
      const body = (params.body || "").slice(0, 6000);
      msgs.push({ role: "user", content:`아래 주제의 장단점 표를 만들어 주세요(근거 간단 명시).\n주제/본문: """${body}"""` });
      break;
    }

    case "legal_dual": {
      const issue = params.issue || "쟁점";
      const body  = (params.body || "").slice(0, 6000);
      msgs.push({
        role: "user",
        content:
`형사 사건 쟁점에 대해 '검사'와 '변호인' 시각을 모두 제시해 주세요.
쟁점: ${issue}
사실관계/자료 일부: """${body}"""
요청사항:
- (검사 주장) / (변호인 주장) / (증거능력·배제 가능성) / (판례 키워드) / (양형 요소)
- 리스트로 간결하게, 결론 유보`
      });
      break;
    }

    case "research_deals": {
      const product = params.product || "제품";
      msgs.push({
        role: "user",
        content:
`"${product}"의 온라인 최저가를 찾기 위한 체크리스트와 검색 퀴리 제안을 만들어 주세요.
요청사항:
- 쿠팡/아마존/네이버쇼핑/다나와에 맞는 검색어 3개씩
- 주의할 스펙·모델명 변형·가품 체크 포인트
- 구매 타이밍 팁(리퍼/관부가세/보증)
- 결과 표는 '플랫폼 | 검색어 | 확인 포인트'`
      });
      break;
    }

    default: {
      msgs.push({ role:"user", content: params.prompt || "요약을 생성해 주세요." });
    }
  }

  return { messages: msgs };
}

/* ========= 헬스체크 ========= */
// 프런트의 /api/health 감지용 (200 OK)
app.get("/health", async (_req, res) => {
  let ok = false;
  try {
    const r = await fetch(`${LM_BASE}/v1/models`);
    ok = r.ok;
  } catch {}
  res.json({ ok, ts: Math.floor(Date.now()/1000), env: NODE_ENV, lm_base: LM_BASE, model: LM_MODEL });
});

// 루트도 상태/모델 목록 돌려줌(정보 조금 더)
app.get("/", async (_req, res) => {
  let ok = false, models = [];
  try {
    const r = await fetch(`${LM_BASE}/v1/models`);
    ok = r.ok;
    if (ok) {
      const j = await r.json().catch(()=> ({}));
      models = j?.data || [];
    }
  } catch {}
  res.json({
    ok,
    ts: Math.floor(Date.now()/1000),
    env: NODE_ENV,
    provider: "lmstudio",
    lm_base: LM_BASE,
    model: LM_MODEL,
    models_seen: models.map(m => m?.id).slice(0,10)
  });
});

/* ========= 논-스트림 (OpenAI 호환) ========= */
app.post("/", async (req, res) => {
  try {
    const user = String(req.body?.user || req.headers["x-user"] || "anon").slice(0,128);
    const mode = String(req.body?.mode || req.headers["x-mode"] || "normal");
    const langHdr = String(req.body?.lang || req.headers["x-lang"] || "");
    const messagesRaw = Array.isArray(req.body?.messages) ? req.body.messages
                      : [{role:"user", content: String(req.body?.message || "")}];

    const messages = injectSystemPrompt(messagesRaw, langHdr);
    const model = req.body?.model || LM_MODEL;
    const temperature = typeof req.body?.temperature === "number" ? req.body.temperature : 0.7;
    const max_tokens = typeof req.body?.max_tokens === "number" ? req.body.max_tokens : undefined;

    let r = await callChatCompletions({ model, messages, temperature, max_tokens, stream:false });

    if (!r.ok) {
      const lastUser = [...messagesRaw].reverse().find(m=>m.role==="user")?.content || "";
      const input = lastUser || messagesRaw.map(m => `${m.role}: ${m.content}`).join("\n");
      r = await callResponses({ model, input, temperature, max_output_tokens:max_tokens, stream:false });
      if (!r.ok) {
        const errtxt = await r.text().catch(()=> "");
        return res.status(502).json({ error:"upstream_error", status:r.status, detail: errtxt });
      }
      const j2 = await r.json().catch(()=> ({}));
      const text2 = j2.output_text || j2?.response?.output_text || j2?.choices?.[0]?.message?.content || "";
      learnFromRequest(user, mode, langHdr || langOf(lastUser), messagesRaw, text2);
      return res.json({ reply: text2, raw: j2, via: "responses" });
    }

    const j = await r.json().catch(()=> ({}));
    const text = j?.choices?.[0]?.message?.content || "";
    learnFromRequest(user, mode, langHdr || langOf(messagesRaw.find(m=>m.role==="user")?.content||""), messagesRaw, text);
    res.json({ reply: text, raw: j, via: "chat.completions" });
  } catch (e) {
    console.error("[POST /] error:", e);
    res.status(500).json({ error:"server_error", detail:String(e?.message||e) });
  }
});

/* ========= 스트림 (OpenAI 호환 SSE) ========= */
app.post("/chat", async (req, res) => {
  try {
    const user = String(req.body?.user || req.headers["x-user"] || "anon").slice(0,128);
    const mode = String(req.body?.mode || req.headers["x-mode"] || "normal");
    const langHdr = String(req.body?.lang || req.headers["x-lang"] || "");
    const messagesRaw = Array.isArray(req.body?.messages) ? req.body.messages
                      : [{role:"user", content: String(req.body?.message || "")}];

    const messages = injectSystemPrompt(messagesRaw, langHdr);
    const model = req.body?.model || LM_MODEL;
    const temperature = typeof req.body?.temperature === "number" ? req.body.temperature : 0.7;
    const max_tokens = typeof req.body?.max_tokens === "number" ? req.body.max_tokens : undefined;

    let r = await callChatCompletions({ model, messages, temperature, max_tokens, stream:true });
    if (r.ok) return pipeSSE(res, r);

    const lastUser = [...messagesRaw].reverse().find(m=>m.role==="user")?.content || "";
    const input = lastUser || messagesRaw.map(m => `${m.role}: ${m.content}`).join("\n");
    r = await callResponses({ model, input, temperature, max_output_tokens:max_tokens, stream:true });
    if (r.ok) return pipeSSE(res, r);

    const errtxt = await r.text().catch(()=> "");
    res.set({ "Content-Type": "text/event-stream", "Cache-Control":"no-cache", "Connection":"keep-alive" });
    res.flushHeaders?.();
    sseWrite(res, JSON.stringify(`[upstream ${r.status}] ${errtxt.slice(0,500)}`));
    sseWrite(res, "[DONE]"); res.end();
  } catch (e) {
    console.error("[POST /chat] error:", e);
    try {
      res.set({ "Content-Type": "text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive" });
      res.flushHeaders?.();
      sseWrite(res, JSON.stringify(`[adapter error] ${String(e?.message||e)}`));
      sseWrite(res, "[DONE]");
    } catch {}
    res.end();
  }
});

/* ========= 액션 실행 ========= */
app.post("/action", async (req, res) => {
  try {
    const intent = String(req.body?.intent || "").trim();
    const params = req.body?.params || {};
    const mode   = String(req.body?.mode || req.headers["x-mode"] || "normal");
    const lang   = String(req.body?.lang || req.headers["x-lang"] || "ko");
    const model  = req.body?.model || LM_MODEL;
    const temperature = typeof req.body?.temperature === "number" ? req.body.temperature : 0.5;
    const max_tokens  = typeof req.body?.max_tokens  === "number" ? req.body.max_tokens  : undefined;

    const built = buildActionMessages({ intent, params, mode, lang });
    if (built && built.needs) return res.json({ needs: built.needs, hint: "more_params_required" });

    const messages = injectSystemPrompt(built.messages, lang);
    let r = await callChatCompletions({ model, messages, temperature, max_tokens, stream:false });
    if (!r.ok) {
      const input = messages.map(m=>`${m.role}: ${m.content}`).join("\n");
      r = await callResponses({ model, input, temperature, max_output_tokens:max_tokens, stream:false });
      if (!r.ok) {
        const errtxt = await r.text().catch(()=> "");
        return res.status(502).json({ error:"upstream_error", status:r.status, detail: errtxt });
      }
      const j2 = await r.json().catch(()=> ({}));
      const text2 = j2.output_text || j2?.response?.output_text || j2?.choices?.[0]?.message?.content || "";
      return res.json({ intent, reply: text2, via: "responses" });
    }
    const j = await r.json().catch(()=> ({}));
    const text = j?.choices?.[0]?.message?.content || "";
    return res.json({ intent, reply: text, via: "chat.completions" });
  } catch (e) {
    console.error("[POST /action] error:", e);
    res.status(500).json({ error:"server_error", detail:String(e?.message||e) });
  }
});

/* ========= 학습/추천 API ========= */
app.post("/learn", (req, res) => {
  const user = String(req.body?.user || req.headers["x-user"] || "anon").slice(0,128);
  const mode = String(req.body?.mode || req.headers["x-mode"] || "normal");
  const lang = String(req.body?.lang || req.headers["x-lang"] || "");
  const messages = Array.isArray(req.body?.messages) ? req.body.messages
                  : [{role:"user", content: String(req.body?.message || "")}];
  const reply = String(req.body?.reply || "");
  learnFromRequest(user, mode, lang, messages, reply);
  const suggestions = buildSuggestions(user, mode);
  res.json({ user, mode, suggestions, size: loadUserUsage(user).length });
});

app.post("/learn/contextual", (req, res) => {
  const user = String(req.body?.user || req.headers["x-user"] || "anon").slice(0,128);
  const mode = String(req.body?.mode || req.headers["x-mode"] || "normal");
  const context = String(req.body?.context || "");
  const suggestions = buildSuggestions(user, mode, context);
  res.json({ user, mode, suggestions });
});

app.get("/suggest", (req, res) => {
  const user = String(req.query.user || req.headers["x-user"] || "anon").slice(0,128);
  const mode = String(req.query.mode || req.headers["x-mode"] || "normal");
  const suggestions = buildSuggestions(user, mode);
  res.json({ user, mode, suggestions });
});

/* ========= 시작 ========= */
app.listen(PORT, () => {
  console.log(`✅ Adapter listening on http://127.0.0.1:${PORT}`);
  console.log(`↪️ LM Studio: ${LM_BASE}  (model=${LM_MODEL})  env=${NODE_ENV}`);
});
