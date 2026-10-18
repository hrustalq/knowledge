import {
  Body,
  Controller,
  createParamDecorator,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/access.decorator.js';
import type { Env } from '../config/env.js';
import { SCIM_CONTENT_TYPE } from './scim-errors.js';
import { listResponse, resourceTypes, schemas, serviceProviderConfig } from './scim-resources.js';
import { ScimTokenGuard } from './scim-token.guard.js';
import { ScimService, type ScimCaller, type ScimPageQuery } from './scim.service.js';

/** The workspace and token `ScimTokenGuard` resolved. */
const Caller = createParamDecorator((_: unknown, ctx: ExecutionContext): ScimCaller => ctx.switchToHttp().getRequest().scim);

type Doc = Record<string, unknown>;

/**
 * SCIM 2.0 service provider (RFC 7643/7644, #75 phase 5) at /v1/scim/v2.
 *
 * Bodies are SCIM documents, not DTOs: the global ValidationPipe skips an
 * untyped body, and the readers in scim-resources.ts / scim-patch.ts do the
 * validating, answering in SCIM's error shape. Every response is
 * `application/scim+json`; errors get it from `ApiExceptionFilter`.
 *
 * Kept out of the OpenAPI document on purpose: the contract is the RFC, and
 * the generated web client has no use for it.
 */
@ApiExcludeController()
@Public()
@UseGuards(ScimTokenGuard)
@Controller('v1/scim/v2')
export class ScimController {
  private readonly maxPage: number;

  constructor(
    private readonly scim: ScimService,
    config: ConfigService<Env, true>,
  ) {
    this.maxPage = config.get('AUTH_SCIM_MAX_PAGE', { infer: true });
  }

  @Get('ServiceProviderConfig')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  serviceProviderConfig(): Doc {
    return serviceProviderConfig(this.scim.base, this.maxPage);
  }

  @Get('ResourceTypes')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  resourceTypes(): Doc {
    const all = resourceTypes(this.scim.base);
    return listResponse(all, all.length, 1);
  }

  @Get('Schemas')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  schemas(): Doc {
    const all = schemas(this.scim.base);
    return listResponse(all, all.length, 1);
  }

  // ------------------------------------------------------------------ users

  @Get('Users')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  listUsers(@Caller() caller: ScimCaller, @Query() query: ScimPageQuery): Promise<Doc> {
    return this.scim.listUsers(caller, query);
  }

  @Post('Users')
  @HttpCode(201)
  async createUser(@Caller() caller: ScimCaller, @Body() body: Doc, @Res({ passthrough: true }) res: Response): Promise<Doc> {
    return created(res, await this.scim.createUser(caller, body));
  }

  @Get('Users/:id')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  getUser(@Caller() caller: ScimCaller, @Param('id') id: string): Promise<Doc> {
    return this.scim.getUser(caller, id);
  }

  @Put('Users/:id')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  replaceUser(@Caller() caller: ScimCaller, @Param('id') id: string, @Body() body: Doc): Promise<Doc> {
    return this.scim.replaceUser(caller, id, body);
  }

  @Patch('Users/:id')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  patchUser(@Caller() caller: ScimCaller, @Param('id') id: string, @Body() body: Doc): Promise<Doc> {
    return this.scim.patchUser(caller, id, body);
  }

  @Delete('Users/:id')
  @HttpCode(204)
  deleteUser(@Caller() caller: ScimCaller, @Param('id') id: string): Promise<void> {
    return this.scim.deleteUser(caller, id);
  }

  // ----------------------------------------------------------------- groups

  @Get('Groups')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  listGroups(@Caller() caller: ScimCaller, @Query() query: ScimPageQuery): Promise<Doc> {
    return this.scim.listGroups(caller, query);
  }

  @Post('Groups')
  @HttpCode(201)
  async createGroup(@Caller() caller: ScimCaller, @Body() body: Doc, @Res({ passthrough: true }) res: Response): Promise<Doc> {
    return created(res, await this.scim.createGroup(caller, body));
  }

  @Get('Groups/:id')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  getGroup(@Caller() caller: ScimCaller, @Param('id') id: string, @Query('excludedAttributes') excluded?: string): Promise<Doc> {
    return this.scim.getGroup(caller, id, excluded);
  }

  @Put('Groups/:id')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  replaceGroup(@Caller() caller: ScimCaller, @Param('id') id: string, @Body() body: Doc): Promise<Doc> {
    return this.scim.replaceGroup(caller, id, body);
  }

  @Patch('Groups/:id')
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  patchGroup(@Caller() caller: ScimCaller, @Param('id') id: string, @Body() body: Doc): Promise<Doc> {
    return this.scim.patchGroup(caller, id, body);
  }

  @Delete('Groups/:id')
  @HttpCode(204)
  deleteGroup(@Caller() caller: ScimCaller, @Param('id') id: string): Promise<void> {
    return this.scim.deleteGroup(caller, id);
  }
}

/** RFC 7644 §3.3: a 201 carries the new resource's URI in `Location`. */
function created(res: Response, resource: Doc): Doc {
  res.setHeader('Content-Type', SCIM_CONTENT_TYPE);
  const location = (resource.meta as { location?: string } | undefined)?.location;
  if (location) res.setHeader('Location', location);
  return resource;
}
