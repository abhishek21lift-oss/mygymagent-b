# inventory

**Status: implemented (v1 scope).**

A product catalog plus a stock-movement ledger, following the same
conventions as the other core modules:

- Every query/mutation scoped by `organizationId` taken from `@CurrentUser()`,
  never from client input.
- Routes protected by `@RequirePermissions('inventory.<action>')` against the
  permission catalog in `src/rbac/permissions.catalog.ts`.
- Mutating endpoints annotated `@Audited(...)` for the audit trail.
- `InventoryLow` is emitted on the domain event bus (`src/events/domain-events.ts`)
  whenever a stock movement leaves `quantityOnHand <= reorderLevel`, so a
  future Notifications module can alert staff without Inventory knowing it
  exists.

## What v1 covers

- **Products** (`/products`): SKU, name, description, category, unit price,
  optional cost price, `quantityOnHand`, `reorderLevel`, active flag.
  SKUs are unique per organization.
- **Stock movements** (`/products/:id/stock-movements`, `/stock-movements`):
  an append-only ledger of `RESTOCK` / `SALE` / `ADJUSTMENT` / `DAMAGED`
  entries. Each entry stores the *signed delta* actually applied to
  `quantityOnHand`, so summing a product's movements always reconstructs its
  current stock -- see `StockMovement.quantity`'s doc comment in
  `prisma/schema.prisma`. Applying a movement is one DB transaction
  (`stock_movements` insert + `products.quantityOnHand` atomic `increment`),
  and a movement that would take stock negative is rejected with 400 rather
  than silently clamped.

## Scope decisions (v1, deliberately simplified)

- **No suppliers or purchase orders.** The original architecture doc
  (`docs/ARCHITECTURE.md#inventory`) describes a full supplier/PO workflow;
  v1 ships only the catalog + ledger that a front desk actually needs to
  track "how much stock do we have" day to day. Suppliers/POs can layer on
  top of `Product`/`StockMovement` later without a breaking schema change.
- **No valuation/COGS reporting.** `costPrice` is captured per product for
  future use but nothing aggregates it into a valuation report yet.
- **quantityOnHand is set directly on create**, not via an initial stock
  movement -- so a brand-new product's starting count isn't in the ledger.
  Every change *after* creation must go through a stock movement (`PATCH
  /products/:id` cannot touch `quantityOnHand`), keeping the ledger
  authoritative going forward.
- **Not AI-integrated.** Unlike Workouts/Nutrition, there's no
  `create_*_draft` AI tool for inventory in v1 -- there's no natural
  "draft" concept here, and stock changes are exactly the kind of mutating
  action that shouldn't happen without a human directly initiating it.
