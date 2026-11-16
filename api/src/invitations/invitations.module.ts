import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Invitation } from './invitation.entity';
import {
  FunnelController,
  InvitationsController,
} from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [TypeOrmModule.forFeature([Invitation]), NotificationsModule],
  controllers: [InvitationsController, FunnelController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
