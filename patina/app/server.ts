// 운영자 노드 HTTP 서버. POST /api/<메서드> 로 PatinaApi 를 열고, 빌드된 웹앱을 정적으로 서빙한다.
//
//   npm run app            # 데모 모드 (가상 친구·시간 빨리 감기), http://localhost:8787
//   PORT=9000 npm run app
//   npm run app -- --real  # 데모 기능 끔
//
// 상태는 메모리에만 있다 (재시작하면 초기화). 영구 저장은 다음 단계.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { API_METHODS, ApiError, type ApiMethod, type PatinaApi } from "./api.js";
import { AppService } from "./service.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const MAX_BODY = 256 * 1024;

export function createPatinaServer(api: PatinaApi, staticDir?: string): Server {
  return createServer((req, res) => {
    handle(api, staticDir, req, res).catch((e: unknown) => {
      console.error("[patina] 요청 처리 실패", e);
      if (!res.headersSent) send(res, 500, { error: "internal", message: "서버 오류" });
    });
  });
}

async function handle(api: PatinaApi, staticDir: string | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const method = url.pathname.slice("/api/".length) as ApiMethod;
    if (req.method !== "POST" || !API_METHODS.includes(method)) return send(res, 404, { error: "not-found", message: "없는 API" });
    let params: unknown;
    try {
      params = JSON.parse((await readBody(req)) || "[]");
    } catch {
      return send(res, 400, { error: "bad-request", message: "JSON 이 아니에요" });
    }
    if (!Array.isArray(params)) return send(res, 400, { error: "bad-request", message: "인자는 배열이어야 해요" });
    try {
      const fn = api[method] as unknown as (...args: unknown[]) => Promise<unknown>;
      return send(res, 200, { result: (await fn.apply(api, params)) ?? null });
    } catch (e) {
      if (e instanceof ApiError) return send(res, 400, { error: e.code, message: e.message });
      if (e instanceof TypeError || e instanceof RangeError) return send(res, 400, { error: "bad-request", message: e.message });
      throw e;
    }
  }
  if (!staticDir || (req.method !== "GET" && req.method !== "HEAD")) return send(res, 404, { error: "not-found", message: "없는 경로" });
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "") || "index.html";
  if (rel.split(/[/\\]/).includes("..")) return send(res, 400, { error: "bad-request", message: "잘못된 경로" });
  try {
    const body = await readFile(join(staticDir, rel));
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    send(res, 404, { error: "not-found", message: "없는 파일 (npm run app:build 를 먼저 하세요)" });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("요청이 너무 커요"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------- 실행

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const demo = !process.argv.includes("--real");
  const port = Number(process.env.PORT ?? 8787);
  const service = new AppService({ demo });
  setInterval(() => void service.tick(), 2_000);
  const staticDir = fileURLToPath(new URL("../../app/dist/web/", import.meta.url));
  createPatinaServer(service, staticDir).listen(port, "0.0.0.0", () => {
    console.log(`Patina 운영자 노드 (${demo ? "데모 모드" : "실서버 모드"})`);
    console.log(`  이 컴퓨터:  http://localhost:${port}`);
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) console.log(`  같은 와이파이 폰: http://${a.address}:${port}`);
    }
    console.log("  (폰 카메라 QR 스캔은 https 에서만 됩니다. 코드 입력은 어디서나 됩니다.)");
  });
}
