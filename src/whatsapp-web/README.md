# WhatsApp Web (Baileys)

A gym can link **its own WhatsApp number** as a "WhatsApp Web" linked
device, so the WHATSAPP channel sends from that number at no per-message
cost, instead of through the Meta Cloud API (`src/whatsapp/`).

## Read this first: the risk

[Baileys](https://github.com/WhiskeySockets/Baileys) is an **unofficial**,
reverse-engineered WhatsApp Web client. Automating a personal or WhatsApp
Business app number this way is against WhatsApp's Terms of Service, and
WhatsApp can restrict or permanently ban a number it sees used like this. Bulk
or promotional sending is what gets numbers banned most often.

So the feature is:

- **Off per deployment** until `WHATSAPP_WEB_ENABLED=true`.
- **Off per gym** until an owner links a number and explicitly accepts the
  risk (`acceptRisk: true`, recorded as `riskAcceptedAt`/`riskAcceptedByUserId`
  and in the audit log).
- **Off for sending** until the gym also turns on `useForSending`. Linking
  alone changes nothing about how messages go out.

The official Meta Cloud API remains the supported path, and the one to use for
anything promotional.

## Safeguards

| Safeguard | Where |
|---|---|
| MARKETING-category messages refused, even with consent | `WhatsappWebSender.enqueue` |
| Daily cap per gym, default 200 in any 24 hours, configurable 1-1000 | `WhatsappWebSender.enqueue` |
| Messages spaced 8-15 s apart per gym (`WHATSAPP_WEB_MIN_GAP_MS` + up to `WHATSAPP_WEB_JITTER_MS`) | Redis-booked slots, `nextSlot()` |
| One message at a time | processor `concurrency: 1` |
| Numbers not on WhatsApp fail at once, no retries | `NotOnWhatsappError` |
| Local numbers get +91 only for an Indian gym (INR or Asia/Kolkata); otherwise a country code is required | `normaliseWhatsappNumber` |
| No silent fallback between WhatsApp Web and the Meta API | `WhatsappRouterProvider` |

## How it works

- **Session keys** (Baileys' signal state) are stored per gym in
  `whatsapp_web_auth_keys`, AES-256-GCM encrypted with `WHATSAPP_TOKEN_KEY`.
  Holding them means holding the WhatsApp account, so they never leave the
  server. Render's disk is ephemeral, which is why they are not files.
- **One socket per number, on one server.** A Redis lock per gym decides which
  instance holds the socket. It is renewed every 20 s and expires in 60 s, so a
  dead instance hands over within a minute. Sends are queued (`whatsapp-web`
  queue) and retried until they reach the instance that holds the socket.
- **Linking**: `POST /whatsapp-web/connect` starts a socket. The QR (as an
  image) and, if a phone number was given, an 8-character pairing code are put
  in Redis and returned by `GET /whatsapp-web`. The pairing code is for linking
  from the same phone the settings page is open on, where a QR cannot be
  scanned.
- **Sending**: `CommunicationsService` logs the message as PENDING, the
  sender queues it, and the processor sends it and marks it SENT with
  `providerMessageId = waweb:<WhatsApp id>`. Receipts advance it to DELIVERED
  and READ, forward only.
- **Replies** from a phone-number JID are filed through `WhatsappInboundFiler`,
  the same path as Meta webhook replies, so they reach the CRM inbox matched
  to the member. Group chats and senders identified only by LID are skipped.
- **Unlinked or blocked**: a 401 (unlinked from the phone) or 403 (WhatsApp
  refused the number) deletes the keys, sets LOGGED_OUT with a plain reason,
  and turns sending off. A deploy only ends the socket (never logs out), and
  gyms that were CONNECTED are resumed on boot.

## Deploying

```
WHATSAPP_WEB_ENABLED=true
WHATSAPP_TOKEN_KEY=<64 hex chars>   # openssl rand -hex 32; also used by the Meta vault
# optional
WHATSAPP_WEB_MIN_GAP_MS=8000
WHATSAPP_WEB_JITTER_MS=7000
```

Needs Node 22.12 or later: the webpack build loads Baileys (an ES module) with
`require()`.

The sandbox this was built in cannot reach `web.whatsapp.com`, so the suite
drives a fake socket (`test/whatsapp-web.e2e-spec.ts`). The first real
pairing should be tried on staging with a spare number.
