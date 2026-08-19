import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as reachable without authentication. Everything else is
 * denied by default (see JwtAuthGuard, registered globally). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
