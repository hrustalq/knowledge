import { IsOptional, IsString, IsNotEmpty, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProjectDto {
  // Field name must stay `workspaceId`: @Access('editor', 'body') resolves it.
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  // Explicit `type: String` on a nullable property — without it openapi-typescript
  // emits Record<string, never> and the web typecheck breaks at every call site.
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: CreateProjectDto) => o.description !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class UpdateProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  /** `null` clears the description; omitting the field leaves it untouched. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateProjectDto) => o.description !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}
