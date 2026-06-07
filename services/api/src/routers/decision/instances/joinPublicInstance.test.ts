import {
  anonymousParticipantRoleDefinition,
  createDecisionRole,
} from '@op/common';
import { db } from '@op/db/client';
import {
  accessRoles,
  profileUserToAccessRoles,
  profileUsers,
} from '@op/db/schema';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { appRouter } from '../..';
import { TestDecisionsDataManager } from '../../../test/helpers/TestDecisionsDataManager';
import {
  createIsolatedTestClient,
  createTestContextWithSession,
} from '../../../test/supabase-utils';
import { createCallerFactory } from '../../../trpcFactory';

const createCaller = createCallerFactory(appRouter);

async function createAnonymousCaller(testData: TestDecisionsDataManager) {
  const client = createIsolatedTestClient();
  const { data, error } = await client.auth.signInAnonymously();

  if (error || !data.session || !data.user) {
    throw new Error(`Failed to create anonymous session: ${error?.message}`);
  }

  testData.trackAuthUserForCleanup(data.user.id);

  const userRecord = await db.query.users.findFirst({
    where: { authUserId: data.user.id },
  });

  if (userRecord?.profileId) {
    testData.trackProfileForCleanup(userRecord.profileId);
  }

  return {
    authUserId: data.user.id,
    caller: createCaller(await createTestContextWithSession(data.session)),
  };
}

async function createAnonymousParticipantRole(profileId: string) {
  return createDecisionRole({
    ...anonymousParticipantRoleDefinition,
    profileId,
  });
}

async function getInstanceMembership({
  profileId,
  authUserId,
}: {
  profileId: string;
  authUserId: string;
}) {
  return db
    .select({
      profileUserId: profileUsers.id,
      roleId: accessRoles.id,
      roleName: accessRoles.name,
    })
    .from(profileUsers)
    .innerJoin(
      profileUserToAccessRoles,
      eq(profileUsers.id, profileUserToAccessRoles.profileUserId),
    )
    .innerJoin(
      accessRoles,
      eq(profileUserToAccessRoles.accessRoleId, accessRoles.id),
    )
    .where(
      and(
        eq(profileUsers.profileId, profileId),
        eq(profileUsers.authUserId, authUserId),
      ),
    );
}

describe.concurrent('joinPublicInstance', () => {
  it('joins an anonymous user with the anonymous participant role', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);
    const setup = await testData.createDecisionSetup({ instanceCount: 1 });
    const instance = setup.instances[0];

    if (!instance) {
      throw new Error('No instance created');
    }

    await createAnonymousParticipantRole(instance.profileId);
    const { authUserId, caller } = await createAnonymousCaller(testData);

    await expect(
      caller.decision.joinPublicInstance({
        processInstanceId: instance.instance.id,
      }),
    ).resolves.toEqual({ success: true });

    const memberships = await getInstanceMembership({
      profileId: instance.profileId,
      authUserId,
    });

    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.roleName).toBe('Anonymous Participant');
  });

  it('is idempotent for repeated anonymous joins', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);
    const setup = await testData.createDecisionSetup({ instanceCount: 1 });
    const instance = setup.instances[0];

    if (!instance) {
      throw new Error('No instance created');
    }

    await createAnonymousParticipantRole(instance.profileId);
    const { authUserId, caller } = await createAnonymousCaller(testData);
    const input = {
      processInstanceId: instance.instance.id,
    } as const;

    await caller.decision.joinPublicInstance(input);
    await caller.decision.joinPublicInstance(input);

    const memberships = await getInstanceMembership({
      profileId: instance.profileId,
      authUserId,
    });

    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.roleName).toBe('Anonymous Participant');
  });
});
