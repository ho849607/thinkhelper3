from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Literal, Optional
import google.generativeai as genai
import os # 👈 1. os 모듈 가져오기

# 👈 2. 코드에서 키 삭제! 대신 환경 변수에서 읽기
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") 

if not GEMINI_API_KEY:
    print("🔴 치명적 오류: GEMINI_API_KEY 환경 변수가 설정되지 않았습니다!")
    # (실제 서비스에서는 여기서 서버가 꺼지도록 처리할 수도 있음)
else:
    genai.configure(api_key=GEMINI_API_KEY)

app = FastAPI()
model = genai.GenerativeModel('gemini-1.5-flash') # (키가 있을 때만 초기화되도록 수정)

class Message(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str

class ApiPayload(BaseModel):
    action: str
    prompt: Optional[str] = None
    query: Optional[str] = None
    history: Optional[List[Message]] = None

@app.get("/")
def read_root():
    return {"Hello": "ThinkHelper Server"}

@app.post("/api/thinkhelper")
async def handle_api_call(payload: ApiPayload):
    
    if not GEMINI_API_KEY:
        # 헬퍼 1.0 응답 (API 키 없을 때)
        response_text = f"(서버 헬퍼 1.0) '{payload.prompt or payload.query}' (서버에 API 키가 없습니다)"
        return {"ok": True, "text": response_text, "modelUsed": "helper_1.0_no_key"}

    if payload.action == "chat":
        try:
            user_message = payload.prompt or ""
            response = await model.generate_content_async(user_message)
            return { "ok": True, "text": response.text, "modelUsed": "Gemini 1.5 Flash" }
        except Exception as e:
            return {"ok": False, "error": str(e), "text": f"AI 응답 오류 (서버): {e}"}

    elif payload.action == "search":
        # ... (검색 로직 구현) ...
        return {"ok": False, "error": "검색 기능은 아직 구현 중입니다."}
        
    return {"ok": False, "error": "알 수 없는 action입니다."}
