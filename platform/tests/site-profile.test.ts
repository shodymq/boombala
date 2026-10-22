import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { siteProfileProblems } from "../../src/lib/site-profile.ts";
import { notifyLevel } from "../src/server/notify-level.ts";

const good = {
  SITE_PROFILE: "kz-production", LEAD_PIPELINE: "strict", PLATFORM_URL: "http://127.0.0.1:3101", PLATFORM_INTAKE_TOKEN: "t".repeat(32),
  CONSENT_FORM_ENABLED: "0", NEXT_PUBLIC_SITE_URL: "https://site.example.test",
};

describe("Kazakhstan production: an unsafe site configuration accepts no enquiry", () => {
  it("a safe configuration has no problems; any other profile has no requirements at all (today's behaviour is untouched)", () => {
    assert.deepEqual(siteProfileProblems(good), []);
    for (const profile of [undefined, "", "development", "preview", "kz-staging"]) {
      assert.deepEqual(siteProfileProblems({ SITE_PROFILE: profile, LEAD_PIPELINE: "telegram-only", TELEGRAM_BOT_TOKEN: "x:y", TELEGRAM_CHAT_ID: "1" }), [], String(profile));
    }
  });

  it("the pipeline must be exactly 'strict': telegram-only, dual, empty, a typo or another case all refuse", () => {
    for (const v of ["telegram-only", "dual", "", undefined, "Strict", "STRICT", "strict ", " strict_", "strictly", "off"]) {
      const problems = siteProfileProblems({ ...good, LEAD_PIPELINE: v });
      if (v === "strict ") assert.deepEqual(problems, [], "surrounding spaces are trimmed, as the site does");
      else assert.deepEqual(problems, ["lead_pipeline_must_be_strict"], JSON.stringify(v));
    }
  });

  it("the site must not hold Telegram credentials or a Telegram address: it could send a name and a phone around the platform", () => {
    for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_API_BASE"]) assert.deepEqual(siteProfileProblems({ ...good, [k]: "x" }), ["site_must_not_hold_telegram_credentials"], k);
  });

  it("the platform must be on loopback and the shared secret present and long", () => {
    for (const url of ["", undefined, "https://api.example.test", "http://api.example.test", "http://10.0.0.5:3101", "http://127.0.0.1.evil.example", "http://localhost.evil.example", "https://127.0.0.1:3101", "http://user@evil.example@127.0.0.1"]) {
      assert.ok(siteProfileProblems({ ...good, PLATFORM_URL: url }).includes("platform_url_must_be_loopback"), JSON.stringify(url));
    }
    for (const ok of ["http://127.0.0.1:3101", "http://localhost:3101", "http://127.0.0.1:3101/"]) assert.deepEqual(siteProfileProblems({ ...good, PLATFORM_URL: ok }), [], ok);
    for (const t of ["", undefined, "short", "x".repeat(23)]) assert.deepEqual(siteProfileProblems({ ...good, PLATFORM_INTAKE_TOKEN: t }), ["intake_token_required"], JSON.stringify(t));
  });

  it("the site must not hold anything that belongs to another process", () => {
    for (const k of ["DATABASE_URL", "MFA_ENC_KEY", "CRON_SECRET", "PLATFORM_IP_PEPPER", "PLATFORM_ROLE", "PLATFORM_PROFILE", "ADMIN_ALLOWED_CIDRS", "SITE_REVALIDATE_URL", "TELEGRAM_NOTIFY_LEVEL"]) {
      assert.deepEqual(siteProfileProblems({ ...good, [k]: "x" }), [`site_must_not_have_${k.toLowerCase()}`], k);
    }
  });

  it("several mistakes are all reported, as codes only: no value of the environment ever appears", () => {
    const problems = siteProfileProblems({ ...good, LEAD_PIPELINE: "dual", TELEGRAM_BOT_TOKEN: "SECRETBOTTOKEN", DATABASE_URL: "postgres://u:SECRETPASSWORD@h/db", PLATFORM_INTAKE_TOKEN: "" });
    assert.deepEqual(problems.sort(), ["intake_token_required", "lead_pipeline_must_be_strict", "site_must_not_have_database_url", "site_must_not_hold_telegram_credentials"]);
    assert.ok(!JSON.stringify(problems).includes("SECRET"));
  });

  describe("the rollback deployment never carries a name or a phone anywhere", () => {
    const rollback = { SITE_PROFILE: "rollback-safe", NEXT_PUBLIC_SITE_URL: "https://site.example.test", CONSENT_FORM_ENABLED: "0" };

    it("its forms always refuse: the profile has a standing problem, so /api/lead and /api/consent answer 503", () => {
      assert.deepEqual(siteProfileProblems(rollback), ["rollback_forms_disabled"]);
      // whatever else is set cannot reopen them
      for (const extra of [{ LEAD_PIPELINE: "strict" }, { LEAD_PIPELINE: "telegram-only" }, { LEAD_PIPELINE: "dual" }, { PLATFORM_URL: "http://127.0.0.1:3101", PLATFORM_INTAKE_TOKEN: "t".repeat(32), LEAD_PIPELINE: "strict" }]) {
        assert.ok(siteProfileProblems({ ...rollback, ...extra }).includes("rollback_forms_disabled"), JSON.stringify(extra));
      }
    });

    it("the legacy variables that would send an enquiry to Telegram are reported when they are still there", () => {
      const legacy = { ...rollback, LEAD_PIPELINE: "telegram-only", TELEGRAM_BOT_TOKEN: "SECRETBOT", TELEGRAM_CHAT_ID: "1", TELEGRAM_API_BASE: "http://x" };
      const problems = siteProfileProblems(legacy);
      assert.deepEqual(problems.sort(), ["rollback_forms_disabled", "site_must_not_hold_telegram_credentials"]);
      assert.ok(!JSON.stringify(problems).includes("SECRET"));
      assert.ok(siteProfileProblems({ ...rollback, PLATFORM_URL: "http://127.0.0.1:3101" }).includes("site_must_not_have_platform_url"));
      assert.ok(siteProfileProblems({ ...rollback, DATABASE_URL: "postgres://x" }).includes("site_must_not_have_database_url"));
    });

    it("the legacy production configuration, as it runs today, is NOT a safe rollback target: only the new profile makes it one", () => {
      const legacyToday = { LEAD_PIPELINE: "telegram-only", TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "1" };
      assert.deepEqual(siteProfileProblems(legacyToday), [], "no profile: the forms would still send a name and a phone to Telegram");
      assert.notDeepEqual(siteProfileProblems({ ...legacyToday, SITE_PROFILE: "rollback-safe" }), []);
    });
  });

  it("the notification level of the admin is 'minimal' in the production profile whatever the environment says; elsewhere it behaves as before", () => {
    const keep = { p: process.env.PLATFORM_PROFILE, l: process.env.TELEGRAM_NOTIFY_LEVEL };
    try {
      process.env.PLATFORM_PROFILE = "kz-production";
      for (const level of ["full", "", "typo", undefined]) {
        if (level === undefined) delete process.env.TELEGRAM_NOTIFY_LEVEL;
        else process.env.TELEGRAM_NOTIFY_LEVEL = level;
        assert.equal(notifyLevel(), "minimal", String(level));
      }
      delete process.env.PLATFORM_PROFILE;
      process.env.TELEGRAM_NOTIFY_LEVEL = "full";
      assert.equal(notifyLevel(), "full");
      process.env.TELEGRAM_NOTIFY_LEVEL = "minimal";
      assert.equal(notifyLevel(), "minimal");
      delete process.env.TELEGRAM_NOTIFY_LEVEL;
      assert.equal(notifyLevel(), "full", "today's default");
    } finally {
      if (keep.p === undefined) delete process.env.PLATFORM_PROFILE; else process.env.PLATFORM_PROFILE = keep.p;
      if (keep.l === undefined) delete process.env.TELEGRAM_NOTIFY_LEVEL; else process.env.TELEGRAM_NOTIFY_LEVEL = keep.l;
    }
  });
});
