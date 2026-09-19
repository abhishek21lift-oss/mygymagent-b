-- Product-level inventory invariants.
ALTER TABLE "products"
  ADD CONSTRAINT "products_quantity_on_hand_nonnegative_chk"
    CHECK ("quantityOnHand" >= 0) NOT VALID,
  ADD CONSTRAINT "products_reorder_level_nonnegative_chk"
    CHECK ("reorderLevel" >= 0) NOT VALID,
  ADD CONSTRAINT "products_reorder_quantity_nonnegative_chk"
    CHECK ("reorderQuantity" >= 0) NOT VALID;
