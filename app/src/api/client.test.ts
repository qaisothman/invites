import { ApiError, createApiClient, type TokenStore } from './client';

// The client's two jobs that are easy to get wrong and hard to see in the
// UI: turning every failure into an ApiError, and refreshing the access token
// exactly once when several requests find it expired together.

/** Just enough of a fetch Response for the client. */
function reply(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError('Unexpected token <');
      return body;
    },
  } as Response;
}

function memoryTokens(
  initial: { accessToken: string | null; refreshToken: string } | null,
): TokenStore & { cleared: number } {
  let tokens = initial;
  return {
    cleared: 0,
    getAccessToken: () => tokens?.accessToken ?? null,
    getRefreshToken: () => tokens?.refreshToken ?? null,
    async save(next) {
      tokens = next;
    },
    async clear() {
      tokens = null;
      this.cleared += 1;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const expired = reply(401, {
  error: { code: 'invalid_token', message: 'Token is invalid or expired' },
});

describe('token refresh', () => {
  it('shares one refresh between concurrent 401s, then retries both', async () => {
    const tokens = memoryTokens({ accessToken: 'old', refreshToken: 'r1' });
    const refreshReply = deferred<Response>();
    const fetch = jest.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) return refreshReply.promise;
      const auth = (init.headers as Record<string, string>).authorization;
      return auth === 'Bearer new' ? reply(200, { url }) : expired;
    });
    const client = createApiClient({ baseUrl: 'http://api', tokens, fetch });

    const a = client.request('GET', '/a');
    const b = client.request('GET', '/b');
    await flush(); // both have had their 401 and are waiting on the refresh

    const refreshes = () =>
      fetch.mock.calls.filter(([url]) => url.endsWith('/auth/refresh'));
    expect(refreshes()).toHaveLength(1);
    expect(JSON.parse(refreshes()[0][1].body as string)).toEqual({
      refreshToken: 'r1',
    });

    refreshReply.resolve(reply(200, { accessToken: 'new', refreshToken: 'r2' }));
    await expect(a).resolves.toEqual({ url: 'http://api/a' });
    await expect(b).resolves.toEqual({ url: 'http://api/b' });

    expect(refreshes()).toHaveLength(1);
    // Refresh tokens rotate: the new one must replace the used one.
    expect(tokens.getRefreshToken()).toBe('r2');
  });

  it('gets an access token first after a cold start', async () => {
    // Only the refresh token survives a restart.
    const tokens = memoryTokens({ accessToken: null, refreshToken: 'r1' });
    const fetch = jest.fn(async (url: string) =>
      url.endsWith('/auth/refresh')
        ? reply(200, { accessToken: 'new', refreshToken: 'r2' })
        : reply(200, { ok: true }),
    );
    const client = createApiClient({ baseUrl: 'http://api', tokens, fetch });

    await expect(client.request('GET', '/users/me')).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://api/auth/refresh',
      'http://api/users/me',
    ]);
  });

  it('ends the session once when the refresh token is rejected', async () => {
    const tokens = memoryTokens({ accessToken: 'old', refreshToken: 'r1' });
    const fetch = jest.fn(async (url: string) =>
      url.endsWith('/auth/refresh')
        ? reply(401, {
            error: { code: 'refresh_token_reused', message: 'Signed out for safety' },
          })
        : expired,
    );
    const client = createApiClient({ baseUrl: 'http://api', tokens, fetch });

    const results = await Promise.allSettled([
      client.request('GET', '/a'),
      client.request('GET', '/b'),
    ]);

    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        status: 401,
        code: 'refresh_token_reused',
      });
    }
    expect(tokens.cleared).toBe(1);
    expect(tokens.getRefreshToken()).toBeNull();
  });

  it('keeps the session when the refresh fails for lack of network', async () => {
    const tokens = memoryTokens({ accessToken: 'old', refreshToken: 'r1' });
    const fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) throw new TypeError('Network request failed');
      return expired;
    });
    const client = createApiClient({ baseUrl: 'http://api', tokens, fetch });

    await expect(client.request('GET', '/a')).rejects.toMatchObject({
      code: 'network_error',
    });
    expect(tokens.cleared).toBe(0);
    expect(tokens.getRefreshToken()).toBe('r1');
  });
});

