import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, RolesGuard, UserThrottlerGuard } from './auth/guards';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { onlyFor } from './common/quota';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { AppConfig, validateEnv } from './config/env.validation';
import { typeOrmOptions } from './database/typeorm.options';
import { HealthController } from './health/health.controller';
import { InvitationsModule } from './invitations/invitations.module';
import { MetricsModule } from './metrics/metrics.module';
import { NotificationsModule } from './notifications/notifications.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        typeOrmOptions(
          config.get('DATABASE_URL', { infer: true }),
          config.get('DB_POOL_SIZE', { infer: true }),
        ),
    }),
    // In-memory counters: correct for one API instance. With several, move
    // the storage to Redis (see docs/04-scaling-plan.md, stage 1).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        throttlers: [
          {
            name: 'default',
            ttl: 60_000,
            limit: config.get('THROTTLE_PER_MINUTE', { infer: true }),
          },
          {
            name: 'auth',
            ttl: 60_000,
            limit: config.get('AUTH_PER_MINUTE', { infer: true }),
            skipIf: onlyFor('auth'),
          },
          {
            name: 'invites',
            ttl: 3_600_000,
            limit: config.get('INVITES_PER_HOUR', { infer: true }),
            skipIf: onlyFor('invites'),
          },
        ],
      }),
    }),
    MetricsModule,
    AuthModule,
    UsersModule,
    NotificationsModule,
    InvitationsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global pipe, filter and guards are registered here rather than in
    // main.ts so they also apply in tests, which build the app from this
    // module without running main.ts.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true, // strip properties the DTO doesn't declare
        forbidNonWhitelisted: true, // ...and reject the request if any were sent
        transform: true, // give handlers real DTO instances and typed params
      }),
    },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // Guards run in this order: authenticate, authorise, then rate-limit.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
