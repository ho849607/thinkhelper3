# app.py — ThinkHelper Chat Backend (FastAPI + SSE)
# -------------------------------------------------
# Endpoints
#  - POST /chat           : non-stream chat
#  - POST /chat/stream    : SSE stream chat (EventSource)
#  - GET  /suggest        : suggestions from conversation memory
#  - POST /learn          : optional: learn from free text (for cold-start)
# Features
#  - Country → Language routing (X-Country, ?country, body.country)
#  - Script-based lang detection (ko/ja/en fallback)
#  - System prompt language enforcement
#  - In-memory thread store (user_id + thread_id)
#  - PII scrub + tokenization → lightweight suggestions
#  - OpenAI-compatible backends (OpenAI/Mistral/OpenRouter/LM Studio)
# -------------------------------------------------

import os
import json
import time
import asyncio
from typing import List, Optional, Literal, Dict, Any
from collections import defaultdict, deque

import httpx
from fastapi import FastAPI, Header, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from starlette.responses import JSONResponse, StreamingResponse

load_dotenv()

# ====== ENV ======
PROVIDER: Literal["openai", "mistral", "openrouter", "lmstudio"] = os.getenv("PROVIDER", "lmstudio")
API_BASE = os.getenv("API_BASE", "http://127.0.0.1:1234").rstrip("/")
API_KEY = os.getenv("API_KEY", "")
MODEL = os.getenv("MODEL", "mistralai/mathstral-7b-v0.1")
PORT = int(os.getenv("PORT", "8080"))

ALLOW_ORIGINS = [o.strip() for o in os.getenv("ALLOW_ORIGINS", "http://localhost:3000,https://thinkhelper.store").split(",") if o.strip()]

FORCE_LANG = os.getenv("FORCE_LANG", "auto")  # auto | ko | en | ja | fr ...
DEFAULT_COUNTRY = os.getenv("DEFAULT_COUNTRY", "KR")

# ====== Lang routing ======
COUNTRY_TO_LANG = {
    "KR": "ko", "KP": "ko",
    "JP": "ja",
    "US": "en", "GB": "en", "CA": "en", "AU": "en", "NZ": "en", "IE": "en", "SG": "en", "PH": "en", "IN": "en",
    "FR": "fr", "DE": "de", "ES": "es", "IT": "it", "PT": "pt", "NL": "nl",
    "SE": "sv", "NO": "no", "PL": "pl", "CZ": "cs", "TR": "tr", "RU": "ru",
    "AE": "ar", "SA": "ar", "EG": "ar",
    "BR": "pt", "MX": "es", "AR": "es", "CL": "es", "CO": "es",
    "DEFAULT": "en",
}
def language_from_country(code: Optional[str]) -> str:
    if not code:
        return COUNTRY_TO_LANG.get(DEFAULT_COUNTRY.upper(), "en")
    return COUNTRY_TO_LANG.get(code.upper(), COUNTRY_TO_LANG["DEFAULT"])

def lang_of_text(s: str) -> str:
    if any("\uac00" <= ch <= "\ud7a3" for ch in s):  # Hangul
        return "ko"
    if any(("\u3040" <= ch <= "\u30ff") or ("\uff66" <= ch <= "\uff9f") for ch in s):  # Kana
        return "ja"
    if any("A" <= ch <= "Z" or "a" <= ch <= "z" for ch in s):
        return "en"
    return "en"

def build_system_prompt(target_lang: str) -> str:
    lines = [
        "You are ThinkHelper's assistant. Be concise and helpful.",
        "If the user's message is in Korean, do NOT answer in English unless explicitly asked.",
        "If the user's message is in Japanese, do NOT answer in English unless explicitly asked.",
    ]
    m = {
        "ko": "항상 한국어로 답변하세요.",
        "ja": "常に日本語で回答してください。",
        "zh": "请始终使用中文回答。",
        "fr": "Répondez toujours en français.",
        "de": "Antworten Sie immer auf Deutsch.",
        "es": "Responda siempre en español.",
        "it": "Rispondi sempre in italiano.",
        "pt": "Responda sempre em português.",
        "ru": "Всегда отвечайте на русском языке.",
        "tr": "Her zaman Türkçe cevap verin.",
        "en": "Always answer in English unless the user asked for another language.",
    }
    lines.append(m.get(target_lang, m["en"]))
    return " ".join(lines)

