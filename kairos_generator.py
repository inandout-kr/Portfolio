"""
kairos/generator.py
===================
생성기 — 발굴 파이프라인 ①단계 (CLAUDE.md §4, §10-5).

핵심 규칙 (§4-①): **모든 후보는 경제적 메커니즘(thesis)을 달고 나온다.**
이유 없는 전략은 감점이 아니라 *생성 자체가 불가능*하다. 여기서 그걸 타입으로
강제한다 — Thesis 없는 Candidate 는 만들 수 없고, 빈 thesis 는 예외.

두 가지 제안 경로
  1) GeneticGenerator : Kairos 프리미티브 위 유전 프로그래밍. 각 프리미티브가
     경제적 카테고리를 달고 있어, 생성된 트리에서 thesis 가 자동 유도된다.
  2) LLMProposer      : LLM 이 (카테고리, 근거)를 제안하면 카테고리에 맞는
     프리미티브 템플릿으로 Candidate 화. provider-agnostic (llm_fn 주입식) —
     특정 LLM 업체를 여기서 고정하지 않는다 (그 선택은 사용자 결정 사항).

경제적 카테고리(§4-①): risk_premium / behavioral / microstructure / supply_demand.
  - risk_premium 은 펀더멘털(밸류/캐리)이 필요한데 PIT 펀더멘털 소스가 아직
    미연동(§10-3 라이브 가정)이라, close/volume 만으로 만드는 현재 프리미티브
    집합엔 빠져 있다. 펀더멘털 연동 시 추가.
"""
from __future__ import annotations

import random
import statistics
from dataclasses import dataclass, field
from typing import Callable

# 허용 경제 카테고리
CATEGORIES = ("risk_premium", "behavioral", "microstructure", "supply_demand")

_RATIONALE_TEMPLATES = {
    "behavioral": "투자자 과소/과대반응에서 오는 행동편향 (모멘텀/리버설).",
    "microstructure": "가격 레벨 돌파 등 미시구조적 수급 신호.",
    "supply_demand": "거래량 급증으로 드러나는 수급 불균형.",
    "risk_premium": "위험 보상(밸류/캐리)에서 오는 위험프리미엄.",
}


# ---------------------------------------------------------------------------
# thesis (경제적 근거) — 없으면 만들 수 없다
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Thesis:
    category: str
    rationale: str

    def __post_init__(self) -> None:
        if self.category not in CATEGORIES:
            raise ValueError(f"unknown category: {self.category}")
        if not self.rationale or not self.rationale.strip():
            raise ValueError("thesis rationale must be non-empty (경제적 근거 강제)")


# ---------------------------------------------------------------------------
# 프리미티브 + 표현식 트리 (GP 대상)
# ---------------------------------------------------------------------------
def _ret(closes: list[float], n: int) -> float:
    if len(closes) <= n or closes[-1 - n] == 0:
        return 0.0
    return closes[-1] / closes[-1 - n] - 1.0


@dataclass(frozen=True)
class Terminal:
    """말단 프리미티브. score(window)->float, category 를 단다."""
    name: str
    category: str
    fn: Callable[[dict], float]


def _make_terminals() -> list[Terminal]:
    def mom(n):
        return Terminal(f"mom{n}", "behavioral", lambda w, n=n: _ret(w["close"], n))

    def rev(n):
        return Terminal(f"rev{n}", "behavioral", lambda w, n=n: -_ret(w["close"], n))

    def breakout(n):
        def f(w, n=n):
            c = w["close"]
            if len(c) <= n:
                return 0.0
            hi, lo = max(c[-1 - n:-1]), min(c[-1 - n:-1])
            if c[-1] > hi:
                return 1.0
            if c[-1] < lo:
                return -1.0
            return 0.0
        return Terminal(f"breakout{n}", "microstructure", f)

    def volsurge(n):
        def f(w, n=n):
            v = w.get("volume")
            if not v or len(v) <= n:
                return 0.0
            avg = statistics.fmean(v[-1 - n:-1])
            return (v[-1] / avg - 1.0) if avg > 0 else 0.0
        return Terminal(f"volsurge{n}", "supply_demand", f)

    out = []
    for n in (1, 5, 20):
        out += [mom(n), rev(n), breakout(n), volsurge(n)]
    return out


