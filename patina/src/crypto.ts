// 암호 유틸: 도메인 분리 해시, Ed25519 서명, X25519, AES-GCM, 결정적 난수.
// 서버(Node)와 휴대폰 브라우저가 같은 코드를 돌리도록 순수 JS 감사 라이브러리(noble)만 쓴다.
// 브라우저 번들에서는 Buffer 폴리필을 주입한다 (app/client/buffer-shim.ts).

import { gcm } from "@noble/ciphers/aes.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac as nobleHmac } from "@noble/hashes/hmac.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

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
  return Buffer.from(nobleSha256(encodeParts(...parts)));
}

/** 인코딩 없이 바이트를 이어 붙여 해시한다 (머클 트리처럼 형식이 고정된 곳 전용). */
export function sha256Raw(...chunks: Bytes[]): Buffer {
  return Buffer.from(nobleSha256(Buffer.concat(chunks.map((c) => Buffer.from(c)))));
}

export function hmac(key: Bytes, ...parts: Part[]): Buffer {
  return Buffer.from(nobleHmac(nobleSha256, key, encodeParts(...parts)));
}

export function hex(b: Bytes): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(s: string): Buffer {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new TypeError("hex 문자열이 아니다");
  return Buffer.from(s, "hex");
}

// ---------------------------------------------------------------- Ed25519 (서명)

export interface KeyPair {
  /** 원시 공개키 hex. 이게 곧 가명(pseudonym)이다. */
  readonly publicKey: string;
  /** 32바이트 시드. 사용자 기기 밖으로 나가지 않는다. */
  readonly secretKey: Uint8Array;
}

export function keyPairFromSeed(seed: Bytes): KeyPair {
  if (seed.length !== 32) throw new RangeError("Ed25519 시드는 32바이트");
  const secretKey = Uint8Array.from(seed);
  return { publicKey: hex(ed25519.getPublicKey(secretKey)), secretKey };
}

export function generateKeyPair(rng: RandomSource = systemRandom): KeyPair {
  return keyPairFromSeed(rng.bytes(32));
}

export function signMessage(keys: KeyPair, message: Bytes): string {
  return hex(ed25519.sign(message, keys.secretKey));
}

export function verifyMessage(publicKey: string, message: Bytes, signature: string): boolean {
  try {
    return ed25519.verify(fromHex(signature), message, fromHex(publicKey));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- X25519 + HKDF (타임락 봉인용)

export function x25519PublicKey(secret: Bytes): Buffer {
  return Buffer.from(x25519.getPublicKey(secret));
}

export function x25519Shared(secret: Bytes, publicKey: Bytes): Buffer {
  return Buffer.from(x25519.getSharedSecret(secret, publicKey));
}

export function hkdfSha256(ikm: Bytes, salt: Bytes, info: string, length = 32): Buffer {
  return Buffer.from(hkdf(nobleSha256, ikm, salt, Buffer.from(info, "utf8"), length));
}

// ---------------------------------------------------------------- 난수

export interface RandomSource {
  bytes(n: number): Buffer;
}

export const systemRandom: RandomSource = { bytes: (n) => Buffer.from(randomBytes(n)) };

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

/** iv(12) | 암호문 | 태그(16). */
export function aeadSeal(key: Bytes, plaintext: Bytes, rng: RandomSource): Buffer {
  const iv = rng.bytes(12);
  return Buffer.concat([iv, Buffer.from(gcm(key, iv).encrypt(plaintext))]);
}

/** 인증 실패면 예외. */
export function aeadOpen(key: Bytes, box: Bytes): Buffer {
  const b = Buffer.from(box);
  return Buffer.from(gcm(key, b.subarray(0, 12)).decrypt(b.subarray(12)));
}
