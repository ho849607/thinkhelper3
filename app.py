# app.py
import os
import time
from typing import List, Dict, Any

from flask import Flask, request, jsonify
from flask_cors import CORS

# ===== (선택) .env 로컬 개발 편의 =====
try:
    from dotenv import load_dotenv  # requirements.txt에 python-dotenv 추가 시 사용
    load_dotenv()
except Exception:
    pass

# ===== 외부 모델 SDK =====
# OpenAI (우선 사용)
try:
    from openai import OpenAI  # openai==1.x
except Exception:
    OpenAI = None

# Google Gemini (폴백 및 프리미엄 추천어)
try:
    import google.generativeai as genai  # google-generativeai
except Exception:
    genai = None

app = Flask(__name__)
CORS(app)

# ===== 환경변수 =====
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")            # 경량/저렴
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")       # 반응 빠름

OPENAI_TIMEOUT = float(os.getenv("OPENAI_TIMEOUT", "18.0"))
GEMINI_TIMEOUT = float(os.getenv("GEMINI_TIMEOUT", "18.0"))

# ===== 클라이언트 초기화 =====
oai_client = None
if OPENAI_API_KEY and OpenAI is not None:
    try:
        oai_client = OpenAI(api_key=OPENAI_API_KEY)
    except Exception:
        oai_client = None

if GOOGLE_API_KEY and genai is not None:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
    except Exception:
        pass


# ===== 유틸: 간단 언어 감지 =====
def detect_lang(text: str) -> str:
    s = (text or "").strip()
    if any("\u3040" <= ch <= "\u30ff" or "\u4e00" <= ch <= "\u9fff" for ch in s):
        # 일본어/한자 섞임 → 자주 쓰는 케이스만 단순 판단
        if any("\u3040" <= ch <= "\u309f" or "\u30a0" <= ch <= "\u30ff" for ch in s):
            return "ja"
    if any("\uac00" <= ch <= "\ud7a3" for ch in s):
        return "ko"
    return "en"


# ===== 유틸: 메시지 형식 보정 =====
def normalize_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for m in messages or []:
        role = (m.get("role") or "").strip() or "user"
        content = m.get("content")
        if isinstance(content, list):
            content = " ".join([str(x) for x in content])
        content = str(content or "")
        out.append({"role": role, "content": content})
    return out


# ===== OpenAI 호출 =====
def call_openai(messages: List[Dict[str, str]], lang_hint: str = "ko") -> str:
    if not oai_client:
        raise RuntimeError("OpenAI client unavailable")

    # system 프롬프트(간결 응답 + 언어 고정)
    if lang_hint == "ko":
        sys = "너는 매우 간결하고 유용한 조수야. 항상 한국어로 간단명료하게 답해."
    elif lang_hint == "ja":
        sys = "あなたは簡潔で役立つアシスタントです。常に日本語で簡潔に答えてください。"
    else:
        sys = "You are a concise, helpful assistant. Always answer briefly in English."

    payload = [{"role": "system", "content": sys}] + messages

    # OpenAI Python SDK v1.x
    # chat.completions.create 를 사용 (responses API도 가능)
    resp = oai_client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=payload,
        temperature=0.6,
        timeout=OPENAI_TIMEOUT,
    )
    return (resp.choices[0].message.content or "").strip()


# ===== Gemini 호출 =====
def call_gemini(messages: List[Dict[str, str]], lang_hint: str = "ko") -> str:
    if not genai or not GOOGLE_API_KEY:
        raise RuntimeError("Gemini client unavailable")

    # system 스타일 힌트를 첫 user로 앞에 붙임(간단 대응)
    if lang_hint == "ko":
        sys = "항상 한국어로 간결하게 답하세요."
    elif lang_hint == "ja":
        sys = "常に日本語で簡潔に答えてください。"
    else:
        sys = "Always answer concisely in English."

    model = genai.GenerativeModel(GEMINI_MODEL)

    # Gemini는 history/parts 설계가 있지만, 간단히 한 번에 붙여도 동작
    # role: "user"/"model" 매핑. 여기서는 user/assistant를 텍스트로 연결
    joined = [f"[{m['role']}] {m['content']}" for m in messages]
    prompt = sys + "\n\n" + "\n".join(joined)

    # timeouts: SDK에 직접 timeout 파라미터가 없으므로 간단 시간 제한만 래핑
    start = time.time()
    res = model.generate_content(prompt)
    if time.time() - start > GEMINI_TIMEOUT:
        raise TimeoutError("Gemini timeout")

    txt = ""
    try:
        txt = (res.text or "").strip()
    except Exception:
        # 일부 응답 구조에서 candidates[0].content.parts[...].text 로 접근이 필요할 수 있음
        try:
            cands = getattr(res, "candidates", None) or []
            if cands and cands[0].content and cands[0].content.parts:
                txt = str(cands[0].content.parts[0].text or "").strip()
        except Exception:
            pass
    if not txt:
        txt = "죄송합니다. 응답을 생성하지 못했습니다." if lang_hint == "ko" else "Sorry, I could not generate a reply."
    return txt


# ===== 무료/프리미엄 추천어 =====
BASIC_WORDS = {
    "ko": ["정의", "원리", "핵심", "절차", "전략", "주의점", "사례", "한계", "대안", "비교"],
    "en": ["definition", "principle", "key points", "process", "strategy", "pitfalls", "examples", "limitations", "alternatives", "comparison"],
    "ja": ["定義", "仕組み", "要点", "手順", "戦略", "注意点", "事例", "限界", "代替案", "比較"],
}
BASIC_TEMPL = {
    "ko": [
        lambda t: f"{t}를 쉽게 설명해 주세요.",
        lambda t: f"{t}의 핵심만 한 단락으로 정리해 주세요.",
        lambda t: f"{t}의 단계별 절차와 주의할 점을 알려 주세요.",
    ],
    "en": [
        lambda t: f"Explain {t} in simple terms.",
        lambda t: f"Summarize the key points of {t} in one paragraph.",
        lambda t: f"List step-by-step process and pitfalls for {t}.",
    ],
    "ja": [
        lambda t: f"{t}を分かりやすく説明してください。",
        lambda t: f"{t}の要点を1段落でまとめてください。",
        lambda t: f"{t}の手順と注意点をステップごとに示してください。",
    ],
}


