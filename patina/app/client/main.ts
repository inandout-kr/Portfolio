// Patina 앱 화면. 메인(연결) 탭엔 내 코드·QR과 상대 코드 입력칸만, 나머지는 관계·평판·설정 탭으로.

import { DAY, MONTH, WEEK, YEAR } from "../../src/time.js";
import type { ReviewContent, Stance } from "../../src/messages.js";
import type { ProfileView, ReviewerTask } from "../../src/views.js";
import { codeFromScan, formatCode, normalizeCode, type AppInfo, type InviteView, type PatinaApi, type ScheduleView } from "../api.js";
import { PatinaClient, type Contact, type KeyValueStore } from "./patina-client.js";
import { copyText, fmtCountdown, fmtDate, h, icon, identicon, openSheet, qrSvg, shortId, toast, type IconName } from "./ui.js";

type Tab = "connect" | "people" | "rep" | "settings";
const TABS: readonly { id: Tab; label: string; icon: IconName }[] = [
  { id: "connect", label: "연결", icon: "connect" },
  { id: "people", label: "관계", icon: "people" },
  { id: "rep", label: "평판", icon: "shine" },
  { id: "settings", label: "설정", icon: "gear" },
];

const STANCES: readonly { id: Stance; label: string; placeholder: string }[] = [
  { id: "endorse", label: "믿어요", placeholder: "예: 약속 시간을 늘 지켜요" },
  { id: "neutral", label: "그저 그래요", placeholder: "예: 나쁘진 않은데 연락이 늦어요" },
  { id: "warn", label: "경고", placeholder: "예: 선입금을 받고 연락이 끊겼어요" },
];

export interface StartOptions {
  /** 브라우저 안에서 서비스까지 도는 데모 (새로고침하면 초기화). */
  readonly standalone: boolean;
  readonly store: KeyValueStore;
  readonly reload?: () => void;
}

export async function startApp(root: HTMLElement, api: PatinaApi, opts: StartOptions): Promise<void> {
  root.replaceChildren(h("div", { class: "boot" }, "Patina 여는 중…"));
  let client: PatinaClient;
  try {
    client = await PatinaClient.open(api, opts.store);
  } catch (e) {
    root.replaceChildren(h("div", { class: "boot" }, `서버에 연결할 수 없어요. ${message(e)}`));
    return;
  }
  await new App(root, api, client, opts).start();
}

function message(e: unknown): string {
  if (e instanceof TypeError && /fetch/i.test(e.message)) return "서버에 연결할 수 없어요";
  return e instanceof Error ? e.message : String(e);
}

class App {
  info!: AppInfo;
  tab: Tab = "connect";
  myInvite: InviteView | null = null;
  joining: { code: string; digits: string } | null = null;
  tasks: ReviewerTask[] = [];
  myProfile: ProfileView | null = null;
  readonly schedules = new Map<string, ScheduleView>();
  readonly #handledCodes = new Set<string>();
  #confirmOpenFor: string | null = null;
  #polling = false;

  readonly api: PatinaApi;
  readonly client: PatinaClient;
  readonly opts: StartOptions;
  readonly root: HTMLElement;
  readonly layer = h("div");
  readonly toasts = h("div", { class: "toasts" });
  readonly views = {} as Record<Tab, HTMLElement>;
  readonly tabButtons = {} as Record<Tab, HTMLButtonElement>;
  readonly demoChip = h("span", { class: "chip demo", hidden: true });
  // 연결 탭에서 다시 그리지 않고 값만 바꾸는 부분
  readonly qrBox = h("div");
  readonly codeText = h("div", { class: "bigcode", "aria-live": "polite" });
  readonly ttlText = h("span");
  readonly joinInput = h("input", { id: "join-code", class: "input code", placeholder: "ABC-DEF", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: 7, "aria-label": "상대 코드" });
  readonly joinStatus = h("div");

  constructor(root: HTMLElement, api: PatinaApi, client: PatinaClient, opts: StartOptions) {
    this.root = root;
    this.api = api;
    this.client = client;
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.info = await this.api.info();
    this.#build();
    const join = new URLSearchParams(location.search).get("join");
    if (join) {
      this.joinInput.value = formatCode(join);
      try {
        history.replaceState(null, "", location.pathname);
      } catch {
        /* 주소를 못 바꾸는 환경 */
      }
    }
    if (this.client.serverWasReset) this.say("서버가 다시 시작돼서 이 기기의 관계 목록을 비웠어요");
    await this.newInvite();
    this.show("connect");
    await this.poll();
    setInterval(() => void this.poll(), 2000);
  }