TERMINALS = _make_terminals()

# 함수 프리미티브 (카테고리 없음 — 결합만)
FUNCTIONS = {
    "add": (2, lambda a, b: a + b),
    "sub": (2, lambda a, b: a - b),
    "neg": (1, lambda a: -a),
}


@dataclass
class Node:
    """표현식 트리 노드. op='term'이면 terminal, 아니면 FUNCTIONS 키."""
    op: str
    terminal: Terminal | None = None
    children: list["Node"] = field(default_factory=list)

    def eval(self, window: dict) -> float:
        if self.op == "term":
            return self.terminal.fn(window)
        arity, fn = FUNCTIONS[self.op]
        return fn(*[c.eval(window) for c in self.children])

    def terminals(self) -> list[Terminal]:
        if self.op == "term":
            return [self.terminal]
        out = []
        for c in self.children:
            out += c.terminals()
        return out

    def __str__(self) -> str:
        if self.op == "term":
            return self.terminal.name
        return f"{self.op}(" + ", ".join(str(c) for c in self.children) + ")"


# ---------------------------------------------------------------------------
# 후보 — Thesis 없이는 존재 불가
# ---------------------------------------------------------------------------
@dataclass
class Candidate:
    tree: Node
    thesis: Thesis
    deadzone: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.thesis, Thesis):
            raise TypeError("Candidate requires a Thesis (경제적 근거 강제)")

    def score(self, window: dict) -> float:
        return self.tree.eval(window)

    def signal(self, window: dict) -> int:
        """+1 매수 / -1 매도 / 0 관망."""
        s = self.score(window)
        if s > self.deadzone:
            return 1
        if s < -self.deadzone:
            return -1
        return 0


def derive_thesis(tree: Node) -> Thesis:
    """트리의 말단 카테고리에서 지배 카테고리를 골라 thesis 를 만든다."""
    cats = [t.category for t in tree.terminals()]
    if not cats:
        raise ValueError("no economic terminal -> thesis 불가")
    dominant = max(set(cats), key=cats.count)
    return Thesis(dominant, _RATIONALE_TEMPLATES[dominant])


# ---------------------------------------------------------------------------
# 1) 유전 프로그래밍 생성기
# ---------------------------------------------------------------------------
@dataclass
class GeneticGenerator:
    rng: random.Random = field(default_factory=random.Random)
    max_depth: int = 3

    def random_tree(self, depth: int | None = None) -> Node:
        depth = self.max_depth if depth is None else depth
        # 말단이거나(깊이 0 또는 확률) 함수 노드.
        if depth <= 0 or self.rng.random() < 0.4:
            return Node("term", terminal=self.rng.choice(TERMINALS))
        op = self.rng.choice(list(FUNCTIONS))
        arity = FUNCTIONS[op][0]
        return Node(op, children=[self.random_tree(depth - 1) for _ in range(arity)])

    def make_candidate(self) -> Candidate:
        tree = self.random_tree()
        return Candidate(tree, derive_thesis(tree))

    def generate(self, n: int) -> list[Candidate]:
        return [self.make_candidate() for _ in range(n)]

    # --- GP 연산 ---
    def _nodes(self, tree: Node) -> list[Node]:
        out = [tree]
        for c in tree.children:
            out += self._nodes(c)
        return out

    def mutate(self, cand: Candidate) -> Candidate:
        """무작위 서브트리 하나를 새 무작위 서브트리로 교체."""
        clone = _clone(cand.tree)
        nodes = self._nodes(clone)
        target = self.rng.choice(nodes)
        new_sub = self.random_tree(self.rng.randint(0, self.max_depth - 1))
        target.op, target.terminal, target.children = (
            new_sub.op, new_sub.terminal, new_sub.children,
        )
        return Candidate(clone, derive_thesis(clone))

    def crossover(self, a: Candidate, b: Candidate) -> Candidate:
        """a 의 서브트리 한 곳을 b 의 서브트리로 치환."""
        clone = _clone(a.tree)
        donor = _clone(self.rng.choice(self._nodes(b.tree)))
        target = self.rng.choice(self._nodes(clone))
        target.op, target.terminal, target.children = (
            donor.op, donor.terminal, donor.children,
        )
        return Candidate(clone, derive_thesis(clone))


