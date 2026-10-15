import { Injectable } from '@nestjs/common';
import { EventsPublisher } from '../events/events.publisher.js';
import { NotificationsService, type DirectNotifyInput } from '../notifications/notifications.service.js';
import type { AccessResource } from './acl-read.js';

/**
 * What a change to who-sees-what tells the rest of the system (#76, phase 5).
 *
 * `acl.changed` carries no page, no title and no names: a live client that
 * receives it drops what it cached and refetches, and every API process's
 * live gateway forgets the visibility it cached for that workspace. It goes
 * on the shared bus, so the event itself must leak nothing.
 *
 * One place rather than a publish at each writer, so a writer added later
 * (connector ACL sync, phase 6) has one call to make.
 */
@Injectable()
export class AclEventsService {
  constructor(
    private readonly events: EventsPublisher,
    private readonly notifications: NotificationsService,
  ) {}

  async changed(workspaceId: string, actor?: string): Promise<void> {
    await this.events.publish({ type: 'acl.changed', workspaceId, ...(actor ? { actor } : {}) });
  }

  /**
   * Tell people they can now open something. `title` is the node's name, which
   * they may read from now on; the row links to the page itself.
   */
  async granted(input: {
    workspaceId: string;
    resource: AccessResource;
    title: string | null;
    userIds: string[];
    actor: string;
    level: string;
  }): Promise<void> {
    if (input.userIds.length === 0) return;
    await this.notify({
      workspaceId: input.workspaceId,
      userIds: input.userIds,
      type: 'access.granted',
      reason: 'participant',
      actor: input.actor,
      ...resourceTarget(input.resource),
      title: input.title,
      metadata: { resourceType: input.resource.type, resourceId: input.resource.id, level: input.level },
    });
  }

  /** A direct notification about access, with its live frame. */
  async notify(input: DirectNotifyInput): Promise<void> {
    await this.events.announce(input.workspaceId, await this.notifications.notify(input));
  }
}

/** Where an access notification points: the page, or the project. */
export function resourceTarget(resource: AccessResource): Pick<DirectNotifyInput, 'documentId' | 'subjectType' | 'subjectId'> {
  return resource.type === 'document'
    ? { documentId: resource.id, subjectType: 'document', subjectId: resource.id }
    : { documentId: null, subjectType: 'project', subjectId: resource.id };
}
