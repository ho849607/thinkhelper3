from flask import Flask, request, jsonify
from flask_cors import CORS
import os, time, uuid

app = Flask(__name__, static_folder="static", static_url_path="/static")

# Netlify의 도메인만 허용(CORS)
CORS(app, resources={
    r"/*": {"origins": [
        "https://thinkhelper.store",
        "https://www.thinkhelper.store"
    ]}
})

# ───────── 상태/저장 (메모리 데모) ─────────
docs = {}
usage_remaining = 5
plus_activated = False

def is_plus():
    key = (request.headers.get("X-Plus-Key") or "").strip()
    return plus_activated or bool(key)

# ───────── API ─────────
@app.get("/whoami")
def whoami():
    return jsonify(ok=True, plan=("plus" if is_plus() else "free"))

@app.get("/usage")
def usage():
    if is_plus():
        return jsonify(
            plan="plus",
            usage={"remaining": 999999, "reset_at": int(time.time()) + 3600}
        )
    return jsonify(
        plan="free",
        usage={"remaining": 5, "reset_at": int(time.time()) + 3600}
    )

@app.post("/ask")
def ask():
    data = request.get_json(silent=True) or {}
    q = (data.get("question") or "").strip()
    plan = "plus" if is_plus() else "free"
    return jsonify(answer=f'질문 잘 받았어요: “{q}”', plan=plan)

@app.post("/doc/save")
def save_doc():
    data = request.get_json(silent=True) or {}
    doc_id = data.get("id") or str(uuid.uuid4())
    docs[doc_id] = {
        "id": doc_id,
        "title": data.get("title", "Untitled"),
        "html": data.get("html", ""),
        "ts": int(time.time() * 1000)
    }
    return jsonify(ok=True, id=doc_id, ts=docs[doc_id]["ts"])

@app.get("/healthz")
def healthz():
    return jsonify(ok=True)

# # (정적/SPA까지 백엔드에서 같이 서빙할 때만 사용)
# from flask import send_from_directory
# @app.get("/")
# def root():
#     return send_from_directory(".", "index.html")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
