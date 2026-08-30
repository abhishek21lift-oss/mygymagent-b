import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PtPackagesController } from './pt-packages.controller';
import { PtPackagesService } from './pt-packages.service';

@Module({
  controllers: [PtPackagesController],
  providers: [PtPackagesService, PrismaService],
  exports: [PtPackagesService],
})
export class PtPackagesModule {}
