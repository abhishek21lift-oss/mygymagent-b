-- Complete Inventory OS v2
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'OPENING';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'TRANSFER_IN';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'TRANSFER_OUT';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'RETURN';

CREATE TYPE "InventoryPurchaseOrderStatus" AS ENUM ('DRAFT','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED');
CREATE TYPE "InventoryTransferStatus" AS ENUM ('DRAFT','IN_TRANSIT','RECEIVED','CANCELLED');
CREATE TYPE "InventorySaleStatus" AS ENUM ('COMPLETED','CANCELLED','RETURNED');

ALTER TABLE "products"
  ADD COLUMN "reorderQuantity" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "barcode" TEXT,
  ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'unit';

CREATE UNIQUE INDEX "products_organizationId_barcode_key" ON "products"("organizationId","barcode");
CREATE INDEX "products_organizationId_category_isActive_idx" ON "products"("organizationId","category","isActive");

ALTER TABLE "stock_movements"
  ADD COLUMN "branchId" TEXT,
  ADD COLUMN "unitCost" DECIMAL(10,2),
  ADD COLUMN "totalCost" DECIMAL(12,2),
  ADD COLUMN "referenceType" TEXT,
  ADD COLUMN "referenceId" TEXT;

CREATE INDEX "stock_movements_organizationId_branchId_createdAt_idx" ON "stock_movements"("organizationId","branchId","createdAt");
CREATE INDEX "stock_movements_organizationId_referenceType_referenceId_idx" ON "stock_movements"("organizationId","referenceType","referenceId");

CREATE TABLE "product_stocks" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantityOnHand" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_stocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_stocks_organizationId_branchId_productId_key" ON "product_stocks"("organizationId","branchId","productId");
CREATE INDEX "product_stocks_organizationId_branchId_idx" ON "product_stocks"("organizationId","branchId");
CREATE INDEX "product_stocks_productId_idx" ON "product_stocks"("productId");

CREATE TABLE "inventory_suppliers" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "address" TEXT,
  "taxId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inventory_suppliers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "inventory_suppliers_organizationId_isActive_idx" ON "inventory_suppliers"("organizationId","isActive");

CREATE TABLE "inventory_purchase_orders" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "branchId" TEXT,
  "number" TEXT NOT NULL,
  "status" "InventoryPurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "notes" TEXT,
  "orderedAt" TIMESTAMP(3),
  "expectedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3),
  "totalCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inventory_purchase_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_purchase_orders_organizationId_number_key" ON "inventory_purchase_orders"("organizationId","number");
CREATE INDEX "inventory_purchase_orders_organizationId_status_idx" ON "inventory_purchase_orders"("organizationId","status");
CREATE INDEX "inventory_purchase_orders_supplierId_idx" ON "inventory_purchase_orders"("supplierId");

CREATE TABLE "inventory_purchase_order_items" (
  "id" TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "orderedQuantity" INTEGER NOT NULL,
  "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
  "unitCost" DECIMAL(10,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inventory_purchase_order_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_purchase_order_items_purchaseOrderId_productId_key" ON "inventory_purchase_order_items"("purchaseOrderId","productId");
CREATE INDEX "inventory_purchase_order_items_productId_idx" ON "inventory_purchase_order_items"("productId");

CREATE TABLE "inventory_transfers" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "fromBranchId" TEXT NOT NULL,
  "toBranchId" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "status" "InventoryTransferStatus" NOT NULL DEFAULT 'DRAFT',
  "notes" TEXT,
  "shippedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inventory_transfers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_transfers_organizationId_number_key" ON "inventory_transfers"("organizationId","number");
CREATE INDEX "inventory_transfers_organizationId_status_idx" ON "inventory_transfers"("organizationId","status");
CREATE INDEX "inventory_transfers_fromBranchId_idx" ON "inventory_transfers"("fromBranchId");
CREATE INDEX "inventory_transfers_toBranchId_idx" ON "inventory_transfers"("toBranchId");

CREATE TABLE "inventory_transfer_items" (
  "id" TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  CONSTRAINT "inventory_transfer_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_transfer_items_transferId_productId_key" ON "inventory_transfer_items"("transferId","productId");
CREATE INDEX "inventory_transfer_items_productId_idx" ON "inventory_transfer_items"("productId");

CREATE TABLE "inventory_sales" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "memberId" TEXT,
  "invoiceId" TEXT,
  "createdByUserId" TEXT,
  "number" TEXT NOT NULL,
  "status" "InventorySaleStatus" NOT NULL DEFAULT 'COMPLETED',
  "subtotal" DECIMAL(12,2) NOT NULL,
  "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_sales_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_sales_organizationId_number_key" ON "inventory_sales"("organizationId","number");
CREATE INDEX "inventory_sales_organizationId_createdAt_idx" ON "inventory_sales"("organizationId","createdAt");
CREATE INDEX "inventory_sales_organizationId_branchId_createdAt_idx" ON "inventory_sales"("organizationId","branchId","createdAt");
CREATE INDEX "inventory_sales_memberId_idx" ON "inventory_sales"("memberId");
CREATE INDEX "inventory_sales_invoiceId_idx" ON "inventory_sales"("invoiceId");

CREATE TABLE "inventory_sale_items" (
  "id" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitPrice" DECIMAL(10,2) NOT NULL,
  "unitCost" DECIMAL(10,2) NOT NULL,
  "total" DECIMAL(12,2) NOT NULL,
  CONSTRAINT "inventory_sale_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "inventory_sale_items_productId_idx" ON "inventory_sale_items"("productId");

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_suppliers" ADD CONSTRAINT "inventory_suppliers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_purchase_orders" ADD CONSTRAINT "inventory_purchase_orders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_purchase_orders" ADD CONSTRAINT "inventory_purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "inventory_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_purchase_orders" ADD CONSTRAINT "inventory_purchase_orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_purchase_order_items" ADD CONSTRAINT "inventory_purchase_order_items_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "inventory_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_purchase_order_items" ADD CONSTRAINT "inventory_purchase_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_fromBranchId_fkey" FOREIGN KEY ("fromBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_transfer_items" ADD CONSTRAINT "inventory_transfer_items_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "inventory_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_transfer_items" ADD CONSTRAINT "inventory_transfer_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_sales" ADD CONSTRAINT "inventory_sales_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_sales" ADD CONSTRAINT "inventory_sales_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_sales" ADD CONSTRAINT "inventory_sales_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_sales" ADD CONSTRAINT "inventory_sales_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_sales" ADD CONSTRAINT "inventory_sales_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_sale_items" ADD CONSTRAINT "inventory_sale_items_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "inventory_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_sale_items" ADD CONSTRAINT "inventory_sale_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
