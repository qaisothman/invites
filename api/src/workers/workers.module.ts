import { Module } from '@nestjs/common';
import { InvitationsModule } from '../invitations/invitations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkerRunner } from './worker-runner';

@Module({
  imports: [NotificationsModule, InvitationsModule],
  providers: [WorkerRunner],
})
export class WorkersModule {}
