import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Sprint 6 — unified error envelope for NestJS.
 * Every non-success response is normalized to:
 *   { error: true, code: "UPPER_SNAKE", message: string, details?: object, status: number }
 * Keeps backwards compat: if the thrown response already has { error, code, message } — forward it.
 */

const STATUS_CODE_MAP: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'UPSTREAM_ERROR',
  503: 'SERVICE_UNAVAILABLE',
  504: 'UPSTREAM_TIMEOUT',
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('GlobalExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let rawResponse: any = null;
    let message = 'Internal server error';
    let code: string | undefined;
    let details: any = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      rawResponse = exception.getResponse();
    } else if (exception instanceof Error) {
      message = exception.message || message;
    }

    // HttpException may return a string or an object
    if (rawResponse) {
      if (typeof rawResponse === 'string') {
        message = rawResponse;
      } else if (typeof rawResponse === 'object') {
        // Already in unified envelope? forward (only normalize status)
        if (rawResponse.error === true && rawResponse.code && rawResponse.message) {
          const payload = { ...rawResponse, status };
          if (status >= 500) {
            this.logger.error(
              `${request?.method} ${request?.url} → ${status} ${payload.code}`,
              exception instanceof Error ? exception.stack : undefined,
            );
          }
          response.status(status).json(payload);
          return;
        }
        // class-validator / NestJS pipe style: { message, error, statusCode }
        if (Array.isArray(rawResponse.message)) {
          message = 'Validation failed';
          code = 'VALIDATION_ERROR';
          details = { errors: rawResponse.message };
        } else if (typeof rawResponse.message === 'string') {
          message = rawResponse.message;
        }
        if (!code && typeof rawResponse.error === 'string') {
          // Nest default "error" field is a human-readable status e.g. "Not Found"
          code = rawResponse.error.toString().toUpperCase().replace(/\s+/g, '_');
        }
      }
    }

    if (!code) {
      code = STATUS_CODE_MAP[status] || 'INTERNAL_ERROR';
    }

    if (status >= 500) {
      this.logger.error(
        `${request?.method} ${request?.url} → ${status} ${code}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (status >= 400) {
      this.logger.warn(`${request?.method} ${request?.url} → ${status} ${code}: ${message}`);
    }

    response.status(status).json({
      error: true,
      code,
      message,
      ...(details ? { details } : {}),
      status,
    });
  }
}
