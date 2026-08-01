// Advanced-mode Pages worker. The Zero Trust Access gate only covers the custom
// domain; the Pages project is also served at staycool-site.pages.dev and at
// per-deploy <hash>.pages.dev preview URLs with NO gate. Nobody should be using
// those, so hard-block them (404 — as if nothing is there). The real site at
// staycoolandstaycool.com serves normally.
//
// NOTE: advanced mode bypasses both the automatic 404.html convention AND the
// functions/ directory, so the contact endpoint lives here rather than in a
// Pages Function.
//
// Secrets (wrangler pages secret put <NAME> --project-name staycool-site):
//   TURNSTILE_SECRET  - Turnstile widget secret key
//   RESEND_API_KEY    - Resend key, sending domain staycoolandstaycool.com
const CONTACT_TO = "support@staycoolandstaycool.com";
const CONTACT_FROM = "Stay Cool site <hello@staycoolandstaycool.com>";
const MAX_MESSAGE = 5000;
// Where /cartridge/buy sends people. Points at the product page until the
// store is live, then becomes the Lemon Squeezy checkout. 302, never 301, so
// browsers don't cache it past the switchover.
const BUY_DESTINATION = "https://staycoolandstaycool.com/cartridge/#buy";
// Topic drives the subject line and the accent colour of the notification.
const TOPICS = {
  bug:      { name: "Bug",      tint: "#ff5a3c" },
  question: { name: "Question", tint: "#3a37f0" },
  hi:       { name: "Saying hi", tint: "#c3a300" },
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function verifyTurnstile(token, ip, secret) {
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const r = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body }
  );
  const data = await r.json().catch(() => ({ success: false }));
  return data.success === true;
}

async function handleContact(request, env) {
  if (!env.TURNSTILE_SECRET || !env.RESEND_API_KEY) {
    // Fail loudly rather than pretending to send. Better an honest error than
    // the old markup, which showed a success message and dropped the message.
    // The message is visitor-facing, so it names the fallback.
    return json(
      { error: `This form is not working yet. Email ${CONTACT_TO} and it will reach me.` },
      503
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Malformed submission." }, 400);
  }

  // Honeypot: a field no human sees. Bots fill everything.
  if ((form.get("company") || "").toString().trim() !== "") {
    return json({ ok: true }); // look successful, deliver nothing
  }

  const token = (form.get("cf-turnstile-response") || "").toString();
  const ip = request.headers.get("CF-Connecting-IP");
  if (!token || !(await verifyTurnstile(token, ip, env.TURNSTILE_SECRET))) {
    return json({ error: "Could not verify you are human. Please retry." }, 403);
  }

  const email = (form.get("email") || "").toString().trim();
  const message = (form.get("message") || "").toString().trim();
  const topic = (form.get("topic") || "hi").toString().trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "That email address doesn't look right." }, 400);
  }
  if (!message) return json({ error: "The message is empty." }, 400);
  if (message.length > MAX_MESSAGE) {
    return json({ error: "That message is too long." }, 400);
  }

  const country = request.headers.get("CF-IPCountry") || "unknown";
  const label = TOPICS[topic] || { name: topic, tint: "#6b7280" };
  const when = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const safe = (t) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const sent = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: CONTACT_FROM,
      to: [CONTACT_TO],
      reply_to: email,
      subject: `${label.name}: ${email}`,
      text:
        `${label.name} from ${email}\n` +
        `${when} · ${country}\n` +
        `${"-".repeat(48)}\n\n` +
        `${message}\n\n` +
        `${"-".repeat(48)}\n` +
        `Reply to this email and it goes straight back to them.\n`,
      html:
        `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#17121f;max-width:640px">` +
          `<div style="border-left:4px solid ${label.tint};padding:2px 0 2px 14px;margin-bottom:20px">` +
            `<div style="font:600 13px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.12em;` +
              `text-transform:uppercase;color:${label.tint}">${label.name}</div>` +
            `<div style="font-size:17px;font-weight:600;margin-top:3px">` +
              `<a href="mailto:${safe(email)}" style="color:#17121f;text-decoration:none">${safe(email)}</a>` +
            `</div>` +
          `</div>` +
          `<div style="white-space:pre-wrap;background:#faf9f5;border:1px solid #e6e3dc;` +
            `border-radius:8px;padding:16px 18px">${safe(message)}</div>` +
          `<p style="font:12px/1.5 ui-monospace,Menlo,monospace;color:#8b8794;margin-top:18px">` +
            `${when} &middot; ${country}<br>Reply to this email and it goes straight back to them.` +
          `</p>` +
        `</div>`,
    }),
  });

  if (!sent.ok) {
    return json({ error: "Could not send right now. Please email us." }, 502);
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // www serves nothing of its own; send it to the canonical bare domain so
    // the two hostnames never split traffic or search ranking.
    if (url.hostname === "www.staycoolandstaycool.com") {
      url.hostname = "staycoolandstaycool.com";
      return Response.redirect(url.toString(), 301);
    }

    if (url.hostname.endsWith(".pages.dev")) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // The plugin's licence dialog links here, and that string is frozen into
    // every installed copy. Keep this route forever and re-point it as the
    // destination changes; never send a build straight at a merchant URL.
    if (url.pathname === "/cartridge/buy") {
      return Response.redirect(BUY_DESTINATION, 302);
    }

    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, 405);
      }
      return handleContact(request, env);
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;

    const notFound = await env.ASSETS.fetch(new URL("/404.html", url));
    return new Response(notFound.body, {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};
