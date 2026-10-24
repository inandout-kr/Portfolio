// 암호 유틸: 도메인 분리 해시, Ed25519 서명, AEAD, 결정적 난수.
// 외부 의존 없이 node:crypto 만 쓴다.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export type Bytes = Uint8Array;
export type Part = Bytes | string | number;

/**
 * 길이 접두 인코딩. ("ab","c") 와 ("a","bc") 가 같은 바이트열이 되는 모호성을 막는다.
 * 숫자는 10진 문자열로 넣는다 (메시지마다 필드 위치가 고정이라 타입 혼동은 없다).
 */
export function encodeParts(...parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const b = typeof p === "string" || typeof p === "number" ? Buffer.from(String(p), "utf8") : Buffer.from(p);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    chunks.push(len, b);
  }
  return Buffer.concat(chunks);
}

export function sha256(...parts: Part[]): Buffer {
  return createHash("sha256").update(encodeParts(...parts)).digest();
}

export function hmac(key: Bytes, ...parts: Part[]): Buffer {
  return createHmac("sha256", key).update(encodeParts(...parts)).digest();
}

export function hex(b: Bytes): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(s: string): Buffer {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new TypeError("hex 문자열이 아니다");
  return Buffer.from(s, "hex");
}

// ---------------------------------------------------------------- Ed25519

// 원시 32바이트 키 <-> DER 변환용 고정 접두사 (RFC 8410).
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface KeyPair {
  /** 원시 공개키 hex. 이게 곧 가명(pseudonym)이다. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

export function keyPairFromSeed(seed: Bytes): KeyPair {
  if (seed.length !== 32) throw new RangeError("Ed25519 시드는 32바이트");
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { publicKey: hex(spki.subarray(spki.length - 32)), privateKey };
}

export function generateKeyPair(rng: RandomSource = systemRandom): KeyPair {
  return keyPairFromSeed(rng.bytes(32));
}

export function signMessage(keys: KeyPair, message: Bytes): string {
  return hex(sign(null, message, keys.privateKey));
}

export function verifyMessage(publicKey: string, message: Bytes, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, fromHex(publicKey)]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, fromHex(signature));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 난수

export interface RandomSource {
  bytes(n: number): Buffer;
}

export const systemRandom: RandomSource = { bytes: (n) => randomBytes(n) };

/** 시드 고정 난수 (SHA-256 카운터 모드). 테스트·시뮬레이션 재현용이지 비밀 생성용이 아니다. */
export class SeededRandom implements RandomSource {
  readonly #seed: Buffer;
  #counter = 0;

  constructor(seed: string | Bytes) {
    this.#seed = Buffer.from(typeof seed === "string" ? sha256("seed", seed) : seed);
  }

  bytes(n: number): Buffer {
    const out: Buffer[] = [];
    let have = 0;
    while (have < n) {
      const block = sha256(this.#seed, this.#counter++);
      out.push(block);
      have += block.length;
    }
    return Buffer.concat(out).subarray(0, n);
  }
}

/** [0, maxExclusive) 균등 정수. 48비트 거부 샘플링이라 편향이 없다. */
export function randomInt(rng: RandomSource, maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 48) {
    throw new RangeError("maxExclusive 는 1..2^48");
  }
  const limit = Math.floor(2 ** 48 / maxExclusive) * maxExclusive;
  for (;;) {
    const x = rng.bytes(6).readUIntBE(0, 6);
    if (x < limit) return x % maxExclusive;
  }
}

export function randomFloat(rng: RandomSource): number {
  return rng.bytes(6).readUIntBE(0, 6) / 2 ** 48;
}

/** Fisher–Yates. 원본은 건드리지 않는다. */
export function shuffle<T>(items: readonly T[], rng: RandomSource): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---------------------------------------------------------------- AEAD (AES-256-GCM)

export function aeadSeal(key: Bytes, plaintext: Bytes, rng: RandomSource): Buffer {
  const iv = rng.bytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function aeadOpen(key: Bytes, box: Bytes): Buffer {
  const b = Buffer.from(box);
  const decipher = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]);
}