describe('error parsing', () => {
  const tokens = () => memoryTokens({ accessToken: 'a', refreshToken: 'r' });

  it("reads the API's error body", async () => {
    const fetch = jest.fn(async () =>
      reply(409, {
        error: {
          code: 'invitation_already_pending',
          message: 'You already have an open invitation to this member',
        },
        requestId: 'req-1',
      }),
    );
    const client = createApiClient({ baseUrl: 'http://api', tokens: tokens(), fetch });

    const error = await client.request('POST', '/invitations', {}).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'invitation_already_pending',
      message: 'You already have an open invitation to this member',
      requestId: 'req-1',
    });
  });

  it('keeps validation details', async () => {
    const fetch = jest.fn(async () =>
      reply(400, {
        error: {
          code: 'validation_failed',
          message: 'The request body is invalid',
          details: ['password must be longer than or equal to 10 characters'],
        },
      }),
    );
    const client = createApiClient({ baseUrl: 'http://api', tokens: tokens(), fetch });

    await expect(client.publicRequest('POST', '/auth/register', {})).rejects.toMatchObject({
      code: 'validation_failed',
      details: ['password must be longer than or equal to 10 characters'],
    });
  });

  it('turns a non-JSON error page into an ApiError', async () => {
    const fetch = jest.fn(async () => reply(502, '<html>Bad Gateway</html>'));
    const client = createApiClient({ baseUrl: 'http://api', tokens: tokens(), fetch });

    await expect(client.request('GET', '/users/me')).rejects.toMatchObject({
      status: 502,
      code: 'http_502',
    });
  });

  it('turns a network failure into status 0', async () => {
    const fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const client = createApiClient({ baseUrl: 'http://api', tokens: tokens(), fetch });

    await expect(client.request('GET', '/users/me')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });

  it('gives up on a stalled request after 15 seconds', async () => {
    jest.useFakeTimers();
    try {
      const fetch = jest.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(new Error('Aborted'))),
          ),
      );
      const client = createApiClient({ baseUrl: 'http://api', tokens: tokens(), fetch });

      const request = client.request('GET', '/users/me');
      jest.advanceTimersByTime(14_999);
      expect(fetch.mock.calls[0][1].signal?.aborted).toBe(false);
      jest.advanceTimersByTime(1);
      await expect(request).rejects.toMatchObject({ status: 0, code: 'network_error' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up on a body that stalls after the headers, so a refresh can run again', async () => {
    jest.useFakeTimers();
    try {
      // Headers arrive, then the body never does, on success and on error.
      const stalled = (status: number) =>
        ({
          ok: status < 300,
          status,
          json: () => new Promise(() => undefined),
        }) as Response;
      const tokens = memoryTokens({ accessToken: null, refreshToken: 'r1' });
      const fetch = jest
        .fn()
        .mockResolvedValueOnce(stalled(200)) // the refresh
        .mockResolvedValueOnce(reply(200, { accessToken: 'a', refreshToken: 'r2' }))
        .mockResolvedValueOnce(stalled(500));
      const client = createApiClient({ baseUrl: 'http://api', tokens, fetch });

      const first = expect(client.request('GET', '/users/me')).rejects.toMatchObject({
        status: 0,
        code: 'network_error',
      });
      await jest.advanceTimersByTimeAsync(15_000);
      await first;
      expect(tokens.cleared).toBe(0);

      // The refresh slot was freed: the next request refreshes again.
      const second = expect(client.request('GET', '/users/me')).rejects.toMatchObject({
        status: 0,
        code: 'network_error',
      });
      await jest.advanceTimersByTimeAsync(15_000);
      await second;
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        'http://api/auth/refresh',
        'http://api/auth/refresh',
        'http://api/users/me',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
});
