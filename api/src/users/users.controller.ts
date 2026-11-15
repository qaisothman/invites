import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth-user';
import { toMe } from './user.entity';
import { LookupUserQuery, UpdateMeDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return toMe(await this.users.get(user.id));
  }

  @Patch('me')
  async updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return toMe(await this.users.updateMe(user.id, dto));
  }

  @Get('lookup')
  lookup(@Query() query: LookupUserQuery) {
    return this.users.lookupByEmail(query.email);
  }
}
