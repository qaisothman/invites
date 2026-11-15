// The HTTP client: fetch plus the two things every screen would otherwise
// repeat, error parsing and access-token refresh.
//
// No Expo or React imports here. Token storage and fetch are passed in, so
// the refresh logic runs unchanged in Jest (client.test.ts).

/** Every failure, HTTP or network, reaches callers as this one type. */
export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the request never got an answer. */
    readonly status: number,
    /** The API's machine-readable code, e.g. `invitation_already_pending`. */
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Echoed by the API; quote it when asking the backend team to look. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; details?: unknown };
  requestId?: string;
}

// The API always answers errors with
//   { error: { code, message, details? }, requestId }
// but a proxy or load balancer in between can answer with HTML or nothing.
// Those still become an ApiError, with a code made from the status.
export async function parseError(res: Response): Promise<ApiError> {
  let body: ErrorBody | undefined;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = undefined;
  }
  const e = body?.error;
  if (e && typeof e.code === 'string') {
    return new ApiError(
      res.status,
      e.code,
      typeof e.message === 'string' ? e.message : 'Request failed',
      e.details,
      body?.requestId,
    );
  }
  return new ApiError(
    res.status,
    `http_${res.status}`,
    `Request failed (${res.status})`,
  );
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** Where the client reads and writes the session (src/auth/session.ts). */
export interface TokenStore {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  save(tokens: Tokens): Promise<void>;
  /** The session is over: forget the tokens (the app shows sign-in). */
  clear(): Promise<void>;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

// Past this a request fails as a network error. Without a limit a stalled
// connection waits for the platform's own, holding up sign-out and every
// request queued behind a refresh.
const TIMEOUT_MS = 15_000;

export function createApiClient(options: {
  baseUrl: string;
  tokens: TokenStore;
  /** Defaults to the global fetch; tests pass a fake. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}) {
  const { baseUrl, tokens } = options;
  const fetchFn = options.fetch ?? fetch;

  async function send<T>(
    method: Method,
    path: string,
    body: unknown,
    accessToken: string | null,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;

    const networkError = () =>
      new ApiError(
        0,
        'network_error',
        "Can't reach the server. Check your connection and try again.",
      );
    // The limit covers the body too: an answer whose body stalls after the
    // headers would otherwise never settle, and could hold the refresh that
    // every other request waits on. Not every platform's fetch stops reading
    // a body on abort, so the read itself races the timer.
    const controller = new AbortController();
    const timedOut = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(networkError())),
    );
    timedOut.catch(() => undefined); // never an unhandled rejection
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const read = <R>(p: Promise<R>) => Promise.race([p, timedOut]);
    try {
      let res: Response;
      try {
        res = await read(
          fetchFn(baseUrl + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
          }),
        );
      } catch {
        throw networkError();
      }
      if (!res.ok) throw await read(parseError(res));
      if (res.status === 204) return undefined as T;
      return (await read(res.json())) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // Single flight: when several requests find the access token expired at
  // once, they all wait on one refresh. Refresh tokens rotate: parallel
  // refreshes are each answered (the server's grace window), but the app could
  // keep a token the server has already replaced, and presenting that later
  // reads as theft (`refresh_token_reused`) and signs the user out everywhere.
  let refreshing: Promise<string> | null = null;

  function refreshAccessToken(): Promise<string> {
    if (!refreshing) {
      // .finally runs after this assignment, so the slot is always freed.
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function doRefresh(): Promise<string> {
    const refreshToken = tokens.getRefreshToken();
    try {
      if (!refreshToken) {
        throw new ApiError(401, 'not_signed_in', 'Please sign in');
      }
      const next = await send<Tokens>(
        'POST',
        '/auth/refresh',
        { refreshToken },
        null,
      );
      // Save before anyone retries: the old refresh token is now dead.
      await tokens.save(next);
      return next.accessToken;
    } catch (e) {
      // A 401 means the server rejected the refresh token (expired, revoked,
      // reused): the session is over. A network error doesn't: the token may
      // still be good, so keep it and let the screen show the error.
      if (e instanceof ApiError && e.status === 401) await tokens.clear();
      throw e;
    }
  }

  /** A signed-in request. Refreshes the access token once if it expired. */
  async function request<T>(
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<T> {
    // After a cold start only the refresh token exists (the access token
    // lives in memory), so the first request gets one.
    const token = tokens.getAccessToken() ?? (await refreshAccessToken());
    try {
      return await send<T>(method, path, body, token);
    } catch (e) {
      if (
        !(e instanceof ApiError && e.status === 401 && e.code === 'invalid_token')
      ) {
        throw e;
      }
      // If another request refreshed while this one was in flight, use its
      // token instead of refreshing again.
      const current = tokens.getAccessToken();
      const fresh =
        current && current !== token ? current : await refreshAccessToken();
      // Retry once. A second 401 is a real answer, not an expired token.
      return send<T>(method, path, body, fresh);
    }
  }

  /** Sign-in endpoints: no token, no refresh. */
  function publicRequest<T>(method: Method, path: string, body?: unknown) {
    return send<T>(method, path, body, null);
  }

  return { request, publicRequest };
}
