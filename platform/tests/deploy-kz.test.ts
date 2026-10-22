import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { siteProfileProblems } from "../../src/lib/site-profile.ts";
import { profileProblems } from "../src/server/exposure.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const KZ = join(REPO, "deploy/kz");

const DEPLOY_ENV = `
ADMIN_HOST=panel.example.test
PUBLIC_SITE_HOST=site.example.test
PUBLIC_IP=198.51.100.10
PUBLIC_IF=eth0
WG_SERVER_ADDR=10.77.0.1
WG_SUBNET=10.77.0.0/24
WG_PORT=51820
ADMIN_PORT=3100
API_PORT=3101
SITE_PORT=3000
DB_NAME=boombala
BACKUP_S3_ENDPOINT=s3.backup.example.test
BACKUP_S3_BUCKET=boombala-backups
BACKUP_S3_REGION=kz-1
BACKUP_SFTP_HOST=backup2.example.test
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
        const left = (read(f).match(/@[A-Z0-9_]+@/g) ?? []).filter((p) => !/(PASSWORD|_TOKEN|_KEY|_SECRET|PEPPER|CHAT_ID)@$/.test(p));
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

  describe("nginx: the public site (the whole web contour is on this server)", () => {
    const tls = () => (r("nginx/site.conf").split(/\n(?=server \{)/).find((b) => b.includes("server_name site.example.test;") && b.includes("http2 on")) as string);

    it("serves only the site's own routes: the API routes it has, the pages, and nothing of the staff application", () => {
      const c = tls();
      const locs = [...c.matchAll(/^\s*location\s+(=\s+)?(\S+)\s*\{/gm)].map((m) => (m[1] ? "= " : "") + m[2]);
      assert.deepEqual(locs, ["= /api/revalidate-news", "= /api/lead", "= /api/consent", "= /api/availability", "/api/", "/"]);
      assert.match(c, /location = \/api\/revalidate-news \{ return 404; \}/, "the cache refresh is called on loopback only");
      assert.match(c, /location \/api\/ \{ return 404; \}/, "no other API route exists");
      for (const bad of ["login", "contacts", "export", "media", "cron", "users", "intake"]) assert.ok(!new RegExp(`location[^\\n]*${bad}`).test(c), bad);
      const passes = [...c.matchAll(/proxy_pass\s+([^;]+);/g)].map((m) => m[1]);
      assert.ok(passes.length >= 4 && passes.every((p) => p === "http://127.0.0.1:3000"), "only the site process on loopback, never the API or the admin");
    });
    it("listens on the public address only, rate-limits the forms hard, caps the body, redirects other names, and answers nothing for an unknown name", () => {
      const all = r("nginx/site.conf");
      for (const m of all.matchAll(/^\s*listen\s+([^;]+);/gm)) assert.match(m[1], /^198\.51\.100\.10:(80|443)/, m[1]);
      assert.match(all, /limit_req zone=bb_forms burst=3 nodelay;/);
      assert.match(all, /rate=6r\/m/);
      assert.match(all, /client_max_body_size 8k;/);
      assert.match(all, /ssl_reject_handshake on;/);
      assert.match(all, /return 444;/);
      assert.match(all, /limit_except POST \{ deny all; \}/);
      assert.match(all, /return 301 https:\/\/site\.example\.test\$request_uri;/);
      assert.ok(!/Access-Control-Allow-Origin/.test(all), "no CORS at all: the browser only ever talks to its own site");
    });
    it("has no public API host any more: the API process has no nginx listener and no public name", () => {
      assert.ok(!existsSync(join(KZ, "nginx/api.conf.template")));
      const rendered = walk(out).filter((f) => f.startsWith(join(out, "nginx")));
      for (const f of rendered) assert.ok(!/server_name[^;]*\bapi\./.test(read(f)), relative(out, f));
      const api = r("systemd/bb-api.service");
      assert.match(api, /-p 3101 -H 127\.0\.0\.1/);
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
      const site = r("systemd/bb-site.service");
      assert.match(admin, /^User=bbadmin$/m);
      assert.match(api, /^User=bbapi$/m);
      assert.match(site, /^User=bbsite$/m);
      assert.match(site, /^EnvironmentFile=\/etc\/boombala\/site\.env$/m);
      assert.match(site, /-p 3000 -H 127\.0\.0\.1/);
      assert.equal(new Set([admin, api, site].map((u) => /^User=(\w+)$/m.exec(u)?.[1])).size, 3, "three different operating-system users");
      assert.match(admin, /^EnvironmentFile=\/etc\/boombala\/admin\.env$/m);
      assert.match(api, /^EnvironmentFile=\/etc\/boombala\/api\.env$/m);
      assert.match(admin, /-p 3100 -H 127\.0\.0\.1/);
      assert.match(api, /-p 3101 -H 127\.0\.0\.1/);
      for (const u of [admin, api, site]) {
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
    it("the site environment carries no database, second-factor or admin settings, reaches the API on loopback, and keeps today's behaviour", () => {
      const env = fill(r("env/site.env.example"));
      for (const k of Object.keys(env)) assert.ok(!/^(DATABASE|MFA|CRON|ADMIN|ALLOWED|PLATFORM_ROLE|PLATFORM_PROFILE|PLATFORM_IP_PEPPER|SITE_REVALIDATE|TELEGRAM)/.test(k), k);
      assert.equal(env.PLATFORM_URL, "http://127.0.0.1:3101");
      assert.equal(env.LEAD_PIPELINE, "strict", "production accepts an enquiry only into the platform");
      assert.equal(env.SITE_PROFILE, "kz-production");
      assert.ok(!("TELEGRAM_BOT_TOKEN" in env) && !("TELEGRAM_CHAT_ID" in env), "the site holds no Telegram credentials");
      assert.deepEqual(siteProfileProblems(env), [], "the example satisfies the site's own production profile");
      assert.equal(env.CONSENT_FORM_ENABLED, "0");
      assert.equal(env.NEXT_PUBLIC_SITE_URL, "https://site.example.test");
    });
    it("the rollback environment example opens no way for a name or a phone to leave: no Telegram, no platform, forms disabled", () => {
      const env = fill(r("env/rollback.env.example"));
      assert.equal(env.SITE_PROFILE, "rollback-safe");
      assert.deepEqual(siteProfileProblems(env), ["rollback_forms_disabled"], "exactly the standing 'forms disabled' marker and nothing else");
      for (const k of Object.keys(env)) assert.ok(!/^(TELEGRAM|PLATFORM|DATABASE|LEAD_PIPELINE)/.test(k), k);
    });
    it("the admin refreshes the site's cache on loopback; the API is addressed on loopback; no production file points at Vercel", () => {
      assert.match(r("env/admin.env.example"), /^SITE_REVALIDATE_URL=http:\/\/127\.0\.0\.1:3000$/m);
      assert.match(r("env/api.env.example"), /^ALLOWED_HOSTS=127\.0\.0\.1:3101$/m);
      for (const f of walk(KZ)) {
        const t = read(f);
        const stripped = t.replace(/^.*(X-Vercel|x-vercel).*$/gim, "");
        assert.ok(!/vercel\.app|VERCEL_|@vercel/i.test(stripped), `${relative(REPO, f)} refers to Vercel`);
      }
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


  describe("external backups: each repository gets its own backups, and each is checked and restorable on its own", () => {
    const stubDir = () => mkdtempSync(join(tmp, "pgb-"));
    const calls = (dir: string) => (existsSync(join(dir, "calls.log")) ? read(join(dir, "calls.log")).trim().split("\n").filter(Boolean) : []);
    const NOW = 1_800_000_000;
    /** A stand-in for pgbackrest: `info` answers from JSON files per repository, other commands are recorded. */
    const pgb = (dir: string, infoByRepo: Record<string, unknown>, opts: { verifyFails?: string[]; restoreFails?: string[] } = {}) => {
      for (const [repo, data] of Object.entries(infoByRepo)) writeFileSync(join(dir, `info-${repo}.json`), JSON.stringify(data));
      writeFileSync(join(dir, "pgbackrest"), `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls.log"
