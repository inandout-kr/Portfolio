// 타임락 봉인. 실제 tlock(drand IBE)은 "라운드 r 의 비콘 서명 = 복호화 키" 라서
// 라운드가 오기 전엔 작성자·받는 사람·운영자 누구도 열 수 없다.

import type { Beacon } from "./beacon.js";
import {
  aeadOpen,
  aeadSeal,
  hkdfSha256,
  hmac,
  systemRandom,
  x25519PublicKey,
  x25519Shared,
  type Bytes,
  type RandomSource,
} from "./crypto.js";

export interface SealedBox {
  /** tlock 과 똑같이 해제 라운드는 평문 헤더다. 그래서 봉인 상자를 공개 저장하면 공개 시점이 샌다. */
  readonly round: number;
  readonly ciphertext: Buffer;
}

/** v2 실연동 대상: tlock-js (timelockEncrypt / timelockDecrypt). */
export interface Timelock {
  seal(plaintext: Bytes, round: number): Promise<SealedBox>;
  /** 라운드 전이면 BeaconNotReadyError. */
  open(box: SealedBox): Promise<Buffer>;
}

const ECIES_INFO = "patina/tlock-ecies";

function boxKey(shared: Bytes, ephemeralPublic: Bytes, roundPublic: Bytes): Buffer {
  return hkdfSha256(shared, Buffer.concat([Buffer.from(ephemeralPublic), Buffer.from(roundPublic)]), ECIES_INFO);
}

/**
 * 라운드 공개키만으로 봉인한다 (비밀값 불필요). 휴대폰 클라이언트가 이걸 직접 부른다.
 * 암호문 = 임시 공개키(32) | AES-GCM 상자. 실제 tlock 의 "공개 파라미터로 미래 라운드에 암호화"에 해당.
 */
export function sealToRoundKey(plaintext: Bytes, round: number, roundPublicKey: Bytes, rng: RandomSource = systemRandom): SealedBox {
  if (!Number.isSafeInteger(round) || round < 1) throw new RangeError("잘못된 라운드");
  if (roundPublicKey.length !== 32) throw new RangeError("라운드 공개키는 32바이트");
  const ephemeral = rng.bytes(32);
  const ephemeralPublic = x25519PublicKey(ephemeral);
  const key = boxKey(x25519Shared(ephemeral, roundPublicKey), ephemeralPublic, roundPublicKey);
  return { round, ciphertext: Buffer.concat([ephemeralPublic, aeadSeal(key, plaintext, rng)]) };
}

/**
 * IBE 없이 tlock 의미론을 흉내 내는 목업.
 * - 라운드마다 X25519 키쌍을 HMAC(master, round) 에서 만든다. 공개키는 누구에게나 준다 (roundPublicKey).
 * - 봉인은 공개키만으로 된다. 여는 개인키는 비콘이 그 라운드를 공개했을 때만 쓴다.
 * master 는 drand 네트워크의 임계 키를 대신하는 값이라 이 객체 밖으로 나가지 않는다.
 * (실제 tlock 은 "라운드 전엔 못 연다"가 암호학적으로 강제되고, 이 목업은 코드로 강제한다.)
 */
export class MockTimelock implements Timelock {
  readonly #beacon: Beacon;
  readonly #master: Buffer;
  readonly #rng: RandomSource;

  constructor(beacon: Beacon, master: Bytes, rng: RandomSource = systemRandom) {
    this.#beacon = beacon;
    this.#master = Buffer.from(master);
    this.#rng = rng;
  }

  roundPublicKey(round: number): Buffer {
    return x25519PublicKey(this.#roundSecret(round));
  }

  async seal(plaintext: Bytes, round: number): Promise<SealedBox> {
    return sealToRoundKey(plaintext, round, this.roundPublicKey(round), this.#rng);
  }

  async open(box: SealedBox): Promise<Buffer> {
    await this.#beacon.randomness(box.round); // 라운드 전이면 여기서 BeaconNotReadyError
    const ct = Buffer.from(box.ciphertext);
    if (ct.length < 32 + 12 + 16) throw new RangeError("봉인 상자가 너무 짧다");
    const ephemeralPublic = ct.subarray(0, 32);
    const secret = this.#roundSecret(box.round);
    const key = boxKey(x25519Shared(secret, ephemeralPublic), ephemeralPublic, x25519PublicKey(secret));
    return aeadOpen(key, ct.subarray(32));
  }

  #roundSecret(round: number): Buffer {
    return hmac(this.#master, "patina/mock-tlock", round);
  }
}
