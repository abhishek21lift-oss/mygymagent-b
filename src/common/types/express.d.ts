import type { AuthenticatedUser } from './authenticated-user';

declare module 'express-serve-static-core' {
  interface Request {
    /** Populated by Passport from JwtStrategy.validate(); absent on @Public() routes. */
    user?: AuthenticatedUser;
    /** Populated by the cookie-parser middleware registered in main.ts. */
    cookies: Record<string, string>;
  }
}
