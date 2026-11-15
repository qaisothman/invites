import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { AppConfig } from '../config/env.validation';
import { DevicesModule } from '../devices/devices.module';
import { AckTokens } from './ack-tokens';
import { OutboxDispatcher } from './dispatcher';
import { EmailLinks } from './email-links';
import { EmailsController } from './emails.controller';
import { InvitationEmailer } from './invitation-emails';
import { Notification } from './notification.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ExpoPushSender } from './providers/expo-push.sender';
import { FakePushSender } from './providers/fake-push.sender';
import { PUSH_SENDER } from './providers/push-sender';
import {
  EMAIL_SENDER,
  FakeEmailSender,
  LogEmailSender,
} from './providers/email-sender';
import { ReceiptPoller } from './receipts';

@Module({
  imports: [TypeOrmModule.forFeature([Notification]), DevicesModule],
  controllers: [NotificationsController, EmailsController],
  providers: [
    NotificationsService,
    AckTokens,
    OutboxDispatcher,
    ReceiptPoller,
    InvitationEmailer,
    EmailLinks,
    ExpoPushSender,
    FakePushSender,
    LogEmailSender,
    FakeEmailSender,
    // Which implementation backs each interface is decided once, here, from
    // config. Nothing else in the codebase knows Expo exists.
    {
      provide: PUSH_SENDER,
      inject: [ConfigService, ExpoPushSender, FakePushSender],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        expo: ExpoPushSender,
        fake: FakePushSender,
      ) =>
        config.get('PUSH_DRIVER', { infer: true }) === 'fake' ? fake : expo,
    },
    {
      provide: EMAIL_SENDER,
      inject: [ConfigService, LogEmailSender, FakeEmailSender],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        log: LogEmailSender,
        fake: FakeEmailSender,
      ) => {
        if (config.get('EMAIL_DRIVER', { infer: true }) === 'fake') return fake;
        if (config.get('NODE_ENV', { infer: true }) === 'production')
          new Logger('Email').warn(
            'No email provider connected: invitation emails are logged, not sent',
          );
        return log;
      },
    },
  ],
  exports: [
    NotificationsService,
    OutboxDispatcher,
    ReceiptPoller,
    InvitationEmailer,
  ],
})
export class NotificationsModule {}
