import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './test-app';

describe('App skeleton (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health answers when the database is up', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('reuses a sane x-request-id from the caller', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('x-request-id', 'client-abc-12345');
    expect(res.headers['x-request-id']).toBe('client-abc-12345');
  });

  it('returns every error in one shape, with the request id', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .expect(404);
    expect(res.body).toEqual({
      error: { code: 'not_found', message: expect.any(String) as string },
      requestId: res.headers['x-request-id'],
    });
  });
});
