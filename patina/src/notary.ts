// 시간 공증. 블록체인을 쓰는 이유는 딱 하나: "이 관계/등록이 그 시각에 이미 있었다"를
// 나중에 날짜를 바꿔 끼울 수 없게 하는 것. 체인에는 32바이트 머클루트만 올라간다 (규칙 12).

import type { Clock } from "./time.js";
import { hex, sha256, sha256Raw, type Bytes } from "./crypto.js";

// ---------------------------------------------------------------- 머클 트리

const LEAF_TAG = Buffer.from([0x00]);
const NODE_TAG = Buffer.from([0x01]);

export function leafHash(data: Bytes): Buffer {
  return sha256Raw(LEAF_TAG, data);
}

function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256Raw(NODE_TAG, left, right);
}

export interface MerkleStep {
  readonly sibling: string;
  /** 형제가 오른쪽이면 true. */
  readonly right: boolean;
}

/** 각 층. 홀수 개면 마지막 노드를 복제하지 않고 그대로 올린다 (복제식 트리의 위조 취약점 회피). */
function levels(leaves: readonly Bytes[]): Buffer[][] {
  if (leaves.length === 0) throw new RangeError("빈 트리");
  const out: Buffer[][] = [leaves.map(leafHash)];
  while (out[out.length - 1]!.length > 1) {
    const cur = out[out.length - 1]!;
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? nodeHash(cur[i]!, cur[i + 1]!) : cur[i]!);
    }
    out.push(next);
  }
  return out;
}

export function merkleRoot(leaves: readonly Bytes[]): Buffer {
  const lv = levels(leaves);
  return lv[lv.length - 1]![0]!;
}

export function merklePath(leaves: readonly Bytes[], index: number): MerkleStep[] {
  const lv = levels(leaves);
  const path: MerkleStep[] = [];
  let i = index;
  for (let d = 0; d < lv.length - 1; d++) {
    const layer = lv[d]!;
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    if (sib < layer.length) path.push({ sibling: hex(layer[sib]!), right: i % 2 === 0 });
    i = Math.floor(i / 2);
  }
  return path;
}

export function verifyMerklePath(leaf: Bytes, path: readonly MerkleStep[], root: string): boolean {
  let h = leafHash(leaf);
  for (const step of path) {
    const s = Buffer.from(step.sibling, "hex");
    h = step.right ? nodeHash(h, s) : nodeHash(s, h);
  }
  return hex(h) === root;
}

// ---------------------------------------------------------------- 체인

export interface ChainReceipt {
  readonly txRef: string;
  readonly root: string;
  /** 체인이 매긴 시각. 공증의 근거는 이 값 하나다. */
  readonly timestamp: number;
}

/** v2 실연동 대상: L2(예: Base) 에 하루 한 번 머클루트 기록. 받는 건 32바이트 루트뿐이다. */
export interface ChainNotary {
  publish(root: Bytes): Promise<ChainReceipt>;
  lookup(txRef: string): ChainReceipt | undefined;
}

export class InMemoryChain implements ChainNotary {
  readonly #clock: Clock;
  readonly #receipts = new Map<string, ChainReceipt>();
  /** 체인에 실제로 올라간 페이로드 기록 (규칙 12 검증용). */
  readonly payloads: Buffer[] = [];

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async publish(root: Bytes): Promise<ChainReceipt> {
    if (root.length !== 32) throw new RangeError("체인에는 32바이트 머클루트만 올린다");
    this.payloads.push(Buffer.from(root));
    const receipt: ChainReceipt = {
      txRef: hex(sha256("patina/mock-tx", this.#receipts.size, root)),
      root: hex(root),
      timestamp: this.#clock.now(),
    };
    this.#receipts.set(receipt.txRef, receipt);
    return receipt;
  }

  lookup(txRef: string): ChainReceipt | undefined {
    return this.#receipts.get(txRef);
  }
}

// ---------------------------------------------------------------- 공증인

export interface InclusionProof {
  readonly leaf: string;
  readonly path: readonly MerkleStep[];
  readonly root: string;
  readonly txRef: string;
  /** 주장하는 공증 시각. 검증 때 체인 기록과 대조한다. */
  readonly anchoredAt: number;
}

/** 잎을 모았다가 flush 때 루트 하나로 체인에 올린다. 잎의 시각 = 체인 시각 (주장값이 아니다). */
export class TimeNotary {
  readonly #chain: ChainNotary;
  #pending: Buffer[] = [];
  readonly #proofs = new Map<string, InclusionProof>();

  constructor(chain: ChainNotary) {
    this.#chain = chain;
  }

  submit(leaf: Bytes): void {
    const key = hex(leaf);
    if (this.#proofs.has(key) || this.#pending.some((p) => hex(p) === key)) throw new Error("이미 제출된 잎");
    this.#pending.push(Buffer.from(leaf));
  }

  async flush(): Promise<ChainReceipt | null> {
    if (this.#pending.length === 0) return null;
    const leaves = this.#pending;
    this.#pending = [];
    const receipt = await this.#chain.publish(merkleRoot(leaves));
    leaves.forEach((leaf, i) => {
      this.#proofs.set(hex(leaf), {
        leaf: hex(leaf),
        path: merklePath(leaves, i),
        root: receipt.root,
        txRef: receipt.txRef,
        anchoredAt: receipt.timestamp,
      });
    });
    return receipt;
  }

  /** 공증된 시각. 아직 flush 전이면 undefined (= 나이 0 으로 취급). */
  anchoredAt(leaf: Bytes): number | undefined {
    return this.#proofs.get(hex(leaf))?.anchoredAt;
  }

  proof(leaf: Bytes): InclusionProof | undefined {
    return this.#proofs.get(hex(leaf));
  }
}

/** 머클 경로 + 체인 기록(루트·시각) 둘 다 맞아야 통과. 시각을 바꿔 끼우면 체인 기록과 어긋난다. */
export function verifyInclusion(proof: InclusionProof, chain: Pick<ChainNotary, "lookup">): boolean {
  const receipt = chain.lookup(proof.txRef);
  if (!receipt) return false;
  if (receipt.root !== proof.root || receipt.timestamp !== proof.anchoredAt) return false;
  return verifyMerklePath(Buffer.from(proof.leaf, "hex"), proof.path, proof.root);
}
