import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CompleteAvatarUploadResponse,
  CreateAvatarUploadResponse,
} from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { AvatarsService } from './avatars.service.js';
import { CompleteAvatarUploadDto, CreateAvatarUploadDto } from './avatars.dto.js';
import { t } from '../i18n/t.js';

/**
 * Avatars for people and projects (docs/features/22).
 *
 * One controller for both, because the flow is identical and only the ACL
 * differs. The `/v1/me/...` routes take no id at all — which is what keeps them
 * out of platform-admin territory, the same reasoning MeController states: there
 * is no parameter here to point at somebody else. The project routes do take
 * one, so they go through AclGuard's existing `'project'` source and a project
 * id from another tenant 403s before this class runs.
 *
 * Kept out of UsersController deliberately: that class is `@PlatformAdmin()`
 * whole-class, and reading a colleague's face is a viewer-level act.
 */
@ApiTags('avatars')
@Controller('v1')
export class AvatarsController {
  constructor(private readonly avatars: AvatarsService) {}

  // ---------------------------------------------------------------- people

  @Post('me/avatar')
  @HttpCode(200)
  @ApiOperation({ summary: "Reserve a presigned upload for the caller's own avatar" })
  reserveMine(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateAvatarUploadDto,
  ): Promise<CreateAvatarUploadResponse> {
    return this.avatars.reserve('users', this.own(principal), dto);
  }

  @Post('me/avatar/complete')
  @HttpCode(200)
  @ApiOperation({ summary: "Confirm the upload and make it the caller's avatar" })
  completeMine(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CompleteAvatarUploadDto,
  ): Promise<CompleteAvatarUploadResponse> {
    return this.avatars.complete('users', this.own(principal), dto.filename, dto.uploadId);
  }

  @Delete('me/avatar')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove the caller’s avatar and fall back to initials' })
  async removeMine(@CurrentPrincipal() principal: Principal): Promise<void> {
    await this.avatars.remove('users', this.own(principal));
  }

  /**
   * A person's picture, as a redirect.
   *
   * Not `@Access`-guarded, because there is no single workspace to resolve
   * against: a user belongs to several, and the question is whether the caller
   * shares *any* of them. The service answers that in one indexed query.
   */
  @Get('users/:userId/avatar')
  @Redirect(undefined, 302)
  @ApiOperation({ summary: 'Redirect to a short-lived signed URL for a user’s avatar' })
  async userAvatar(
    @CurrentPrincipal() principal: Principal,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<{ url: string }> {
    await this.avatars.assertCanSeeUser(principal, userId);
    return { url: await this.avatars.presignedGet('users', userId) };
  }

  // -------------------------------------------------------------- projects

  @Post('projects/:id/avatar')
  @HttpCode(200)
  @Access('editor', 'project')
  @ApiOperation({ summary: 'Reserve a presigned upload for a project avatar' })
  reserveProject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAvatarUploadDto,
  ): Promise<CreateAvatarUploadResponse> {
    return this.avatars.reserve('projects', id, dto);
  }

  @Post('projects/:id/avatar/complete')
  @HttpCode(200)
  @Access('editor', 'project')
  @ApiOperation({ summary: 'Confirm the upload and make it the project’s avatar' })
  completeProject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteAvatarUploadDto,
  ): Promise<CompleteAvatarUploadResponse> {
    return this.avatars.complete('projects', id, dto.filename, dto.uploadId);
  }

  @Delete('projects/:id/avatar')
  @HttpCode(204)
  @Access('editor', 'project')
  @ApiOperation({ summary: 'Remove a project’s picture and fall back to the monogram' })
  async removeProject(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.avatars.remove('projects', id);
  }

  @Get('projects/:id/avatar')
  @Access('viewer', 'project')
  @Redirect(undefined, 302)
  @ApiOperation({ summary: 'Redirect to a short-lived signed URL for a project’s avatar' })
  async projectAvatar(@Param('id', ParseUUIDPipe) id: string): Promise<{ url: string }> {
    return { url: await this.avatars.presignedGet('projects', id) };
  }

  /**
   * The dev principal has no `users` row, so there is nothing to hang a picture
   * on — the same wall `POST /v1/me/api-key` runs into, refused the same way
   * rather than silently writing nowhere.
   */
  private own(principal: Principal): string {
    if (principal.mode === 'dev') throw new BadRequestException(t('error.avatar.noDevAvatar'));
    return principal.userId;
  }
}
