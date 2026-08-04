import { test } from "node:test";
import assert from "node:assert/strict";
import { licenceEmail, betaEmail, buildUpdateEmail, licencesFrom } from "../src/email.js";

const KEY = "MnxjYXJ0cmlkZ2V8ZnVsbHxKbyBUZXN0ZXI=." + "a1b2c3".repeat(80);

test("every message ships both a text and an html part", () => {
  for (const m of [
    licenceEmail({ name: "Jo", display: "Cartridge", licence: KEY }),
    betaEmail({ name: "Jo", display: "Cartridge", licence: KEY,
                expiry: "20261031", download: "https://example.test/x" }),
  ]) {
    assert.ok(m.subject && m.text && m.html);
    // The key must survive verbatim in both parts.
    assert.ok(m.text.includes(KEY));
    assert.ok(m.html.includes(KEY));
  }
});

test("the key is laid out to wrap visually, never with newlines", () => {
  // This is the whole reason the html part exists: a hard-wrapped key pastes
  // with newlines in it, which the plugin used to reject outright.
  const { html } = licenceEmail({ name: "Jo", display: "Cartridge", licence: KEY });
  assert.match(html, /word-break:\s*break-all/);
  const block = html.slice(html.indexOf(KEY) - 200, html.indexOf(KEY) + KEY.length);
  assert.ok(!block.includes("\n"), "the key must not be broken across lines in the source");
});

test("html is escaped, so a name cannot inject markup", () => {
  const m = licenceEmail({ name: '<img src=x onerror="alert(1)">', display: "Cartridge", licence: KEY });
  assert.ok(!m.html.includes("<img"), "name must be escaped");
  assert.ok(m.html.includes("&lt;img"));
});

test("beta mail shows the expiry as a date and links the download", () => {
  const m = betaEmail({ name: "Jo", display: "Cartridge", licence: KEY,
                        expiry: "20261031", download: "https://example.test/build.dmg" });
  assert.ok(m.html.includes("2026-10-31"));
  assert.ok(m.text.includes("2026-10-31"));
  assert.ok(m.html.includes("https://example.test/build.dmg"));
});

test("beta mail renders one button per platform", () => {
  const m = betaEmail({
    name: "Jo", display: "Cartridge", licence: KEY, expiry: "20261031",
    downloads: [
      { label: "macOS", url: "https://x.test/a.dmg" },
      { label: "Windows", url: "https://x.test/b.exe" },
      { label: "Linux", url: "https://x.test/c.zip" },
    ],
  });
  for (const l of ["macOS", "Windows", "Linux"]) {
    assert.ok(m.html.includes(`>${l}</a>`), `html must have a ${l} button`);
    assert.ok(m.text.includes(`${l}: https://`), `text must label the ${l} link`);
  }
});

test("a bare download string still works", () => {
  const m = betaEmail({ name: "Jo", display: "Cartridge", licence: KEY,
                        expiry: "20261031", download: "https://x.test/only.dmg" });
  assert.ok(m.html.includes("https://x.test/only.dmg"));
  assert.ok(m.text.includes("https://x.test/only.dmg"));
});

test("beta mail omits the download block when there is no link", () => {
  const m = betaEmail({ name: "Jo", display: "Cartridge", licence: KEY, expiry: "20261031", download: "" });
  assert.ok(!m.html.includes("<strong>Download</strong>"));
});

test("retail mail points at offline activation and key recovery", () => {
  const { html, text } = licenceEmail({ name: "Jo", display: "Cartridge", licence: KEY });
  for (const s of [html, text]) {
    assert.ok(s.includes("/cartridge/activate"));
    assert.ok(s.includes("/cartridge/key"));
  }
});

test("from line is the licences address", () => {
  assert.equal(licencesFrom("Cartridge"), "Cartridge <licences@staycoolandstaycool.com>");
});

test("a build-update email carries no licence key", () => {
  // Their key still works. Re-sending one would imply the old one had stopped,
  // which is the first thing anyone would ask.
  const m = buildUpdateEmail({
    name: "Jo", display: "Cartridge", version: "v1.14.1",
    downloads: [{ label: "macOS", url: "https://x.test/a.dmg" }],
    notes: "Fixed a thing\nChanged another",
  });
  assert.ok(!m.text.includes(KEY));
  assert.ok(!m.html.includes(KEY));
  assert.ok(m.text.includes("existing licence key still works"));
  assert.ok(m.subject.includes("v1.14.1"));
});

test("build-update notes render as bullets in both parts", () => {
  const m = buildUpdateEmail({
    name: "Jo", display: "Cartridge", version: "v1.14.1",
    downloads: [{ label: "macOS", url: "https://x.test/a.dmg" }],
    notes: "First thing\nSecond thing",
  });
  assert.ok(m.html.includes("<li>First thing</li>"));
  assert.ok(m.html.includes("<li>Second thing</li>"));
  assert.ok(m.text.includes("  - First thing"));
});

