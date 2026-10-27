import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";

/**
 * A software authenticator for tests: makes the same bytes a real one (Face ID, a security key) would, so the REAL server-side
 * verification (@simplewebauthn/server) is exercised: CBOR, COSE key, authenticator data, ES256 signature.
 * Not used by the application.
 */

// ── a tiny CBOR encoder (only what WebAuthn needs) ──────────────────────────────────────────────
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  throw new Error("too big");
}
type Cbor = number | string | Buffer | Map<number | string, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

const sha256 = (b: Buffer | string): Buffer => createHash("sha256").update(b).digest() as Buffer;
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

export interface VirtualOptions {
  rpID: string;
  origin: string;
  /** Sets the user-verified flag (Face ID / PIN). Default true. */
  userVerified?: boolean;
  /** Reported as "backed up" (a synced passkey). */
  backedUp?: boolean;
}

export class VirtualAuthenticator {
  readonly credentialId: Buffer = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  counter = 0;
  userHandle: Buffer | null = null;

  private readonly opts: VirtualOptions;
  constructor(opts: VirtualOptions) {
    this.opts = opts;
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x as string, "base64url") as Buffer;
    this.y = Buffer.from(jwk.y as string, "base64url");
  }

  private flags(attested: boolean): number {
    const uv = this.opts.userVerified !== false;
    return 0x01 | (uv ? 0x04 : 0) | (this.opts.backedUp ? 0x10 | 0x08 : 0) | (attested ? 0x40 : 0);
  }
  private authData(rpID: string, attested: boolean): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const parts = [sha256(rpID), Buffer.from([this.flags(attested)]), counter];
    if (attested) {
      const cose = new Map<number | string, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]);
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), idLen, this.credentialId, cbor(cose));
    }
    return Buffer.concat(parts);
  }
  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** The browser's answer to a registration ceremony (attestation "none"). */
  register(options: { challenge: string; rp?: { id?: string }; user?: { id: string } }, over: { origin?: string; rpID?: string } = {}) {
    this.counter = 0;
    if (options.user?.id) this.userHandle = Buffer.from(options.user.id, "base64url") as Buffer;
    const clientDataJSON = this.clientData("webauthn.create", options.challenge, over.origin ?? this.opts.origin);
    const attestationObject = cbor(new Map<number | string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(over.rpID ?? this.opts.rpID, true)]]));
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key" as const,
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal" as const] },
    };
  }

  /** The browser's answer to an authentication ceremony. `counter` overrides the next value (to test a cloned key). */
  assert(options: { challenge: string }, over: { origin?: string; rpID?: string; counter?: number; omitUserHandle?: boolean; userHandle?: Buffer } = {}) {
    this.counter = over.counter ?? this.counter + 1;
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, over.origin ?? this.opts.origin);
    const authenticatorData = this.authData(over.rpID ?? this.opts.rpID, false);
    const signer = createSign("SHA256");
    signer.update(Buffer.concat([authenticatorData, sha256(clientDataJSON)]));
    const signature = signer.sign({ key: this.privateKey, dsaEncoding: "der" });
    const handle = over.userHandle ?? this.userHandle;
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key" as const,
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
        ...(handle && !over.omitUserHandle ? { userHandle: b64u(handle) } : {}),
      },
    };
  }
}
