import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { API_ERROR_CODES, type ApiErrorCode, type ApiErrorPayload } from '@knowledge/contracts';

/**
 * Strict error envelope — the ONLY shape a non-2xx response can have
 * (enforced by ApiExceptionFilter, advertised on every operation by
 * createOpenApiDocument so generated clients get a typed error contract).
 */
export class ApiErrorResponse implements ApiErrorPayload {
  @ApiProperty({ example: 404, description: 'HTTP status (0 is reserved for client-synthesized errors)' })
  statusCode!: number;

  @ApiProperty({ enum: API_ERROR_CODES, example: 'NOT_FOUND', description: 'Stable machine-readable code — branch on this, never on message' })
  code!: ApiErrorCode;

  @ApiProperty({ example: 'Document 3f2a… not found' })
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Machine-readable extras: validation errors[], conflict currentHeadRevisionId/comparisonUrl, …',
  })
  details?: Record<string, unknown>;

  @ApiProperty({ example: '/v1/documents/3f2a' })
  path!: string;

  @ApiProperty({ example: '2026-09-02T12:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ description: 'Correlation id — echoed from the x-request-id request header (also set as a response header)' })
  requestId!: string;
}
