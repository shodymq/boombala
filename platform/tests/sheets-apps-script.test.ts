import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const script = readFileSync(new URL("../../deploy/kz/google-apps-script/Code.gs", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../../deploy/kz/google-apps-script/appsscript.json", import.meta.url), "utf8")) as {
  oauthScopes: string[];
};

describe("standalone Google Apps Script contract", () => {
  it("uses standalone-safe locking and never requires a service account or Drive access", () => {
    assert.ok(script.includes("SpreadsheetApp.openById"));
    assert.ok(script.includes("LockService.getScriptLock()"));
    assert.ok(!script.includes("LockService.getDocumentLock()"));
    assert.ok(!script.includes("DriveApp"));
    assert.doesNotMatch(script, /service account|private_key|client_email/i);
    assert.ok(manifest.oauthScopes.includes("https://www.googleapis.com/auth/spreadsheets"));
    assert.ok(!manifest.oauthScopes.some((scope) => scope.includes("drive")));
  });

  it("signs bounded requests with replay identifiers and leaves timer installation explicit", () => {
    assert.ok(script.includes("computeHmacSha256Signature"));
    assert.ok(script.includes("X-BB-Timestamp"));
    assert.ok(script.includes("X-BB-Nonce"));
    assert.ok(script.includes("CRM_SYNC_PENDING_REQUEST_ID"));
    assert.ok(script.includes("maxRequestBytes"));
    const setup = script.slice(script.indexOf("function setupCrmSyncIdAutomation()"), script.indexOf("/** Installable edit trigger."));
    assert.ok(!setup.includes("installLiveSyncTimer"));
    assert.ok(script.includes("function installLiveSyncTimer()"));
  });
});