repo=""; target=""; cmd=""
for a in "$@"; do
  case "$a" in --repo=*) repo="\${a#--repo=}";; --pg1-path=*) target="\${a#--pg1-path=}";; info|verify|restore|backup) cmd="$a";; esac
done
case "$cmd" in
  info) cat "${dir}/info-$repo.json" 2>/dev/null || exit 1;;
  verify) case " ${(opts.verifyFails ?? []).join(" ")} " in *" $repo "*) exit 1;; esac;;
  restore) case " ${(opts.restoreFails ?? []).join(" ")} " in *" $repo "*) exit 1;; esac; echo 16 > "$target/PG_VERSION";;
esac
exit 0
`);
      chmodSync(join(dir, "pgbackrest"), 0o755);
      return join(dir, "pgbackrest");
    };
    const healthy = (ageHours = 5, fullAgeDays = 2) => [{
      name: "boombala", status: { code: 0, message: "ok" },
      backup: [
        { type: "full", label: "F", timestamp: { start: NOW - fullAgeDays * 86400 - 60, stop: NOW - fullAgeDays * 86400 } },
        { type: "diff", label: "D", timestamp: { start: NOW - ageHours * 3600 - 60, stop: NOW - ageHours * 3600 } },
      ],
      archive: [{ id: "16-1", min: "000000010000000000000001", max: "000000010000000000000009" }],
    }];
    const check = (bin: string, env: Record<string, string> = {}) => spawnSync("bash", [join(out, "backup/check-backups.sh")], { encoding: "utf8", env: { ...process.env, PGBACKREST_BIN: bin, NOW_EPOCH: String(NOW), ...env } });

    it("both repositories hold encrypted copies, nothing counts that lives on this disk, and the configuration says why the jobs are separate", () => {
      const c = r("backup/pgbackrest.conf");
      assert.match(c, /^repo1-type=s3$/m);
      assert.match(c, /^repo2-type=sftp$/m);
      assert.equal((c.match(/^repo\d-cipher-type=aes-256-cbc$/gm) ?? []).length, 2, "both copies are encrypted");
      assert.equal((c.match(/^repo\d-retention-full=4$/gm) ?? []).length, 2);
      assert.ok(!/repo\d-type=posix/.test(c), "no copy on the same disk counts as a backup");
      for (const m of c.matchAll(/^repo\d-(cipher-pass|s3-key|s3-key-secret)=(.*)$/gm)) assert.match(m[2], /^@[A-Z0-9_]+@$/, "secrets stay as markers");
      assert.match(c, /writes to ONE repository only/);
      const pg = read(join(KZ, "postgres/postgresql.conf.snippet"));
      assert.match(pg, /^archive_mode = on$/m);
      assert.match(pg, /pgbackrest --stanza=boombala archive-push %p/);
    });

    it("four separate timers: full and differential, each for ONE repository, at different times, each with an alert on failure", () => {
      const want: Record<string, [string, string]> = { "full-1": ["Sun", "03:00"], "full-2": ["Sun", "04:30"], "diff-1": ["Mon..Sat", "03:00"], "diff-2": ["Mon..Sat", "04:30"] };
      for (const [inst, [days, time]] of Object.entries(want)) {
        const t = r(`backup/bb-backup-${inst}.timer`);
        assert.match(t, new RegExp(`^OnCalendar=${days.replace(/\./g, "\\.")} \\*-\\*-\\* ${time}:00$`, "m"), inst);
        assert.match(t, new RegExp(`^Unit=bb-backup@${inst}\\.service$`, "m"));
        assert.match(t, /^Persistent=true$/m);
      }
      const svc = r("backup/bb-backup@.service");
      assert.match(svc, /^ExecStart=\/opt\/boombala\/deploy\/kz\/backup\/bb-backup\.sh %i$/m);
      assert.match(svc, /^OnFailure=bb-alert@%n\.service$/m);
      assert.match(svc, /^User=postgres$/m);
      // no unit anywhere makes a backup without naming its repository
      for (const f of walk(out)) assert.ok(!/pgbackrest[^\n]*\bbackup\b/.test(read(f).replace(/^#.*$/gm, "").replace(/pgbackrest --stanza=boombala archive-push/g, "")) || /--repo=/.test(read(f)), relative(out, f));
      const check = r("backup/bb-backup-check.service");
      assert.match(check, /^OnFailure=bb-alert@%n\.service$/m);
      assert.match(r("backup/bb-backup-check.timer"), /^OnCalendar=\*-\*-\* 07:00:00$/m);
      const alert = r("backup/bb-alert@.service");
      assert.match(alert, /EnvironmentFile=\/etc\/boombala\/alert\.env/);
      assert.ok(!/telegram_bot_token|ALERT_BOT_TOKEN=[A-Za-z0-9:_-]{20,}/i.test(alert), "no token in the unit");
    });

    it("the backup job writes ONLY into the repository named in its instance, with the right type, and refuses anything else", () => {
      const dir = stubDir();
      const bin = pgb(dir, {});
      const run = (inst: string) => spawnSync("bash", [join(out, "backup/bb-backup.sh"), inst], { encoding: "utf8", env: { ...process.env, PGBACKREST_BIN: bin } });
      for (const [inst, repo, type] of [["full-1", "1", "full"], ["diff-1", "1", "diff"], ["full-2", "2", "full"], ["diff-2", "2", "diff"]] as const) {
        assert.equal(run(inst).status, 0, inst);
        const last = calls(dir).at(-1)!;
        assert.ok(last.includes(`--repo=${repo}`) && last.includes(`--type=${type}`) && /\bbackup$/.test(last), `${inst}: ${last}`);
        assert.ok(!last.includes(`--repo=${repo === "1" ? "2" : "1"}`), `${inst} touches only repo${repo}`);
      }
      for (const bad of ["", "full", "full-3", "incr-1", "full-1;rm", "../full-1", "full-12"]) assert.notEqual(run(bad).status, 0, JSON.stringify(bad));
      assert.equal(calls(dir).length, 4, "the refused ones ran nothing");
    });

    it("the daily check passes only when BOTH repositories are healthy, and looks at each one separately (info and verify per repository)", () => {
      const dir = stubDir();
      const bin = pgb(dir, { "1": healthy(), "2": healthy() });
      const res = check(bin);
      assert.equal(res.status, 0, res.stdout);
      assert.match(res.stdout, /PASS\s+repo1/);
      assert.match(res.stdout, /PASS\s+repo2/);
      const log = calls(dir);
      for (const repo of ["1", "2"]) {
        assert.ok(log.some((l) => l.includes(`--repo=${repo}`) && l.includes("info")), `info for repo${repo}`);
        assert.ok(log.some((l) => l.includes(`--repo=${repo}`) && l.endsWith("verify")), `verify for repo${repo}`);
      }
    });

    it("a problem in ONE repository fails the check and names it: no backups at all, a stale backup, no recent full, empty WAL archive, a bad stanza, failed integrity check, unreadable answer", () => {
      const cases: Array<[string, string, Record<string, unknown>, { verifyFails?: string[] }, RegExp]> = [
        ["repo2 holds no backup at all (only WAL would flow there)", "2", { "1": healthy(), "2": [{ name: "boombala", status: { code: 0, message: "ok" }, backup: [], archive: healthy()[0].archive }] }, {}, /FAIL\s+repo2: no backup at all/],
        ["repo2 newest backup is two days old", "2", { "1": healthy(), "2": healthy(60, 3) }, {}, /FAIL\s+repo2: newest backup is 60 h old/],
        ["repo1 has no full backup in 8 days", "1", { "1": healthy(5, 12), "2": healthy() }, {}, /FAIL\s+repo1: newest full backup is 12 days old/],
        ["repo2 WAL archive empty", "2", { "1": healthy(), "2": [{ ...healthy()[0], archive: [] }] }, {}, /FAIL\s+repo2: WAL archive is empty/],
        ["repo1 stanza not ok", "1", { "1": [{ ...healthy()[0], status: { code: 2, message: "missing stanza path" } }], "2": healthy() }, {}, /FAIL\s+repo1: stanza status is not ok/],
        ["repo2 verify fails", "2", { "1": healthy(), "2": healthy() }, { verifyFails: ["2"] }, /FAIL\s+repo2: pgbackrest verify failed/],
        ["repo2 not answering", "2", { "1": healthy() }, {}, /FAIL\s+repo2: pgbackrest info failed/],
        ["repo1 holds only a differential, never a full", "1", { "1": [{ ...healthy()[0], backup: [healthy()[0].backup[1]] }], "2": healthy() }, {}, /FAIL\s+repo1: no full backup/],
      ];
      for (const [name, bad, info, o, re] of cases) {
        const dir = stubDir();
        const res = check(pgb(dir, info, o));
        assert.notEqual(res.status, 0, name);
        assert.match(res.stdout, re, name);
        const good = bad === "1" ? "2" : "1";
        assert.match(res.stdout, new RegExp(`PASS\\s+repo${good}`), `${name}: the healthy repository is still reported as healthy`);
      }
    });

    it("the restore drill restores from EACH repository into its own empty directory, fails if one cannot be restored, and refuses a non-empty target", () => {
      const run = (bin: string, target: string, env: Record<string, string> = {}) => spawnSync("bash", [join(out, "backup/restore-drill.sh")], { encoding: "utf8", env: { ...process.env, PGBACKREST_BIN: bin, RESTORE_TARGET_DIR: target, ...env } });
      const dir = stubDir();
      const target = mkdtempSync(join(tmp, "drill-"));
      const ok = run(pgb(dir, {}), target);
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.match(ok.stdout, /PASS\s+repo1 restored/);
      assert.match(ok.stdout, /PASS\s+repo2 restored/);
      const log = calls(dir);
      assert.ok(log.some((l) => l.includes("--repo=1") && l.includes(`--pg1-path=${join(target, "repo1")}`) && l.endsWith("restore")));
      assert.ok(log.some((l) => l.includes("--repo=2") && l.includes(`--pg1-path=${join(target, "repo2")}`) && l.endsWith("restore")));
      assert.match(ok.stdout, /anonymised again/);

      const dir2 = stubDir();
      const target2 = mkdtempSync(join(tmp, "drill-"));
      const failed = run(pgb(dir2, {}, { restoreFails: ["2"] }), target2);
      assert.notEqual(failed.status, 0);
      assert.match(failed.stdout, /PASS\s+repo1 restored/);
      assert.match(failed.stdout, /FAIL\s+repo2 could not be restored/);

      const dir3 = stubDir();
      const target3 = mkdtempSync(join(tmp, "drill-"));
      mkdirSync(join(target3, "repo2"));
      writeFileSync(join(target3, "repo2", "x"), "x");
      const refused = run(pgb(dir3, {}), target3);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /refusing: .*repo2 is not empty/);

      const single = run(pgb(stubDir(), {}), mkdtempSync(join(tmp, "drill-")), { REPOS: "2" });
      assert.equal(single.status, 0);
      assert.ok(!/repo1/.test(single.stdout), "a single repository can be drilled alone");
      assert.notEqual(run(pgb(stubDir(), {}), mkdtempSync(join(tmp, "drill-")), { REPOS: "3" }).status, 0);
    });
  });

  describe("the web contour does not depend on Vercel when it runs on our own server", () => {
    it("the trusted-OIDC call exists only behind a check that the process runs on Vercel, in the site and in the platform", () => {
      for (const f of [join(REPO, "src/lib/platform.ts"), join(REPO, "platform/src/server/api.ts")]) {
        const calls = read(f).split("\n").filter((l) => /getVercelOidcToken\(\)/.test(l) && !/^import/.test(l.trim()));
        assert.ok(calls.length >= 1, f);
        for (const l of calls) assert.match(l, /process\.env\.VERCEL === "1" \?/, `${relative(REPO, f)}: ${l.trim()}`);
      }
    });
    it("the DNS rollback plan returns to the safe rollback deployment, never to the legacy production that would send names and phones to Telegram again", () => {
      const admin = read(join(REPO, "docs/platform/ADMIN-ISOLATION-KZ.md"));
      const plan = read(join(REPO, "docs/platform/PRODUCTION-PLAN-KZ.md"));
      for (const [name, t] of [["ADMIN-ISOLATION-KZ", admin], ["PRODUCTION-PLAN-KZ", plan]] as const) {
        assert.ok(!/вернуть DNS на Vercel|возврат DNS на Vercel/i.test(t), `${name}: no plain "return DNS to Vercel"`);
        assert.match(t, /rollback-safe/, name);
        assert.match(t, /не возвращается|не на старый Production/i, name);
      }
      assert.match(admin, /ротировать \(отозвать\) токен Telegram/);
      assert.match(admin, /Запрещено:\*? возвращать DNS на старый Production-проект/);
      assert.match(admin, /форма → Telegram[^\n]*юридическое решение/);
    });
    it("the documents say that production is entirely in Kazakhstan and Vercel is for Preview and tests only", () => {
      for (const doc of ["docs/platform/ADMIN-ISOLATION-KZ.md", "docs/platform/PRODUCTION-PLAN-KZ.md"]) {
        const t = read(join(REPO, doc));
        assert.match(t, /весь (веб-)?контур[^\n]*Казахстан|Production[^\n]*целиком в Казахстане/i, doc);
        assert.match(t, /Vercel[^\n]*(только|лишь)[^\n]*(Preview|тест)/i, doc);
        assert.ok(!/публичный сайт \(Vercel/i.test(t), `${doc} still places the public site on Vercel`);
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
        if (f.endsWith("src/lib/site-profile.ts")) continue; // the one file that NAMES these variables, in order to forbid them
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
        spawnSync("bash", [join(KZ, "scripts/verify-isolation.sh")], { encoding: "utf8", env: { ...process.env, MODE: mode, CURL_BIN: join(bin, "curl"), NC_BIN: join(bin, "nc"), DIG_BIN: join(bin, "dig"), PUBLIC_IP: "198.51.100.10", SITE_HOST: "site.example.test", ADMIN_HOST: "panel.example.test", WG_SERVER_ADDR: "10.77.0.1", ...env } });
      // a correctly closed server
      stub("nc", "exit 1"); // every port closed
      stub("dig", "exit 0"); // no public DNS record
      stub("curl", `url="\${@: -1}"; for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in
  https://site.example.test/) printf 200;;
  *site.example.test/*) printf 404;;
  *panel.example.test/*|*198.51.100.10/*) printf 000;;
  *) printf 200;;
esac`);
      const good = run("outside", {});
      assert.equal(good.status, 0, good.stdout);
      assert.match(good.stdout, /ALL PASS/);
      assert.ok(!/FAIL/.test(good.stdout));

      // the login page leaks on the public API
      stub("curl", `for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in *site.example.test/login*) printf 200;; https://site.example.test/) printf 200;; *site.example.test/*) printf 404;; *) printf 000;; esac`);
      const leak = run("outside", {});
      assert.notEqual(leak.status, 0);
      assert.match(leak.stdout, /FAIL\s+public site: \/login answered 200/);

      // the admin answers on the public address
      stub("curl", `for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in *panel.example.test/*) printf 200;; https://site.example.test/) printf 200;; *) printf 404;; esac`);
      const exposed = run("outside", {});
      assert.notEqual(exposed.status, 0);
      assert.match(exposed.stdout, /FAIL\s+the admin name on the public address answered 200/);

      // the database port is open
      stub("curl", `for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
case "$url" in https://site.example.test/) printf 200;; *site.example.test/*) printf 404;; *) printf 000;; esac`);
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