def local_suggestions(topic: str, lang: str) -> List[str]:
    lang = lang if lang in BASIC_WORDS else "en"
    words = BASIC_WORDS[lang]
    templs = BASIC_TEMPL[lang]
    t = topic or {"ko": "주제", "en": "topic", "ja": "テーマ"}.get(lang, "topic")
    sents = [fn(t) for fn in templs]
    out = list(dict.fromkeys(words + sents))  # dedupe keep order
    return out[:10]


def gemini_suggestions(topic: str, lang: str) -> List[str]:
    # 프리미엄 전용 — 서버 보유 키 사용 (프런트에 노출 금지)
    if not genai or not GOOGLE_API_KEY:
        # Gemini 미사용 가능 시 로컬로 대체
        return local_suggestions(topic, lang)

    lang = lang or detect_lang(topic)
    if lang == "ko":
        sys = "다음 주제에 대해 한국어로 10개 이하의 제안 문장을 불릿 없이 한 줄씩 출력하세요."
    elif lang == "ja":
        sys = "次のテーマについて、日本語で提案文を10個以内で、箇条書き記号なしで1行ずつ出力してください。"
    else:
        sys = "For the given topic, produce up to 10 short suggestion lines in English, one per line without bullets."

    model = genai.GenerativeModel(GEMINI_MODEL)
    prompt = f"{sys}\n\ntopic: {topic or '(none)'}"
    res = model.generate_content(prompt)
    text = getattr(res, "text", "") or ""
    # 줄 단위 파싱
    items = [line.strip("•- \t") for line in (text or "").splitlines() if line.strip()]
    # 너무 길면 자르고, 빈값이면 로컬로 대체
    items = [x for x in items if x][:10]
    return items or local_suggestions(topic, lang)


# ===== 라우트 =====
@app.get("/health")
def health():
    return "ok", 200


@app.get("/")
def root():
    return "ThinkHelper API", 200


@app.post("/v1/chat")
def chat():
    """
    프런트 예시 payload:
    {
      "messages":[{"role":"user","content":"ping"}],
      "mode":"normal",
      "lang":"ko",
      "provider":"gptoss",
      "thread_id":"c_..."
    }
    """
    data = request.get_json(silent=True) or {}
    msgs = normalize_messages(data.get("messages") or [])
    lang = (data.get("lang") or "").strip().lower() or (detect_lang(msgs[-1]["content"]) if msgs else "ko")

    # 1) OpenAI → 2) Gemini → 3) 로컬 응답
    try:
        if msgs and oai_client:
            reply = call_openai(msgs, lang_hint=lang)
            return jsonify({"reply": reply})
    except Exception as e:
        # OpenAI 실패 → Gemini 폴백 시도
        pass

    try:
        if msgs and genai and GOOGLE_API_KEY:
            reply = call_gemini(msgs, lang_hint=lang)
            return jsonify({"reply": reply})
    except Exception:
        pass

    # 최종 폴백: 단순 에코
    last = msgs[-1]["content"] if msgs else ""
    reply = "pong" if last.strip().lower() == "ping" else f"echo: {last}"
    return jsonify({"reply": reply})


@app.post("/v1/action")
def action():
    """
    프런트의 추천 액션/커맨드 호출:
    { "intent":"echo", "params":{"text":"hi"}, "mode":"...", "lang":"..." }
    """
    data = request.get_json(silent=True) or {}
    intent = (data.get("intent") or "").strip().lower()
    params = data.get("params") or {}
    lang = (data.get("lang") or "").strip().lower() or "ko"

    if intent == "echo":
        return jsonify({"reply": params.get("text", "")})

    if intent == "news_today":
        topics = params.get("topics") or ["AI", "Tech"]
        body = ("뉴스 토픽: " if lang == "ko" else "News topics: ") + ", ".join(map(str, topics))
        return jsonify({"reply": body})

    return jsonify({"reply": f"unknown intent: {intent}"}), 400


@app.post("/v1/suggest")
def suggest():
    """
    추천어 API
    - 무료(free): 로컬 생성
    - 프리미엄(pro): Gemini로 생성 (서버 환경변수의 GOOGLE_API_KEY 사용, 프런트로 키 노출 없음)
    요청 예:
    { "topic":"RAG 파이프라인", "lang":"ko", "plan":"pro" }  # plan in {"free","pro"}
    """
    data = request.get_json(silent=True) or {}
    topic = (data.get("topic") or "").strip()
    lang = (data.get("lang") or "").strip().lower() or detect_lang(topic)
    plan = (data.get("plan") or "free").strip().lower()

    try:
        if plan == "pro":
            items = gemini_suggestions(topic, lang)
        else:
            items = local_suggestions(topic, lang)
        return jsonify({"items": items})
    except Exception as e:
        # 실패 시 로컬로
        return jsonify({"items": local_suggestions(topic, lang), "fallback": True})

# ===== 개발용 실행 =====
if __name__ == "__main__":
    # 운영 배포는 gunicorn/uwsgi 등 WSGI 서버를 권장
    app.run(host="127.0.0.1", port=5050, debug=True)
