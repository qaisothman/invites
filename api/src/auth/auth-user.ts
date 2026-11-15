import { UserRole } from '../users/user.entity';

// What a verified access token tells us about the caller. Deliberately small:
// anything that can change (name, email settings) is read from the database
// instead.
export interface AuthUser {
  id: string;
  role: UserRole;
}

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
}
