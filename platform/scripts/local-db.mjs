// Local development database: `npm run db:local -- start|stop|status|url`.
// A private cluster in platform/.local-pg on port 54330 (does not touch other PostgreSQL servers).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initCluster, isRunning, startCluster, stopCluster } from "./lib/cluster.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".local-pg");
const data = join(root, "data");
const PORT = 54330;
const DB = "boombala_platform";
const url = `postgres://postgres@127.0.0.1:${PORT}/${DB}`;
const cmd = process.argv[2] ?? "status";

if (cmd === "start") {
  initCluster(data);
  if (!isRunning(data)) startCluster(data, PORT);
  try {
    execFileSync("createdb", ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", DB], { stdio: "ignore" });
  } catch {
    /* already exists */
  }
  console.log(`running. DATABASE_URL=${url}`);
} else if (cmd === "stop") {
  stopCluster(data);
  console.log("stopped");
} else if (cmd === "url") {
  console.log(url);
} else {
  console.log(isRunning(data) ? `running. DATABASE_URL=${url}` : "not running (npm run db:local -- start)");
}
