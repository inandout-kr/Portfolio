// 화면 도우미: 요소 생성(텍스트는 항상 textContent), 아이콘, 식별 그림, QR, 시트, 토스트.

import qrcode from "qrcode-generator";
import { sha256 } from "../../src/crypto.js";

type Child = Node | string | number | false | null | undefined;
type Props = {
  class?: string;
  hidden?: boolean;
  [key: `on${string}`]: ((e: never) => void) | undefined;
} & Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "hidden") el.hidden = Boolean(v);
    else if (k === "value" && "value" in el) (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue;
    el.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: SVGElement[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}

// ---------------------------------------------------------------- 아이콘 (24px 선)

const ICONS = {
  connect: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 18.5V20M18.5 14H20",
  people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.7.8 2.8 2.6 3 5.2",
  shine: "M12 3l1.9 5.6L19.5 10.5 13.9 12.4 12 18l-1.9-5.6L4.5 10.5l5.6-1.9zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z",
  gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  scan: "M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M4 12h16",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12M18 6L6 18",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 22): SVGElement {
  return svg(
    "svg",
    { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
    svg("path", { d: ICONS[name] }),
  );
}

// ---------------------------------------------------------------- 식별 그림 (공개키에서 만든 5×5 대칭 무늬)

export function identicon(pub: string, size = 36): SVGElement {
  const d = sha256("patina/identicon", pub);
  const hue = Math.round((d.readUInt16BE(0) / 65535) * 360);
  const fg = `hsl(${hue} 42% 42%)`;
  const bg = `hsl(${hue} 30% 90%)`;
  const cells: SVGElement[] = [svg("rect", { width: 5, height: 5, rx: 1.1, fill: bg })];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (((d[2 + y * 3 + x] ?? 0) & 1) === 0) continue;
      for (const xx of x === 2 ? [2] : [x, 4 - x]) cells.push(svg("rect", { x: xx + 0.08, y: y + 0.08, width: 0.84, height: 0.84, rx: 0.15, fill: fg }));
    }
  }
  return svg("svg", { viewBox: "0 0 5 5", width: size, height: size, class: "identicon", "aria-hidden": "true" }, ...cells);
}

// ---------------------------------------------------------------- QR

/** 스캔이 잘 되도록 테마와 상관없이 흰 바탕에 검은 점. */
export function qrSvg(text: string, label: string): SVGElement {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
  const q = 3;
  return svg(
    "svg",
    { viewBox: `${-q} ${-q} ${n + 2 * q} ${n + 2 * q}`, class: "qr", role: "img", "aria-label": label, "shape-rendering": "crispEdges" },
    svg("rect", { x: -q, y: -q, width: n + 2 * q, height: n + 2 * q, fill: "#ffffff" }),
    svg("path", { d, fill: "#111611" }),
  );
}

// ---------------------------------------------------------------- 시트(아래에서 올라오는 창)와 토스트

export function openSheet(host: HTMLElement, title: string, body: Node, opts: { dismissible?: boolean } = {}): () => void {
  const dismissible = opts.dismissible ?? true;
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && dismissible) close();
  };
  const panel = h(
    "div",
    { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "sheet-head" }, h("h2", null, title), dismissible ? h("button", { class: "icon-btn", "aria-label": "닫기", onclick: close }, icon("close", 20)) : null),
    body,
  );
  const backdrop = h("div", { class: "backdrop", onclick: (e: MouseEvent) => dismissible && e.target === backdrop && close() }, panel);
  host.append(backdrop);
  document.addEventListener("keydown", onKey);
  panel.querySelector<HTMLElement>("input, textarea, button.primary")?.focus();
  return close;
}

export function toast(host: HTMLElement, message: string, kind: "info" | "error" = "info"): void {
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  while (host.children.length >= 3) host.firstElementChild!.remove();
  host.append(t);
  setTimeout(() => t.remove(), 3600);
}

// ---------------------------------------------------------------- 표기

export function shortId(pub: string): string {
  return `${pub.slice(0, 4)}…${pub.slice(-4)}`;
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 복사: 클립보드가 막혀 있으면 입력칸을 선택해서 직접 복사하게 한다. */
export async function copyText(text: string, fallback?: HTMLInputElement | HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    fallback?.select();
    return false;
  }
}
