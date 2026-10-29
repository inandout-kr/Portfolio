// 앱 ↔ 운영자 노드 계약. 휴대폰 앱은 이 인터페이스만 본다.
// 전송은 두 가지: HttpApi (진짜 서버), LocalApi (브라우저 안에서 도는 데모 서비스).
// 둘 다 JSON 직렬화를 거치므로 데모에서 되는 건 서버에서도 된다.

import type { ReviewRegistration } from "../src/membership.js";
import type { RelationshipOpening } from "../src/messages.js";
import type { ProfileView, ReviewerTask } from "../src/views.js";

export interface AppInfo {
  readonly demo: boolean;
  /** 서버 시각 (데모면 빨리 감긴 시각). */
  readonly now: number;
  readonly batchSize: number;
  readonly warningThreshold: number;
  readonly minDelay: number;
  readonly maxDelay: number;
  readonly editWindow: number;
  readonly minRelationshipAge: number;
  readonly maxTextLength: number;
}

export type InviteStatus = "open" | "accepted" | "done" | "expired" | "failed";

/** 초대코드 하나의 상태. 코드를 아는 사람(만난 두 사람)만 조회할 수 있다. */
export interface InviteView {
  readonly code: string;
  readonly inviter: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly status: InviteStatus;
  readonly acceptor?: string;
  readonly relationshipId?: string;
  readonly error?: string;
}

export interface ScheduleView {
  readonly revealRound: number;
  readonly revealAt: number;
  readonly editOpensAt: number;
}

export interface SealedSubmission {
  readonly slotId: string;
  readonly round: number;
  /** base64 */
  readonly ciphertext: string;
  readonly signature: string;
}

export interface PatinaApi {
  info(): Promise<AppInfo>;
  /** 이미 있으면 그대로. 계정 생성 시각(공증)은 첫 등록 시각이다. */
  registerAccount(pub: string): Promise<{ readonly anchoredAt: number | null }>;
  createInvite(req: { pub: string; nonce: string; signature: string }): Promise<InviteView>;
  getInvite(code: string): Promise<InviteView>;
  /** 초대받은 쪽이 commitment 에 서명해서 낸다. */
  acceptInvite(code: string, req: { pub: string; signature: string }): Promise<InviteView>;
  /** 초대한 쪽이 확인 숫자를 맞춰본 뒤 서명해서 관계를 만든다. */
  confirmInvite(code: string, req: { signature: string }): Promise<InviteView>;
  relationship(id: string): Promise<{ readonly id: string; readonly anchoredAt: number | null } | null>;
  registerReview(reg: ReviewRegistration): Promise<{ readonly slotId: string }>;
  schedule(slotId: string): Promise<ScheduleView | null>;
  /** 라운드 공개키(hex). 이것만으로 봉인할 수 있다. */
  roundKey(round: number): Promise<string>;
  submitSealed(sub: SealedSubmission): Promise<{ readonly ok: true }>;
  tasks(slotIds: readonly string[]): Promise<ReviewerTask[]>;
  reaffirm(req: { slotId: string; checkpoint: number; signature: string }): Promise<{ readonly ok: true }>;
  profile(pub: string): Promise<ProfileView>;

  // 데모 모드 전용 (실서버에선 "demo-only" 오류)
  demoAdvance(ms: number): Promise<{ readonly now: number }>;
  /** 가상 친구가 초대코드를 만든다. 내가 그 코드를 입력하면 친구가 바로 승인한다. */
  demoBotInvite(): Promise<InviteView>;
  /** 가상 친구가 내 코드를 입력한다. 내가 확인 숫자를 보고 승인하면 연결된다. */
  demoBotJoin(code: string): Promise<InviteView>;
}

export type ApiMethod = keyof PatinaApi;

export const API_METHODS: readonly ApiMethod[] = [
  "info",
  "registerAccount",
  "createInvite",
  "getInvite",
  "acceptInvite",
  "confirmInvite",
  "relationship",
  "registerReview",
  "schedule",
  "roundKey",
  "submitSealed",
  "tasks",
  "reaffirm",
  "profile",
  "demoAdvance",
  "demoBotInvite",
  "demoBotJoin",
];

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type AnyFn = (...args: unknown[]) => Promise<unknown>;

/** 메서드 이름 + 인자 배열 하나로 모든 호출을 실어 나르는 얇은 RPC. */
function rpcProxy(call: (method: ApiMethod, params: unknown[]) => Promise<unknown>): PatinaApi {
  const api: Partial<Record<ApiMethod, AnyFn>> = {};
  for (const m of API_METHODS) api[m] = (...params: unknown[]) => call(m, params);
  return api as unknown as PatinaApi;
}

export function httpApi(base = ""): PatinaApi {
  return rpcProxy(async (method, params) => {
    const res = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string; message?: string };
    if (!res.ok) throw new ApiError(body.error ?? "network", body.message ?? `서버 오류 (${res.status})`);
    return body.result;
  });
}

/** 같은 프로세스의 서비스를 부르되, 서버와 똑같이 JSON 을 한 번 거친다. */
export function localApi(service: PatinaApi): PatinaApi {
  return rpcProxy(async (method, params) => {
    const args = JSON.parse(JSON.stringify(params)) as unknown[];
    const fn = service[method] as unknown as AnyFn;
    const result = await fn.apply(service, args);
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  });
}

/** 초대코드 표기: 혼동되는 글자(0 O 1 I L)를 뺀 6자, 가운데 하이픈. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

/** 링크(…?join=ABCDEF)나 코드 문자열 어느 쪽이 와도 코드만 뽑는다. */
export function codeFromScan(text: string): string {
  const m = /[?&#]join=([0-9A-Za-z-]+)/.exec(text);
  return normalizeCode(m ? m[1]! : text);
}

export type { RelationshipOpening, ReviewRegistration, ProfileView, ReviewerTask };
