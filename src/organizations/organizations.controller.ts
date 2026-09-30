import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import {
  MAX_LOGO_BYTES,
  OrganizationsService,
  type UploadedLogo,
} from './organizations.service';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('current')
  @RequirePermissions('organizations.read')
  getCurrent(@CurrentUser() user: AuthenticatedUser) {
    return this.organizationsService.getCurrent(user.organizationId!);
  }

  @Patch('current')
  @RequirePermissions('organizations.update')
  @Audited({ resource: 'organization', action: 'update' })
  updateCurrent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateCurrent(user.organizationId!, dto);
  }

  /** Multipart field `file`: PNG, JPEG or WebP, up to 2 MB. */
  @Post('current/logo')
  @RequirePermissions('organizations.update')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Audited({ resource: 'organization', action: 'update_logo' })
  @UseInterceptors(
    // Multer stops reading past the limit (413) rather than buffering a
    // huge upload; the service re-checks size and the real image type.
    FileInterceptor('file', { limits: { fileSize: MAX_LOGO_BYTES } }),
  )
  setLogo(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: UploadedLogo | undefined,
  ) {
    return this.organizationsService.setLogo(user.organizationId!, file);
  }

  @Delete('current/logo')
  @RequirePermissions('organizations.update')
  @Audited({ resource: 'organization', action: 'remove_logo' })
  removeLogo(@CurrentUser() user: AuthenticatedUser) {
    return this.organizationsService.removeLogo(user.organizationId!);
  }
}
