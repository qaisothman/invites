import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { FakePushSender } from '../src/notifications/providers/fake-push.sender';

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

// Empties every table between tests, keeping the migrations record, and
// forgets what the fake providers saw.
export async function resetDatabase(app: TestApp) {
  const db = app.get(DataSource);
  const tables = db.entityMetadatas.map((m) => `"${m.tableName}"`);
  await db.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  app.get(FakePushSender).reset();
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  refreshToken: string;
}

interface AuthBody {
  accessToken: string;
  refreshToken: string;
  user: { id: string };
}

export async function registerUser(
  app: TestApp,
  overrides: Partial<{
    email: string;
    displayName: string;
  }> = {},
): Promise<TestUser> {
  const email = overrides.email ?? `u-${randomUUID().slice(0, 8)}@example.com`;
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      email,
      password: 'correct horse battery',
      displayName: overrides.displayName ?? 'Test User',
      ...overrides,
    })
    .expect(201);
  const body = res.body as AuthBody;
  return {
    id: body.user.id,
    email,
    token: body.accessToken,
    refreshToken: body.refreshToken,
  };
}

export async function addDevice(
  app: TestApp,
  user: TestUser,
  token = `ExponentPushToken[${randomUUID()}]`,
  report: { platform?: 'ios' | 'android'; notifications?: string } = {},
) {
  await request(app.getHttpServer())
    .post('/devices')
    .set('authorization', `Bearer ${user.token}`)
    .send({ expoPushToken: token, platform: 'ios', ...report })
    .expect(201);
  return token;
}

export const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
