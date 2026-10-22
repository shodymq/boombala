import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { profileProblems } from "../src/server/exposure.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const KZ = join(REPO, "deploy/kz");

const DEPLOY_ENV = `
ADMIN_HOST=panel.example.test
API_HOST=api.example.test
PUBLIC_SITE_HOST=www.example.test
PUBLIC_IP=198.51.100.10
PUBLIC_IF=eth0
WG_SERVER_ADDR=10.77.0.1
WG_SUBNET=10.77.0.0/24
WG_PORT=51820
ADMIN_PORT=3100
API_PORT=3101
DB_NAME=boombala
`;

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const read = (p: string) => readFileSync(p, "utf8");
const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

describe("Kazakhstan deployment files", () => {
  let tmp: string;
  let out: string;
  const r = (rel: string) => read(join(out, rel));

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "bbdeploy-"));
    writeFileSync(join(tmp, "deploy.env"), DEPLOY_ENV);
    out = join(tmp, "out");
    execFileSync("bash", [join(KZ, "scripts/render.sh"), join(tmp, "deploy.env"), out], { stdio: "pipe" });
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  describe("rendering", () => {
    it("fills every non-secret placeholder and refuses an incomplete deploy.env", () => {
      for (const f of walk(out)) {
        const left = (read(f).match(/@[A-Z_]+@/g) ?? []).filter((p) => !/(PASSWORD|_TOKEN|_KEY|_SECRET|PEPPER|TELEGRAM_CHAT_ID)@$/.test(p));
        assert.deepEqual(left, [], relative(out, f));
      }
      writeFileSync(join(tmp, "bad.env"), DEPLOY_ENV.replace("ADMIN_HOST=panel.example.test\n", ""));
      const res = spawnSync("bash", [join(KZ, "scripts/render.sh"), join(tmp, "bad.env"), join(tmp, "out2")], { encoding: "utf8" });
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /missing ADMIN_HOST/);
    });
  });

  describe("nginx: the admin", () => {
    it("listens only on the VPN address, with TLS only, and denies every other source", () => {
      const c = r("nginx/admin.conf");
      const listens = [...c.matchAll(/^\s*listen\s+([^;]+);/gm)].map((m) => m[1].trim());
      assert.ok(listens.length >= 2);
      for (const l of listens) assert.match(l, /^10\.77\.0\.1:443 ssl/, l);
      assert.ok(!/listen\s+(443|80|\[::\]|0\.0\.0\.0|198\.51\.100\.10)/.test(c), "never on a public address, never on :80");
      assert.match(c, /allow 10\.77\.0\.0\/24;\s*\n\s*deny all;/);
      assert.match(c, /server_name panel\.example\.test;/);
      assert.match(c, /ssl_reject_handshake on;/, "an unknown name gets no certificate");
      assert.match(c, /Strict-Transport-Security/);
      assert.match(c, /X-Robots-Tag "noindex/);
    });
    it("proxies to loopback only and never exposes the worker, intake or public reads", () => {
      const c = r("nginx/admin.conf");
      const passes = [...c.matchAll(/proxy_pass\s+([^;]+);/g)].map((m) => m[1]);
      assert.deepEqual(passes, ["http://127.0.0.1:3100"]);
      for (const p of ["/api/cron/", "/api/intake/", "/api/public/"]) assert.match(c, new RegExp(`location ${p.replace(/\//g, "\\/")} \\{ return 404; \\}`));
    });
  });

  describe("nginx: the public API", () => {
    it("exposes only health, public reads and intake; everything else is 404; no login, no admin", () => {
      const all = r("nginx/api.conf");
      const c = all.split(/\n(?=server \{)/).find((b) => b.includes("http2 on")) as string; // the TLS block of the API host
      const locs = [...c.matchAll(/^\s*location\s+(=\s+)?(\S+)\s*\{/gm)].map((m) => (m[1] ? "= " : "") + m[2]);
      assert.deepEqual(locs, ["= /api/health", "/api/public/", "/api/intake/", "/"]);
      assert.match(c, /location \/ \{ return 404; \}/);
      for (const bad of ["login", "contacts", "export", "media", "cron", "users"]) assert.ok(!new RegExp(`location[^\\n]*${bad}`).test(c), bad);
    });
    it("listens on the public address only, rate-limits, caps the body, allows one CORS origin", () => {
      const c = r("nginx/api.conf");
      for (const m of c.matchAll(/^\s*listen\s+([^;]+);/gm)) assert.match(m[1], /^198\.51\.100\.10:(80|443)/, m[1]);
      assert.match(c, /limit_req zone=bb_health/);
      assert.match(c, /limit_req zone=bb_server/);
      assert.match(c, /client_max_body_size 8k;/);
      assert.match(c, /"https:\/\/www\.example\.test" \$http_origin;/);
      assert.ok(!/Access-Control-Allow-Origin\s+\*/.test(c), "no wildcard CORS");
      assert.match(c, /ssl_reject_handshake on;/);
      assert.match(c, /limit_except POST \{ deny all; \}/);
    });
  });

  describe("nginx: the shared proxy settings", () => {
    it("write the client identity themselves and throw away what the visitor sent", () => {
      const c = r("nginx/bb-proxy.conf");
      assert.match(c, /proxy_set_header X-Real-IP \$remote_addr;/);
      assert.match(c, /proxy_set_header X-Forwarded-For \$remote_addr;/, "overwrite, never append");
      assert.ok(!/\$proxy_add_x_forwarded_for/.test(c));
      for (const h of ["X-Forwarded-Host", "Forwarded", "X-Vercel-Forwarded-For", "X-Vercel-Trusted-Oidc-Idp-Token"]) assert.match(c, new RegExp(`proxy_set_header ${h} "";`), h);
      assert.match(c, /proxy_set_header Host \$host;/);
    });
  });

  describe("firewall", () => {
    it("drops by default; opens WireGuard, the public web ports on the public interface, and SSH/admin/DNS from VPN addresses only", () => {
      const c = r("nftables/boombala.nft");
      assert.match(c, /chain input \{[^}]*policy drop;/s);
      assert.match(c, /chain forward \{[^}]*policy drop;/s);
      const accepts = lines(c).filter((l) => /\baccept\b/.test(l));
      assert.ok(accepts.includes("udp dport 51820 accept"));
      assert.ok(accepts.includes('iifname "eth0" tcp dport { 80, 443 } accept'));
      assert.ok(accepts.includes('iifname "wg0" ip saddr @vpn_net tcp dport { 22, 443 } accept'));
      for (const l of accepts) assert.ok(!/(5432|3100|3101)/.test(l), `no rule may open the database or an application port: ${l}`);
      assert.ok(!accepts.some((l) => /^tcp dport/.test(l)), "no rule opens a TCP port on every interface");
      assert.ok(!/ip_forward|masquerade|dnat/i.test(c), "no forwarding, no NAT");
    });
  });

  describe("PostgreSQL", () => {
    it("listens on loopback only, uses SCRAM, never logs parameters, and the access file rejects everything else", () => {
      const conf = read(join(KZ, "postgres/postgresql.conf.snippet"));
      assert.match(conf, /^listen_addresses = '127\.0\.0\.1'$/m);
      assert.match(conf, /^password_encryption = scram-sha-256$/m);
      assert.match(conf, /^log_parameter_max_length = 0$/m);
      assert.match(conf, /^log_statement = 'none'$/m);
      const hba = lines(r("postgres/pg_hba.conf"));
      const rules = hba.map((l) => l.split(/\s+/));
      for (const [type, , user, addr, method] of rules) {
        if (type === "host" && method !== "reject") {
          assert.ok(["bb_api", "bb_admin", "bb_owner"].includes(user), user);
          assert.equal(addr, "127.0.0.1/32");
          assert.equal(method, "scram-sha-256");
        }
        assert.notEqual(method, "trust");
        assert.notEqual(method, "md5");
      }
      assert.ok(hba.includes("host     all        all         0.0.0.0/0        reject".replace(/\s+/g, " ")) || hba.some((l) => /^host\s+all\s+all\s+0\.0\.0\.0\/0\s+reject$/.test(l)));
      assert.ok(hba.some((l) => /^host\s+all\s+all\s+::\/0\s+reject$/.test(l)));
    });
  });

  describe("systemd", () => {
    it("runs the two applications as different users with different env files, on loopback, hardened", () => {
      const admin = r("systemd/bb-admin.service");
      const api = r("systemd/bb-api.service");
      assert.match(admin, /^User=bbadmin$/m);
      assert.match(api, /^User=bbapi$/m);
      assert.match(admin, /^EnvironmentFile=\/etc\/boombala\/admin\.env$/m);
      assert.match(api, /^EnvironmentFile=\/etc\/boombala\/api\.env$/m);
      assert.match(admin, /-p 3100 -H 127\.0\.0\.1/);
      assert.match(api, /-p 3101 -H 127\.0\.0\.1/);
      for (const u of [admin, api]) {
        for (const d of ["NoNewPrivileges=true", "ProtectSystem=strict", "ProtectHome=true", "PrivateTmp=true", "CapabilityBoundingSet="]) assert.ok(u.includes(d), d);
        assert.ok(!/^Environment=.*(SECRET|TOKEN|KEY|PASSWORD)/mi.test(u), "no secret in the unit file");
      }
    });
    it("the retry worker talks to loopback with the headers the admin expects, not through nginx", () => {
      const s = r("systemd/bb-outbox.service");
      assert.match(s, /http:\/\/127\.0\.0\.1:3100\/api\/cron\/outbox/);
      assert.match(s, /-H "X-Real-IP: 127\.0\.0\.1"/);
      assert.match(s, /-H "Host: panel\.example\.test"/);
    });
  });

  describe("environment files", () => {
    const fill = (text: string) =>
      Object.fromEntries(
        text.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
          const i = l.indexOf("=");
          const v = l.slice(i + 1).replace(/@MFA_ENC_KEY@/, Buffer.alloc(32, 5).toString("base64")).replace(/@(PASSWORD|[A-Z_]*(TOKEN|SECRET|PEPPER))@|@[A-Z_]*(PASSWORD|TOKEN|SECRET|PEPPER)@/g, "x".repeat(32)).replace(/@TELEGRAM_CHAT_ID@/, "1");
          return [l.slice(0, i), v];
        }),
      ) as Record<string, string>;

    it("the admin example satisfies the production profile, and the API example does too", () => {
      const admin = fill(r("env/admin.env.example"));
      const api = fill(r("env/api.env.example"));
      assert.deepEqual(profileProblems(admin), []);
      assert.deepEqual(profileProblems(api), []);
      assert.equal(admin.MFA_MODE, "required");
      assert.equal(admin.TELEGRAM_NOTIFY_LEVEL, "minimal");
      assert.equal(api.PII_INTAKE_ENABLED, "0", "personal data stays off in the example");
    });
    it("secrets are separated by file: no variable appears as an assignment in both applications' files", () => {
      const admin = Object.keys(fill(r("env/admin.env.example")));
      const api = Object.keys(fill(r("env/api.env.example")));
      const secretish = (k: string) => /(TOKEN|SECRET|KEY|PEPPER|PASSWORD)/.test(k);
      const shared = admin.filter((k) => api.includes(k) && secretish(k));
      assert.deepEqual(shared, []);
      assert.notEqual(read(join(KZ, "env/admin.env.example")).match(/DATABASE_URL=.*/)?.[0].split("@DB_")[1], read(join(KZ, "env/api.env.example")).match(/DATABASE_URL=.*/)?.[0].split("@DB_")[1], "different database passwords");
      assert.match(read(join(KZ, "env/admin.env.example")), /DATABASE_URL=postgres:\/\/bb_admin:/);
      assert.match(read(join(KZ, "env/api.env.example")), /DATABASE_URL=postgres:\/\/bb_api:/);
    });
    it("the Vercel site environment carries no database, second-factor or admin settings", () => {
      const site = Object.keys(fill(read(join(KZ, "env/site.vercel.env.example"))));
      for (const k of site) assert.ok(!/^(DATABASE|MFA|CRON|TELEGRAM|ADMIN|ALLOWED|PLATFORM_ROLE|PLATFORM_PROFILE|PLATFORM_IP_PEPPER)/.test(k), k);
      assert.equal(fill(read(join(KZ, "env/site.vercel.env.example"))).LEAD_PIPELINE, "telegram-only");
      assert.equal(fill(read(join(KZ, "env/site.vercel.env.example"))).CONSENT_FORM_ENABLED, "0");
    });
  });

  describe("no secrets and no wrong domains in the repository", () => {
    it("the files hold placeholders only: no private key, no long random string, no real token", () => {
      for (const f of walk(KZ)) {
        const t = read(f);
        assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t), f);
        const longRandom = t.match(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g) ?? [];
        assert.deepEqual(longRandom.filter((s) => !/^[a-z-]+$/i.test(s) && !/[a-z]+[-_][a-z]+/.test(s) && !/^\/|\//.test(s)), [], `${relative(REPO, f)}: ${longRandom.join(",")}`);
      }
    });
    it("the admin is never placed on the public domain: no admin.boombala.kz and no boombala.kz/admin anywhere in code, config or docs", () => {
      const roots = [join(REPO, "src"), join(REPO, "platform/src"), join(KZ), join(REPO, "docs/platform")];
      for (const dir of roots) {
        for (const f of walk(dir)) {
          if (/\.(png|jpg|webp|ico)$/.test(f)) continue;
          const t = read(f);
          const hits = t.match(/admin\.boombala\.kz|boombala\.kz\/admin|Domain=\.?boombala\.kz/gi) ?? [];
          if (hits.length) assert.fail(`${relative(REPO, f)} mentions ${hits[0]}`);
        }
      }
    });
  });

  describe("cookies and sessions", () => {
    it("no code sets a cookie for a parent domain: the session cookie is host-only, with the __Host- prefix over HTTPS", () => {
      const files = [...walk(join(REPO, "platform/src")), ...walk(join(REPO, "src"))].filter((f) => /\.(ts|tsx)$/.test(f));
      for (const f of files) {
        const t = read(f);
        if (!/cookies\(\)|Set-Cookie/i.test(t)) continue;
        assert.ok(!/\bdomain\s*:/.test(t), `${relative(REPO, f)} sets a cookie domain`);
      }
      assert.match(read(join(REPO, "platform/src/server/env.ts")), /"__Host-bb_session"/);
      assert.ok(!files.some((f) => f.startsWith(join(REPO, "src")) && /bb_session/.test(read(f))), "the public site never touches the staff cookie");
    });
  });

  describe("the public site has no staff surface", () => {
    it("no page or route of the site is a login, an admin page or an admin API", () => {
      const files = walk(join(REPO, "src/app")).filter((f) => /\/(page|route)\.(tsx|ts)$/.test(f)).map((f) => "/" + relative(join(REPO, "src/app"), f));
      assert.ok(files.length >= 8);
      const forbidden = /(admin|login|logout|staff|dashboard|users|contacts|requests|bookings|export|retention|audit|account|mfa|cron|intake|media|legal|session)/i;
      assert.deepEqual(files.filter((f) => forbidden.test(f.replace(/\/(page|route)\.(tsx|ts)$/, ""))), []);
    });
    it("the site holds no database driver, no password hashing, no second-factor code and no staff session", () => {
      const pkg = JSON.parse(read(join(REPO, "package.json")));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      for (const bad of ["pg", "postgres", "@node-rs/argon2", "argon2", "bcrypt", "bcryptjs", "otplib", "speakeasy", "iron-session"]) assert.ok(!deps.includes(bad), bad);
      for (const f of walk(join(REPO, "src")).filter((x) => /\.(ts|tsx)$/.test(x))) {
        const t = read(f);
        assert.ok(!/from "pg"|DATABASE_URL|MFA_ENC_KEY|bb_session|ADMIN_ALLOWED|PLATFORM_ROLE/.test(t), relative(REPO, f));
      }
    });
    it("the site's configuration does not rewrite or redirect anything to an admin", () => {
      const cfg = read(join(REPO, "next.config.ts"));
      assert.ok(!/rewrites|redirects|admin/i.test(cfg));
    });
  });

  describe("scripts: device registry and isolation checks (with stand-ins for wg, curl, nc)", () => {
    const KEY = (c: string) => c.repeat(43) + "=";
    let bin: string;
    let state: string;
    const stub = (name: string, body: string) => {
      const p = join(bin, name);
      writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(p, 0o755);
    };
    const wgstaff = (args: string[]) =>
      spawnSync("bash", [join(KZ, "wireguard/wg-staff.sh"), ...args], { encoding: "utf8", env: { ...process.env, WG_BIN: join(bin, "wg"), STATE_DIR: state, SERVER_PUBLIC_KEY: "SERVERPUB", VPN_ENDPOINT: "vpn.example.test" } });
    const calls = () => (existsSync(join(bin, "wg.log")) ? read(join(bin, "wg.log")).trim().split("\n") : []);

    before(() => {
      bin = mkdtempSync(join(tmp, "bin-"));
      state = mkdtempSync(join(tmp, "state-"));
      stub("wg", `if [ "$1" = genpsk ]; then echo "PSK$RANDOM$RANDOM$RANDOM$RANDOM$RANDOM$RANDOM$RANDOM$RANDOM$RANDOM="; exit 0; fi\necho "$*" >> "${join(bin, "wg.log")}"`);
    });

    it("adds a device with a single-address allowlist, a preshared key, and never prints a server private key", () => {
      const res = wgstaff(["add", "--name", "Aigerim iPhone", "--email", "a@example.test", "--role", "manager", "--pubkey", KEY("A")]);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Address = 10\.77\.0\.10\/32/);
      assert.match(res.stdout, /AllowedIPs = 10\.77\.0\.1\/32/, "split tunnel: only the server");
      assert.match(res.stdout, /PresharedKey = PSK/);
      assert.ok(!/PrivateKey = [A-Za-z0-9+/]{43}=/.test(res.stdout), "the device's private key is never known to the server");
      assert.ok(calls().some((c) => c.includes(`set wg0 peer ${KEY("A")}`) && c.includes("allowed-ips 10.77.0.10/32")));
      const second = wgstaff(["add", "--name", "Aigerim laptop", "--email", "a@example.test", "--role", "manager", "--pubkey", KEY("B")]);
      assert.match(second.stdout, /10\.77\.0\.11\/32/);
    });

    it("refuses bad input: a duplicate key, a malformed key, an unknown role, tabs in a name", () => {
      assert.notEqual(wgstaff(["add", "--name", "x", "--email", "a@example.test", "--role", "manager", "--pubkey", KEY("A")]).status, 0);
      assert.notEqual(wgstaff(["add", "--name", "x", "--email", "a@example.test", "--role", "manager", "--pubkey", "short"]).status, 0);
      assert.notEqual(wgstaff(["add", "--name", "x", "--email", "a@example.test", "--role", "admin", "--pubkey", KEY("C")]).status, 0);
      assert.notEqual(wgstaff(["add", "--name", "a\tb", "--email", "a@example.test", "--role", "editor", "--pubkey", KEY("C")]).status, 0);
      assert.notEqual(wgstaff(["add", "--name", "x", "--email", "a@example.test", "--role", "editor"]).status, 0);
    });

    it("revokes one device, then every device of a person, at once; the list shows only active devices", () => {
      wgstaff(["add", "--name", "Marat phone", "--email", "m@example.test", "--role", "editor", "--pubkey", KEY("D")]);
      const id = wgstaff(["list"]).stdout.split("\n").find((l) => l.includes("Marat phone"))!.split(/\s+/)[0];
      const one = wgstaff(["revoke", "--id", id]);
      assert.equal(one.status, 0, one.stderr);
      assert.ok(calls().some((c) => c === `set wg0 peer ${KEY("D")} remove`));
      assert.ok(!wgstaff(["list"]).stdout.includes("Marat phone"));
      const all = wgstaff(["revoke", "--email", "a@example.test"]);
      assert.match(all.stdout, /2 device\(s\) revoked/);
      assert.match(all.stdout, /disable the account in the admin/i, "the reminder to end the sessions too");
      assert.ok(calls().some((c) => c === `set wg0 peer ${KEY("A")} remove`) && calls().some((c) => c === `set wg0 peer ${KEY("B")} remove`));
      assert.notEqual(wgstaff(["revoke", "--email", "a@example.test"]).status, 0, "nothing left to revoke");
      assert.notEqual(wgstaff(["revoke", "--id", "nonexistent"]).status, 0);
    });

    it("after a restart only the ACTIVE devices are restored; a revoked one never comes back", () => {
      writeFileSync(join(bin, "wg.log"), "");
      wgstaff(["add", "--name", "Active one", "--email", "k@example.test", "--role", "manager", "--pubkey", KEY("E")]);
      writeFileSync(join(bin, "wg.log"), "");
      const res = wgstaff(["restore"]);
      assert.equal(res.status, 0, res.stderr);
      const log = calls();
      assert.ok(log.some((c) => c.includes(KEY("E"))));
      for (const revoked of ["A", "B", "D"]) assert.ok(!log.some((c) => c.includes(KEY(revoked))), `${revoked} must not be restored`);
    });

    it("the isolation check passes on a correctly closed server and FAILS when something is exposed", () => {
      const run = (mode: string, env: Record<string, string>) =>
        spawnSync("bash", [join(KZ, "scripts/verify-isolation.sh")], { encoding: "utf8", env: { ...process.env, MODE: mode, CURL_BIN: join(bin, "curl"), NC_BIN: join(bin, "nc"), DIG_BIN: join(bin, "dig"), PUBLIC_IP: "198.51.100.10", API_HOST: "api.example.test", ADMIN_HOST: "panel.example.test", WG_SERVER_ADDR: "10.77.0.1", ...env } });
      // a correctly closed server
      stub("nc", "exit 1"); // every port closed
      stub("dig", "exit 0"); // no public DNS record
      stub("curl", `url="\${@: -1}"; for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in
  *api.example.test/api/health) printf 200;;
  *api.example.test/*) printf 404;;
  *panel.example.test/*|*198.51.100.10/*) printf 000;;
  *) printf 200;;
esac`);
      const good = run("outside", {});
      assert.equal(good.status, 0, good.stdout);
      assert.match(good.stdout, /ALL PASS/);
      assert.ok(!/FAIL/.test(good.stdout));

      // the login page leaks on the public API
      stub("curl", `for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in *api.example.test/login*) printf 200;; *api.example.test/api/health) printf 200;; *api.example.test/*) printf 404;; *) printf 000;; esac`);
      const leak = run("outside", {});
      assert.notEqual(leak.status, 0);
      assert.match(leak.stdout, /FAIL\s+public API: \/login answered 200/);

      // the admin answers on the public address
      stub("curl", `for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in *panel.example.test/*) printf 200;; *api.example.test/api/health) printf 200;; *) printf 404;; esac`);
      const exposed = run("outside", {});
      assert.notEqual(exposed.status, 0);
      assert.match(exposed.stdout, /FAIL\s+the admin name on the public address answered 200/);

      // the database port is open
      stub("curl", `for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in *api.example.test/api/health) printf 200;; *api.example.test/*) printf 404;; *) printf 000;; esac`);
      stub("nc", "exit 0");
      const db = run("outside", {});
      assert.notEqual(db.status, 0);
      assert.match(db.stdout, /FAIL\s+port 5432 is OPEN/);

      // inside the VPN: the worker endpoint and the database must stay closed
      stub("nc", "exit 1");
      stub("curl", `for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in *panel.example.test/login|*panel.example.test/api/health) printf 200;; *) printf 404;; esac`);
      const inside = run("inside", {});
      assert.equal(inside.status, 0, inside.stdout);
      stub("nc", "exit 0");
      const insideDb = run("inside", {});
      assert.notEqual(insideDb.status, 0);
      assert.match(insideDb.stdout, /FAIL\s+PostgreSQL is reachable from the VPN/);
    });
  });
});
