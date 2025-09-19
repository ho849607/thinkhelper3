import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const LM_BASE = (process.env.LM_BASE_URL || "http://127.0.0.1:1234/v1").replace(/\/$/, "");
const LM_MODEL = process.env.LM_MODEL || "mistralai/mathstral-7b-v0.1";

const DATA_DIR = path.join(__dirname, "data");
const CHATS_FILE = path.join(DATA_DIR, "chats.json");
const DOCS_FILE = path.join(DATA_DIR, "docs.json");
const ACCOUNT_FILE = path.join(DATA_DIR, "account.json");

const now = () => Math.floor(Date.now() / 1000);
const uuid = () => crypto.randomUUID();

async function touch(file, init = {}) {
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, JSON.stringify(init, null, 2), "utf8");
  }
}

async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await touch(CHATS_FILE, { chats: [] });
  await touch(DOCS_FILE, { docs: [] });
  await touch(ACCOUNT_FILE, {
    first_seen: now(),
    plan: "trial" // 30일 체험 플래그
  });
}

const loadJSON = async (f) => JSON.parse(await fs.readFile(f, "utf8"));
const saveJSON = (f, o) => fs.writeFile(f, JSON.stringify(o, null, 2), "utf8");

// ===== middleware / static =====
app.use(express.json({ limit: "2mb" }));
app.use("/static", express.static(path.join(__dirname, "static"))); // /static/... 서빙

// SPA 루트
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "index.html"));
});

// ===== health =====
app.get("/whoami", (_req, res) => res.json({ ok: true, model: LM_MODEL }));
app.get("/ping", (_req, res) => res.json({ ok: true }));

// ===== usage (trial 30days 표시) =====
app.get("/usage", async (_req, res) => {
  await ensureData();
  const acc = await loadJSON(ACCOUNT_FILE);
  const first = acc.first_seen || now();
  const TRIAL_SECS = 30 * 24 * 3600;
  const left = Math.max(0, first + TRIAL_SECS - now());
  const plan = left > 0 ? "trial" : (acc.plan || "free");
  res.json({
    plan,
    trial_ends_at: first + TRIAL_SECS,
    usage: { limit_tokens: 800000, remaining_tokens: 800000, reset_at: now() + 12 * 3600 }
  });
});

// ===== docs 저장소 =====
app.get("/list", async (req, res) => {
  await ensureData();
  const type = (req.query.type || "").toLowerCase();
  const { docs } = await loadJSON(DOCS_FILE);
  const { chats } = await loadJSON(CHATS_FILE);

  const docList = docs.map(d => ({ id: d.id, title: d.title, updatedAt: d.updatedAt }));
  const chatList = chats.map(c => ({ id: c.id, title: c.title || "(제목 없음)", updatedAt: c.updatedAt }));

  if (type === "doc") return res.json({ docs: docList });
  if (type === "chat") return res.json({ chats: chatList });
  res.json({ docs: docList, chats: chatList });
});

// 프런트가 기대하는 경로: /doc/save
app.post("/doc/save", async (req, res) => {
  await ensureData();
  const { id, title = "Untitled", html = "" } = req.body || {};
  const store = await loadJSON(DOCS_FILE);

  if (!id) {
    const d = { id: uuid(), title, html, createdAt: now(), updatedAt: now() };
    store.docs.unshift(d);
    await saveJSON(DOCS_FILE, store);
    return res.json({ id: d.id });
  }
  const i = store.docs.findIndex(x => x.id === id);
  if (i < 0) store.docs.unshift({ id, title, html, createdAt: now(), updatedAt: now() });
  else { store.docs[i].title = title; store.docs[i].html = html; store.docs[i].updatedAt = now(); }
  await saveJSON(DOCS_FILE, store);
  res.json({ id });
});

// ===== chat 저장소 & API (프런트 호환 경로) =====
function inferTitleFromMessages(messages) {
  const first = (messages || []).find(m => m.role === "user")?.content || "새 채팅";
  return first.replace(/\s+/g, " ").trim().slice(0, 30) || "새 채팅";
}

