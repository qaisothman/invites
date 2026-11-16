import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../users/user.entity';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

// Every route needs a valid access token unless it is marked @Public().
// Secure by default: a new endpoint someone forgets to annotate stays closed.
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES, roles);
