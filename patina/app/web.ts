// 실서버에 붙는 휴대폰 웹앱 진입점 (npm run app 이 서빙하는 /app.js).
import { httpApi } from "./api.js";
import { browserStore } from "./client/patina-client.js";
import { startApp } from "./client/main.js";

void startApp(document.getElementById("app")!, httpApi(), { standalone: false, store: browserStore() });
