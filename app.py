# -*- coding: utf-8 -*-
"""
ThinkHelper Brain v2
- 실시간(on-type) 학습 + 즉시 추천
- 전역/문서별 수락 카운트(강화학습) + 시간감쇠
- 문서별 TF(빈도) 기반 컨텍스트 가중
- 사용자 사전(user_dict) 동기화 + 기본 사전(seed) 결합
- JSON 영속화 (스키마 변화에 대비한 안전 로드)
"""

import re
import time
import json
import math
import os
from collections import Counter
from typing import List, Dict, Optional


def now_ms() -> int:
    return int(time.time() * 1000)


def days_since(ts_ms: Optional[int]) -> float:
    if not ts_ms:
        return 9999.0
    # 현재(ms) - 과거(ms) -> 일수
    return max(0.0, (now_ms() - ts_ms) / (1000.0 * 60 * 60 * 24))


class ThinkHelperBrain:
    """
    사용 패턴:
      brain = ThinkHelperBrain()
      brain.observe_text_incremental(doc_id, current_text)   # 타이핑 중 수시 호출
      cands = brain.get_suggestions(prefix, doc_id, top_n=8) # 접두사 추천
      brain.accept_suggestion(doc_id, chosen_word)           # 탭/엔터 수락시 호출
    """

    def __init__(self, storage_file: str = "brain_data.json"):
        self.storage_file = storage_file

        # 불용어 (너무 흔한 단어 제외)
        self.stop_ko: set = {
            "그리고", "그러나", "하지만", "또", "또는", "및", "있다",
            "하는", "에서", "으로", "에게", "입니다", "수", "것", "등", "때"
        }
        self.stop_en: set = {
            "the", "and", "for", "with", "that", "this", "from",
            "have", "are", "not", "to", "of", "in", "on", "by", "as", "be", "is"
        }

        # 기본(시드) 사전 — 필요시 추가
        self.dict_ko_base: List[str] = [
            "분석","연구","결과","방법","과정","결론","참고","출처","데이터","요약",
            "종합","한계","전망","쟁점","법리","판례","형법","형사소송법","대법원","요지",
            "사실관계","알고리즘","프로토타입","컨텍스트","토큰","임베딩","오프라인",
            "캐시","스레드","비동기","이벤트루프","렌더링","성능최적화"
        ]
        self.dict_en_base: List[str] = [
            "analysis","baseline","benchmark","context","dataset","design","embedding",
            "evaluation","fallback","feature","guide","heuristic","insight","journey",
            "knowledge","latency","model","note","optimize","pipeline","quality",
            "research","summary","template","validation","workflow","yield","zero-copy"
        ]

        # 최대 사용자 사전 용량(언어별)
        self.user_dict_caps = {"ko": 400, "en": 400}

        # 메모리 로드 + 스키마 보정
        self.memory = self._load_or_init()

        # 감쇠 파라미터(일 단위)
        self.decay_daily = 0.99

        # 문서별 수락 로그(선택사항) — 필요시 분석용
        # {"doc_id": {"accept_counts": {...}, "last_used_at": {...}}}
        if "per_doc_accept" not in self.memory:
            self.memory["per_doc_accept"] = {}

    # ------------------ Persistence ------------------

    def _load_or_init(self) -> Dict:
        if not os.path.exists(self.storage_file):
            return {
                "accept_counts": {},        # 전역 선택 횟수 {word: count}
                "last_used_at": {},         # 전역 마지막 사용 시각(ms) {word: ts}
                "doc_freq": {},             # 문서별 TF {doc_id: {word: count}}
                "user_dict": {"ko": [], "en": []},  # 사용자 사전
            }
        try:
            with open(self.storage_file, "r", encoding="utf-8") as f:
                mem = json.load(f)
        except Exception:
            # 파일 깨졌을 때 복구
            mem = {}

        # 스키마 보정
        mem.setdefault("accept_counts", {})
        mem.setdefault("last_used_at", {})
        mem.setdefault("doc_freq", {})
        mem.setdefault("user_dict", {"ko": [], "en": []})
        # 타입 보정
        for lang in ("ko", "en"):
            if not isinstance(mem["user_dict"].get(lang, []), list):
                mem["user_dict"][lang] = []
        return mem

    def save_memory(self) -> None:
        tmp_path = self.storage_file + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(self.memory, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, self.storage_file)

    # ------------------ Tokenization ------------------

    def extract_tokens(self, text: str) -> Dict[str, List[str]]:
        """
        텍스트에서 언어별 토큰 목록 추출.
        - 한글: 2글자 이상
        - 영어: 3글자 이상, 소문자화
        - 불용어 제거
        """
        text = text or ""
        ko_tokens = re.findall(r"[가-힣]{2,}", text)
        ko_tokens = [w for w in ko_tokens if w not in self.stop_ko and len(w) <= 20]

        en_tokens = re.findall(r"[A-Za-z][A-Za-z\-]{2,}", text)
        en_tokens = [w.lower() for w in en_tokens if w.lower() not in self.stop_en and len(w) <= 24]

        return {"ko": ko_tokens[:1000], "en": en_tokens[:1000]}

    # ------------------ Learning ------------------

    def observe_text_incremental(self, doc_id: str, current_text: str) -> None:
        """
        현재 문서의 전체 텍스트를 넣어주면 TF를 갱신하고,
        사용자 사전을 최신 빈도로 동기화한다.
        - 프런트엔드: 키 입력(debounce 500~1200ms 권장) 때마다 호출
        """
        tokens = self.extract_tokens(current_text)
        all_tokens = tokens["ko"] + tokens["en"]
        self.memory["doc_freq"][doc_id] = dict(Counter(all_tokens))

        # 사용자 사전 동기화 (각 언어별 빈도 상위 + 중복 제거 + 용량 캡)
        for lang in ("ko", "en"):
            freq = Counter(tokens[lang])
            # 노이즈 제거: 2회 이상 등장
            cand = [w for w, c in freq.items() if c >= 2]
            current: set = set(self.memory["user_dict"].get(lang, []))
            # 많이 나온 것부터 추가
            for w, _ in freq.most_common():
                if w in current:
                    continue
                if w in cand:
                    current.add(w)
                if len(current) >= self.user_dict_caps[lang]:
                    break
            # 기본 사전과 충돌 없이 유지(중복 허용 X)
            self.memory["user_dict"][lang] = list(current)[: self.user_dict_caps[lang]]

        self.save_memory()

    # ------------------ Scoring ------------------

    def _decay_score(self, count: int, last_ts_ms: Optional[int]) -> float:
        d = days_since(last_ts_ms)  # 일수
        return (count or 0) * (self.decay_daily ** d)

    def _context_score(self, word: str, doc_id: Optional[str]) -> float:
        if not doc_id:
            return 0.0
        tf = self.memory["doc_freq"].get(doc_id, {}).get(word, 0)
        # 문서 내 자주 등장할수록 가산점(상한 완만)
        return 0.2 * min(5, tf)

    def _per_doc_accept_score(self, word: str, doc_id: Optional[str]) -> float:
        if not doc_id:
            return 0.0
        drec = self.memory.get("per_doc_accept", {}).get(doc_id, {})
        cnt = drec.get("accept_counts", {}).get(word, 0)
        last_ts = drec.get("last_used_at", {}).get(word, 0)
        return 1.2 * self._decay_score(cnt, last_ts)

    def _score_word(self, word: str, doc_id: Optional[str]) -> float:
        # 전역 강화 점수(감쇠)
        g = self._decay_score(
            self.memory["accept_counts"].get(word, 0),
            self.memory["last_used_at"].get(word)
        )
        # 문서별 강화 + 컨텍스트 TF 점수
        return g + self._per_doc_accept_score(word, doc_id) + self._context_score(word, doc_id)

    # ------------------ Suggestion ------------------

    def _lang_of_prefix(self, prefix: str) -> str:
        return "ko" if re.search(r"[가-힣]", prefix) else "en"

    def _candidate_pool(self, lang: str) -> List[str]:
        base = self.dict_ko_base if lang == "ko" else self.dict_en_base
        user = self.memory["user_dict"].get(lang, [])
        # 순서 보존하며 중복 제거
        seen = set()
        out = []
        for w in user + base:
            if w not in seen:
                seen.add(w)
                out.append(w)
        return out

    def get_suggestions(self, prefix: str, doc_id: Optional[str] = None, top_n: int = 8) -> List[str]:
        if not prefix:
            return []
        lang = self._lang_of_prefix(prefix)
        p = prefix.lower()

        pool = self._candidate_pool(lang)
        cand = [w for w in pool if w.lower().startswith(p)]

        scored = sorted(cand, key=lambda w: (-self._score_word(w, doc_id), w))
        return scored[:top_n]

    # ------------------ Reinforcement ------------------

    def accept_suggestion(self, doc_id: str, word: str) -> None:
        # 전역 강화
        self.memory["accept_counts"][word] = self.memory["accept_counts"].get(word, 0) + 1
        self.memory["last_used_at"][word] = now_ms()

        # 문서별 강화
        pda = self.memory.setdefault("per_doc_accept", {})
        drec = pda.setdefault(doc_id, {"accept_counts": {}, "last_used_at": {}})
        drec["accept_counts"][word] = drec["accept_counts"].get(word, 0) + 1
        drec["last_used_at"][word] = now_ms()

        self.save_memory()
        # 로그 용도: 실제 서비스에선 로깅 시스템으로 전송
        print(f"👍 Learned: '{word}' (global={self.memory['accept_counts'][word]}, doc={drec['accept_counts'][word]})")


# ------------------ Demo ------------------
if __name__ == "__main__":
    brain = ThinkHelperBrain()

    doc_id = "doc_123"
    text = """
    자율주행 기술의 핵심은 인공지능과 센서 퓨전이다.
    자율주행 자동차는 라이다 센서를 통해 주변을 인식하고,
    인공지능 알고리즘은 판단을 내린다. Analysis and embedding pipeline
    with offline cache and context map.
    """

    print("[1] observe_text_incremental() — 실시간 학습")
    brain.observe_text_incremental(doc_id, text)

    print("[2] 접두사 '자' 추천:", brain.get_suggestions("자", doc_id, top_n=6))
    print("[3] 접두사 'ana' 추천:", brain.get_suggestions("ana", doc_id, top_n=6))

    print("[4] 사용자가 '자율주행' 수락(강화)")
    brain.accept_suggestion(doc_id, "자율주행")

    print("[5] 재추천(강화 반영):", brain.get_suggestions("자", doc_id, top_n=6))