# ====== OpenAI-compatible HTTP client ======
def build_headers() -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    if PROVIDER in ("openai", "mistral", "openrouter") and API_KEY:
        if PROVIDER == "openrouter":
            h["Authorization"] = f"Bearer {API_KEY}"
            h["HTTP-Referer"] = os.getenv("OR_REFERER", "https://thinkhelper.store")
            h["X-Title"] = os.getenv("OR_X_TITLE", "ThinkHelper")
        else:
            h["Authorization"] = f"Bearer {API_KEY}"
    return h

def completions_url() -> str:
    # 통일: 모두 /v1/chat/completions 사용
    return f"{API_BASE}/v1/chat/completions"

# ====== Memory: per (user_id, thread_id) ======
# 채팅 로그 저장 + 추천용 키워드
ThreadMessage = Dict[str, Any]
THREADS: Dict[str, Dict[str, deque]] = defaultdict(lambda: defaultdict(lambda: deque(maxlen=200)))
# THREADS[user_id][thread_id] = deque([{"role":"user/assistant","content":"..."}])

def pii_scrub(s: str) -> str:
    import re
    return (re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[email]", s)
              .replace("\u200b", "")
              .strip())

def tokenize(s: str) -> List[str]:
    import re
    t = pii_scrub(s).lower()
    toks = re.findall(r"[a-zA-Z0-9가-힣]{2,}", t)
    return [w for w in toks if 2 <= len(w) <= 36]

def bigrams(arr: List[str]) -> List[str]:
    out = []
    for i in range(len(arr)-1):
        a, b = arr[i], arr[i+1]
        if not (a and b):
            continue
        if len(a)+len(b) < 4:
            continue
        out.append(f"{a} {b}")
    return out

def suggest_from_history(history: List[ThreadMessage], mode: str = "normal", k: int = 10) -> List[str]:
    # 최신 100개 메시지로 간단 랭킹
    from collections import Counter
    texts = []
    for m in history[-100:]:
        texts.append(m.get("content", ""))
    blob = " ".join(texts)[:12000]
    toks = tokenize(blob)
    bis  = bigrams(toks)
    c = Counter(toks + bis)
    cand = [w for (w, _) in c.most_common(24)]

    out = []
    for term in cand:
        if mode == "legal":
            out += [f"{term} — 쟁점 정리(검사·변호 양측)", f"{term} — 관련 판례 3건 요약"]
        elif mode == "research":
            out += [f"{term} — 최신 뉴스 요약", f"{term} — 가격비교(아마존/쿠팡)"]
        else:
            out += [f"{term} — 요약", f"{term} — 목차 자동 생성"]
    # 중복 제거 & 상위만
    seen, picked = set(), []
    for s in out:
        r = s.split(" — ")[0]
        if r in seen: 
            continue
        seen.add(r)
        picked.append(s)
        if len(picked) >= k: 
            break
    return picked