// /chat/list?docId=<chatId>  → [{role, text, ts}, ...]
app.get("/chat/list", async (req, res) => {
  await ensureData();
  const chatId = req.query.docId || req.query.id;
  const store = await loadJSON(CHATS_FILE);
  const chat = store.chats.find(c => c.id === chatId);
  if (!chat) return res.json({ list: [] });
  res.json({
    list: (chat.messages || []).map(m => ({ role: m.role, text: m.content, ts: m.ts }))
  });
});

// /chat/append {docId, role, text}
app.post("/chat/append", async (req, res) => {
  await ensureData();
  const { docId, role, text } = req.body || {};
  if (!role || !text) return res.status(400).json({ error: "bad_request" });

  const store = await loadJSON(CHATS_FILE);
  let chat = docId ? store.chats.find(c => c.id === docId) : null;
  if (!chat) { chat = { id: uuid(), title: "", messages: [], createdAt: now(), updatedAt: now() }; store.chats.unshift(chat); }
  chat.messages.push({ role, content: text, ts: now() });
  if (!chat.title) chat.title = inferTitleFromMessages(chat.messages);
  chat.updatedAt = now();
  await saveJSON(CHATS_FILE, store);

  res.json({ id: chat.id, title: chat.title });
});

// ===== 자동완성 LLM 엔드포인트 없을 때 빈결과로 UI 보호 =====
app.post("/ac", (_req, res) => res.json({ completions: [], next: [], phrases: [] }));

// (옵션) 오프라인 검색도 404 안 나게
app.post("/search_local", (_req, res) => res.json({ results: [] }));

// ===== LM Studio 프록시 =====
app.post("/ask", async (req, res) => {
  try {
    const { question, messages, docId } = req.body || {};
    await ensureData();

    // 채팅 스레드 동기 저장(있으면)
    let store = await loadJSON(CHATS_FILE);
    let chat = docId ? store.chats.find(c => c.id === docId) : null;
    if (!chat) { chat = { id: uuid(), title: "", messages: [], createdAt: now(), updatedAt: now() }; store.chats.unshift(chat); }
    const userMsg = String(question ?? "").trim();
    if (userMsg) chat.messages.push({ role: "user", content: userMsg, ts: now() });

    const msgs = Array.isArray(messages) && messages.length
      ? messages
      : chat.messages.map(m => ({ role: m.role, content: m.content }));

    const r = await fetch(`${LM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: LM_MODEL, messages: msgs, temperature: 0.7, stream: false })
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: "lm_error", detail: err });
    }

    const data = await r.json();
    const answer = data?.choices?.[0]?.message?.content ?? "";
    if (answer) chat.messages.push({ role: "assistant", content: answer, ts: now() });
    if (!chat.title) chat.title = inferTitleFromMessages(chat.messages);
    chat.updatedAt = now();
    await saveJSON(CHATS_FILE, store);

    res.json({ id: chat.id, title: chat.title, answer, raw: data, plan: "free" });
  } catch (e) {
    res.status(500).json({ error: "server_error", detail: String(e) });
  }
});

// ===== PayPal (더미) =====
// 프런트의 startDirectPayPal() 을 만족시키기 위한 모의 라우트
app.post("/paypal/create-order", async (req, res) => {
  // 실제 PayPal 연동 대신, 승인 URL 없이 id만 반환 (오프라인 확인용)
  res.json({ id: "ORDER-" + uuid(), approve: null });
});

app.post("/paypal/capture/:orderId", async (req, res) => {
  await ensureData();
  // 체험 종료 전이라도 바로 PLUS로 표기해주는 모의 캡처
  const acc = await loadJSON(ACCOUNT_FILE);
  acc.plan = "plus";
  await saveJSON(ACCOUNT_FILE, acc);
  res.json({ ok: true, orderId: req.params.orderId, plan: "plus" });
});

// ===== start =====
app.listen(PORT, HOST, () => {
  console.log(`✅ ThinkHelper listening on http://${HOST}:${PORT}`);
  console.log(`↪️  Proxy -> ${LM_BASE}/chat/completions (model=${LM_MODEL})`);
});
