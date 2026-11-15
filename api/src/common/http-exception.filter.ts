import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ensureRequestId } from './request-id.middleware';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  429: 'rate_limited',
};

// What Express's body parser throws for a body it won't read (too large, an
// encoding it doesn't support): not an HttpException, but a 4xx status of
// its own.
const isClientError = (e: unknown): e is { status: number } => {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
};

// Catches everything thrown anywhere in the request (guards, pipes,
// controllers, services) and turns it into one response shape:
//   { error: { code, message, details? }, requestId }
// Code can throw `new ConflictException({ code: 'x', message: 'y' })` to pick
// its own code. Unknown errors become a 500 whose details stay in the log.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = ensureRequestId(req, res);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'Something went wrong';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODE_BY_STATUS[status] ?? 'error';
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const b = body as { code?: string; message?: string | string[] };
        if (Array.isArray(b.message)) {
          // ValidationPipe puts one message per failed rule here.
          code = 'validation_failed';
          message = 'The request body is invalid';
          details = b.message;
        } else {
          message = b.message ?? exception.message;
        }
        if (b.code) code = b.code;
      }
    } else if (isClientError(exception)) {
      status = exception.status;
      code = CODE_BY_STATUS[status] ?? 'bad_request';
      message =
        status === HttpStatus.PAYLOAD_TOO_LARGE
          ? 'The request body is too large'
          : 'The request could not be read';
    } else {
      this.logger.error(
        JSON.stringify({
          requestId,
          path: req.originalUrl.split('?')[0], // no query: it can carry a signed token
        }),
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json({
      error: { code, message, ...(details ? { details } : {}) },
      requestId,
    });
  }
}
