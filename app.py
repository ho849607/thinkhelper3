# app.py
from __future__ import annotations
from flask import Flask, request, jsonify, render_template, make_response, redirect, url_for, session
import os, json, re, time, uuid, threading, requests
from typing import Optional
from flask_cors import CORS

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = os.environ.get("FLASK_SECRET", "dev-secret-change-me")

# ---------------------------------------
# CORS: 127.0.0.1/localhost 및 file://(origin=null) 대응
# ---------------------------------------
CORS(
    app,
    resources={
        r"/.*": {
            "origins": ["http://127.0.0.1:5050", "http://localhost:5050",
                        "http://127.0.0.1:5500", "http://localhost:5500", "null"],
            "methods": ["GET", "POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "X-Plus-Key", "Accept-Language", "X-Client-Timezone"],
        }
    },
    supports_credentials=False,
)

# ============= 환경변수(약관/개인정보 링크) =============
# 구글독스 URL을 여기에 넣어두면 index.html에서 자동 반영됩니다.
TERMS_URL   = os.environ.get("TERMS_URL",   "https://docs.google.com/document/d/your-terms-id")
PRIVACY_URL = os.environ.get("PRIVACY_URL", "https://docs.google.com/document/d/your-privacy-id")

# ============= Optional: Google OAuth / Docs =============
GOOGLE_AVAILABLE = True
try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request as GARequest
    from google_auth_oauthlib.flow import Flow
    from googleapiclient.discovery import build
except Exception:
    GOOGLE_AVAILABLE = False

# ============= 모델/요금 관련 =============
# 무료(오프라인) 백엔드 (Ollama/LM Studio의 Ollama 호환 서버)
OLLAMA_URL   = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gpt-oss:20b")

# PLUS(유료) 백엔드: OpenAI (없으면 자동으로 로컬 폴백)
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL   = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

# 무료 플랜 크레딧
FREE_LIMIT   = int(os.environ.get("FREE_LIMIT", "5"))    # 12시간 5회 (채팅 기준)
WINDOW_HOURS = int(os.environ.get("WINDOW_HOURS", "12")) # 12시간 윈도우

# PLUS 키(데모/관리자)
PLUS_KEY = os.environ.get("PLUS_KEY", "")
ADMIN_USERS = set(u.strip().lower() for u in os.environ.get("ADMIN_USERS", "").split(",") if u.strip())

# 사용량 저장(JSON)
USAGE_DB = os.environ.get("USAGE_DB", "usage.json")
USAGE_LOCK = threading.Lock()

# 자동완성 인덱스(선택)
AC_PATH = os.environ.get("AC_PATH", "ac_index.json")
_ac, _ac_mtime = None, 0.0
_token_re = re.compile(r"[A-Za-z0-9가-힣]+(?:[._-][A-Za-z0-9가-힣]+)*")

# Google OAuth 파일/스코프(선택)
GOOGLE_CLIENT_JSON = os.environ.get("GOOGLE_CLIENT_JSON", "client_secret_web.json")
GOOGLE_SCOPES = [
    "openid", "email", "profile",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file",
]
TOKENS_DIR = os.path.join(os.getcwd(), os.environ.get("TOKENS_DIR", "tokens"))
os.makedirs(TOKENS_DIR, exist_ok=True)

# ============= 공통 유틸 =============
def load_json(path, default):
    if not os.path.exists(path): return default
    with open(path, "r", encoding="utf-8") as f:
        try: return json.load(f)
        except Exception: return default

def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def now_sec() -> float: return time.time()

def uid_from_request():
    # 우선순위: 세션 이메일 → 쿠키(th_uid) → 헤더(X-User) → IP
    email = session.get("uid_email")
    if email: return email.lower()
    uid = (request.headers.get("X-User") or "").strip().lower()
    if uid: return uid
    uid = request.cookies.get("th_uid")
    if uid: return uid
    return (request.remote_addr or "anon").lower()

def is_plus_user(uid: str) -> bool:
    if uid and uid in ADMIN_USERS: return True
    client_key = request.headers.get("X-Plus-Key", "")
    if PLUS_KEY and client_key and client_key == PLUS_KEY: return True
    return False

# ============= PLUS 동의(Consent) =============
CONSENT_COOKIE = "plus_consent"

def has_plus_consent() -> bool:
    if session.get("plus_consent") is True:
        return True
    if request.cookies.get(CONSENT_COOKIE) == "1":
        session["plus_consent"] = True
        return True
    return False

@app.get("/plus/status")
def plus_status():
    uid = uid_from_request()
    return jsonify({"uid": uid, "is_plus": is_plus_user(uid), "consent": has_plus_consent()})

@app.post("/plus/consent")
def plus_consent():
    data = request.get_json(silent=True) or {}
    agree = bool(data.get("agree", False))
    resp = make_response(jsonify({"ok": bool(agree)}))
    if agree:
        session["plus_consent"] = True
        resp.set_cookie(CONSENT_COOKIE, "1", max_age=365*24*3600, samesite="Lax")
    else:
        session.pop("plus_consent", None)
        resp.delete_cookie(CONSENT_COOKIE)
    return resp

# ============= 무료 크레딧(12시간 창) =============
def _prune_and_get(usage, uid):
    window = WINDOW_HOURS * 3600
    now = now_sec()
    arr = usage.get(uid, [])
    arr = [t for t in arr if now - t < window]
    usage[uid] = arr
    save_json(USAGE_DB, usage)
    return arr

def get_usage(uid):
    with USAGE_LOCK:
        usage = load_json(USAGE_DB, {})
        arr = _prune_and_get(usage, uid)
    reset_at = (min(arr) + WINDOW_HOURS * 3600) if arr else (now_sec() + WINDOW_HOURS * 3600)
    remaining = max(FREE_LIMIT - len(arr), 0)
    return {"limit": FREE_LIMIT, "remaining": remaining, "reset_at": int(reset_at)}

def charge_one(uid):
    with USAGE_LOCK:
        usage = load_json(USAGE_DB, {})
        arr = _prune_and_get(usage, uid)
        if len(arr) >= FREE_LIMIT:
            return False, {"limit": FREE_LIMIT, "remaining": 0}
        arr.append(now_sec())
        usage[uid] = arr
        save_json(USAGE_DB, usage)
        return True, {"limit": FREE_LIMIT, "remaining": FREE_LIMIT - len(arr)}

# ============= 백엔드 LLM 호출 =============
def call_ollama(prompt: str) -> str:
    """Ollama 또는 LM Studio(ollama 호환)에서 /api/generate 사용"""
    try:
        r = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
            timeout=(5, 120),
        )
        r.raise_for_status()
        return (r.json().get("response") or "").strip()
    except requests.exceptions.ConnectionError:
        return "오류: 로컬 모델 서버가 실행 중인지 확인해주세요. (Ollama 또는 LM Studio Ollama 호환)"
    except requests.exceptions.Timeout:
        return "오류: 로컬 모델 응답 시간이 초과되었습니다."
    except Exception as e:
        return f"오류: {e}"

