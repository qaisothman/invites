import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public, Roles } from '../auth/decorators';
import { PageQuery } from '../common/pagination';
import { UserRole } from '../users/user.entity';
import { IsString, Length } from 'class-validator';
import { AckTokens } from './ack-tokens';
import { NotificationsService } from './notifications.service';

class AckDto {
  @IsString()
  @Length(20, 100)
  token: string;
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly ackTokens: AckTokens,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    return this.notifications.list(user.id, q);
  }

  // Called by the app when the push arrives (foreground or background
  // handler). Without this, "sent" is the last thing the server knows.
  @Post(':id/delivered')
  @HttpCode(204)
  async delivered(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.notifications.markDelivered(id, user.id);
  }

  // The same confirmation for a background task with no session: the push
  // carried a token signed for this one notification.
  @Public()
  @Post(':id/ack')
  @HttpCode(204)
  async ack(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AckDto) {
    if (!this.ackTokens.verify(id, dto.token)) {
      throw new UnauthorizedException({
        code: 'invalid_ack_token',
        message: 'This token does not match the notification',
      });
    }
    await this.notifications.markDeliveredById(id);
  }

  // Called when the user taps the push.
  @Post(':id/opened')
  @HttpCode(204)
  async opened(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.notifications.markOpened(id, user.id);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/users')
export class NotificationsAdminController {
  constructor(private readonly notifications: NotificationsService) {}

  // "User X says they never got the invitation": one call shows their
  // devices, each notification, and what happened to it on each device.
  @Get(':userId/notification-trace')
  trace(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.notifications.trace(userId);
  }
}
