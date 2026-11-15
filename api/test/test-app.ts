import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';

export type TestApp = INestApplication<App>;

// Builds the real app from AppModule against the test database, with the
// migrations applied. `customise` lets a test swap a provider.
export async function createTestApp(
  customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestApp> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customise) builder = customise(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<TestApp>();
  await app.init();
  await app.get(DataSource).runMigrations();
  return app;
}

// Empties every table between tests, keeping the migrations record.
export async function resetDatabase(app: TestApp) {
  const db = app.get(DataSource);
  const tables = db.entityMetadatas.map((m) => `"${m.tableName}"`);
  await db.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}
