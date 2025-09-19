// server.js — ThinkHelper (Express, EB-friendly, unified)
// Node 18+ (global fetch)

'use strict';
require('dotenv').config();

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();

// ====== Config ======
const PORT = Number(process.env.PORT) || 8080;   // EB가 주는 PORT 사용
const HOST = '0.0.0.0';                           // EB에서 외부 바인딩
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const STATIC_DIR = path.join(PUBLIC_DIR, 'static');

// 개발 편의: PLUS 강제
const DEV_FORCE_PLUS = String(process.env.DEV_FORCE_PLUS || '1') === '1';

// ====== Middlewares ======
app.set('trust proxy', true);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type','Accept-Language','X-Client-Timezone','X-Plus-Key']
}));

// 간단 로그
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} <- ${req.ip}`);
  next();
});

// ====== Static ======
app.use('/static', express.static(STATIC_DIR, {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js'))  res.type('application/javascript; charset=utf-8');
    if (filePath.endsWith('.css')) res.type('text/css; charset=utf-8');
    if (filePath.endsWith('.svg')) res.type('image/svg+xml');
  }
}));

// 루트 인덱스
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ====== Tiny NLP bits (로컬 추천용) ======
function simpleKoTokenize(text){
  if (!text) return [];
  const RE = /(?:[가-힣]{2,}|[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:[.,]\d+)*|[가-힣]|[^\s])/g;
  return (String(text).match(RE) || []).map(t=>t.trim()).filter(Boolean);
}
function buildNgrams(tokens){
  const uni=new Map(), bi=new Map(), tri=new Map();
  for (let i=0;i<tokens.length;i++){
    const w1=tokens[i]; if(!w1) continue;
    uni.set(w1,(uni.get(w1)||0)+1);
    const w2=tokens[i+1];
    if (w2){ if(!bi.has(w1)) bi.set(w1,new Map()); const m=bi.get(w1); m.set(w2,(m.get(w2)||0)+1); }
    const p1=tokens[i-2], p2=tokens[i-1];
    if (p1&&p2){ const k=p1+' '+p2; if(!tri.has(k)) tri.set(k,new Map()); const m=tri.get(k); m.set(w1,(m.get(w1)||0)+1); }
  }
  return { uni, bi, tri };
}
function mle(map){ const tot=[...map.values()].reduce((a,b)=>a+b,0)||1; return new Map([...map.entries()].map(([w,c])=>[w,c/tot])); }
function nextBackoff(p1,p2, bi,tri,uni, k=8){
  const L3=0.7, L2=0.2, L1=0.1, score=new Map();
  const triKey=(p1&&p2)?(p1+' '+p2):null;
  const add=(dist,w)=>{ for(const [t,p] of dist) score.set(t,(score.get(t)||0)+w*p); };
  if (triKey && tri.has(triKey)) add(mle(tri.get(triKey)), L3);
  if (p2 && bi.has(p2))         add(mle(bi.get(p2)),      L2);
  add(mle(uni), L1);
  return [...score.entries()].sort((a,b)=>b[1]-a[1]).slice(0,k).map(([w])=>w);
}

// ====== In-memory state (demo) ======
const docs = new Map();             // id -> {id,title,html,tags,ts}
const chatLogs = new Map();         // docId -> [{id,role,text,ts}]
const pendingOrders = new Map();    // PayPal stub

let usageRemaining = 8;

// ====== Plan helpers ======
function isPlus(req){
  if (DEV_FORCE_PLUS) return true;
  const key = (req.headers['x-plus-key']||'').toString().trim();
  return !!key;
}

// ====== Health ======
app.get('/healthz', (_req,res)=>res.json({ok:true, ts:Date.now()}));

// ====== /whoami /usage ======
app.get('/whoami', (req,res)=>{
  const plan = isPlus(req) ? 'plus' : 'free';
  res.json({ ok:true, plan, is_admin_key:false });
});
app.get('/usage', (req,res)=>{
  const plan = isPlus(req) ? 'plus' : 'free';
  if (plan==='plus') return res.json({ plan, usage:{ remaining: 999999, reset_at: Math.floor(Date.now()/1000)+3600 }});
  res.json({ plan, usage:{ remaining: usageRemaining, reset_at: Math.floor(Date.now()/1000)+3600 }});
});

// ====== /ac (autocomplete) ======
app.post('/ac', async (req, res) => {
  try{
    const { prefix='', context='', k=8, doc='' } = req.body || {};
    const K = Math.max(1, +k || 8);

    const toks = simpleKoTokenize(doc||'');
    const { uni, bi, tri } = buildNgrams(toks);
    const ctx = simpleKoTokenize(context||'').slice(-2);
    const [p1, p2] = [ctx[0]||null, ctx[1]||null];

    // completions
    let completions = [];
    if (prefix) {
      const pfx = prefix.toLowerCase();
      const arr = [];
      for (const [tok,cnt] of uni.entries()){
        if (tok.toLowerCase().startsWith(pfx) && tok.toLowerCase()!==pfx) arr.push([tok,cnt]);
      }
      arr.sort((a,b)=>b[1]-a[1]);
      completions = arr.slice(0, K).map(([w])=>w);
    }
    // next
    let next = (bi.size||tri.size||uni.size) ? nextBackoff(p1,p2, bi,tri,uni, Math.max(2, Math.floor(K/3))) : [];
    // phrases (간단 템플릿)
    const TEMPLATES = {
      ko: ['요약하면, ','핵심은 다음과 같습니다: ','예를 들어, ','결론적으로, ','추가로, '],
      en: ['In short, ','Key points are: ','For example, ','In conclusion, ','Additionally, '],
      ja: ['要するに、','ポイントは以下の通りです：','例えば、','結論として、','加えて、']
    };
    const phrases = prefix ? [] : TEMPLATES.ko.slice(0, Math.max(2, Math.floor(K/3)));

    res.json({ completions, next, phrases });
  }catch(e){
    res.status(500).json({ error:'ac_failed', detail:String(e?.message||e) });
  }
});

// ====== /ask (chat demo) ======
app.post('/ask', async (req, res) => {
  try{
    const { question='', docId='' } = req.body || {};
    const plan = isPlus(req) ? 'plus' : 'free';

    if (plan==='free'){
      if (usageRemaining<=0){
        return res.status(429).json({
          error:'limit_reached',
          usage:{ remaining:0, reset_at: Math.floor(Date.now()/1000)+3600 },
          plan
        });
      }
      usageRemaining = Math.max(0, usageRemaining-1);
    }

    // LLM 호출 대신 데모 응답 (원하면 여기서 openai/gemini/ollama 호출 넣기)
    const text = `질문 잘 받았어요: “${question}” (데모 응답${plan==='plus'?' · PLUS':''})`;

    const id = (docId || '_global').toString();
    if (!chatLogs.has(id)) chatLogs.set(id, []);
    const arr = chatLogs.get(id);
    const now = Date.now();
    arr.push({ id: randomUUID(), role:'user',      text: question, ts: now-1 });
    arr.push({ id: randomUUID(), role:'assistant', text,           ts: now   });
    if (arr.length > 200) arr.splice(0, arr.length - 200);

    res.json({
      answer: text,
      plan,
      usage:{
        remaining: plan==='plus' ? 999999 : usageRemaining,
        reset_at: Math.floor(Date.now()/1000)+3600
      }
    });
  }catch(e){
    res.status(500).json({ error:'ask_failed', detail:String(e?.message||e) });
  }
});

// ====== Chat list / append (sidebar) ======
app.post('/chat/append', (req,res)=>{
  const { docId='', role='', text='' } = req.body || {};
  const id = (docId || '_global').toString();
  if (!chatLogs.has(id)) chatLogs.set(id, []);
  const arr = chatLogs.get(id);
  arr.push({ id: randomUUID(), role: String(role||'user'), text: String(text||''), ts: Date.now() });
  if (arr.length > 200) arr.splice(0, arr.length - 200);
  res.json({ ok:true, count: arr.length });
});
app.get('/chat/list', (req,res)=>{
  const id = (req.query.docId || '_global').toString();
  const arr = (chatLogs.get(id) || []).slice(-50);
  arr.sort((a,b)=>a.ts-b.ts);
  res.json({ ok:true, list: arr });
});

// ====== Docs ======
app.post('/doc/save', (req,res)=>{
  const { id, title, html, tags } = req.body || {};
  const now = Date.now();
  const docId = id || randomUUID();
  const rec = {
    id: docId,
    title: String(title||'Untitled'),
    html: String(html||''),
    tags: Array.isArray(tags)? tags.slice(0,50) : [],
    ts: now
  };
  docs.set(docId, rec);
  if (!chatLogs.has(docId)) chatLogs.set(docId, []);
  res.json({ ok:true, id:docId, ts: now });
});
app.get('/doc/list', (_req,res)=>{
  const list = [...docs.values()].sort((a,b)=>b.ts-a.ts).map(d=>({id:d.id, title:d.title, tags:d.tags, ts:d.ts}));
  res.json({ ok:true, list });
});
app.get('/doc/:id', (req,res)=>{
  const d = docs.get(req.params.id);
  if (!d) return res.status(404).json({ ok:false, error:'not_found' });
  res.json({ ok:true, doc:d });
});
app.post('/doc/clear', (_req,res)=>{
  docs.clear(); chatLogs.clear();
  res.json({ ok:true });
});

// ====== PayPal (stub) ======
app.post('/paypal/create-order', (req,res)=>{
  const { plan='monthly', return_url='', cancel_url='' } = req.body || {};
  const id = 'ORDER-' + randomUUID().slice(0,8).toUpperCase();
  pendingOrders.set(id, { plan, created_at: Date.now(), return_url, cancel_url });
  let approve = '';
  if (return_url){
    const u = new URL(return_url);
    u.searchParams.set('token', id);
    u.searchParams.set('ppreturn','1');
    u.searchParams.set('PayerID','FAKEPAYER');
    approve = u.toString();
  }
  res.json({ ok:true, id, approve });
});
app.post('/paypal/capture/:orderId', (req,res)=>{
  const { orderId } = req.params || {};
  if (!pendingOrders.has(orderId)) return res.status(400).json({ ok:false, error:'invalid_order' });
  pendingOrders.delete(orderId);
  res.json({ ok:true, order_id: orderId, plan:'plus' });
});

// ====== SPA Fallback ======
app.get(/^\/(?!static\/|healthz|whoami|usage|ac|ask|chat\/|doc\/|paypal\/).*/, (_req,res)=>{
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ====== Start ======
app.listen(PORT, HOST, () => {
  console.log(`🚀 ThinkHelper server on http://${HOST}:${PORT}`);
  console.log(` - static  : /static`);
  console.log(` - api     : /whoami /usage /ac /ask /doc/* /chat/* /paypal/* /healthz`);
});
