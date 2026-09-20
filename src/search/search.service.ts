import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(organizationId: string, rawQuery: string, limit: number) {
    const q = rawQuery.trim();
    if (q.length < 2) {
      throw new BadRequestException(
        'Search query must contain at least 2 characters',
      );
    }

    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        type: string;
        title: string;
        subtitle: string | null;
        href: string | null;
        rank: number;
      }>
    >(
      `SELECT * FROM (
        SELECT id, 'member' AS type, concat("firstName",' ',"lastName") AS title, "phone" AS subtitle, concat('/members/',id) AS href,
               CASE WHEN lower(concat("firstName",' ',"lastName")) = lower($2) THEN 100 ELSE 80 END AS rank
        FROM members WHERE "organizationId"=$1 AND ("firstName" ILIKE $3 OR "lastName" ILIKE $3 OR "phone" ILIKE $3 OR COALESCE("email",'') ILIKE $3)
        UNION ALL
        SELECT id, 'lead', concat("firstName",' ',"lastName"), "phone", concat('/crm/leads/',id), 70
        FROM leads WHERE "organizationId"=$1 AND ("firstName" ILIKE $3 OR "lastName" ILIKE $3 OR "phone" ILIKE $3 OR COALESCE("email",'') ILIKE $3)
        UNION ALL
        SELECT id, 'product', name, sku, concat('/inventory/products/new?edit=',id), 60
        FROM products WHERE "organizationId"=$1 AND (name ILIKE $3 OR sku ILIKE $3 OR COALESCE(barcode,'') ILIKE $3)
        UNION ALL
        SELECT id, 'invoice', number, status::text, concat('/billing?invoice=',id), 50
        FROM invoices WHERE "organizationId"=$1 AND (number ILIKE $3)
      ) results ORDER BY rank DESC, title ASC LIMIT $4`,
      organizationId,
      q,
      like,
      limit,
    );

    return { query: q, results: rows };
  }
}
