import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    .setVersion('0.40.0')
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
  // #472: the contracts types routes answer with, generated from the types
  // themselves (scripts/generate-contract-schemas.mjs). A route names one with
  // @Returns, which leaves `x-returns` here; it becomes the schema of whichever
  // 2xx the route already declares — 201 for a POST, unless @HttpCode says
  // otherwise — so no second success code appears beside it.
  const contractSchemas = JSON.parse(
    readFileSync(join(import.meta.dirname, 'contract-schemas.json'), 'utf8'),
  ) as Record<string, unknown>;
  const schemas = ((doc.components ??= {}).schemas ??= {}) as Record<string, unknown>;
  for (const [name, schema] of Object.entries(contractSchemas)) schemas[name] ??= schema;

  for (const pathItem of Object.values(doc.paths)) {
    for (const op of Object.values(pathItem as Record<string, unknown>)) {
      if (op && typeof op === 'object' && 'responses' in op) {
        const responses = (op as { responses: Record<string, { description?: string; content?: unknown }> }).responses;
        const returns = (op as Record<string, unknown>)['x-returns'];
        if (typeof returns === 'string') {
          const code = Object.keys(responses).find((c) => /^2\d\d$/.test(c)) ?? '200';
          responses[code] = {
            ...responses[code],
            description: responses[code]?.description ?? '',
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${returns}` } } },
          };
          delete (op as Record<string, unknown>)['x-returns'];
        }
        responses['4XX'] ??= errorResponse;
        responses['5XX'] ??= errorResponse;
        const holder = op as { parameters?: unknown[] };
        holder.parameters = [...(holder.parameters ?? []), acceptLanguage];
      }
    }
  }
  return doc;
}
