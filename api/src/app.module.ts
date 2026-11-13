import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { EnvironmentVariables, validateEnv } from './config/env.validation';
import { typeOrmOptions } from './database/typeorm.options';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        typeOrmOptions(config.get('DATABASE_URL', { infer: true })),
    }),
  ],
  controllers: [HealthController],
  providers: [
    // Registered here rather than in main.ts so they also apply in tests,
    // which build the app from this module without running main.ts.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true, // strip properties the DTO doesn't declare
        forbidNonWhitelisted: true, // ...and reject the request if any were sent
        transform: true, // give handlers real DTO instances and typed params
      }),
    },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
