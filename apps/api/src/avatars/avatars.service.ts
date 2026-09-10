import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  type AvatarContentType,
  type AvatarUrl,
  type CompleteAvatarUploadResponse,
  type CreateAvatarUploadRequest,
  type CreateAvatarUploadResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { projectAvatarUrl, userAvatarUrl } from '../common/avatar-url.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';

/** Which table an avatar hangs off. The two differ only in the row they write. */
export type AvatarOwner = 'users' | 'projects';

/**
 * Pictures for people and projects (docs/features/22).
 *
 * The three-step upload page attachments already use, for the same reason: the
 * browser PUTs to a presigned URL, so a 2 MB image never streams through Node.
 * A row is only made the live face once the API has confirmed the bytes landed,
 * which is what stops an abandoned upload rendering as a broken picture.
 *
 * Reads go out as a 302 to a short-lived presigned GET rather than a proxy —
 * `<img>` cannot send an Authorization header, so the API authorizes the request
 * (AuthGuard also accepts `?token=`, the same way SSE does) and then hands the
 * browser a URL it can fetch directly.
 */
@Injectable()
export class AvatarsService {
  private readonly logger = new Logger(AvatarsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Step 1: check what is being uploaded, then hand back somewhere to put it.
   *
   * Both limits are enforced here, before a single byte moves — the rule
   * feature 16 established for imports. Refusing a 40 MB photograph after it has
   * been uploaded wastes the upload and tells the person nothing they could not
   * have been told immediately.
   *
   * Nothing is written to the row yet. An upload that is started and abandoned
   * must leave the current face exactly as it was.
   */
  async reserve(
    kind: AvatarOwner,
    ownerId: string,
    dto: CreateAvatarUploadRequest,
  ): Promise<CreateAvatarUploadResponse> {
    if (!AVATAR_CONTENT_TYPES.includes(dto.contentType as AvatarContentType)) {
      throw new BadRequestException(
        t('error.avatar.unsupportedType', { types: AVATAR_CONTENT_TYPES.join(', ') }),
      );
    }
    if (dto.sizeBytes > AVATAR_MAX_BYTES) {
      throw new PayloadTooLargeException(t('error.avatar.tooLarge', { limit: AVATAR_MAX_BYTES }));
    }

    const uploadId = randomUUID();
    const key = this.storage.avatarObjectKey(kind, ownerId, uploadId, dto.filename);
    const url = await this.storage.presignPut(key, dto.contentType);
    return {
      uploadId,
      upload: {
        url,
        method: 'PUT',
        headers: { 'Content-Type': dto.contentType },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    };
  }

  /**
   * Step 2: the bytes are supposed to be there — confirm it, then switch faces.
   *
   * `headObject` is the confirmation, and it is not ceremony: the presigned PUT
   * goes straight to object storage, so this process never saw whether it
   * succeeded. Taking the client's word for it is how a row ends up pointing at
   * an object that does not exist.
   *
   * The size is re-checked against what actually arrived, because the number in
   * step 1 was a claim by the caller and this one is a fact.
   */
  async complete(
    kind: AvatarOwner,
    ownerId: string,
    filename: string,
    uploadId: string,
  ): Promise<CompleteAvatarUploadResponse> {
    const key = this.storage.avatarObjectKey(kind, ownerId, uploadId, filename);
    const head = await this.storage.headObject(key);
    if (!head) throw new BadRequestException(t('error.avatar.notUploaded'));
    if (head.contentLength > AVATAR_MAX_BYTES) {
      await this.storage.deleteObject(key).catch(() => undefined);
      throw new PayloadTooLargeException(t('error.avatar.tooLarge', { limit: AVATAR_MAX_BYTES }));
    }

    const previous = await this.swapKey(kind, ownerId, key);
    // After the swap, never before: until the row points at the new object, the
    // old one is still the live face, and a reader mid-request is entitled to it.
    if (previous && previous !== key) {
      await this.storage.deleteObject(previous).catch((e: unknown) => {
        this.logger.warn(`orphaned previous avatar ${previous}: ${String(e)}`);
      });
    }
    return { avatarUrl: await this.urlFor(kind, ownerId) };
  }

  /** Back to initials (people) or the monogram (projects). */
  async remove(kind: AvatarOwner, ownerId: string): Promise<void> {
    const previous = await this.swapKey(kind, ownerId, null);
    if (previous) {
      await this.storage.deleteObject(previous).catch((e: unknown) => {
        this.logger.warn(`orphaned removed avatar ${previous}: ${String(e)}`);
      });
    }
  }

  /**
   * Where the browser should actually fetch the picture from.
   *
   * `inline`, and with the stored content type — the same rule attachments
   * apply: disposition and type are decided here rather than inherited from the
   * object's own metadata, so an upload can never talk the browser into
   * treating it as something executable.
   */
  async presignedGet(kind: AvatarOwner, ownerId: string): Promise<string> {
    const key = await this.keyOf(kind, ownerId);
    if (!key) throw new NotFoundException(t('error.avatar.none'));
    const head = await this.storage.headObject(key);
    return this.storage.presignGet(key, {
      filename: 'avatar',
      contentType: head?.contentType ?? 'application/octet-stream',
      disposition: 'inline',
      // Longer than the default: a face is fetched on every screen that lists
      // people, and a URL that expires inside a session sends them all back.
      expiresInSeconds: 3600,
    });
  }

  /**
   * May `principal` see this person's picture?
   *
   * A display name is already visible to anyone sharing a workspace, and a face
   * is no more revealing than the name beside it — but "any authenticated
   * caller" would let one tenant enumerate another's people by id, which is a
   * different thing. So: yourself, a platform admin, or somebody you actually
   * share a workspace with.
   *
   * Written as one indexed query rather than through AclGuard because there is
   * no single workspace to resolve: a user belongs to several, and the answer is
   * whether *any* of them overlaps.
   */
  async assertCanSeeUser(principal: Principal, userId: string): Promise<void> {
    if (principal.mode === 'dev' || principal.isAdmin || principal.userId === userId) return;
    const shared = await this.prisma.workspaceMember.findFirst({
      where: {
        userId,
        workspace: { members: { some: { userId: principal.userId } } },
      },
      select: { workspaceId: true },
    });
    if (!shared) throw new ForbiddenException(t('error.avatar.forbidden'));
  }

  private async keyOf(kind: AvatarOwner, ownerId: string): Promise<string | null> {
    if (kind === 'users') {
      const row = await this.prisma.user.findUnique({
        where: { id: ownerId },
        select: { avatarKey: true },
      });
      return row?.avatarKey ?? null;
    }
    const row = await this.prisma.project.findUnique({
      where: { id: ownerId },
      select: { avatarKey: true },
    });
    return row?.avatarKey ?? null;
  }

  /** Point the row at `key` and report what it pointed at before. */
  private async swapKey(
    kind: AvatarOwner,
    ownerId: string,
    key: string | null,
  ): Promise<string | null> {
    const avatarUpdatedAt = new Date();
    if (kind === 'users') {
      const before = await this.prisma.user.findUnique({
        where: { id: ownerId },
        select: { avatarKey: true },
      });
      if (!before) throw new NotFoundException(t('error.user.notFound', { id: ownerId }));
      await this.prisma.user.update({
        where: { id: ownerId },
        data: { avatarKey: key, avatarUpdatedAt },
      });
      return before.avatarKey;
    }
    const before = await this.prisma.project.findUnique({
      where: { id: ownerId },
      select: { avatarKey: true },
    });
    if (!before) throw new NotFoundException(t('error.project.notFound', { id: ownerId }));
    await this.prisma.project.update({
      where: { id: ownerId },
      // A project has one face: uploading a picture retires the emoji, the same
      // way choosing an emoji clears the picture. Two set at once would leave the
      // renderer picking, and it would pick differently in different places.
      data: { avatarKey: key, avatarUpdatedAt, ...(key ? { avatarEmoji: null } : {}) },
    });
    return before.avatarKey;
  }

  private async urlFor(kind: AvatarOwner, ownerId: string): Promise<AvatarUrl> {
    if (kind === 'users') {
      const row = await this.prisma.user.findUnique({
        where: { id: ownerId },
        select: { id: true, avatarKey: true, avatarUpdatedAt: true },
      });
      return userAvatarUrl(row);
    }
    const row = await this.prisma.project.findUnique({
      where: { id: ownerId },
      select: { id: true, avatarKey: true, avatarUpdatedAt: true },
    });
    return projectAvatarUrl(row);
  }
}
