import re
import time
import json
import math
from collections import Counter, defaultdict
from typing import List, Dict, Set, Tuple
from datetime import datetime

class ThinkHelperBrain:
    def __init__(self, storage_file='brain_data.json'):
        self.storage_file = storage_file
        self.stop_ko = {"그리고", "그러나", "하지만", "또는", "있다", "하는", "에서", "으로", "에게", "입니다", "이다", "된", "된", "하고"}
        self.stop_en = {"the", "and", "for", "with", "that", "this", "from", "have", "are", "not", "was", "been", "is"}
        
        # 메모리 로드
        self.memory = self.load_memory()
        self.current_doc_id = None  # 현재 작업 중인 문서

    def load_memory(self) -> Dict:
        try:
            with open(self.storage_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # timestamp 호환성 보장
                for k in data.get("last_used_at", {}):
                    if isinstance(data["last_used_at"][k], str):
                        data["last_used_at"][k] = datetime.fromisoformat(data["last_used_at"][k]).timestamp() * 1000
                return data
        except:
            return {
                "accept_counts": {},      # {word: count}
                "last_used_at": {},       # {word: timestamp_ms}
                "doc_freq": {},           # {doc_id: {word: count}}
                "user_dict": {"ko": [], "en": []},
                "doc_history": []         # [doc_id, ...] 순서 보장
            }

    def save_memory(self):
        # timestamp을 문자열로 저장 (JSON 호환)
        save_data = self.memory.copy()
        last_used = {}
        for k, v in save_data["last_used_at"].items():
            last_used[k] = datetime.fromtimestamp(v / 1000).isoformat()
        save_data["last_used_at"] = last_used
        
        with open(self.storage_file, 'w', encoding='utf-8') as f:
            json.dump(save_data, f, ensure_ascii=False, indent=2)

    # 1. 토큰 추출 (향상된 정규식)
    def extract_tokens(self, text: str) -> Dict[str, List[str]]:
        ko_tokens = re.findall(r'[가-힣]{2,}', text)
        ko_tokens = [w for w in ko_tokens if w not in self.stop_ko and len(w) <= 10]
        
        en_tokens = re.findall(r'\b[a-zA-Z]{3,}\b', text)
        en_tokens = [w.lower() for w in en_tokens if w.lower() not in self.stop_en]
        
        return {"ko": ko_tokens, "en": en_tokens}

    # 2. 문서 학습 (실시간)
    def scan_document(self, doc_id: str, text: str):
        self.current_doc_id = doc_id
        if doc_id not in self.memory["doc_freq"]:
            self.memory["doc_history"].append(doc_id)
            if len(self.memory["doc_history"]) > 100:
                old_doc = self.memory["doc_history"].pop(0)
                self.memory["doc_freq"].pop(old_doc, None)
        
        tokens = self.extract_tokens(text)
        all_tokens = tokens['ko'] + tokens['en']
        freq = Counter(all_tokens)
        
        # 문서 빈도 누적
        if doc_id not in self.memory["doc_freq"]:
            self.memory["doc_freq"][doc_id] = {}
        for w, c in freq.items():
            self.memory["doc_freq"][doc_id][w] = self.memory["doc_freq"][doc_id].get(w, 0) + c
        
        # 사용자 사전 업데이트 (2회 이상 등장)
        for lang, words in tokens.items():
            candidates = [w for w, c in Counter(words).items() if c >= 2]
            current = set(self.memory["user_dict"][lang])
            current.update(candidates)
            self.memory["user_dict"][lang] = list(current)
        
        self.save_memory()

    # 3. 점수 계산 (단순 + 효과적)
    def _calculate_score(self, word: str) -> float:
        now = time.time() * 1000
        
        # 1. 선택 횟수
        count = self.memory["accept_counts"].get(word, 0)
        
        # 2. 최근성 (최근 7일 보너스)
        last_ts = self.memory["last_used_at"].get(word, 0)
        hours_ago = (now - last_ts) / (1000 * 60 * 60) if last_ts else 999
        recency_bonus = max(0, 10 - hours_ago // 24 * 2)  # 7일 내 보너스
        
        # 3. 현재 문서 빈도
        context_bonus = 0
        if self.current_doc_id and self.current_doc_id in self.memory["doc_freq"]:
            context_bonus = self.memory["doc_freq"][self.current_doc_id].get(word, 0) * 3
        
        return count * 5 + recency_bonus + context_bonus

    # 4. 추천 (실시간 + 상위 5개)
    def get_suggestions(self, prefix: str, top_n: int = 5) -> List[str]:
        if not prefix or len(prefix) < 1:
            return []
        
        lang = "ko" if re.search(r'[가-힣]', prefix) else "en"
        prefix = prefix.lower() if lang == "en" else prefix
        
        candidates = [
            w for w in self.memory["user_dict"][lang]
            if (w if lang == "ko" else w.lower()).startswith(prefix)
        ]
        
        # 점수 정렬
        candidates.sort(key=self._calculate_score, reverse=True)
        return candidates[:top_n]

    # 5. 선택 학습
    def accept_suggestion(self, word: str):
        self.memory["accept_counts"][word] = self.memory["accept_counts"].get(word, 0) + 1
        self.memory["last_used_at"][word] = time.time() * 1000
        self.save_memory()
        print(f"Learned: '{word}' (+1)")

    # 6. LLM에 보낼 컨텍스트 생성 (핵심!)
    def get_context_for_llm(self, user_input: str, max_tokens: int = 300) -> str:
        tokens = self.extract_tokens(user_input)
        all_words = tokens['ko'] + tokens['en']
        
        # 상위 10개 키워드 추출
        word_scores = [(w, self._calculate_score(w)) for w in set(all_words)]
        word_scores.sort(key=lambda x: x[1], reverse=True)
        top_keywords = [w for w, s in word_scores[:10]]
        
        # 현재 문서 요약
        doc_summary = ""
        if self.current_doc_id and self.current_doc_id in self.memory["doc_freq"]:
            top_in_doc = sorted(
                self.memory["doc_freq"][self.current_doc_id].items(),
                key=lambda x: x[1], reverse=True
            )[:5]
            doc_summary = "현재 문서 키워드: " + ", ".join([f"{w}({c})" for w, c in top_in_doc])
        
        return f"""
[CONTEXT]
- 주제: {', '.join(top_keywords[:5])}
- {doc_summary}
- 사용자 입력: {user_input}
[/CONTEXT]
""".strip()

# === 테스트 ===
if __name__ == "__main__":
    brain = ThinkHelperBrain()
    
    doc_id = "doc_selfdrive"
    text = """
    자율주행 기술은 인공지능과 센서 퓨전으로 이루어집니다.
    자율주행 자동차는 라이다와 카메라를 사용해 주변을 인식합니다.
    딥러닝 모델이 실시간으로 판단을 내립니다.
    """
    
    print("문서 학습 중...")
    brain.scan_document(doc_id, text)
    
    print("\n'자' 입력 → 추천:")
    print(brain.get_suggestions("자"))
    
    brain.accept_suggestion("자율주행")
    
    print("\n다시 '자' 입력 → 추천:")
    print(brain.get_suggestions("자"))  # 자율주행이 1위!
    
    print("\nLLM에 보낼 컨텍스트:")
    print(brain.get_context_for_llm("자율주행에서 안전성"))
