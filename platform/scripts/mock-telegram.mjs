// Local stand-in for api.telegram.org used by the e2e run: `node scripts/mock-telegram.mjs 3199`. Never talks to the network.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3199);
createServer((req, res) => {
  req.resume();
  req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"result":{}}'));
}).listen(port, "127.0.0.1", () => console.log(`mock telegram on ${port}`));
