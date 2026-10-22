// Throwaway PostgreSQL cluster in its own directory and port. Never touches any other PostgreSQL on this machine.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// macOS: PostgreSQL refuses to start without a valid locale in the environment.
const ENV = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function initCluster(dir) {
  if (existsSync(join(dir, "PG_VERSION"))) return;
  mkdirSync(dir, { recursive: true });
  execFileSync("initdb", ["-D", dir, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale"], { stdio: "ignore", env: ENV });
}

export function startCluster(dir, port, { fast = false } = {}) {
  const socketDir = mkdtempSync(join(tmpdir(), "bbpg-sock-"));
  const opts = [`-p ${port}`, `-k ${socketDir}`, "-c listen_addresses=127.0.0.1", "-c max_connections=100"];
  // fsync off: only for disposable test clusters, never for real data.
  if (fast) opts.push("-c fsync=off", "-c synchronous_commit=off", "-c full_page_writes=off");
  execFileSync("pg_ctl", ["-D", dir, "-o", opts.join(" "), "-l", join(dir, "server.log"), "-w", "start"], { stdio: "ignore", env: ENV });
  return socketDir;
}

export function stopCluster(dir, socketDir) {
  spawnSync("pg_ctl", ["-D", dir, "-m", "fast", "-w", "stop"], { stdio: "ignore", env: ENV });
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
}

export function isRunning(dir) {
  return spawnSync("pg_ctl", ["-D", dir, "status"], { stdio: "ignore", env: ENV }).status === 0;
}
