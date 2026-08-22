import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const LOOKBACK_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StockForecast {
  productId: string;
  sku: string;
  name: string;
  quantityOnHand: number;
  reorderLevel: number;
  atOrBelowReorderLevel: boolean;
  /// Units sold per day, averaged over the last LOOKBACK_DAYS -- 0 when
  /// there were no SALE movements in that window (not missing data).
  dailySalesRate: number;
  /// Null when dailySalesRate is 0 -- "no recent sales" doesn't forecast
  /// to "never runs out," it means there's nothing to forecast from.
  daysUntilStockout: number | null;
}

/**
 * Real stock-velocity forecasting from actual `StockMovement` history --
 * not a guess. `Product` isn't branch-scoped in this schema (see that
 * model's comment in schema.prisma), so there's no branch filter here.
 */
@Injectable()
export class InventoryIntelligenceService {
  constructor(private readonly prisma: PrismaService) {}

  async getStockForecast(organizationId: string): Promise<StockForecast[]> {
    const [products, salesByProduct] = await Promise.all([
      this.prisma.product.findMany({
        where: { organizationId, isActive: true },
        select: {
          id: true,
          sku: true,
          name: true,
          quantityOnHand: true,
          reorderLevel: true,
        },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['productId'],
        where: {
          organizationId,
          type: 'SALE',
          createdAt: { gte: new Date(Date.now() - LOOKBACK_DAYS * MS_PER_DAY) },
        },
        _sum: { quantity: true },
      }),
    ]);

    const soldByProduct = new Map(
      // StockMovement.quantity for a SALE is stored as a negative delta
      // (see StockMovementsService.resolveDelta) -- Math.abs turns it
      // back into "units sold," a positive count.
      salesByProduct.map((row) => [
        row.productId,
        Math.abs(Number(row._sum.quantity ?? 0)),
      ]),
    );

    return products
      .map((product) => {
        const unitsSold = soldByProduct.get(product.id) ?? 0;
        const dailySalesRate = unitsSold / LOOKBACK_DAYS;
        return {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          quantityOnHand: product.quantityOnHand,
          reorderLevel: product.reorderLevel,
          atOrBelowReorderLevel: product.quantityOnHand <= product.reorderLevel,
          dailySalesRate: Math.round(dailySalesRate * 100) / 100,
          daysUntilStockout:
            dailySalesRate > 0
              ? Math.floor(product.quantityOnHand / dailySalesRate)
              : null,
        };
      })
      .sort((a, b) => {
        // Soonest-to-stock-out first; products with no forecast (null)
        // sort last, not first (a real deadline outranks "unknown").
        if (a.daysUntilStockout === null) return 1;
        if (b.daysUntilStockout === null) return -1;
        return a.daysUntilStockout - b.daysUntilStockout;
      });
  }
}
