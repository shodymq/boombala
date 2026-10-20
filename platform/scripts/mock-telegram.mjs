// Local stand-in for api.telegram.org used by tests: `node scripts/mock-telegram.mjs 3199`. Never talks to the network.
// Prints the first lines of every message it receives (test data only), so a run can be checked by reading its output.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3199);
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      console.log("telegram<-", JSON.stringify(String(JSON.parse(body).text ?? "").split("\n").slice(0, 3)));
    } catch {
      /* not JSON: ignore */
    }
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"result":{}}');
  });
}).listen(port, "127.0.0.1", () => console.log(`mock telegram on ${port}`));