# ====== FastAPI App ======
app = FastAPI(title="ThinkHelper Chat API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

class Msg(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str

class ChatPayload(BaseModel):
    messages: List[Msg]
    model: Optional[str] = None
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = None
    country: Optional[str] = None
    user_id: Optional[str] = "anon"
    thread_id: Optional[str] = "default"
    mode: Optional[str] = "normal"

@app.get("/health")
def health():
    return {"ok": True, "provider": PROVIDER, "api_base": API_BASE, "model": MODEL}

def decide_lang(payload: ChatPayload, x_country: Optional[str], country_q: Optional[str]) -> str:
    if FORCE_LANG and FORCE_LANG.lower() != "auto":
        return FORCE_LANG.lower()
    code = x_country or country_q or payload.country
    if code:
        return language_from_country(code)
    last_user = next((m.content for m in reversed(payload.messages) if m.role == "user"), "")
    return lang_of_text(last_user)

def inject_system(messages: List[Dict[str, str]], lang: str) -> List[Dict[str, str]]:
    return [{"role":"system","content":build_system_prompt(lang)}] + messages

async def upstream_nonstream(body: Dict[str, Any]) -> httpx.Response:
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(completions_url(), headers=build_headers(), json=body)
        return r

async def upstream_stream(body: Dict[str, Any]):
    headers = build_headers()
    headers["Accept"] = "text/event-stream"
    client = httpx.AsyncClient(timeout=None)
    return client.stream("POST", completions_url(), headers=headers, json=body)

def store_history(user_id: str, thread_id: str, msgs: List[Msg], assistant_text: Optional[str] = None):
    dq = THREADS[user_id][thread_id]
    for m in msgs:
        dq.append({"role": m.role, "content": m.content, "ts": int(time.time())})
    if assistant_text is not None:
        dq.append({"role": "assistant", "content": assistant_text, "ts": int(time.time())})

@app.post("/chat")
async def chat(
    payload: ChatPayload,
    x_country: Optional[str] = Header(default=None),
    country_q: Optional[str] = Query(default=None),
):
    target_lang = decide_lang(payload, x_country, country_q)
    msgs = [m.model_dump() for m in payload.messages]
    msgs = inject_system(msgs, target_lang)

    body = {
        "model": payload.model or MODEL,
        "messages": msgs,
        "temperature": payload.temperature or 0.7,
        "stream": False,
    }
    if payload.max_tokens:
        body["max_tokens"] = payload.max_tokens

    r = await upstream_nonstream(body)
    if not r.is_success:
        return JSONResponse({"error":"upstream_error", "status": r.status_code, "detail": r.text[:500]}, status_code=502)

    data = r.json()
    reply = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")

    # save history
    store_history(payload.user_id or "anon", payload.thread_id or "default", payload.messages, reply)

    return {"target_lang": target_lang, "reply": reply, "raw": data}

@app.post("/chat/stream")
async def chat_stream(
    payload: ChatPayload,
    x_country: Optional[str] = Header(default=None),
    country_q: Optional[str] = Query(default=None),
):
    target_lang = decide_lang(payload, x_country, country_q)
    msgs = [m.model_dump() for m in payload.messages]
    msgs = inject_system(msgs, target_lang)

    body = {
        "model": payload.model or MODEL,
        "messages": msgs,
        "temperature": payload.temperature or 0.7,
        "stream": True,
    }

    # SSE generator
    async def event_gen():
        # 누적 텍스트(히스토리 저장용)
        acc = []
        async with await upstream_stream(body) as resp:
            if resp.status_code >= 400:
                text = await resp.aread()
                yield f"data: {json.dumps('[upstream error] ' + text.decode('utf-8')[:300])}\n\n"
                yield "data: [DONE]\n\n"
                return
            async for line in resp.aiter_lines():
                if not line:
                    continue
                if line.startswith("data:"):
                    raw = line[5:].strip()
                    if raw == "[DONE]":
                        # 저장
                        try:
                            store_history(payload.user_id or "anon",
                                          payload.thread_id or "default",
                                          payload.messages,
                                          "".join(acc))
                        except Exception:
                            pass
                        yield "data: [DONE]\n\n"
                        return
                    # 다양한 벤더 delta 포맷 흡수
                    out = ""
                    try:
                        j = json.loads(raw)
                        out = (
                            j.get("choices", [{}])[0].get("delta", {}).get("content")
                            or j.get("choices", [{}])[0].get("message", {}).get("content")
                            or j.get("delta")
                            or j.get("output_text")
                            or j.get("content")
                            or ""
                        )
                    except Exception:
                        out = raw
                    if out:
                        acc.append(out)
                        yield f"data: {json.dumps(out)}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream")

@app.get("/suggest")
def suggest(
    user_id: str = Query(default="anon"),
    thread_id: str = Query(default="default"),
    mode: str = Query(default="normal"),
    k: int = Query(default=10),
):
    hist = list(THREADS[user_id][thread_id])
    return {"suggestions": suggest_from_history(hist, mode=mode, k=k), "size": len(hist)}

class LearnPayload(BaseModel):
    user_id: Optional[str] = "anon"
    thread_id: Optional[str] = "default"
    text: str

@app.post("/learn")
def learn(p: LearnPayload):
    toks = tokenize(p.text)
    if not toks:
        return {"ok": True, "added": 0}
    # 히스토리에 사용자 메시지로 보강 (추천 엔진은 history 기반)
    THREADS[p.user_id][p.thread_id].append({"role":"user","content":pii_scrub(p.text),"ts":int(time.time())})
    return {"ok": True, "added": len(toks)}

# Entrypoint (uvicorn)
# uvicorn app:app --host 0.0.0.0 --port $PORT
