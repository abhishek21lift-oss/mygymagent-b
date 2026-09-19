-- Inventory integrity hardening: financial/quantity checks, partial returns, and pagination indexes.

ALTER TYPE "InventorySaleStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_RETURNED';

ALTER TABLE "inventory_sale_items"
  ADD COLUMN IF NOT EXISTS "returnedQuantity" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "inventory_purchase_order_items"
  ADD CONSTRAINT "inventory_po_items_ordered_positive_chk"
    CHECK ("orderedQuantity" > 0) NOT VALID,
  ADD CONSTRAINT "inventory_po_items_received_nonnegative_chk"
    CHECK ("receivedQuantity" >= 0) NOT VALID,
  ADD CONSTRAINT "inventory_po_items_received_le_ordered_chk"
    CHECK ("receivedQuantity" <= "orderedQuantity") NOT VALID,
  ADD CONSTRAINT "inventory_po_items_unit_cost_nonnegative_chk"
    CHECK ("unitCost" >= 0) NOT VALID;

ALTER TABLE "inventory_transfer_items"
  ADD CONSTRAINT "inventory_transfer_items_quantity_positive_chk"
    CHECK ("quantity" > 0) NOT VALID;

ALTER TABLE "inventory_sale_items"
  ADD CONSTRAINT "inventory_sale_items_quantity_positive_chk"
    CHECK ("quantity" > 0) NOT VALID,
  ADD CONSTRAINT "inventory_sale_items_returned_nonnegative_chk"
    CHECK ("returnedQuantity" >= 0) NOT VALID,
  ADD CONSTRAINT "inventory_sale_items_returned_le_quantity_chk"
    CHECK ("returnedQuantity" <= "quantity") NOT VALID,
  ADD CONSTRAINT "inventory_sale_items_unit_price_nonnegative_chk"
    CHECK ("unitPrice" >= 0) NOT VALID,
  ADD CONSTRAINT "inventory_sale_items_unit_cost_nonnegative_chk"
    CHECK ("unitCost" >= 0) NOT VALID,
  ADD CONSTRAINT "inventory_sale_items_total_nonnegative_chk"
    CHECK ("total" >= 0) NOT VALID;

ALTER TABLE "inventory_purchase_orders"
  ADD CONSTRAINT "inventory_po_total_nonnegative_chk"
    CHECK ("totalCost" >= 0) NOT VALID;

ALTER TABLE "inventory_sales"
  ADD CONSTRAINT "inventory_sales_subtotal_nonnegative_chk"
    CHECK ("subtotal" >= 0) NOT VALID,
  ADD CONSTRAINT "inventory_sales_discount_nonnegative_chk"
    CHECK ("discount" >= 0) NOT VALID,
  ADD CONSTRAINT "inventory_sales_total_nonnegative_chk"
    CHECK ("total" >= 0) NOT VALID;

ALTER TABLE "product_stocks"
  ADD CONSTRAINT "product_stocks_quantity_nonnegative_chk"
    CHECK ("quantityOnHand" >= 0) NOT VALID;

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_unit_cost_nonnegative_chk"
    CHECK ("unitCost" IS NULL OR "unitCost" >= 0) NOT VALID,
  ADD CONSTRAINT "stock_movements_total_cost_nonnegative_chk"
    CHECK ("totalCost" IS NULL OR "totalCost" >= 0) NOT VALID;

CREATE INDEX IF NOT EXISTS "inventory_purchase_orders_org_branch_created_idx"
  ON "inventory_purchase_orders"("organizationId","branchId","createdAt");
CREATE INDEX IF NOT EXISTS "inventory_transfers_org_created_idx"
  ON "inventory_transfers"("organizationId","createdAt");
CREATE INDEX IF NOT EXISTS "inventory_sales_org_branch_created_status_idx"
  ON "inventory_sales"("organizationId","branchId","createdAt","status");
CREATE INDEX IF NOT EXISTS "product_stocks_org_branch_updated_idx"
  ON "product_stocks"("organizationId","branchId","updatedAt");
