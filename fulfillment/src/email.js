// Transactional email for the fulfilment worker.
//
// One place for every message this worker sends, so they share a layout and
// cannot drift apart the way they had. Each builder returns { subject, text,
// html } and sends nothing; send() does the Resend call. That split keeps the
// templates trivially testable without stubbing the network.
//
// Every message ships BOTH parts. The html is not decoration: a licence key is
// ~600 characters, and in a plain-text mail clients hard-wrap it, so a pasted
// key arrives with newlines in it. CSS soft-wrapping renders the key across
// lines while copying as one unbroken string, because no newline is ever put
// into the text. Plain text stays as the fallback for clients that refuse html.

const FROM_LICENCES = "licences@staycoolandstaycool.com";
const SITE = "https://staycoolandstaycool.com";

// Sampled from the site so mail and web look related.
const INK = "#1f1f1f";
const PAPER = "#faf9f5";
const RULE = "#e8e4df";
const ACCENT = "#d43040";
const MUTED = "#6b6b6b";

const esc = (t) =>
  String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Shared shell: wordmark, body, footer. Body is trusted html. */
function layout(bodyHtml) {
  return (
    `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;` +
    `color:${INK};max-width:600px;margin:0 auto;padding:8px 4px">` +
    `<div style="font:600 13px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;` +
    `text-transform:uppercase;color:${ACCENT};padding-bottom:14px;border-bottom:1px solid ${RULE}">` +
    `Stay Cool &amp; Stay Cool</div>` +
    `<div style="padding:20px 0">${bodyHtml}</div>` +
    `<div style="border-top:1px solid ${RULE};padding-top:14px;font-size:12px;color:${MUTED}">` +
    `<a href="${SITE}/cartridge/support" style="color:${MUTED}">Support</a> &middot; ` +
    `<a href="${SITE}/cartridge/manual/" style="color:${MUTED}">Manual</a> &middot; ` +
    `<a href="${SITE}/cartridge/install" style="color:${MUTED}">Install guide</a>` +
    `</div></div>`
  );
}

/** The key itself. Monospaced, boxed, and wrapped by CSS rather than newlines. */
function keyBlock(licence) {
  return (
    `<p style="font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;background:${PAPER};` +
    `border:1px solid ${RULE};border-radius:8px;padding:14px 16px;` +
    `word-break:break-all;white-space:pre-wrap;margin:0 0 8px">${esc(licence)}</p>` +
    `<p style="font-size:13px;color:${MUTED};margin:0 0 20px">` +
    `Select the whole block and copy it. It is one long line, so make sure nothing is left behind.</p>`
  );
}

function activateHtml(display) {
  return (
    `<p>To activate: open ${esc(display)}, click the <strong>DEMO</strong> badge in the top bar, ` +
    `paste the key in, and hit <strong>Activate</strong>.</p>`
  );
}

/** Retail purchase: perpetual key, three machines. */
export function licenceEmail({ name, display, licence }) {
  const text =
    `Hi ${name},\n\n` +
    `Thanks for buying ${display}. Here's your licence key:\n\n${licence}\n\n` +
    `To activate: open ${display}, click the DEMO badge in the top bar, paste the ` +
    `key in, and hit Activate. A one-time online activation binds it to that ` +
    `machine — you can activate up to 3 machines, and free one up any time from ` +
    `the licence badge. After activation ${display} runs fully offline.\n\n` +
    `No internet on that machine? ${SITE}/cartridge/activate\n` +
    `Lost this email? ${SITE}/cartridge/key\n\n` +
    `Keep this email; it's your proof of licence.\n\n— Stay Cool and Stay Cool`;

  const html = layout(
    `<p>Hi ${esc(name)},</p>` +
      `<p>Thanks for buying ${esc(display)}. Here is your licence key:</p>` +
      keyBlock(licence) +
      activateHtml(display) +
      `<p>A one-time online activation binds it to that machine. You can activate up to ` +
      `<strong>3 machines</strong>, and free one up any time from the licence badge. ` +
      `After activation ${esc(display)} runs fully offline.</p>` +
      `<p style="font-size:14px;color:${MUTED}">` +
      `No internet on that machine? <a href="${SITE}/cartridge/activate">Activate offline</a>.<br>` +
      `Lost this email? <a href="${SITE}/cartridge/key">Recover your key</a>.</p>` +
      `<p>Keep this email; it is your proof of licence.</p>` +
      `<p>&mdash; Stay Cool and Stay Cool</p>`
  );

  return { subject: `Your ${display} licence key`, text, html };
}

/**
 * Beta tester: expiring key, one machine, and a download per platform.
 *
 * `downloads` is [{ label, url }, ...]. Testers often have more than one
 * machine, and we do not always know which they will install on, so every
 * platform is offered rather than guessing. A bare `download` string is still
 * accepted and shown as a single unlabelled button.
 */
export function betaEmail({ name, display, licence, expiry, downloads, download }) {
  const nice = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`;
  const links = Array.isArray(downloads) && downloads.length
    ? downloads.filter((d) => d && d.url)
    : (download ? [{ label: "", url: download }] : []);

  const text =
    `Hi ${name},\n\n` +
    `Thanks for testing ${display}. Here's everything you need.\n\n` +
    (links.length
      ? "Downloads:\n" + links.map((d) => `${d.label ? d.label + ": " : ""}${d.url}`).join("\n\n") + "\n\n"
      : "") +
    `Licence key:\n${licence}\n\n` +
    `To activate: install and open ${display}, click the DEMO badge in the top ` +
    `bar, paste the key in, and hit Activate. That binds the key to this one ` +
    `machine; afterwards it validates offline. Moving to another machine? ` +
    `Deactivate from the licence badge first.\n\n` +
    `This beta key expires on ${nice}; the plugin returns to demo mode after ` +
    `that. You'll get a fresh key (or a release build) before then.\n\n` +
    `Thanks for testing!\n\n— Stay Cool and Stay Cool`;

  const html = layout(
    `<p>Hi ${esc(name)},</p>` +
      `<p>Thanks for testing ${esc(display)}. Here is everything you need.</p>` +
      (links.length
        ? `<p style="margin-bottom:6px"><strong>Download</strong></p>` +
          `<p style="margin:0 0 20px">` +
          links
            .map(
              (d) =>
                `<a href="${esc(d.url)}" style="display:inline-block;background:${ACCENT};` +
                `color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;` +
                `font-weight:600;margin:0 8px 8px 0">${esc(d.label || display)}</a>`
            )
            .join("") +
          `</p>`
        : "") +
      `<p style="margin-bottom:6px"><strong>Licence key</strong></p>` +
      keyBlock(licence) +
      activateHtml(display) +
      `<p>That binds the key to this one machine; afterwards it validates offline. ` +
      `Moving to another machine? Deactivate from the licence badge first.</p>` +
      `<p style="font-size:14px;color:${MUTED}">This beta key expires on <strong>${esc(nice)}</strong>, ` +
      `after which the plugin returns to demo mode. You will get a fresh key, or a release ` +
      `build, before then.</p>` +
      `<p>Thanks for testing!</p>` +
      `<p>&mdash; Stay Cool and Stay Cool</p>`
  );

  return { subject: `Your ${display} beta licence key`, text, html };
}

/** Post to Resend. Throws with the API's own message so failures are debuggable. */
export async function send(env, { to, from, subject, text, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error("email send failed: " + (await res.text()));
}

export function licencesFrom(display) {
  return `${display} <${FROM_LICENCES}>`;
}
