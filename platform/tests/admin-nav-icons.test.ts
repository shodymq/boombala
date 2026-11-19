import assert from "node:assert/strict";
import test from "node:test";
import { adminNavIcon } from "../src/core/admin-nav-icons.ts";

test("owner-only Sheets import route resolves to a supported navigation icon", () => {
  assert.equal(adminNavIcon("/sheets-import"), "calendar");
});

test("unmapped admin routes still render a supported fallback icon", () => {
  assert.equal(adminNavIcon("/future-admin-route"), "more");
});