def call_openai(messages) -> str:
    if not OPENAI_API_KEY:
        # 키 없으면 로컬로 폴백
        return call_ollama(messages[-1].get("content", ""))
    try:
        r = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            json={"model": OPENAI_MODEL, "messages": messages, "temperature": 0.3},
            timeout=(5, 120),
        )
        r.raise_for_status()
        data = r.json()
        return (data["choices"][0]["message"]["content"] or "").strip()
    except Exception as e:
        return f"오류: OpenAI 호출 실패: {e}"

# ============= 자동완성 인덱스/폴백 =============
def _load_ac_if_changed():
    global _ac, _ac_mtime
    if not os.path.exists(AC_PATH): return
    m = os.path.getmtime(AC_PATH)
    if m != _ac_mtime:
        _ac = load_json(AC_PATH, None)
        _ac_mtime = m
        app.logger.info(f"[AC] loaded {AC_PATH}")

def _last_tokens(s: str, n: int = 2):
    toks = _token_re.findall((s or "").lower())
    return toks[-n:]

def _blend_unique(*lists, k=8):
    seen, out = set(), []
    for L in lists:
        for x in L:
            if x not in seen:
                seen.add(x); out.append(x)
                if len(out) >= k: return out
    return out[:k]

def suggest_words(prefix: str, context: str, k: int = 8):
    _load_ac_if_changed()
    if not _ac: return {"completions": [], "next": [], "phrases": []}
    pref = (prefix or "").lower()
    last2 = _last_tokens(context, 2)

    # completions
    compl = _ac["prefix"].get(pref, [])[:k*2] if pref else []

    # next-word
    nxt = []
    if len(last2) == 2:
        key = f"{last2[0]}\t{last2[1]}"
        nxt = _ac["trigram"].get(key, [])[:k]
        if len(nxt) < k:
            nxt = _blend_unique(nxt, _ac["bigram"].get(last2[1], [])[:k*2], k=k)
    elif len(last2) == 1:
        nxt = _ac["bigram"].get(last2[0], [])[:k]

    # phrases
    base = (pref or (last2[-1] if last2 else "")).lower()
    phr = []
    if base:
        starts = [p for p in _ac["phrases"] if p.startswith(base)][:k*2]
        if len(starts) < k:
            cont = [p for p in _ac["phrases"] if base in p][:k*2]
            phr = _blend_unique(starts, cont, k=k)
        else:
            phr = starts[:k]

    return {"completions": compl[:k], "next": nxt[:k], "phrases": phr[:k]}

