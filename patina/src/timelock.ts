// 타임락 봉인. 실제 tlock(drand IBE)은 "라운드 r 의 비콘 서명 = 복호화 키" 라서
// 라운드가 오기 전엔 작성자·받는 사람·운영자 누구도 열 수 없다.

import type { Beacon } from "./beacon.js";
import { aeadOpen, aeadSeal, hmac, systemRandom, type Bytes, type RandomSource } from "./crypto.js";

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

/**
 * IBE 없이 tlock 의미론을 흉내 내는 목업.
 * - 봉인: 라운드별 키 HMAC(master, round) 로 AES-GCM. (실제 tlock 의 "공개키로 미래 라운드에 암호화"에 해당)
 * - 해제: 비콘이 그 라운드를 공개했을 때만 진행. (실제 tlock 은 이 조건이 암호학적으로 강제된다)
 * master 는 drand 네트워크의 임계 키를 대신하는 값이라 이 객체 밖으로 나가지 않는다.
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

  async seal(plaintext: Bytes, round: number): Promise<SealedBox> {
    if (!Number.isSafeInteger(round) || round < 1) throw new RangeError("잘못된 라운드");
    return { round, ciphertext: aeadSeal(this.#roundKey(round), plaintext, this.#rng) };
  }

  async open(box: SealedBox): Promise<Buffer> {
    await this.#beacon.randomness(box.round); // 라운드 전이면 여기서 BeaconNotReadyError
    return aeadOpen(this.#roundKey(box.round), box.ciphertext);
  }

  #roundKey(round: number): Buffer {
    return hmac(this.#master, "patina/mock-tlock", round);
  }
}
