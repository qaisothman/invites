import request from 'supertest';
import { createTestApp, TestApp } from './test-app';

describe('App skeleton (e2e)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the liveness and readiness probes', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('reuses a sane x-request-id from the caller', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .set('x-request-id', 'client-abc-12345');
    expect(res.headers['x-request-id']).toBe('client-abc-12345');
  });

  it('replaces an x-request-id that is not sane', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .set('x-request-id', 'short');
    expect(res.headers['x-request-id']).not.toBe('short');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns every error in one shape, with the request id', async () => {
    // Unknown routes are a 404 before any guard runs.
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .expect(404);
    expect(res.body).toEqual({
      error: { code: 'not_found', message: expect.any(String) as string },
      requestId: res.headers['x-request-id'],
    });
  });

  it('gives a body it cannot read the same shape, with a 4xx', async () => {
    const malformed = await request(app.getHttpServer())
      .post('/auth/login')
      .set('content-type', 'application/json')
      .send('{bad')
      .expect(400);
    expect(malformed.body).toEqual({
      error: { code: 'bad_request', message: expect.any(String) as string },
      requestId: malformed.headers['x-request-id'],
    });

    const tooLarge = await request(app.getHttpServer())
      .post('/auth/login')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ email: 'x'.repeat(200_000) }))
      .expect(413);
    expect(tooLarge.body).toEqual({
      error: {
        code: 'payload_too_large',
        message: 'The request body is too large',
      },
      requestId: tooLarge.headers['x-request-id'],
    });
    expect(tooLarge.body.requestId).toEqual(expect.any(String));
  });

  it('exposes Prometheus metrics', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toContain('http_request_duration_seconds');
    expect(res.text).toContain('outbox_due');
    expect(res.text).toContain('invitation_emails_total');
    expect(res.text).toContain('device_reports_total');
  });
});
