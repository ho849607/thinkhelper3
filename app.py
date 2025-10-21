# app.py
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # Nginx에서도 CORS 헤더 추가하지만, 로컬 테스트 편의로 허용

@app.get("/health")
def health():
    return "ok", 200

@app.post("/v1/chat")
def chat():
    """
    프런트가 보내는 payload 예:
    {
      "messages":[{"role":"user","content":"ping"}],
      "mode":"normal","lang":"ko","provider":"gptoss","thread_id":"c_..."}
    """
    data = request.get_json(silent=True) or {}
    msgs = data.get("messages") or []
    # 데모: 단순 에코/핑퐁
    last = msgs[-1]["content"] if msgs else ""
    reply = "pong" if last.strip().lower() == "ping" else f"echo: {last}"
    return jsonify({"reply": reply})

@app.post("/v1/action")
def action():
    """
    프런트의 추천 액션 호출 예:
    { "intent":"echo", "params":{"text":"hi"}, "mode":"...", "lang":"..." }
    """
    data = request.get_json(silent=True) or {}
    intent = data.get("intent")
    params = data.get("params") or {}

    if intent == "echo":
        return jsonify({"reply": params.get("text", "")})

    if intent == "news_today":
        topics = params.get("topics") or ["AI", "Tech"]
        # 데모: 토픽 리스트만 묶어서 반환
        body = "뉴스 토픽: " + ", ".join(topics)
        return jsonify({"reply": body})

    # 알 수 없는 intent
    return jsonify({"reply": f"unknown intent: {intent}"}), 400

# (옵션) 헬스 체크 외 루트
@app.get("/")
def root():
    return "ThinkHelper API", 200

if __name__ == "__main__":
    # 개발용 실행 (운영은 gunicorn 사용)
    app.run(host="127.0.0.1", port=5050)