def _tokenize(s: str):
    return _token_re.findall((s or "").lower())

def suggest_from_doc(prefix: str, context: str, doc: str, k: int = 8):
    toks = _tokenize(doc)
    if not toks:
        return {"completions": [], "next": [], "phrases": []}

    pref = (prefix or "").lower()

    # completions
    freq = {}
    if pref:
        for t in toks:
            if t.startswith(pref):
                freq[t] = freq.get(t, 0) + 1
    completions = [w for w, _ in sorted(freq.items(), key=lambda x: -x[1])][:k]

    # next
    ctx = _tokenize(context)
    nxt = []
    if len(ctx) >= 2:
        w1, w2 = ctx[-2], ctx[-1]
        for i in range(len(toks)-2):
            if toks[i] == w1 and toks[i+1] == w2:
                nxt.append(toks[i+2])
    elif len(ctx) == 1:
        w = ctx[-1]
        for i in range(len(toks)-1):
            if toks[i] == w:
                nxt.append(toks[i+1])
    nf = {}
    for w in nxt:
        nf[w] = nf.get(w, 0) + 1
    next_words = [w for w, _ in sorted(nf.items(), key=lambda x: -x[1])][:k]

    # phrases
    phrases = []
    if pref:
        for n in (2, 3, 4):
            for i in range(len(toks)-n+1):
                ph = " ".join(toks[i:i+n])
                if pref in ph and ph not in phrases:
                    phrases.append(ph)
                    if len(phrases) >= k:
                        break
            if len(phrases) >= k:
                break

    return {"completions": completions, "next": next_words, "phrases": phrases}

# ============= 간단 로케일 엔드포인트 =============
@app.get("/locale")
def get_locale():
    """
    IP 지오로케이션 없이, 브라우저/프록시가 보낸 Accept-Language로 추정.
    """
    supported = ["ko","en","ja","zh","de","fr","es","pt","ru","vi","th"]
    best = request.accept_languages.best_match(supported) or "ko"
    return jsonify({"lang": best})

# ============= Google OAuth / Docs(선택) =============
def token_path(uid: str) -> str:
    safe = uid.replace("/", "_")
    return os.path.join(TOKENS_DIR, f"{safe}.json")

