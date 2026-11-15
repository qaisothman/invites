import 'reflect-metadata';
import { validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  JWT_SECRET: 'a-secret-that-is-at-least-32-characters',
};

describe('validateEnv', () => {
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
