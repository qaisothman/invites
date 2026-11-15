import 'reflect-metadata';
import { validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  JWT_SECRET: 'a-secret-that-is-at-least-32-characters',
};

describe('validateEnv', () => {
  it('reads true/1 and false/0 as booleans', () => {
    expect(validateEnv({ ...base, WORKERS_ENABLED: '1' }).WORKERS_ENABLED).toBe(
      true,
    );
    expect(
      validateEnv({ ...base, WORKERS_ENABLED: 'false' }).WORKERS_ENABLED,
    ).toBe(false);
    expect(validateEnv({ ...base, LOG_REQUESTS: '0' }).LOG_REQUESTS).toBe(
      false,
    );
  });

  it('refuses any other boolean spelling instead of reading it as false', () => {
    for (const value of ['yes', 'TRUE', 'on', ''])
      expect(() => validateEnv({ ...base, WORKERS_ENABLED: value })).toThrow(
        /WORKERS_ENABLED/,
      );
  });

  it('defaults to logging requests and trusting no proxy', () => {
    expect(validateEnv(base)).toMatchObject({
      LOG_REQUESTS: true,
      TRUST_PROXY_HOPS: 0,
    });
  });

  describe('TRUST_PROXY_HOPS in production', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
    };

    it('is required', () => {
      for (const env of [production, { ...production, TRUST_PROXY_HOPS: '' }])
        expect(() => validateEnv(env)).toThrow(
          /TRUST_PROXY_HOPS must be set in production/,
        );
    });

    it('accepts 0 when it is set', () => {
      for (const value of ['0', '1'])
        expect(
          validateEnv({ ...production, TRUST_PROXY_HOPS: value })
            .TRUST_PROXY_HOPS,
        ).toBe(Number(value));
    });
  });
});
