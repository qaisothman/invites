import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config/env.validation';
import { MetricsService } from '../metrics/metrics.service';

// Gives the request an id, once: the caller's x-request-id when it looks
// sane, a new UUID otherwise, and returns it in the response header. Also
// called by the exception filter, for errors raised before this middleware
// ran (a body the parser refused).
export function ensureRequestId(req: Request, res: Response): string {
  if (!req.requestId) {
    const incoming = req.header('x-request-id');
    req.requestId =
      incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
  }
  return req.requestId;
}

// Runs before routing. Gives every request an id and, when the response
// finishes, logs one JSON line and records its latency. Support can then
// match a user's report to the exact log line.
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');
  private readonly logRequests: boolean;

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.logRequests = config.get('LOG_REQUESTS', { infer: true });
  }

  use(req: Request, res: Response, next: NextFunction) {
    ensureRequestId(req, res);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      // The route pattern (/invitations/:id), not the raw URL, so the metric
      // has one series per endpoint instead of one per id.
      const route =
        (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      if (route !== '/metrics') {
        this.metrics.httpDuration
          .labels(req.method, route, String(res.statusCode))
          .observe(seconds);
      }
      if (this.logRequests) {
        this.logger.log(
          JSON.stringify({
            requestId: req.requestId,
            userId: req.user?.id,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            ms: Math.round(seconds * 1000),
          }),
        );
      }
    });
    next();
  }
}
