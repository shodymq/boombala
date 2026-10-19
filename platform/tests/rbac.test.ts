import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ForbiddenError } from "../src/core/errors.ts";
import { assertCan, can, PERMISSIONS, ROLES } from "../src/core/rbac.ts";

describe("role matrix", () => {
  it("owner holds every permission", () => {
    for (const p of PERMISSIONS) assert.ok(can("owner", p), p);
  });

  it("manager works with requests, bookings and clients, nothing administrative", () => {
    for (const p of ["requests.manage", "bookings.manage", "contacts.view", "catalog.view", "dashboard.view"] as const) assert.ok(can("manager", p), p);
    for (const p of ["users.manage", "audit.view", "prices.manage", "news.manage"] as const) assert.ok(!can("manager", p), p);
  });

  it("editor can only manage news (plus the dashboard)", () => {
    assert.ok(can("editor", "news.manage"));
    assert.ok(can("editor", "dashboard.view"));
    for (const p of PERMISSIONS.filter((x) => x !== "news.manage" && x !== "dashboard.view")) assert.ok(!can("editor", p), p);
  });

  it("assertCan throws ForbiddenError for a missing permission", () => {
    assert.throws(() => assertCan({ id: "1", role: "editor" }, "bookings.manage"), ForbiddenError);
    assert.doesNotThrow(() => assertCan({ id: "1", role: "manager" }, "bookings.manage"));
  });

  it("every role is known", () => {
    assert.deepEqual([...ROLES], ["owner", "manager", "editor"]);
  });
});
