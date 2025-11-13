// server.js — ThinkHelper Brain (Node/Express)
// Endpoints:
//  - POST /observe { doc_id, text }
//  - GET  /suggest?prefix=&doc_id=&top_n=8
//  - POST /accept  { doc_id, word }
//
// 특징:
//  - ko/en 토큰화, 불용어 제외
//  - 문서별 빈도(doc_freq) + 전역 수락강화(accept_counts)
//  - 시간 감쇠(decay) 점수 + 문맥 점수(context)로 정렬
//  - JSON 파일(persistence): brain_data.json
//  - CORS/JSON 제한/간단 rate-limit(옵션)

import express from "express";
import fs from "fs/promises";
import path from "path";
import cors from "cors";

const PORT = process.env.PORT || 5500;
const DATA_FILE = process.env.BRAIN_FILE || "brain_data.json";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ----------------- Tiny in-memory rate limit (optional) ----------------- */
const hits = new Map();
app.use((req, res, next) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "local";
  const now = Date.now();
  const win = 10_000; // 10s 윈도우
  const rec = hits.get(ip) || [];
  const recent = rec.filter((t) => now - t < win);
  recent.push(now);
  hits.set(ip, recent);
  if (recent.length > 80) return res.status(429).json({ error: "Too Many Requests" });
  next();
});

/* ----------------- Storage layer ----------------- */
const defaultMemory = () => ({
  accept_counts: {},       // { word: count }
  last_used_at: {},        // { word: timestamp(ms) }
  doc_freq: {},            // { doc_id: { word: count } }
  user_dict: { ko: [], en: [] }, // per-lang dictionary
});

let MEMORY = defaultMemory();

async function loadMemory() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    MEMORY = { ...defaultMemory(), ...JSON.parse(raw) };
  } catch {
    MEMORY = defaultMemory();
  }
}
async function saveMemory() {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(MEMORY, null, 2), "utf-8");
  } catch (e) {
    console.error("saveMemory failed:", e);
  }
}

/* ----------------- Tokenization & utils ----------------- */
const STOP_KO = new Set(["그리고","그러나","하지만","또는","있다","하는","에서","으로","에게","입니다"]);
const STOP_EN = new Set(["the","and","for","with","that","this","from","have","are","not"]);

function extractTokens(text = "") {
  const ko = (text.match(/[가-힣]{2,}/g) || []).filter((w) => !STOP_KO.has(w));
  const en = (text.match(/[A-Za-z]{3,}/g) || [])
    .map((w) => w.toLowerCase())
    .filter((w) => !STOP_EN.has(w));
  return { ko, en };
}

function count(arr) {
  const m = Object.create(null);
  for (const w of arr) m[w] = (m[w] || 0) + 1;
  return m;
}

function nowMs() { return Date.now(); }

function decayScore(count, lastTsMs) {
  if (!count) return 0;
  if (!lastTsMs) return count;
  const days = (nowMs() - lastTsMs) / 86_400_000; // ms -> days
  return count * Math.pow(0.99, Math.max(0, days));
}

/* ----------------- Core scoring ----------------- */
function calcScore(word, docId) {
  const gCount = MEMORY.accept_counts[word] || 0;
  const lastTs = MEMORY.last_used_at[word] || 0;
  const globalScore = decayScore(gCount, lastTs);

  let contextScore = 0;
  if (docId && MEMORY.doc_freq[docId]) {
    const f = MEMORY.doc_freq[docId][word] || 0;
    contextScore = f * 2.0; // 문맥 가중치
  }
  return globalScore + contextScore;
}

/* ----------------- Endpoints ----------------- */

// Observe: 문서 스캔 -> doc_freq 업데이트 + user_dict 후보 반영
app.post("/observe", async (req, res) => {
  try {
    const { doc_id, text } = req.body || {};
    if (!doc_id || typeof text !== "string") {
      return res.status(400).json({ error: "doc_id and text are required" });
    }

    const toks = extractTokens(text);
    const all = [...toks.ko, ...toks.en];
    MEMORY.doc_freq[doc_id] = count(all);

    // 2회 이상 등장 단어를 사용자 사전에 반영(중복 제거)
    for (const lang of ["ko", "en"]) {
      const freq = count(toks[lang]);
      const candidates = Object.entries(freq)
        .filter(([, c]) => c >= 2)
        .map(([w]) => w);

      const set = new Set([...(MEMORY.user_dict[lang] || []), ...candidates]);
      // 상한선(예: 800) 관리하고 싶으면 여기서 slice
      MEMORY.user_dict[lang] = Array.from(set);
    }

    await saveMemory();
    res.json({ ok: true, learned: { ko: toks.ko.length, en: toks.en.length } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "observe failed" });
  }
});

// Suggest: 접두사+문맥 기반 정렬 반환
app.get("/suggest", (req, res) => {
  try {
    const prefixRaw = String(req.query.prefix || "");
    const doc_id = req.query.doc_id ? String(req.query.doc_id) : undefined;
    const topN = Math.min(50, Math.max(1, parseInt(req.query.top_n || "8", 10)));

    if (!prefixRaw) return res.json([]);

    const lang = /[가-힣]/.test(prefixRaw) ? "ko" : "en";
    const prefix = prefixRaw.toLowerCase();

    const dict = MEMORY.user_dict[lang] || [];
    const cands = dict.filter((w) => w.toLowerCase().startsWith(prefix));

    // 점수순 정렬 → 사전순 tie-break
    cands.sort((a, b) => {
      const sa = calcScore(a, doc_id);
      const sb = calcScore(b, doc_id);
      if (sb !== sa) return sb - sa;
      return a.localeCompare(b);
    });

    res.json(cands.slice(0, topN));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "suggest failed" });
  }
});

// Accept: 단어 수락 → 강화 학습(수락횟수 + 마지막 사용시간)
app.post("/accept", async (req, res) => {
  try {
    const { word } = req.body || {};
    if (!word) return res.status(400).json({ error: "word is required" });

    MEMORY.accept_counts[word] = (MEMORY.accept_counts[word] || 0) + 1;
    MEMORY.last_used_at[word] = nowMs();

    await saveMemory();
    res.json({ ok: true, word, count: MEMORY.accept_counts[word] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "accept failed" });
  }
});

/* ----------------- Health & Static ----------------- */
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use(express.static("public")); // public/index.html, index.js 등

/* ----------------- Boot ----------------- */
await loadMemory();
app.listen(PORT, () => {
  console.log(`ThinkHelper Brain server running on http://localhost:${PORT}`);
  console.log(`Storage: ${path.resolve(DATA_FILE)}`);
});
