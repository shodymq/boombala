import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { birthdayStartTimes, hasBirthdayDuration, hasBirthdayStart } from "../src/core/birthday-booking-time.ts";

describe("birthday booking start times", () => {
  it("offers every full hour that fits a four-hour party in branch hours", () => {
    assert.deepEqual(birthdayStartTimes("10:00-22:00"), [
      "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00",
    ]);
  });

  it("accepts the spaced working-hours format used by the staging catalog", () => {
    assert.deepEqual(birthdayStartTimes("10:00 - 22:00"), birthdayStartTimes("10:00-22:00"));
  });

  it("starts at the next whole hour when the branch opens between hours", () => {
    assert.deepEqual(birthdayStartTimes("10:30-22:00"), [
      "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00",
    ]);
  });

  it("allows a party ending exactly at closing and rejects one that would run past it", () => {
    assert.deepEqual(birthdayStartTimes("10:00-14:00"), ["10:00"]);
    assert.deepEqual(birthdayStartTimes("10:00-13:59"), []);
  });

  it("accepts midnight as a closing time only when it is exactly 24:00", () => {
    assert.deepEqual(birthdayStartTimes("20:00-24:00"), ["20:00"]);
    assert.deepEqual(birthdayStartTimes("20:00-24:15"), []);
  });

  it("does not create quarter-hour start choices", () => {
    assert.ok(!birthdayStartTimes("10:00-22:00").some((time) => !time.endsWith(":00")));
    assert.ok(!birthdayStartTimes("10:00-22:00").includes("15:30"));
  });

  it("accepts only a four-hour interval", () => {
    assert.equal(hasBirthdayDuration("2026-11-10T12:00:00+06:00", "2026-11-10T16:00:00+06:00"), true);
    assert.equal(hasBirthdayDuration("2026-11-10T12:00:00+06:00", "2026-11-10T16:30:00+06:00"), false);
  });

  it("matches the exact whole-hour start, including seconds", () => {
    assert.equal(hasBirthdayStart("2026-11-10T12:00:00.000+05:00", "2026-11-10", "12:00"), true);
    assert.equal(hasBirthdayStart("2026-11-10T12:00:00+06:00", "2026-11-10", "12:00"), false);
    assert.equal(hasBirthdayStart("2026-11-10T07:00:00Z", "2026-11-10", "12:00"), true);
    assert.equal(hasBirthdayStart("2026-11-10T12:00:30+05:00", "2026-11-10", "12:00"), false);
    assert.equal(hasBirthdayStart("2026-11-10T12:00:00.500+05:00", "2026-11-10", "12:00"), false);
    assert.equal(hasBirthdayStart("2026-11-10T12:00:00.000001+05:00", "2026-11-10", "12:00"), false);
    assert.equal(hasBirthdayStart("2026-11-10T12:00:00", "2026-11-10", "12:00"), false);
  });
});