def load_creds(uid: str) -> Optional["Credentials"]:
    if not GOOGLE_AVAILABLE:
        return None
    path = token_path(uid)
    if not os.path.exists(path): return None
    data = load_json(path, {})
    creds = Credentials.from_authorized_user_info(data, GOOGLE_SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(GARequest())
        save_json(path, json.loads(creds.to_json()))
    return creds

@app.get("/auth/google/start")
def google_start():
    if not GOOGLE_AVAILABLE:
        return jsonify(error="google_libs_missing"), 501
    flow = Flow.from_client_secrets_file(
        GOOGLE_CLIENT_JSON, scopes=GOOGLE_SCOPES,
        redirect_uri=url_for("google_callback", _external=True),
    )
    auth_url, state = flow.authorization_url(access_type="offline", include_granted_scopes="true", prompt="consent")
    session["state"] = state
    return redirect(auth_url)

@app.get("/auth/google/callback")
def google_callback():
    if not GOOGLE_AVAILABLE:
        return jsonify(error="google_libs_missing"), 501
    state = session.get("state")
    flow = Flow.from_client_secrets_file(
        GOOGLE_CLIENT_JSON, scopes=GOOGLE_SCOPES, state=state,
        redirect_uri=url_for("google_callback", _external=True),
    )
    flow.fetch_token(authorization_response=request.url)
    creds = flow.credentials
    r = requests.get("https://www.googleapis.com/oauth2/v2/userinfo", headers={"Authorization": f"Bearer {creds.token}"})
    email = (r.json().get("email") or "").lower()
    if not email:
        return "Google 로그인 실패(이메일 없음)", 400
    save_json(token_path(email), json.loads(creds.to_json()))
    session["uid_email"] = email
    resp = make_response(redirect(url_for("index")))
    if not request.cookies.get("th_uid"):
        resp.set_cookie("th_uid", email, max_age=365*24*3600, samesite="Lax")
    return resp

@app.get("/gdocs/list")
def gdocs_list():
    if not GOOGLE_AVAILABLE:
        return jsonify(error="google_libs_missing"), 501
    uid = uid_from_request()
    creds = load_creds(uid)
    if not creds:
        return jsonify(error="not_signed_in"), 401
    drive = build("drive", "v3", credentials=creds)
    files = drive.files().list(
        q="mimeType='application/vnd.google-apps.document' and trashed=false",
        pageSize=10, fields="files(id,name,modifiedTime)"
    ).execute().get("files", [])
    return jsonify(files=files)

@app.post("/gdocs/append")
def gdocs_append():
    if not GOOGLE_AVAILABLE:
        return jsonify(error="google_libs_missing"), 501
    uid = uid_from_request()
    creds = load_creds(uid)
    if not creds:
        return jsonify(error="not_signed_in"), 401
    data = request.get_json(silent=True) or {}
    doc_id = data.get("doc_id")
    text = (data.get("text") or "").strip()
    if not doc_id or not text:
        return jsonify(error="bad_request"), 400
    docs = build("docs", "v1", credentials=creds)
    docs.documents().batchUpdate(
        documentId=doc_id,
        body={"requests":[{"insertText":{"location":{"index":1_000_000},"text":text+"\n"}}]}
    ).execute()
    return jsonify(ok=True)

# ============= 뷰/엔드포인트 =============
@app.get("/")
def index():
    resp = make_response(render_template("index.html",
                                         terms_url=TERMS_URL,
                                         privacy_url=PRIVACY_URL))
    if not request.cookies.get("th_uid"):
        resp.set_cookie("th_uid", uuid.uuid4().hex, max_age=365*24*3600, samesite="Lax")
    return resp

@app.get("/favicon.ico")
def favicon():
    return ("", 204)

@app.get("/healthz")
def healthz():
    return jsonify(ok=True, model={"free": OLLAMA_MODEL, "plus": OPENAI_MODEL})

@app.get("/usage")
def usage():
    uid = uid_from_request()
    plan = "plus" if is_plus_user(uid) else "free"
    info = get_usage(uid) if plan == "free" else {"limit": 0, "remaining": -1, "reset_at": 0}
    return jsonify({"uid": uid, "plan": plan, "info": info})

@app.route("/ac", methods=["POST", "OPTIONS"])
def ac_api():
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(silent=True) or {}
    prefix  = data.get("prefix", "") or ""
    context = data.get("context", "") or ""
    k       = int(data.get("k", 8))
    doc     = (data.get("doc") or "")[:4000]

    base = suggest_words(prefix, context, k=k)
    if (not base) or (not any(base.values())):
        base = suggest_from_doc(prefix, context, doc, k=k) if doc else {"completions": [], "next": [], "phrases": []}
    return jsonify(base)

@app.route("/search_local", methods=["POST", "OPTIONS"])
def search_local():
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(silent=True) or {}
    q = (data.get("q") or "").strip().lower()
    results = []
    _load_ac_if_changed()
    if _ac and q:
        for p in (_ac.get("phrases") or []):
            if q in p.lower():
                results.append({"type":"phrase", "text":p})
                if len(results) >= 15: break
        for k, arr in (_ac.get("prefix") or {}).items():
            if k.startswith(q):
                for v in arr[:3]:
                    results.append({"type":"token", "text":v})
            if len(results) >= 25: break
    if not results:
        results = [{"type":"info", "text":"No local results"}]
    return jsonify({"results": results})

@app.route("/ask", methods=["POST", "OPTIONS"])
def ask():
    if request.method == "OPTIONS":
        return ("", 204)
    uid = uid_from_request()
    body = request.get_json(silent=True) or {}
    q = (body.get("question") or "").strip()

    plan = "plus" if is_plus_user(uid) else "free"

    # PLUS는 동의 필요
    if plan == "plus" and not has_plus_consent():
        return jsonify({"error": "consent_required", "message": "PLUS 사용 전 동의가 필요합니다."}), 403

    # 무료 플랜 크레딧 차감
    if plan == "free":
        ok, _ = charge_one(uid)
        if not ok:
            return jsonify({
                "answer": "무료 플랜(12시간 5회)이 소진되었습니다. PLUS를 활성화하면 무제한 이용 가능합니다.",
                "plan": plan, "usage": get_usage(uid)
            }), 429

    # 백엔드 라우팅
    if plan == "plus":
        messages = [
            {"role": "system", "content": "You are ThinkHelper. Provide accurate, concise answers."},
            {"role": "user", "content": q},
        ]
        answer = call_openai(messages)
    else:
        prompt = f"당신은 ThinkHelper입니다. 간결하고 정확하게 답하세요.\n[질문]\n{q}\n[답변]"
        answer = call_ollama(prompt)

    return jsonify({"answer": answer, "plan": plan, "usage": get_usage(uid)})

# ============= 실행 =============
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.logger.info(f"ThinkHelper running on http://127.0.0.1:{port}")
    app.run(host="0.0.0.0", port=port, debug=True)
