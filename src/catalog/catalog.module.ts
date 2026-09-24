import { Module } from '@nestjs/common';
import { CatalogSyncService } from './catalog-sync.service';

@Module({ providers: [CatalogSyncService] })
export class CatalogModule {}
