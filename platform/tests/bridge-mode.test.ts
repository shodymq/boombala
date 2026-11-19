import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Vercel legacy bridge mode without a local PostgreSQL URL", () => {
  it("does not create a Vercel pool before branching for requests or attendance", () => {
    const requests = source("../src/app/(admin)/requests/page.tsx");
    assert.match(requests, /if \(indexed\) \{/);
    assert.match(requests, /else \{\s*const pool = getPool\(\);/);
    assert.doesNotMatch(requests, /const pool = getPool\(\);\s*const token = legacyBridgeEnabled/);

    const attendance = source("../src/app/(admin)/attendance/page.tsx");
    assert.match(attendance, /const pool = bridgeMode \? null : getPool\(\);/);
    assert.match(attendance, /const ready = bridgeMode \? true : await attendanceSchemaReady\(pool!\);/);
  });

  it("routes calendar, export and privacy actions through the authenticated bridge", () => {
    const bookings = source("../src/app/(admin)/bookings/page.tsx");
    assert.match(bookings, /if \(unifiedFastapiCrmEnabled\(\) \|\| legacyBridgeEnabled\(\)\) return <CrmCalendar/);

    const exportRoute = source("../src/app/api/export/route.ts");
    assert.match(exportRoute, /if \(legacyBridgeEnabled\(\)\) \{/);
    assert.match(exportRoute, /bridgeExport\(/);
    assert.ok(exportRoute.indexOf("bridgeExport(") < exportRoute.lastIndexOf("getPool()"));

    const contactActions = source("../src/app/(admin)/contacts/[id]/actions.ts");
    assert.match(contactActions, /if \(legacyBridgeEnabled\(\)\) await bridgeRpc\(op/);
    assert.match(contactActions, /"contacts\.revoke"/);
    assert.match(contactActions, /"contacts\.anonymize"/);
  });

  it("keeps every admin data page on the VPS bridge when Vercel has no DATABASE_URL", () => {
    const dashboard = source("../src/app/(admin)/page.tsx");
    assert.ok(dashboard.indexOf('bridgeRpc<') < dashboard.indexOf("const pool = getPool()"));

    const audit = source("../src/app/(admin)/audit/page.tsx");
    assert.ok(audit.indexOf('bridgeRpc<') < audit.indexOf("getPool().query"));

    const contacts = source("../src/app/(admin)/contacts/page.tsx");
    assert.match(contacts, /requirePermissionAnd\("contacts\.view"[\s\S]*bridgeRpc/);
    const contact = source("../src/app/(admin)/contacts/[id]/page.tsx");
    assert.match(contact, /legacyBridgeEnabled\(\)\s*\?\s*await bridgeRpc/);

    for (const path of [
      "../src/app/(admin)/news/page.tsx",
      "../src/app/(admin)/news/new/page.tsx",
      "../src/app/(admin)/news/[id]/page.tsx",
      "../src/app/(admin)/news/media/page.tsx",
      "../src/app/(admin)/legal/page.tsx",
      "../src/app/(admin)/retention/page.tsx",
      "../src/app/(admin)/users/page.tsx",
    ]) {
      const page = source(path);
      assert.match(page, /legacyBridgeEnabled\(\)/, path);
      assert.match(page, /bridgeRpc</, path);
    }

    const accountAction = source("../src/app/(admin)/account/actions.ts");
    assert.match(accountAction, /legacyBridgeEnabled\(\)/);
    assert.match(accountAction, /"users\.passwordSelf"/);
    const mediaPost = source("../src/app/api/media/route.ts");
    assert.match(mediaPost, /bridgeImageUpload\(/);
    const mediaGet = source("../src/app/api/media/[id]/route.ts");
    assert.match(mediaGet, /bridgeImage\(/);
  });

  it("keeps mutations allowlisted and fails legacy slot-writer actions closed", () => {
    const bridge = source("../src/server/legacy-bridge.ts");
    for (const operation of [
      'case "requests.list"', 'case "requests.status"', 'case "requests.index"', 'case "requests.card"', 'case "calendar.view"', 'case "calendar.catalog"',
      'case "calendar.timeline"', 'case "booking.request"', 'case "booking.payment"',
      'case "booking.confirm"', 'case "attendance.view"', 'case "contacts.list"',
      'case "legal.list"', 'case "news.list"', 'case "users.list"', 'case "audit.list"',
    ]) assert.ok(bridge.includes(operation), operation);
    assert.match(bridge, /case "requests\.confirm": throw new ConflictError\("use_calendar_flow"\)/);

    const oldBookingActions = source("../src/app/(admin)/bookings/actions.ts");
    assert.match(oldBookingActions, /if \(unifiedFastapiCrmEnabled\(\) \|\| legacyBridgeEnabled\(\)\) return failure/);
  });
});
