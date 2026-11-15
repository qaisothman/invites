import type { AuthUser } from '../auth/auth-user';

// Fields this app adds to Express's Request object.
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      // Set by JwtAuthGuard on every authenticated request.
      user?: AuthUser;
    }
  }
}

export {};
