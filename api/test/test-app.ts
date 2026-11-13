import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';

// Builds the real app from AppModule against the test database, with the
// migrations applied. `customise` lets a test swap a provider, for example a
// fake push sender in place of Expo.
export async function createTestApp(
  customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customise) builder = customise(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  await app.init();
  await app.get(DataSource).runMigrations();
  return app;
}

// Empties every table between tests, keeping the migrations record.
export async function resetDatabase(app: INestApplication) {
  const db = app.get(DataSource);
  const tables = db.entityMetadatas.map((m) => `"${m.tableName}"`);
  if (tables.length > 0) {
    await db.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  }
}
