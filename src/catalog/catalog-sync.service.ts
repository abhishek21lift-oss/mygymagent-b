import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { catalogSyncChangedAnything, syncCatalogs } from './catalog-sync';

/**
 * Runs the catalog sync as part of coming up.
 *
 * Deliberately not caught: a boot that cannot converge the catalogs is a
 * boot whose RBAC is wrong, and the failure mode we are fixing is
 * precisely that such a state serves traffic while looking healthy. The
 * app cannot work without Postgres anyway, so failing here costs nothing
 * that was not already lost.
 *
 * `onApplicationBootstrap` rather than `onModuleInit` so this happens
 * once the whole graph is constructed, and before the HTTP server starts
 * accepting requests -- no request can observe a half-synced catalog.
 */
@Injectable()
export class CatalogSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    const report = await syncCatalogs(this.prisma);
    if (catalogSyncChangedAnything(report)) {
      // Worth a line at boot: on a healthy deploy this never prints, so
      // when it does it says exactly what the last release was missing.
      this.logger.log(`Catalogs converged: ${JSON.stringify(report)}`);
    }
  }
}
