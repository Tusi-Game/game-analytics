import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  message: string;
  timestamp: string;
  path: string;
}

/**
 * Global exception filter (SKELETON — spec 002 adds the "always 2xx ack" rule).
 *
 * Catches all exceptions, logs them, and returns a structured JSON body. Uses
 * the HTTP status from `HttpException`; unhandled errors become 500. It does NOT
 * yet enforce the ingest "always ack 2xx" behaviour — that is spec 002's job.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = this.resolveMessage(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${request.method} ${request.url} → ${status}: ${message}`);
    } else {
      this.logger.warn(`${request.method} ${request.url} → ${status}: ${message}`);
    }

    const body: ErrorBody = {
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(status).json(body);
  }

  private resolveMessage(exception: unknown): string {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        return res;
      }
      if (res && typeof res === 'object' && 'message' in res) {
        const { message } = res as { message: unknown };
        return Array.isArray(message) ? message.join(', ') : String(message);
      }
      return exception.message;
    }
    if (exception instanceof Error) {
      return exception.message;
    }
    return 'Internal server error';
  }
}
