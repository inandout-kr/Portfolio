// 서버 없이 브라우저 하나에서 운영자 서비스까지 통째로 도는 데모 진입점.
// 서버와 똑같이 JSON 을 거쳐 부르므로 여기서 되는 흐름은 실서버에서도 된다.
import { localApi } from "./api.js";
import { memoryStore } from "./client/patina-client.js";
import { startApp } from "./client/main.js";
import { AppService } from "./service.js";

const service = new AppService({ demo: true });
setInterval(() => void service.tick(), 1500);
void startApp(document.getElementById("app")!, localApi(service), {
  standalone: true,
  store: memoryStore(),
  reload: () => location.reload(),
});
