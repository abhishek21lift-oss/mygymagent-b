# WhatsApp Integration v1

Multi-tenant WhatsApp foundation for MY GYM AGENT.

Architecture:
- Organization-scoped connection records
- Provider abstraction with Meta WhatsApp Cloud API as the first provider
- Encrypted access credentials; never expose secrets to the client
- Webhook verification and inbound event processing
- Outbound message + delivery status persistence
- Template abstraction for policy-controlled business messaging
- All operations must be organization-scoped

Runtime provider credentials are supplied through environment/configuration; no secrets are committed to source control.

## Planned endpoints

- `GET /whatsapp/integration`
- `POST /whatsapp/integration/connect`
- `POST /whatsapp/integration/disconnect`
- `GET /whatsapp/webhook`
- `POST /whatsapp/webhook`
- `POST /whatsapp/messages`
- `GET /whatsapp/messages`
- `GET /whatsapp/conversations`

The provider implementation must reject sends when an organization is disconnected or credentials are invalid and must persist provider message IDs for idempotent status updates.