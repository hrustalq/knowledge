import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { ApiErrorResponse } from '../common/api-error.dto.js';

/**
 * Single source of truth for the OpenAPI document — used by main.ts (live
 * /docs) and by scripts/generate-openapi.main.ts (make api-schema), so the
 * generated client can never drift from what the server serves.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Knowledge API')
    .setDescription('Dynamic Knowledge Platform — documents, revisions, ingestion, search')
    .setVersion('0.9.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', description: 'kn_ API key or ks_ session token (AUTH_MODE=api-key)' },
      'bearer',
    )
    .build();

  const doc = SwaggerModule.createDocument(app, config, { extraModels: [ApiErrorResponse] });

  // Strict error contract: advertise the ApiErrorResponse envelope as the
  // 4XX/5XX shape of EVERY operation (ApiExceptionFilter guarantees it), so
  // openapi-typescript consumers get typed errors without per-route decorators.
  const errorResponse = {
    description: 'Error envelope — all non-2xx responses conform to ApiErrorResponse',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorResponse' } } },
  };
  // docs/features/18: every route honours Accept-Language, so it is stamped
  // here rather than decorated onto 144 handlers.
  const acceptLanguage = {
    name: 'Accept-Language',
    in: 'header',
    required: false,
    description: 'Response language (docs/features/18). Supported: en, ru. Default: en.',
    schema: { type: 'string', enum: ['en', 'ru'] },
  };
  for (const pathItem of Object.values(doc.paths)) {
    for (const op of Object.values(pathItem as Record<string, unknown>)) {
      if (op && typeof op === 'object' && 'responses' in op) {
        const responses = (op as { responses: Record<string, unknown> }).responses;
        responses['4XX'] ??= errorResponse;
        responses['5XX'] ??= errorResponse;
        const holder = op as { parameters?: unknown[] };
        holder.parameters = [...(holder.parameters ?? []), acceptLanguage];
      }
    }
  }
  return doc;
}
