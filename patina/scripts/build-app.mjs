// 앱 번들: esbuild 로 브라우저용 하나짜리 스크립트를 만든다.
//   app/dist/web/index.html, app.js, manifest, icon  ← npm run app 의 서버가 서빙 (실서버 API 사용)
//   app/dist/web/demo.html                           ← 서버 없이 브라우저 안에서 서비스까지 도는 데모 (파일 하나)
//   app/dist/artifact.html                           ← 같은 데모를 문서 골격 없이 (claude.ai 아티팩트 게시용)

import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const css = await readFile(at("app/client/styles.css"), "utf8");
const template = await readFile(at("app/client/index.html"), "utf8");
const fonts =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hahmlet:wght@600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+KR:wght@400;500;600&display=swap">';

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  inject: [at("app/client/buffer-shim.ts")],
};

await mkdir(at("app/dist/web"), { recursive: true });

// 1) 실서버용 웹앱
await build({ ...common, entryPoints: [at("app/web.ts")], outfile: at("app/dist/web/app.js") });
await writeFile(at("app/dist/web/index.html"), template.replace("/*STYLES*/", css));
await copyFile(at("app/client/manifest.webmanifest"), at("app/dist/web/manifest.webmanifest"));
await copyFile(at("app/client/icon.svg"), at("app/dist/web/icon.svg"));

// 2) 브라우저 안 데모 (스크립트를 페이지에 그대로 넣는다)
const demo = await build({ ...common, entryPoints: [at("app/standalone.ts")], write: false });
const js = demo.outputFiles[0].text.replaceAll("</script", "<\\/script");
const body = `<div id="app"></div>\n<script>${js}</script>\n`;
await writeFile(
  at("app/dist/web/demo.html"),
  `<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<title>Patina 데모</title>\n${fonts}\n<style>${css}</style>\n</head>\n<body>\n${body}</body>\n</html>\n`,
);
await writeFile(
  at("app/dist/artifact.html"),
  `<title>Patina 앱</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${fonts}\n<style>${css}</style>\n${body}`,
);

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)}KB`;
console.log(`앱 빌드 완료: app/dist/web (데모 스크립트 ${kb(js)})`);
