import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  message: string;
  timestamp: string;
  path: string;
  /** Backpressure reason (memory_watermark / queue_depth / rate_limited) if any. */
  reason?: string;
}

/** Env fallback for the Retry-After header (seconds) on backpressure responses. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * Global exception filter. Returns a structured JSON body and — for the
 * backpressure statuses 503 (memory-watermark / queue-depth) and 429 (per-game
 * rate cap) — sets a `Retry-After` header so the SDK backs off and retains the
 * batch (ops-envelope §4/§5). The Retry-After seconds come from the exception's
 * response body when the shedder supplies one, else `RETRY_AFTER_SECONDS`/default.
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
    const reason = this.resolveReason(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${request.method} ${request.url} → ${status}: ${message}`);
    } else {
      this.logger.warn(`${request.method} ${request.url} → ${status}: ${message}`);
    }

    // Retry-After for backpressure (503) + rate-limit (429) — the SDK owns
    // offline buffering + backoff (08/09), so a shed batch is retained + retried.
    if (status === HttpStatus.SERVICE_UNAVAILABLE || status === HttpStatus.TOO_MANY_REQUESTS) {
      const retryAfter = Number(process.env.RETRY_AFTER_SECONDS) || DEFAULT_RETRY_AFTER_SECONDS;
      response.setHeader('Retry-After', String(retryAfter));
    }

    const body: ErrorBody = {
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(reason ? { reason } : {}),
    };

    response.status(status).json(body);
  }

  /** Pull the backpressure `reason` from the exception body, if present. */
  private resolveReason(exception: unknown): string | undefined {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (res && typeof res === 'object' && 'reason' in res) {
        const { reason } = res as { reason: unknown };
        return typeof reason === 'string' ? reason : undefined;
      }
    }
    return undefined;
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
