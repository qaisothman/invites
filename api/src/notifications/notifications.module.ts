import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { AppConfig } from '../config/env.validation';
import { Notification } from './notification.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ExpoPushSender } from './providers/expo-push.sender';
import { FakePushSender } from './providers/fake-push.sender';
import { PUSH_SENDER } from './providers/push-sender';

@Module({
  imports: [TypeOrmModule.forFeature([Notification])],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    ExpoPushSender,
    FakePushSender,
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
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
