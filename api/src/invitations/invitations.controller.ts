import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/decorators';
import { Quota } from '../common/quota';
import { UserRole } from '../users/user.entity';
import {
  CreateInvitationDto,
  FunnelQuery,
  ListInvitationsQuery,
} from './invitations.dto';
import { InvitationsService } from './invitations.service';

@ApiTags('invitations')
@ApiBearerAuth()
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  // Limited per user per hour (the 'invites' quota): spam protection for the
  // people being invited, which also caps the invitation emails they get when
  // push can't reach them.
  @Post()
  @Quota('invites')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateInvitationDto) {
    return this.invitations.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListInvitationsQuery) {
    return this.invitations.list(user.id, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invitations.getForUser(id, user.id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.invitations.respond(id, user.id, 'accept');
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.invitations.respond(id, user.id, 'decline');
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.invitations.cancel(id, user.id);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/funnel')
export class FunnelController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get('invitations')
  funnel(@Query() q: FunnelQuery) {
    return this.invitations.funnel(q.from, q.to);
  }
}
