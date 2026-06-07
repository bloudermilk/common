import { createPublicParticipantRole } from '@op/common';
import { GLOBAL_USER_PUBLIC } from '@op/core';
import { db } from '@op/db/client';
import { profileUserToAccessRoles, profileUsers } from '@op/db/schema';
import { describe, expect, it } from 'vitest';

import { appRouter } from '..';
import { TestDecisionsDataManager } from '../../test/helpers/TestDecisionsDataManager';
import {
  accessTierGatingCell,
  describeAccessTierGating,
} from '../../test/helpers/gating';
import {
  createIsolatedSession,
  createTestContextWithSession,
} from '../../test/supabase-utils';
import { createCallerFactory } from '../../trpcFactory';

const createCaller = createCallerFactory(appRouter);

async function createAuthenticatedCaller(email: string) {
  const { session } = await createIsolatedSession(email);
  return createCaller(await createTestContextWithSession(session));
}

async function makeDecisionPublic(profileId: string) {
  const publicParticipantRole = await createPublicParticipantRole({
    profileId,
  });

  const [publicProfileUser] = await db
    .insert(profileUsers)
    .values({ profileId, authUserId: GLOBAL_USER_PUBLIC })
    .returning();

  if (!publicProfileUser) {
    throw new Error('Failed to create public profileUser');
  }

  await db.insert(profileUserToAccessRoles).values({
    profileUserId: publicProfileUser.id,
    accessRoleId: publicParticipantRole.id,
  });
}

describe.concurrent('listProfilePosts', () => {
  it('allows a no-JWT (public) caller to read updates on a public decision', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);
    const setup = await testData.createDecisionSetup({
      instanceCount: 1,
      grantAccess: true,
    });
    const instance = setup.instances[0];
    if (!instance) {
      throw new Error('No instance created');
    }

    // A decision admin posts an update on the decision profile.
    const adminCaller = await createAuthenticatedCaller(setup.userEmail);
    const update = await adminCaller.posts.createPost({
      content: `Public update ${task.id}`,
      profileId: instance.profileId,
    });

    await makeDecisionPublic(instance.profileId);

    const publicCaller = createCaller(await createTestContextWithSession(null));
    const result = await publicCaller.posts.listProfilePosts({
      profileId: instance.profileId,
    });

    expect(result.items.map((post) => post.id)).toContain(update.id);
  });

  it('rejects a no-JWT caller on a non-public decision', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);
    const setup = await testData.createDecisionSetup({
      instanceCount: 1,
      grantAccess: true,
    });
    const instance = setup.instances[0];
    if (!instance) {
      throw new Error('No instance created');
    }

    const publicCaller = createCaller(await createTestContextWithSession(null));

    await expect(
      publicCaller.posts.listProfilePosts({ profileId: instance.profileId }),
    ).rejects.toMatchObject({ cause: { name: 'AccessControlException' } });
  });

  it('rejects a non-decision (org) profile even for a network member', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);
    const setup = await testData.createDecisionSetup({
      instanceCount: 1,
      grantAccess: true,
    });

    const adminCaller = await createAuthenticatedCaller(setup.userEmail);

    await expect(
      adminCaller.posts.listProfilePosts({
        profileId: setup.organization.profileId,
      }),
    ).rejects.toMatchObject({ cause: { name: 'UnauthorizedError' } });
  });
});

describeAccessTierGating('posts.listProfilePosts', {
  noJwt: accessTierGatingCell(
    'rejects no-JWT caller at the service layer (no membership)',
    async ({ task, onTestFinished, callers }) => {
      const testData = new TestDecisionsDataManager(task.id, onTestFinished);
      const setup = await testData.createDecisionSetup({
        instanceCount: 1,
        grantAccess: true,
      });
      const instance = setup.instances[0];
      if (!instance) {
        throw new Error('No instance created');
      }

      const caller = await callers.noJwt();
      await expect(
        caller.posts.listProfilePosts({ profileId: instance.profileId }),
      ).rejects.toMatchObject({ cause: { name: 'AccessControlException' } });
    },
  ),

  anonJwt: accessTierGatingCell(
    'rejects anon-JWT caller at the service layer (not a member)',
    async ({ task, onTestFinished, callers }) => {
      const testData = new TestDecisionsDataManager(task.id, onTestFinished);
      const setup = await testData.createDecisionSetup({
        instanceCount: 1,
        grantAccess: true,
      });
      const instance = setup.instances[0];
      if (!instance) {
        throw new Error('No instance created');
      }

      const caller = await callers.anonJwt();
      await expect(
        caller.posts.listProfilePosts({ profileId: instance.profileId }),
      ).rejects.toMatchObject({ cause: { name: 'AccessControlException' } });
    },
  ),

  userJwt: accessTierGatingCell(
    'rejects out-of-network user-JWT caller at the service layer (not a member)',
    async ({ task, onTestFinished, callers }) => {
      const testData = new TestDecisionsDataManager(task.id, onTestFinished);
      const setup = await testData.createDecisionSetup({
        instanceCount: 1,
        grantAccess: true,
      });
      const instance = setup.instances[0];
      if (!instance) {
        throw new Error('No instance created');
      }

      const caller = await callers.userJwt();
      await expect(
        caller.posts.listProfilePosts({ profileId: instance.profileId }),
      ).rejects.toMatchObject({ cause: { name: 'AccessControlException' } });
    },
  ),

  networkJwt: accessTierGatingCell(
    'admits network member and returns the update feed',
    async ({ task, onTestFinished, callers }) => {
      const testData = new TestDecisionsDataManager(task.id, onTestFinished);
      const setup = await testData.createDecisionSetup({
        instanceCount: 1,
        grantAccess: true,
      });
      const instance = setup.instances[0];
      if (!instance) {
        throw new Error('No instance created');
      }

      const caller = await callers.networkJwt(setup.userEmail);
      const result = await caller.posts.listProfilePosts({
        profileId: instance.profileId,
      });
      expect(result.items).toBeDefined();
    },
  ),
});
