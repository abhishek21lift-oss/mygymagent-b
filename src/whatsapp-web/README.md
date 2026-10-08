# WhatsApp (WA-AKG)

A gym links **its own WhatsApp number** by scanning a QR, so the WHATSAPP
channel sends from that number. Delivery runs through the shared WA-AKG
gateway (`src/whatsapp/wa-akg.provider.ts`, one session per gym:
`gym-{organizationId}`) -- there is no in-process WhatsApp client anymore,
and the Meta Cloud API path was removed with it.

## How it works

- **Linking**: `POST /whatsapp-web/connect` ensures the gym's WA-AKG
  session and starts it. `GET /whatsapp-web` returns the live status plus
  the QR (`qrDataUrl`) / pairing code while pairing.
- **Sending**: `CommunicationsService` logs the message, the provider
  `POST`s it to WA-AKG, and the log row is marked SENT with
  `providerMessageId = waakg:<id>`. The WA-AKG status webhook advances it
  to DELIVERED and READ.
- **Replies** arrive on `POST /whatsapp/webhook` (WA-AKG events) and are
  filed through `WhatsappInboundFiler`, so they reach the CRM inbox
  matched to the member -- group chats, echoes, and non-texts are skipped.
- **Unlinked**: a LOGGED_OUT session sets the status with a plain reason;
  relink by connecting again.

## Deploying

```
WA_AKG_BASE_URL=https://wa-akg.example.com
WA_AKG_API_KEY=wag_...
WA_AKG_WEBHOOK_SECRET=<shared secret>
# + register POST {backend}/whatsapp/webhook in WA-AKG for the sessions
```

Linking a number this way still automates a WhatsApp account outside the
official Business API: bulk or promotional sending risks the number.
