import { Module } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  controllers: [RolesController],
  providers: [PermissionsService, RolesService],
  exports: [PermissionsService],
})
export class RbacModule {}