def _clone(node: Node) -> Node:
    if node.op == "term":
        return Node("term", terminal=node.terminal)
    return Node(node.op, children=[_clone(c) for c in node.children])


# ---------------------------------------------------------------------------
# 2) LLM 제안기 (provider-agnostic)
# ---------------------------------------------------------------------------
@dataclass
class LLMProposer:
    """
    llm_fn(prompt) -> "category|rationale" 줄들. 어떤 LLM 이든 주입 가능
    (업체 고정 X). 카테고리에 맞는 기본 프리미티브 템플릿으로 Candidate 화.
    """
    llm_fn: Callable[[str], str]

    _TEMPLATE = {
        "behavioral": Node("term", terminal=next(t for t in TERMINALS if t.name == "mom5")),
        "microstructure": Node("term", terminal=next(t for t in TERMINALS if t.name == "breakout20")),
        "supply_demand": Node("term", terminal=next(t for t in TERMINALS if t.name == "volsurge5")),
        "risk_premium": None,  # 펀더멘털 미연동
    }

    def propose(self, prompt: str) -> list[Candidate]:
        raw = self.llm_fn(prompt)
        cands = []
        for line in raw.strip().splitlines():
            if "|" not in line:
                continue
            cat, rationale = (x.strip() for x in line.split("|", 1))
            tmpl = self._TEMPLATE.get(cat)
            if tmpl is None:
                continue   # 지원 안 되는 카테고리(예: 펀더멘털 필요)는 건너뜀
            cands.append(Candidate(_clone(tmpl), Thesis(cat, rationale)))
        return cands


# ---------------------------------------------------------------------------
# 데모 / 자체 검증
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=== 1) GP 생성: 모든 후보에 thesis 가 붙는다 ===")
    gen = GeneticGenerator(rng=random.Random(7), max_depth=3)
    cands = gen.generate(5)
    window = {"close": [100, 101, 99, 103, 108, 107, 110],
              "volume": [10, 12, 9, 30, 11, 10, 25]}
    for c in cands:
        print(f"  [{c.thesis.category:14s}] sig={c.signal(window):+d}  expr={c.tree}")
    print()

    print("=== 2) thesis 없는 후보는 만들 수 없다 ===")
    try:
        Thesis("behavioral", "  ")
    except ValueError as e:
        print("  빈 근거 거부:", e)
    try:
        Candidate(cands[0].tree, thesis=None)  # type: ignore[arg-type]
    except TypeError as e:
        print("  thesis 누락 거부:", e)
    print()

    print("=== 3) GP 연산 (mutate / crossover) ===")
    m = gen.mutate(cands[0])
    x = gen.crossover(cands[0], cands[1])
    print(f"  mutate   -> [{m.thesis.category}] {m.tree}")
    print(f"  crossover-> [{x.thesis.category}] {x.tree}")
    print()

    print("=== 4) LLM 제안기 (가짜 llm_fn 주입) ===")
    def fake_llm(_prompt: str) -> str:
        return (
            "behavioral|단기 모멘텀: 실적 발표 후 과소반응 드리프트\n"
            "supply_demand|거래량 급증은 정보성 매수세\n"
            "risk_premium|저PBR 밸류 프리미엄 (펀더멘털 필요)\n"
        )
    proposed = LLMProposer(fake_llm).propose("KOSPI200 분~일 알파 제안")
    for c in proposed:
        print(f"  [{c.thesis.category:14s}] {c.thesis.rationale}")
    print("  -> risk_premium 은 펀더멘털 미연동이라 자동 스킵됨")
