import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { EnvironmentVariables } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Lets in-flight work and the database pool close cleanly on SIGTERM
  // instead of being cut off mid-job during a deploy.
  app.enableShutdownHooks();
  const config = app.get(ConfigService<EnvironmentVariables, true>);
  await app.listen(config.get('PORT', { infer: true }));
}
void bootstrap();
