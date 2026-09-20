# Search

**Status: implemented.**

Global, organization-scoped search across members, CRM leads, inventory products and invoices.
All records are constrained by the authenticated organization and the endpoint is permission-gated
with `search.read`. PostgreSQL ILIKE is used intentionally for the first implementation so no
external search service is required.
