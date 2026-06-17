"""
kairos/llm.py
=============
LLM 어댑터 — kairos_generator.LLMProposer 에 꽂을 실제 LLM `llm_fn` 구현.
기본값은 Claude (Anthropic SDK). 생성기는 provider-agnostic 이므로, 여기서만
업체를 고른다 (CLAUDE.md §11-3, §10-5 라이브 가정 = LLM 제공자 선택).

`llm_fn(prompt) -> str` 계약 (LLMProposer 가 기대하는 형식)
  - 반환 문자열은 "category|rationale" 줄들.
  - category ∈ {risk_premium, behavioral, microstructure, supply_demand}.

사용
    from kairos_llm import make_claude_llm_fn
    from kairos_generator import LLMProposer
    proposer = LLMProposer(make_claude_llm_fn())          # ANTHROPIC_API_KEY 필요
    cands = proposer.propose("코스피200 분~일 알파 제안")

테스트/오프라인
    - anthropic 패키지·API 키가 없어도 모듈 import 는 된다(지연 import).
    - client 를 주입하면(가짜 client) 네트워크 없이 검증 가능.
"""
from __future__ import annotations

from typing import Callable

from kairos_generator import CATEGORIES

# Claude 모델 (claude-api 레퍼런스 기준 기본값)
DEFAULT_MODEL = "claude-opus-4-8"

SYSTEM_PROMPT = (
    "너는 한국 주식·선물(코스피200급, 분~일봉) 트레이딩 알파 가설 제안기다. "
    "각 가설은 반드시 경제적 메커니즘(thesis)을 동반해야 한다. "
    "출력은 오직 'category|rationale' 형식의 줄들로만 한다(머리말/설명 금지). "
    f"category 는 다음 중 하나: {', '.join(CATEGORIES)}. "
    "rationale 은 한 줄짜리 경제적 근거."
)


def _extract_text(message) -> str:
    """Anthropic 응답에서 text 블록만 이어붙임."""
    return "".join(b.text for b in message.content if getattr(b, "type", None) == "text")


def make_claude_llm_fn(client=None,
                       model: str = DEFAULT_MODEL,
                       system: str = SYSTEM_PROMPT,
                       max_tokens: int = 2000) -> Callable[[str], str]:
    """
    Claude 기반 llm_fn 을 만든다. client 미지정 시 anthropic.Anthropic()
    (환경변수 ANTHROPIC_API_KEY 사용). client 를 주입하면 테스트/대체 가능.
    """
    if client is None:
        import anthropic  # 지연 import: 패키지 없어도 모듈 로드는 됨
        client = anthropic.Anthropic()

    def llm_fn(prompt: str) -> str:
        message = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )
        return _extract_text(message)

    return llm_fn


def propose_hypotheses(prompt: str, llm_fn: Callable[[str], str] | None = None):
    """편의 함수: llm_fn(기본 Claude)으로 후보 리스트 생성."""
    from kairos_generator import LLMProposer
    return LLMProposer(llm_fn or make_claude_llm_fn()).propose(prompt)


# ---------------------------------------------------------------------------
# 데모 (네트워크/키 없이 동작 — 가짜 client)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    from dataclasses import dataclass

    # Anthropic 응답 구조를 흉내낸 최소 가짜 client
    @dataclass
    class _Block:
        type: str
        text: str

    @dataclass
    class _Msg:
        content: list

    class _FakeMessages:
        def create(self, **kwargs):
            print(f"  (가짜 호출) model={kwargs['model']}")
            return _Msg(content=[_Block("text",
                "behavioral|실적 발표 후 과소반응 모멘텀 드리프트\n"
                "supply_demand|거래량 급증은 정보성 매수세\n"
                "microstructure|장중 신고가 돌파 추종\n")])

    class _FakeClient:
        messages = _FakeMessages()

    print("=== Claude 어댑터 (가짜 client 주입) ===")
    fn = make_claude_llm_fn(client=_FakeClient())
    cands = propose_hypotheses("코스피200 분~일 알파 3개 제안", llm_fn=fn)
    for c in cands:
        print(f"  [{c.thesis.category:14s}] {c.thesis.rationale}")
    print(f"\n기본 모델: {DEFAULT_MODEL}")
    print("실제 사용: make_claude_llm_fn() (ANTHROPIC_API_KEY 필요)")
