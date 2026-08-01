# Newsletter transactional email copy

Paste these into Buttondown → Settings → Emails (custom transactional emails
need the Standard plan). Buttondown injects the confirm and unsubscribe links,
so leave those placeholders alone.

Voice notes: plain, deadpan, no exclamation marks, no marketing throat-clearing.
The promise on the signup form is "one email when something ships, and nothing
in between" — every one of these has to be consistent with that or the first
impression is a broken promise.

---

## 1. Confirmation email (double opt-in)

**Subject**

```
Confirm your email
```

**Body**

```
Someone entered this address to hear about Cartridge, a 2A03 chiptune
synthesizer. If that was you, confirm below and you're on the list.

{{ confirmation_link }}

You'll get one email when Cartridge launches. Nothing in between.

If it wasn't you, ignore this and nothing happens. We won't email you again.

Stay Cool and Stay Cool
staycoolandstaycool.com
```

Why it reads this way: it says who it's from and what they signed up for
before asking for a click, which is what stops a confirmation mail looking
like phishing. It also gives the non-subscriber a clean exit.

---

## 2. Welcome email (sent after they confirm)

**Subject**

```
You're on the list
```

**Body**

```
That's it. We'll email you once, when Cartridge launches.

While you wait, there are audio demos and the full manual here:

  https://staycoolandstaycool.com/cartridge/

Cartridge is a chiptune synthesizer built on the Ricoh 2A03: the real 8-bit
voice, a polyphonic modern engine, and a step sequencer on every channel.

Reply to this email if you ever want anything. It reaches a person.

Stay Cool and Stay Cool
staycoolandstaycool.com

{{ unsubscribe_link }}
```

Note: this duplicates the confirmed-subscriber page at
`/cartridge/confirmed` on purpose. The page is what they see in the browser;
this is what's in their inbox later when they've forgotten who you are.

---

## 3. Reminder to unconfirmed subscribers (24h)

**Subject**

```
Still one click away
```

**Body**

```
You entered this address to hear about Cartridge but haven't confirmed yet.
One click and you're done:

{{ confirmation_link }}

If you've changed your mind, ignore this. It's the last you'll hear from us.

Stay Cool and Stay Cool
```

---

## Settings that go with these

- Reply-to: `support@staycoolandstaycool.com`
- After subscribing: `https://staycoolandstaycool.com/cartridge/subscribed`
- After confirming: `https://staycoolandstaycool.com/cartridge/confirmed`
- Subscriber cleanup: **off** (a list that sends once per launch makes
  everyone look inactive; auto-pruning would delete real subscribers)
