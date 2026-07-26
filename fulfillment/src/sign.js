// Offline licence signer — the Worker side of Cartridge's licensing. Produces a
// licence key byte-identical to tools/LicenseTool (juce::RSAKey), so the plugin
// verifies it with its embedded PUBLIC key. Runs in a Cloudflare Worker or Node.
//
// Key format: "exponentHex,modulusHex" (juce::RSAKey.toString()).
// Licence:    base64(payload) + "." + signatureHex
//   payload   = "Name|email|order"
//   signature = (SHA256(payload) ^ privateExponent) mod modulus   (RSA, no padding)

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
