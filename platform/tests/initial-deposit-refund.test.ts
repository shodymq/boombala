import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initialDepositRefundRequiresCancellation } from "../src/core/initial-deposit-refund.ts";

describe("initial deposit refund policy", () => {
  it("requires cancellation for active reservations and legacy confirmed statuses", () => {
    assert.equal(initialDepositRefundRequiresCancellation("new", "active"), true);
    assert.equal(initialDepositRefundRequiresCancellation("booked", "none"), true);
    assert.equal(initialDepositRefundRequiresCancellation("confirmed", "none"), true);
    assert.equal(initialDepositRefundRequiresCancellation("paid", "none"), true);
  });

  it("allows a refund after cancellation or release", () => {
    assert.equal(initialDepositRefundRequiresCancellation("cancelled", "released"), false);
    assert.equal(initialDepositRefundRequiresCancellation("cancelled", "none"), false);
    assert.equal(initialDepositRefundRequiresCancellation("completed", "released"), false);
  });
});
