import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

// Runs before routing. Gives every request an id (reusing the caller's
// x-request-id when it looks sane), returns it in the response header, and logs
// one line per request when the response finishes. Support can then match a
// user's report to the exact log line.
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.header('x-request-id');
    req.requestId =
      incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      this.logger.log(
        JSON.stringify({
          requestId: req.requestId,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          ms: Math.round(ms),
        }),
      );
    });
    next();
  }
}
