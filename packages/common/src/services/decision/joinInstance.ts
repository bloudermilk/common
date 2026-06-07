import { type DbClient, db as defaultDb } from '@op/db/client';
import {
  accessRoles,
  profileUserToAccessRoles,
  profileUsers,
} from '@op/db/schema';
import type { User } from '@op/supabase/lib';
import { and, eq } from 'drizzle-orm';

import { CommonError, NotFoundError, UnauthorizedError } from '../../utils';
import { ANONYMOUS_PARTICIPANT_ROLE_NAME } from './decisionRoles';

const PARTICIPANT_ROLE_NAME = 'Participant';

export type JoinableDecisionInstance = {
  id: string;
  profileId: string | null;
};

export type JoinInstanceResult = {
  profileUser: typeof profileUsers.$inferSelect;
  role: typeof accessRoles.$inferSelect;
};

/**
 * Returns whether a public visitor can self-join the instance.
 */
export function isPublicInstanceJoinEnabled(
  _instance: JoinableDecisionInstance,
): boolean {
  // TODO: Replace this with the real public-instance marker once that lands.
  return true;
}

/**
 * Adds a user to a public decision instance with the appropriate instance role.
 */
export async function joinInstance({
  processInstanceId,
  user,
  db = defaultDb,
}: {
  processInstanceId: string;
  user: User;
  db?: DbClient;
}): Promise<JoinInstanceResult> {
  const instance = await db.query.processInstances.findFirst({
    where: { id: processInstanceId },
  });

  if (!instance) {
    throw new NotFoundError('Process instance', processInstanceId);
  }

  if (!instance.profileId) {
    throw new NotFoundError('Process instance', instance.id);
  }
  const profileId = instance.profileId;

  if (!isPublicInstanceJoinEnabled(instance)) {
    throw new UnauthorizedError("You don't have access to do this");
  }

  const roleName = user.is_anonymous
    ? ANONYMOUS_PARTICIPANT_ROLE_NAME
    : PARTICIPANT_ROLE_NAME;

  return db.transaction(async (tx) => {
    const [role] = await tx
      .select()
      .from(accessRoles)
      .where(
        and(
          eq(accessRoles.name, roleName),
          eq(accessRoles.profileId, profileId),
        ),
      )
      .limit(1);

    if (!role) {
      throw new NotFoundError('Role', roleName);
    }

    const [existingProfileUser] = await tx
      .select()
      .from(profileUsers)
      .where(
        and(
          eq(profileUsers.profileId, profileId),
          eq(profileUsers.authUserId, user.id),
        ),
      )
      .limit(1);

    const profileUser = existingProfileUser ?? (await createProfileUser());

    const [existingRoleAssignment] = await tx
      .select()
      .from(profileUserToAccessRoles)
      .where(
        and(
          eq(profileUserToAccessRoles.profileUserId, profileUser.id),
          eq(profileUserToAccessRoles.accessRoleId, role.id),
        ),
      )
      .limit(1);

    if (!existingRoleAssignment) {
      await tx.insert(profileUserToAccessRoles).values({
        profileUserId: profileUser.id,
        accessRoleId: role.id,
      });
    }

    return { profileUser, role };

    async function createProfileUser() {
      // TODO: Add DB-level uniqueness for (profileId, authUserId). For now this
      // is sequentially idempotent but not race-proof, matching existing profile
      // membership behavior.
      const [createdProfileUser] = await tx
        .insert(profileUsers)
        .values({
          profileId,
          authUserId: user.id,
          email: user.email ?? null,
        })
        .returning();

      if (!createdProfileUser) {
        throw new CommonError('Failed to create profile user');
      }

      return createdProfileUser;
    }
  });
}