  say(text: string, kind: "info" | "error" = "info"): void {
    toast(this.toasts, text, kind);
  }

  async attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      this.say(message(e), "error");
      return undefined;
    }
  }

  // ============================================================ 뼈대

  #build(): void {
    const me = this.client.pub;
    const top = h(
      "header",
      { class: "topbar" },
      identicon(me, 36),
      h("div", { class: "who" }, h("b", null, "Patina"), h("span", { class: "mono" }, shortId(me))),
      h("div", { class: "spacer" }),
      this.demoChip,
    );
    const main = h("main");
    for (const t of TABS) {
      const v = h("section", { "aria-label": t.label, hidden: true });
      this.views[t.id] = v;
      main.append(v);
    }
    this.views.connect.append(this.#buildConnect());
    const tabs = h("nav", { class: "tabbar", "aria-label": "탭" }, h("div", { class: "inner", role: "tablist" }));
    for (const t of TABS) {
      const b = h("button", { class: "tab", role: "tab", "aria-selected": "false", onclick: () => this.show(t.id) }, icon(t.icon), t.label);
      this.tabButtons[t.id] = b;
      tabs.firstElementChild!.append(b);
    }
    this.root.replaceChildren(h("div", { class: "app" }, top, main), tabs, this.layer, this.toasts);
    this.#updateHeader();
  }

  show(tab: Tab): void {
    this.tab = tab;
    for (const t of TABS) {
      this.views[t.id].hidden = t.id !== tab;
      this.tabButtons[t.id].setAttribute("aria-selected", String(t.id === tab));
    }
    this.#render();
    if (tab === "rep" || tab === "people") void this.poll();
  }

  #render(): void {
    if (this.tab === "connect") this.#updateConnect();
    if (this.tab === "people") this.#renderPeople();
    if (this.tab === "rep") this.#renderRep();
    if (this.tab === "settings") this.#renderSettings();
    this.#updateHeader();
  }

  #estChip(): HTMLElement {
    const est = this.client.estAt;
    return h("span", { class: "chip est" }, est === null ? "Est. 확인 중" : `Est. ${fmtDate(est)}`);
  }

  #updateHeader(): void {
    this.demoChip.hidden = !this.info.demo;
    this.demoChip.textContent = `데모 · ${fmtDate(this.info.now)}`;
    const actionable = this.tasks.some((t) => t.kind === "reaffirm") || this.client.contacts().some((c) => !this.client.slotOf(c.id));
    const badge = this.tabButtons.people.querySelector(".badge");
    if (actionable && !badge) this.tabButtons.people.append(h("span", { class: "badge", "aria-label": "할 일 있음" }));
    if (!actionable) badge?.remove();
  }

  // ============================================================ 주기적 새로고침

  async poll(): Promise<void> {
    if (this.#polling || document.visibilityState === "hidden") return;
    this.#polling = true;
    try {
      this.info = await this.api.info();
      if (this.client.estAt === null) this.client.estAt = (await this.api.registerAccount(this.client.pub)).anchoredAt;
      await this.#checkMyInvite();
      await this.#checkJoining();
      this.tasks = await this.client.refresh();
      for (const c of this.client.contacts()) {
        if (c.anchoredAt === null) c.anchoredAt = (await this.api.relationship(c.id))?.anchoredAt ?? null;
        const slot = this.client.slotOf(c.id);
        if (slot && !this.schedules.has(slot.slotId)) {
          const s = await this.api.schedule(slot.slotId);
          if (s) this.schedules.set(slot.slotId, s);
        }
      }
      if (this.tab === "rep") this.myProfile = await this.api.profile(this.client.pub);
      if (this.tab !== "settings") this.#render();
      else this.#updateHeader();
    } catch (e) {
      console.warn("[patina] 새로고침 실패", e);
    } finally {
      this.#polling = false;
    }
  }

  // ============================================================ 연결 (메인)

  #buildConnect(): HTMLElement {
    const standaloneNote = this.opts.standalone
      ? h("div", { class: "banner" }, "브라우저 안에서 도는 데모예요. 설정 탭에서 가상 친구를 부르고 시간을 빨리 감아 보세요. 새로고침하면 처음부터 시작해요.")
      : null;
    const myCard = h(
      "div",
      { class: "card mycode" },
      h("div", { class: "card-label" }, "내 코드 · 만난 사람에게 이 화면을 보여주세요"),
      this.qrBox,
      h(
        "div",
        { class: "row" },
        this.codeText,
        h("button", { class: "icon-btn", "aria-label": "코드 복사", onclick: () => void this.#copyCode() }, icon("copy", 20)),
      ),
      h(
        "div",
        { class: "ttl" },
        icon("clock", 15),
        this.ttlText,
        h("button", { class: "link-btn", onclick: () => void this.attempt(() => this.newInvite()) }, "새 코드"),
      ),
    );
    const canScan = !this.opts.standalone && "BarcodeDetector" in globalThis && Boolean(navigator.mediaDevices?.getUserMedia) && isSecureContext;
    const joinCard = h(
      "form",
      { class: "card stack", onsubmit: (e: SubmitEvent) => (e.preventDefault(), void this.join(this.joinInput.value)) },
      h("div", { class: "field" }, h("label", { for: "join-code" }, "상대 코드 입력"), h("div", { class: "row" }, this.joinInput, h("button", { class: "btn primary", type: "submit" }, "연결"))),
      canScan ? h("button", { class: "btn ghost block", type: "button", onclick: () => void this.#scan() }, icon("scan", 20), "QR 스캔") : null,
      this.joinStatus,
      this.info.demo
        ? h(
            "div",
            { class: "demo-row" },
            h("button", { class: "link-btn", type: "button", onclick: () => void this.attempt(() => this.#botCode()) }, "가상 친구 코드 받기"),
            h("button", { class: "link-btn", type: "button", onclick: () => void this.attempt(() => this.#botJoinsMe()) }, "가상 친구가 내 코드 입력"),
          )
        : null,
    );
    return h(
      "div",
      { class: "stack" },
      standaloneNote,
      myCard,
      joinCard,
      h("p", { class: "hint", style: "text-align:center" }, "관계는 두 사람이 서로 서명해야 생겨요. 서버에는 해시와 시각만 남아요."),
    );
  }

  #updateConnect(): void {
    const inv = this.myInvite;
    if (inv) {
      const link = this.opts.standalone ? inv.code : `${location.origin}${location.pathname}?join=${inv.code}`;
      if (this.qrBox.dataset.code !== inv.code) {
        this.qrBox.replaceChildren(qrSvg(link, `내 코드 ${formatCode(inv.code)} QR`));
        this.qrBox.dataset.code = inv.code;
      }
      this.codeText.textContent = formatCode(inv.code);
      this.ttlText.textContent = `${fmtCountdown(inv.expiresAt - this.info.now)} 뒤 만료`;
    }
    if (this.joining) {
      this.joinStatus.replaceChildren(
        h(
          "div",
          { class: "verify" },
          h("span", { class: "hint" }, "확인 숫자"),
          h("span", { class: "digits" }, this.joining.digits),
          h("span", { class: "hint" }, "상대 화면에 같은 숫자가 떠 있는지 확인하세요"),
          h("span", { class: "waiting" }, h("i", { class: "dot-pulse" }), "상대가 승인하길 기다리는 중"),
        ),
      );
    } else this.joinStatus.replaceChildren();
  }

  async newInvite(): Promise<void> {
    this.myInvite = await this.client.createInvite();
    this.#updateConnect();
  }

  async #copyCode(): Promise<void> {
    if (!this.myInvite) return;
    this.say((await copyText(formatCode(this.myInvite.code))) ? "코드를 복사했어요" : "복사가 막혀 있어요. 코드를 직접 불러 주세요");
  }

  async join(raw: string): Promise<void> {
    const code = normalizeCode(raw);
    if (code.length !== 6) return this.say("코드는 6자예요 (예: ABC-DEF)", "error");
    const r = await this.attempt(() => this.client.acceptInvite(code));
    if (!r) return;
    this.joinInput.value = "";
    this.joining = { code: r.view.code, digits: r.digits };
    this.#updateConnect();
    if (r.view.status === "done") await this.#finishJoin(r.view);
  }

  async #checkJoining(): Promise<void> {
    if (!this.joining) return;
    let view: InviteView;
    try {
      view = await this.api.getInvite(this.joining.code);
    } catch {
      this.joining = null;
      return this.say("상대가 거절했거나 코드가 바뀌었어요", "error");
    }
    if (view.status === "done") await this.#finishJoin(view);
    else if (view.status === "failed" || view.status === "expired") {
      this.joining = null;
      this.say(view.error ?? "시간이 지나 연결이 취소됐어요", "error");
    }
  }

  /** 같은 완료를 join() 과 주기 새로고침이 동시에 볼 수 있어서, 표시는 기다리기 전에 건다. */
  #claim(code: string): boolean {
    if (this.#handledCodes.has(code)) return false;
    this.#handledCodes.add(code);
    return true;
  }

  async #finishJoin(view: InviteView): Promise<void> {
    this.joining = null;
    this.#updateConnect();
    if (!this.#claim(view.code)) return;
    const c = await this.client.remember(view);
    if (c) this.#nameSheet(c);
  }

  async #checkMyInvite(): Promise<void> {
    const inv = this.myInvite;
    if (!inv) return;
    const view = await this.api.getInvite(inv.code).catch(() => null);
    if (!view || view.status === "expired") return this.newInvite();
    this.myInvite = view;
    if (view.status === "accepted" && this.#confirmOpenFor !== view.code) this.#confirmSheet(view);
    if (view.status === "done") {
      if (this.#claim(view.code)) {
        const c = await this.client.remember(view);
        if (c) this.#nameSheet(c);
      }
      await this.newInvite();
    }
    if (view.status === "failed") {
      this.say(view.error ?? "연결하지 못했어요", "error");
      await this.newInvite();
    }
  }

  #confirmSheet(view: InviteView): void {
    this.#confirmOpenFor = view.code;
    const digits = this.client.digitsFor(view);
    let close = () => {};
    const done = () => {
      this.#confirmOpenFor = null;
      close();
    };
    const body = h(
      "div",
      { class: "stack" },
      h("div", { class: "row" }, identicon(view.acceptor!, 44), h("div", { class: "who" }, h("b", null, "상대 계정"), h("span", { class: "mono" }, shortId(view.acceptor!)))),
      h("div", { class: "verify" }, h("span", { class: "hint" }, "확인 숫자"), h("span", { class: "digits" }, digits), h("span", { class: "hint" }, "상대 화면의 숫자와 같을 때만 승인하세요")),
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn ghost grow", onclick: () => (done(), void this.attempt(() => this.newInvite())) }, "거절"),
        h(
          "button",
          {
            class: "btn primary grow",
            onclick: async () => {
              done();
              this.#claim(view.code);
              const r = await this.attempt(() => this.client.confirmInvite(view));
              if (r?.status === "failed") this.say(r.error ?? "연결하지 못했어요", "error");
              if (r?.status === "done") {
                const c = this.client.contacts().find((x) => x.id === r.relationshipId);
                if (c) this.#nameSheet(c);
              }
              await this.attempt(() => this.newInvite());
            },
          },
          "승인",
        ),
      ),
    );
    close = openSheet(this.layer, "연결 요청", body, { dismissible: false });
  }

  #nameSheet(c: Contact): void {
    const input = h("input", { id: "nickname", class: "input", value: c.nickname, maxlength: 30 });
    let close = () => {};
    const save = (e?: Event) => {
      e?.preventDefault();
      this.client.rename(c.id, input.value);
      close();
      this.say("연결됐어요. 관계 탭에서 볼 수 있어요");
      this.#render();
    };
    close = openSheet(
      this.layer,
      "연결됐어요",
      h(
        "form",
        { class: "stack", onsubmit: save },
        h("div", { class: "row" }, identicon(c.other, 44), h("p", { class: "hint grow" }, "이 사람을 뭐라고 부를까요? 이름은 이 기기에만 저장되고 서버로 가지 않아요.")),
        h("div", { class: "field" }, h("label", { for: "nickname" }, "이름"), input),
        h("button", { class: "btn primary block", type: "submit" }, "저장"),
      ),
    );
  }

  async #scan(): Promise<void> {
    type Detector = { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> };
    const Ctor = (globalThis as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch {
      return this.say("카메라를 쓸 수 없어요. 코드를 직접 입력해 주세요", "error");
    }
    const video = h("video", { playsinline: true, muted: true });
    video.srcObject = stream;
    let alive = true;
    const close = openSheet(this.layer, "QR 스캔", h("div", { class: "scanner stack" }, video, h("p", { class: "hint" }, "상대 화면의 QR을 비춰 주세요")));
    const stop = () => {
      alive = false;
      stream.getTracks().forEach((t) => t.stop());
    };
    const observer = new MutationObserver(() => {
      if (!video.isConnected) {
        stop();
        observer.disconnect();
      }
    });
    observer.observe(this.layer, { childList: true });
    await video.play().catch(() => {});
    const detector = new Ctor({ formats: ["qr_code"] });
    while (alive) {
      const found = await detector.detect(video).catch(() => []);
      if (found[0]) {
        stop();
        close();
        await this.join(codeFromScan(found[0].rawValue));
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async #botCode(): Promise<void> {
    const inv = await this.api.demoBotInvite();
    this.joinInput.value = formatCode(inv.code);
    this.joinInput.focus();
    this.say("가상 친구의 코드를 넣었어요. 연결을 눌러 보세요");
  }

  async #botJoinsMe(): Promise<void> {
    if (!this.myInvite) return;
    await this.api.demoBotJoin(this.myInvite.code);
    await this.#checkMyInvite();
  }

  // ============================================================ 관계

  #statusOf(c: Contact): { label: string; kind: "action" | "done" | "" } {
    const slot = this.client.slotOf(c.id);
    if (!slot) return { label: "평가 쓰기", kind: "action" };
    const task = this.tasks.find((t) => t.slotId === slot.slotId);
    if (task?.kind === "reaffirm") return { label: "재확인 요청", kind: "action" };
    if (task?.kind === "edit") return { label: "고칠 수 있음", kind: "action" };
    if (slot.record.sealedRound === undefined) return { label: "봉인 준비 중", kind: "" };
    const s = this.schedules.get(slot.slotId);
    if (s && this.info.now >= s.revealAt) return { label: "공개됨", kind: "done" };
    return { label: "봉인됨", kind: "" };
  }

  #age(c: Contact): string {
    if (c.anchoredAt === null) return "방금 연결";
    const days = Math.floor((this.info.now - c.anchoredAt) / DAY);
    const mature = this.info.now - c.anchoredAt >= this.info.minRelationshipAge;
    const left = Math.ceil((this.info.minRelationshipAge - (this.info.now - c.anchoredAt)) / DAY);
    return `D+${days} · ${mature ? "오래된 관계" : `${left}일 뒤 오래된 관계`}`;
  }

  #renderPeople(): void {
    const contacts = this.client.contacts();
    const slotOwner = new Map<string, Contact>();
    for (const c of contacts) {
      const s = this.client.slotOf(c.id);
      if (s) slotOwner.set(s.slotId, c);
    }
    const reaffirms = this.tasks.filter((t): t is Extract<ReviewerTask, { kind: "reaffirm" }> => t.kind === "reaffirm");
    const taskCards = reaffirms.map((t) => {
      const c = slotOwner.get(t.slotId);
      const mine = c ? this.client.slotOf(c.id)?.record.content : undefined;
      return h(
        "div",
        { class: "card flat task" },
        h("b", null, `재확인 · ${c?.nickname ?? "관계"}`),
        h("span", null, `${t.label} 전에 남긴 지지예요. 아직도 같은 생각인가요?`),
        mine ? h("div", { class: "mine" }, `“${mine.text}”`) : null,
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn ghost small grow", onclick: () => (this.client.decline(t.slotId, t.checkpoint), void this.poll()) }, "아니요"),
          h(
            "button",
            {
              class: "btn primary small grow",
              onclick: async () => {
                await this.attempt(() => this.client.reaffirm(t.slotId, t.checkpoint));
                this.say("다시 서명했어요. 이 보증의 무게가 커져요");
                await this.poll();
              },
            },
            "다시 서명",
          ),
        ),
        h("span", { class: "hint" }, "답하지 않으면 기한이 지나 조용히 사라져요. 상대는 누가 그랬는지 알 수 없어요."),
      );
    });
    const list = contacts.length
      ? h(
          "ul",
          { class: "list" },
          ...contacts.map((c) => {
            const st = this.#statusOf(c);
            return h(
              "li",
              null,
              h(
                "button",
                { class: "item", onclick: () => void this.#contactSheet(c.id) },
                identicon(c.other, 40),
                h("span", { class: "meta" }, h("b", null, c.nickname), h("span", null, this.#age(c))),
                h("span", { class: `tag ${st.kind}` }, st.label),
              ),
            );
          }),
        )
      : h("p", { class: "empty" }, "아직 관계가 없어요. 연결 탭에서 만난 사람과 코드를 주고받으세요.");
    this.views.people.replaceChildren(
      h(
        "div",
        { class: "stack" },
        h("h1", { class: "section-title" }, "관계 ", h("span", { class: "hint" }, `${contacts.length}명`)),
        ...taskCards,
        h("div", { class: "card flat" }, list),
        h("p", { class: "hint" }, "평가는 관계마다 한 번씩 남길 수 있어요. 남긴 평가는 1주에서 3개월 사이 아무도 모르는 날짜에, 다른 평가와 섞여서 공개돼요."),
      ),
    );
  }

  async #contactSheet(id: string): Promise<void> {
    const c = this.client.contacts().find((x) => x.id === id);
    if (!c) return;
    const theirs = await this.attempt(() => this.api.profile(c.other));
    const nameInput = h("input", { id: "rename", class: "input", value: c.nickname, maxlength: 30 });
    const slot = this.client.slotOf(c.id);
    const editTask = slot && this.tasks.find((t) => t.kind === "edit" && t.slotId === slot.slotId);
    let close = () => {};
    const reviewPart = !slot
      ? this.#reviewForm(c, null, () => close())
      : editTask
        ? this.#reviewForm(c, { slotId: slot.slotId, content: slot.record.content }, () => close())
        : h(
            "div",
            { class: "stack" },
            h("div", { class: "card-label" }, "내가 남긴 평가 · 나만 볼 수 있어요"),
            h("div", { class: "mine" }, `${STANCES.find((s) => s.id === slot.record.content.stance)?.label} · “${slot.record.content.text}”`),
            h("p", { class: "hint" }, `${this.#statusOf(c).label}. 공개 날짜는 아무도 몰라요. 공개 48시간 전에 고칠 수 있는 창이 열려요.`),
          );
    close = openSheet(
      this.layer,
      c.nickname,
      h(
        "div",
        { class: "stack" },
        h("div", { class: "row" }, identicon(c.other, 44), h("div", { class: "who" }, h("b", { class: "mono" }, shortId(c.other)), h("span", null, this.#age(c)))),
        h(
          "form",
          {
            class: "row",
            onsubmit: (e: SubmitEvent) => {
              e.preventDefault();
              this.client.rename(c.id, nameInput.value);
              this.say("이름을 바꿨어요 (이 기기에만 저장)");
              this.#render();
            },
          },
          h("div", { class: "field grow" }, h("label", { for: "rename" }, "이름 (이 기기에만)"), nameInput),
          h("button", { class: "btn small", type: "submit", style: "align-self:end" }, "저장"),
        ),
        theirs ? h("div", { class: "card flat stack" }, h("div", { class: "card-label" }, "이 사람의 평판"), this.#curve(theirs), this.#stats(theirs)) : null,
        reviewPart,
      ),
    );
  }

  #reviewForm(c: Contact, editing: { slotId: string; content: ReviewContent } | null, close: () => void): HTMLElement {
    let stance: Stance = editing?.content.stance ?? "endorse";
    const text = h("textarea", { id: "review-text", class: "textarea", maxlength: 200, placeholder: STANCES[0]!.placeholder });
    text.value = editing?.content.text ?? "";
    const warnNote = h("li", { hidden: stance !== "warn" }, "경고는 서로 다른 세 사람이 각자 써야 공개돼요. 혼자 쓴 경고는 어디에도 보이지 않아요.");
    const buttons = STANCES.map((s) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(s.id === stance),
          onclick: () => {
            stance = s.id;
            buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(STANCES[i]!.id === s.id)));
            text.placeholder = s.placeholder;
            warnNote.hidden = s.id !== "warn";
          },
        },
        s.label,
      ),
    );
    const young = c.anchoredAt === null || this.info.now - c.anchoredAt < this.info.minRelationshipAge;
    return h(
      "form",
      {
        class: "stack",
        onsubmit: async (e: SubmitEvent) => {
          e.preventDefault();
          const content: ReviewContent = { stance, text: text.value.trim() };
          if (!content.text) return this.say("한 줄이라도 써 주세요", "error");
          const submit = (e.currentTarget as HTMLFormElement).querySelector<HTMLButtonElement>("button[type=submit]")!;
          submit.disabled = true;
          submit.textContent = editing ? "고치는 중…" : "봉인하는 중… (공개 시점을 뽑고 있어요)";
          const ok = await this.attempt(async () => {
            if (editing) await this.client.edit(editing.slotId, content);
            else await this.client.startReview(c.id, content, { waitMs: 20_000 });
            return true;
          });
          if (!ok) {
            submit.disabled = false;
            submit.textContent = editing ? "고치기" : "봉인하기";
            return;
          }
          close();
          this.say(editing ? "고쳤어요. 공개되는 건 마지막으로 고친 내용이에요" : "봉인했어요. 공개 날짜는 아무도 몰라요");
          await this.poll();
        },
      },
      h("div", { class: "card-label" }, editing ? "공개 전 48시간 · 지금 고칠 수 있어요" : "평가 남기기"),
      h("div", { class: "seg", role: "group", "aria-label": "평가 종류" }, ...buttons),
      h("div", { class: "field" }, h("label", { for: "review-text" }, "한 줄 평"), text),
      h(
        "ul",
        { class: "notes" },
        editing ? null : h("li", null, "1주에서 3개월 사이, 아무도 모르는 날짜에 공개돼요"),
        h("li", null, "공개 전 48시간 동안 몇 번이든 고칠 수 있고, 고쳤는지는 아무도 몰라요"),
        editing ? null : h("li", null, "관계마다 한 번만 남길 수 있고, 취소할 수 없어요"),
        warnNote,
        !editing && young ? h("li", null, "아직 30일이 안 된 관계라, 이 평가는 묶음을 여는 숫자에 들어가지 않아요") : null,
      ),
      h("button", { class: "btn primary block", type: "submit" }, editing ? "고치기" : "봉인하기"),
    );
  }

  // ============================================================ 평판

  #curve(v: ProfileView): HTMLElement {
    return h(
      "div",
      { class: "curve" },
      ...v.curve.map((p) =>
        h(
          "div",
          { class: "curve-row" },
          h("span", null, p.label),
          h("span", { class: "bar" }, h("i", { style: `width:${p.rate === null ? 0 : Math.round(p.rate * 100)}%` })),
          h("span", { class: "v" }, p.rate === null ? `- (n=0)` : `${Math.round(p.rate * 100)}% (n=${p.total})`),
        ),
      ),
    );
  }

  #stats(v: ProfileView): HTMLElement {
    const warned = v.warnings.reduce((s, w) => s + w.length, 0);
    return h("div", { class: "stats" }, h("span", null, `공개 묶음 ${v.batches.length}`), h("span", null, `집계 ${v.aggregates.length}`), h("span", null, `공개 경고 ${warned}`));
  }

  #renderRep(): void {
    const v = this.myProfile;
    if (!v) {
      this.views.rep.replaceChildren(h("p", { class: "empty" }, "불러오는 중…"));
      return;
    }
    const empty = v.batches.length === 0 && v.aggregates.length === 0 && v.warnings.length === 0;
    const label = (s: string) => (s === "endorse" ? "지지" : "중립");
    this.views.rep.replaceChildren(
      h(
        "div",
        { class: "stack" },
        h("h1", { class: "section-title" }, "내 평판"),
        h(
          "div",
          { class: "card stack" },
          h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "card-label" }, "점수"), h("div", { class: "score" }, v.score.toFixed(2))), this.#estChip()),
          Math.abs(v.score) < 0.01 ? h("p", { class: "hint" }, "점수는 시간이 재료라 처음 1년은 0 근처예요. 오래 알고 지낸 사람이 1년 뒤에도 다시 서명하면 그때부터 커져요.") : null,
          h("div", { class: "card-label" }, "아직 믿는 사람의 비율"),
          this.#curve(v),
          this.#stats(v),
        ),
        empty
          ? h("p", { class: "empty" }, "아직 공개된 평가가 없어요. 오래 알고 지낸 사람 4명의 평가가 모이면 섞여서 한꺼번에 열려요. 몇 개가 기다리는지는 나를 포함해 아무도 볼 수 없어요.")
          : h(
              "div",
              { class: "card flat stack" },
              h("div", { class: "card-label" }, "공개된 평가 · 섞여서 도착, 작성자와 날짜 없음"),
              ...[...v.batches]
                .map((b, i) => ({ b, i }))
                .reverse()
                .map(({ b, i }) =>
                  h("div", { class: "letters" }, h("div", { class: "batch-head" }, `묶음 ${i + 1} · ${b.length}개`), ...b.map((item) => h("div", { class: "letter" }, h("small", null, label(item.stance)), item.text))),
                ),
              ...v.aggregates.map((a) => h("p", { class: "hint" }, `집계만 공개: 지지 ${a.endorse} · 중립 ${a.neutral} (6개월 넘게 묶음이 안 차서 원문은 버렸어요)`)),
              ...v.warnings.map((w) => h("div", { class: "letters" }, h("div", { class: "batch-head" }, `공개된 경고 · ${w.length}건`), ...w.map((t) => h("div", { class: "letter" }, h("small", null, "경고"), t)))),
            ),
        h("p", { class: "hint" }, "점수와 비율은 묶음이 열릴 때와 한 달에 한 번만 바뀌어요. 그래서 누가 언제 무엇을 썼는지 점수 변화로도 알 수 없어요."),
      ),
    );
  }

  // ============================================================ 설정

  #renderSettings(): void {
    const me = this.client.pub;
    const secretBox = h("div", { hidden: true, class: "stack" });
    const showSecret = () => {
      const area = h("textarea", { class: "textarea secret", readonly: true, rows: 3 });
      area.value = this.client.exportSeed();
      secretBox.replaceChildren(
        area,
        h("button", { class: "btn small", onclick: async () => this.say((await copyText(area.value, area)) ? "복사했어요" : "선택해 뒀어요. 직접 복사해 주세요") }, icon("copy", 18), "복사"),
        h("p", { class: "hint" }, "이 문자열이 있으면 누구나 이 계정으로 서명할 수 있어요. 안전한 곳에만 보관하세요."),
      );
      secretBox.hidden = false;
    };
    const restoreArea = h("textarea", { id: "restore", class: "textarea secret", rows: 3, placeholder: "64자리 백업 문자열" });
    const demoBtn = (label: string, ms: number) =>
      h(
        "button",
        {
          class: "btn small",
          onclick: async (e: MouseEvent) => {
            const btns = (e.currentTarget as HTMLElement).parentElement!.querySelectorAll("button");
            btns.forEach((b) => (b.disabled = true));
            await this.attempt(() => this.client.sealPending(10_000));
            const r = await this.attempt(() => this.api.demoAdvance(ms));
            btns.forEach((b) => (b.disabled = false));
            if (r) this.say(`${fmtDate(r.now)}로 감았어요`);
            await this.poll();
            this.#renderSettings();
          },
        },
        label,
      );
    this.views.settings.replaceChildren(
      h(
        "div",
        { class: "stack" },
        h("h1", { class: "section-title" }, "설정"),
        h(
          "div",
          { class: "card flat stack" },
          h("div", { class: "row" }, identicon(me, 48), h("div", { class: "who" }, h("b", null, "내 계정"), h("span", null, this.client.estAt === null ? "Est. 확인 중" : `Est. ${fmtDate(this.client.estAt)} · 가입일은 바꿀 수 없어요`))),
          h("div", { class: "mono", style: "font-size:.78rem; color: var(--ink-2)" }, me),
        ),
        h(
          "div",
          { class: "card flat stack" },
          h("div", { class: "card-label" }, "키 백업"),
          h("p", { class: "hint" }, this.opts.standalone ? "데모라서 키가 이 탭에만 있어요. 새로고침하면 사라져요." : "키는 이 기기에만 있어요. 폰을 바꾸거나 잃어버리면 백업 문자열로만 되살릴 수 있어요."),
          h("button", { class: "btn small", onclick: showSecret }, "백업 문자열 보기"),
          secretBox,
        ),
        this.opts.standalone
          ? null
          : h(
              "form",
              {
                class: "card flat stack",
                onsubmit: async (e: SubmitEvent) => {
                  e.preventDefault();
                  const seed = restoreArea.value.trim().toLowerCase();
                  const ok = await this.attempt(() => PatinaClient.open(this.api, this.opts.store, seed));
                  if (ok) (this.opts.reload ?? (() => location.reload()))();
                },
              },
              h("div", { class: "field" }, h("label", { for: "restore" }, "백업으로 되살리기 (지금 키를 바꿔요)"), restoreArea),
              h("button", { class: "btn small", type: "submit" }, "이 키로 바꾸기"),
            ),
        this.info.demo
          ? h(
              "div",
              { class: "card flat stack" },
              h("div", { class: "card-label" }, `데모 · 지금 ${fmtDate(this.info.now)}`),
              h("p", { class: "hint" }, "시간을 빨리 감아서 봉인 해제, 묶음 공개, 1년 재확인까지 직접 볼 수 있어요."),
              h("div", { class: "row wrap" }, demoBtn("+1일", DAY), demoBtn("+1주", WEEK), demoBtn("+1개월", MONTH), demoBtn("+6개월", 6 * MONTH), demoBtn("+1년", YEAR)),
              h(
                "button",
                {
                  class: "btn small",
                  onclick: async () => {
                    const n = await this.attempt(() => this.#connectBots(4));
                    if (n) this.say(`가상 친구 ${n}명과 연결했어요. 시간을 감으면 평가를 써 줘요`);
                    await this.poll();
                  },
                },
                "가상 친구 4명과 연결",
              ),
              h("p", { class: "hint" }, "가상 친구는 35~60일 겪어본 뒤 평가를 쓰고, 공개 전 수정 창에서 위장 수정을 하고, 1년 뒤 85% 확률로 다시 서명해요."),
            )
          : null,
        h("p", { class: "hint" }, "Patina MVP · 서버에는 해시, 시각, 봉인된 평가만 가요. 이름과 내가 쓴 평가 원문은 이 기기에만 있어요."),
      ),
    );
  }

  async #connectBots(n: number): Promise<number> {
    let count = 0;
    for (let i = 0; i < n; i++) {
      const inv = await this.api.demoBotInvite();
      const { view } = await this.client.acceptInvite(inv.code);
      const c = await this.client.remember(view);
      if (c) {
        this.client.rename(c.id, `가상 친구 ${this.client.contacts().length}`);
        count += 1;
      }
    }
    return count;
  }
}
