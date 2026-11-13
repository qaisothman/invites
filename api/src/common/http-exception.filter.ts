import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  429: 'rate_limited',
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
    } else {
      this.logger.error(
        JSON.stringify({ requestId: req.requestId, path: req.originalUrl }),
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json({
      error: { code, message, ...(details ? { details } : {}) },
      requestId: req.requestId,
    });
  }
}
