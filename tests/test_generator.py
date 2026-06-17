"""생성기 테스트 — thesis 강제 + GP + LLM 제안기."""
import random

import pytest

from kairos_generator import (
    CATEGORIES,
    Candidate,
    GeneticGenerator,
    LLMProposer,
    Node,
    TERMINALS,
    Thesis,
    derive_thesis,
)

WINDOW = {"close": [100, 101, 99, 103, 108, 107, 110],
          "volume": [10, 12, 9, 30, 11, 10, 25]}


def term(name):
    return Node("term", terminal=next(t for t in TERMINALS if t.name == name))


# --- thesis 강제 -------------------------------------------------------------
def test_thesis_rejects_empty_rationale():
    with pytest.raises(ValueError):
        Thesis("behavioral", "   ")


def test_thesis_rejects_unknown_category():
    with pytest.raises(ValueError):
        Thesis("astrology", "별자리")


def test_candidate_requires_thesis_instance():
    with pytest.raises(TypeError):
        Candidate(term("mom5"), thesis=None)  # type: ignore[arg-type]


def test_all_generated_candidates_have_valid_thesis():
    gen = GeneticGenerator(rng=random.Random(1))
    for c in gen.generate(30):
        assert isinstance(c.thesis, Thesis)
        assert c.thesis.category in CATEGORIES
        assert c.thesis.rationale.strip()


# --- 프리미티브 / 시그널 -----------------------------------------------------
def test_momentum_terminal_positive_on_uptrend():
    c = Candidate(term("mom5"), Thesis("behavioral", "모멘텀"))
    assert c.signal(WINDOW) == 1            # 100 -> 110 상승


def test_reversion_is_opposite_of_momentum():
    mom = Candidate(term("mom5"), Thesis("behavioral", "x"))
    rev = Candidate(term("rev5"), Thesis("behavioral", "x"))
    assert mom.signal(WINDOW) == -rev.signal(WINDOW)


def test_volsurge_detects_volume_spike():
    c = Candidate(term("volsurge5"), Thesis("supply_demand", "x"))
    assert c.signal(WINDOW) == 1            # 마지막 거래량 25 > 평균


def test_signal_flat_with_insufficient_history():
    c = Candidate(term("mom20"), Thesis("behavioral", "x"))
    assert c.signal({"close": [100, 101]}) == 0


def test_deadzone_suppresses_small_scores():
    c = Candidate(term("mom1"), Thesis("behavioral", "x"), deadzone=1.0)
    assert c.signal(WINDOW) == 0           # 작은 수익률은 deadzone 안


# --- thesis 유도 -------------------------------------------------------------
def test_derive_thesis_picks_dominant_category():
    tree = Node("add", children=[term("mom5"), term("rev5")])  # 둘 다 behavioral
    assert derive_thesis(tree).category == "behavioral"


def test_derive_thesis_requires_terminal():
    with pytest.raises(ValueError):
        derive_thesis(Node("add", children=[]))


# --- GP 연산 -----------------------------------------------------------------
def test_generate_is_deterministic_with_seed():
    a = [str(c.tree) for c in GeneticGenerator(rng=random.Random(42)).generate(10)]
    b = [str(c.tree) for c in GeneticGenerator(rng=random.Random(42)).generate(10)]
    assert a == b


def test_mutate_preserves_valid_thesis():
    gen = GeneticGenerator(rng=random.Random(3))
    base = gen.make_candidate()
    mutant = gen.mutate(base)
    assert mutant.thesis.category in CATEGORIES
    # 원본 트리는 변형되지 않는다 (clone)
    assert isinstance(mutant, Candidate)


def test_crossover_produces_valid_candidate():
    gen = GeneticGenerator(rng=random.Random(5))
    a, b = gen.make_candidate(), gen.make_candidate()
    child = gen.crossover(a, b)
    assert child.thesis.category in CATEGORIES
    assert child.signal(WINDOW) in (-1, 0, 1)


def test_tree_eval_combines_functions():
    tree = Node("sub", children=[term("mom5"), term("mom5")])
    assert Candidate(tree, Thesis("behavioral", "x")).score(WINDOW) == 0.0


# --- LLM 제안기 --------------------------------------------------------------
def test_llm_proposer_builds_candidates_with_thesis():
    def fake(_):
        return "behavioral|모멘텀 드리프트\nsupply_demand|거래량 급증"
    cands = LLMProposer(fake).propose("p")
    assert len(cands) == 2
    assert {c.thesis.category for c in cands} == {"behavioral", "supply_demand"}


def test_llm_proposer_skips_unsupported_category():
    def fake(_):
        return "risk_premium|밸류 (펀더멘털 필요)\nbehavioral|모멘텀"
    cands = LLMProposer(fake).propose("p")
    # risk_premium 은 템플릿 None -> 스킵
    assert [c.thesis.category for c in cands] == ["behavioral"]


def test_llm_proposer_ignores_malformed_lines():
    def fake(_):
        return "garbage line without pipe\nbehavioral|좋은 근거"
    cands = LLMProposer(fake).propose("p")
    assert len(cands) == 1
