import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base32Decode, base32Encode, generateRecoveryCode, generateSecret, hotp, matchTotp, normalizeRecoveryCode, openSecret, otpauthUri, parseKey, sealSecret, totpAt } from "../src/core/totp.ts";

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (8-digit reference values; the 6-digit code is their last 6 digits).
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP (RFC 6238)", () => {
  it("matches the official test vectors", () => {
    for (const [t, code] of VECTORS) {
      assert.equal(hotp(base32Decode(RFC_SECRET), Math.floor(t / 30), 8), code, `time ${t}`);
      assert.equal(totpAt(RFC_SECRET, t * 1000), code.slice(-6));
    }
  });

  it("base32 round-trips and tolerates spaces, dashes, lower case", () => {
    const bytes = Buffer.from("boombala-secret!");
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
    const enc = base32Encode(bytes);
    assert.deepEqual(base32Decode(enc.toLowerCase().replace(/(.{4})/g, "$1 ")), bytes);
    assert.throws(() => base32Decode("not base32 !"));
  });

  it("accepts the current step and one step of drift either way, and nothing further", () => {
    const secret = generateSecret();
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30000);
    const at = (s: number) => totpAt(secret, s * 30000);
    assert.equal(matchTotp(secret, at(step), now), step);
    assert.equal(matchTotp(secret, at(step - 1), now), step - 1);
    assert.equal(matchTotp(secret, at(step + 1), now), step + 1);
    assert.equal(matchTotp(secret, at(step - 2), now), null);
    assert.equal(matchTotp(secret, at(step + 2), now), null);
  });

  it("rejects malformed codes", () => {
    const secret = generateSecret();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5x", "１２３４５６"]) assert.equal(matchTotp(secret, bad, 1_800_000_000_000), null, JSON.stringify(bad));
  });

  it("the otpauth link carries the issuer, the account and the standard parameters", () => {
    const u = otpauthUri("JBSWY3DPEHPK3PXP", "a.b@example.test");
    assert.ok(u.startsWith("otpauth://totp/Boom%20Bala:a.b%40example.test?secret=JBSWY3DPEHPK3PXP&"));
    assert.ok(u.includes("digits=6") && u.includes("period=30") && u.includes("algorithm=SHA1"));
  });

  it("the secret is encrypted at rest: wrong key and tampering are refused, the same secret never looks the same twice", () => {
    const key = parseKey(Buffer.alloc(32, 7).toString("base64"));
    const other = parseKey(Buffer.alloc(32, 9).toString("base64"));
    const secret = generateSecret();
    const a = sealSecret(secret, key);
    const b = sealSecret(secret, key);
    assert.notEqual(a, b);
    assert.ok(!a.includes(secret));
    assert.equal(openSecret(a, key), secret);
    assert.throws(() => openSecret(a, other));
    const parts = a.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    assert.throws(() => openSecret(parts.join("."), key));
    assert.throws(() => parseKey("short"));
    assert.throws(() => parseKey(undefined));
  });

  it("recovery codes are readable, unambiguous and normalise the way people type them", () => {
    const code = generateRecoveryCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    assert.equal(normalizeRecoveryCode(code.toLowerCase().replace("-", " ")), code.replace("-", ""));
  });
});
