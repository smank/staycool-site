// Offline licence signer — the Worker side of Cartridge's licensing. Produces a
// licence key byte-identical to tools/LicenseTool (juce::RSAKey), so the plugin
// verifies it with its embedded PUBLIC key. Runs in a Cloudflare Worker or Node.
//
// Key format: "exponentHex,modulusHex" (juce::RSAKey.toString()).
// Licence:    base64(payload) + "." + signatureHex
//   payload   = "2|product|type|name|email|order|expiry|machine"   (licence v2)
//   signature = (SHA256(payload) ^ privateExponent) mod modulus   (RSA, no padding)
//
// Signing is deterministic: the same payload always yields the identical
// licence string, which is what makes /activate retries idempotent for free.
//
// Payload fields:
//   product lowercase slug ("cartridge", ...) — one signing key serves every
//           product; each plugin only honours its own slug
//   type    "full" | "beta"
//   expiry  "0" (perpetual) or YYYYMMDD, valid through that day inclusive
//   machine "" (unbound — retail and beta keys alike are exchanged via
//           /activate for a machine-bound licence)
//           "*" (any machine — beta / NFR keys)
//           16-64 lowercase hex chars (bound to one machine)

function modpow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decodeUtf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function sha256BigInt(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return BigInt("0x" + bytesToHex(new Uint8Array(digest)));
}

/** Sign a payload with a juce::RSAKey private-key string; returns a licence key. */
export async function signLicence(privateKeyStr, payload) {
  const [expHex, modHex] = privateKeyStr.split(",");
  const exp = BigInt("0x" + expHex);
  const mod = BigInt("0x" + modHex);
  const hash = await sha256BigInt(payload);
  const sig = modpow(hash, exp, mod);
  return b64utf8(payload) + "." + sig.toString(16);
}

/** Mint-time sanitisation: pipes and newlines can never enter a payload field. */
export function sanitizeField(s) {
  return String(s ?? "").replace(/[|\r\n]/g, "").trim();
}

const TYPES = new Set(["full", "beta"]);
const PRODUCT_RE = /^[a-z0-9-]{1,32}$/;
const EXPIRY_RE = /^0$|^[0-9]{8}$/;
const MACHINE_RE = /^$|^\*$|^[0-9a-f]{16,64}$/;

/** Build a v2 payload string from fields (sanitises name/email/order). */
export function buildPayloadV2({ product, type, name, email, order, expiry = 0, machine = "" }) {
  if (!PRODUCT_RE.test(product ?? "")) throw new Error("bad product");
  if (!TYPES.has(type)) throw new Error("bad type");
  name = sanitizeField(name) || "Music maker";
  email = sanitizeField(email);
  order = sanitizeField(order);
  if (!order) throw new Error("bad order");
  const exp = String(expiry);
  if (!EXPIRY_RE.test(exp)) throw new Error("bad expiry");
  if (!MACHINE_RE.test(machine)) throw new Error("bad machine");
  return ["2", product, type, name, email, order, exp, machine].join("|");
}

/**
 * Split and grammar-check a licence key (no signature check).
 * Returns { payload, sigHex, fields: {type,name,email,order,expiry,machine} } or null.
 */
export function parseLicence(licenceKey) {
  const key = String(licenceKey ?? "").trim();
  const dot = key.lastIndexOf(".");
  if (dot <= 0) return null;
  let payload;
  try {
    payload = b64decodeUtf8(key.slice(0, dot));
  } catch {
    return null;
  }
  const sigHex = key.slice(dot + 1);
  if (!/^[0-9a-f]+$/.test(sigHex)) return null;

  const parts = payload.split("|");
  if (parts.length !== 8 || parts[0] !== "2") return null;
  const [, product, type, name, email, order, expiry, machine] = parts;
  if (!PRODUCT_RE.test(product) || !TYPES.has(type) || !order) return null;
  if (!EXPIRY_RE.test(expiry)) return null;
  if (expiry !== "0" && (+expiry < 20000101 || +expiry > 21001231)) return null;
  if (!MACHINE_RE.test(machine)) return null;
  return { payload, sigHex, fields: { product, type, name, email, order, expiry: +expiry, machine } };
}

/** Verify a licence key's signature with the PUBLIC key. Returns parseLicence() result or null. */
export async function verifyLicence(publicKeyStr, licenceKey) {
  const parsed = parseLicence(licenceKey);
  if (!parsed) return null;
  const [expHex, modHex] = publicKeyStr.split(",");
  const recovered = modpow(BigInt("0x" + parsed.sigHex), BigInt("0x" + expHex), BigInt("0x" + modHex));
  if (recovered !== (await sha256BigInt(parsed.payload))) return null;
  return parsed;
}
