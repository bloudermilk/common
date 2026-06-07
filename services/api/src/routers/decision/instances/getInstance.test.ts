import { createPublicParticipantRole } from '@op/common';
import { GLOBAL_USER_PUBLIC } from '@op/core';
import { db } from '@op/db/client';
import {
  ProposalStatus,
  profileUserToAccessRoles,
  profileUsers,
} from '@op/db/schema';
import { describe, expect, it } from 'vitest';

import { appRouter } from '../..';
import { TestDecisionsDataManager } from '../../../test/helpers/TestDecisionsDataManager';
import {
  accessTierGatingCell,
  describeDecisionAccessTierGating,
  // Still used by the getLegacyInstance gating block below — getLegacyInstance
  // stays on networkAuthenticatedProcedure (legacy route, not public).
  expectFailsAccessTierGate,
} from '../../../test/helpers/gating/decision';
import {
  createIsolatedSession,
  createTestContextWithSession,
} from '../../../test/supabase-utils';
import { createCallerFactory } from '../../../trpcFactory';

const createCaller = createCallerFactory(appRouter);

async function createAuthenticatedCaller(email: string) {
  const { session } = await createIsolatedSession(email);
  return createCaller(await createTestContextWithSession(session));
}

describe.concurrent('getInstance', () => {
  it('should return full access for a profile admin', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);

    // grantAccess: true uses isAdmin=true which assigns the Admin role (profile.ADMIN)
    const setup = await testData.createDecisionSetup({
      instanceCount: 1,
      grantAccess: true,
    });

    const instance = setup.instances[0];
    if (!instance) {
      throw new Error('No instance created');
    }

    const caller = await createAuthenticatedCaller(setup.userEmail);
    const result = await caller.decision.getInstance({
      instanceId: instance.instance.id,
    });

    expect(result.access?.admin).toBe(true);
    expect(result.access?.submitProposals).toBe(true);
    expect(result.access?.vote).toBe(true);
  });

  it('should signal public proposal eligibility', async ({
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

    const caller = await createAuthenticatedCaller(setup.userEmail);
    const result = await caller.decision.getInstance({
      instanceId: instance.instance.id,
    });

    expect(result.publicProposalsAllowed).toBe(true);
  });

  it('should return limited access for a member (non-admin) user', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);

    const setup = await testData.createDecisionSetup({
      instanceCount: 1,
      grantAccess: false,
    });

    const instance = setup.instances[0];
    if (!instance) {
      throw new Error('No instance created');
    }

    // Member role has decisions.SUBMIT_PROPOSALS and decisions.VOTE but not admin
    const member = await testData.createMemberUser({
      organization: setup.organization,
      instanceProfileIds: [instance.profileId],
    });

    const caller = await createAuthenticatedCaller(member.email);
    const result = await caller.decision.getInstance({
      instanceId: instance.instance.id,
    });

    expect(result.access?.admin).toBe(false);
    expect(result.access?.submitProposals).toBe(true);
    expect(result.access?.vote).toBe(true);
  });

  it('should return NOT_FOUND for a non-existent instance', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);

    const setup = await testData.createDecisionSetup({ instanceCount: 0 });
    const caller = await createAuthenticatedCaller(setup.userEmail);

    await expect(
      caller.decision.getInstance({
        instanceId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ cause: { statusCode: 404 } });
  });

  it('should return FORBIDDEN for a user with no access to the instance', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);

    const setup = await testData.createDecisionSetup({
      instanceCount: 1,
      grantAccess: false,
    });

    const instance = setup.instances[0];
    if (!instance) {
      throw new Error('No instance created');
    }

    // Create a user in a completely separate org — org-level fallback would grant READ
    // to members of the same org, so we must use a different org to test true unauthorized access
    const separateOrgSetup = await testData.createDecisionSetup({
      instanceCount: 0,
    });
    const outsider = await testData.createMemberUser({
      organization: separateOrgSetup.organization,
      instanceProfileIds: [],
    });

    const outsiderCaller = await createAuthenticatedCaller(outsider.email);

    await expect(
      outsiderCaller.decision.getInstance({
        instanceId: instance.instance.id,
      }),
    ).rejects.toMatchObject({ cause: { statusCode: 403 } });
  });

  it('should exclude draft proposals from stats', async ({
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

    const draftProposal = await testData.createProposal({
      userEmail: setup.userEmail,
      processInstanceId: instance.instance.id,
      proposalData: {
        title: 'Draft proposal',
        description: 'Still drafting',
      },
    });

    const submittedProposal = await testData.createProposal({
      userEmail: setup.userEmail,
      processInstanceId: instance.instance.id,
      proposalData: { title: 'Submitted proposal' },
    });

    const caller = await createAuthenticatedCaller(setup.userEmail);

    const submittedResult = await caller.decision.submitProposal({
      proposalId: submittedProposal.id,
    });

    expect(draftProposal.status).toBe(ProposalStatus.DRAFT);
    expect(submittedResult.status).toBe(ProposalStatus.SUBMITTED);

    const result = await caller.decision.getInstance({
      instanceId: instance.instance.id,
    });

    expect(result.proposalCount).toBe(1);
    expect(result.participantCount).toBe(1);
  });

  it('allows a no-JWT (public) caller to load a public decision with read-only access', async ({
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

    const publicParticipantRole = await createPublicParticipantRole({
      profileId: instance.profileId,
    });

    const [publicProfileUser] = await db
      .insert(profileUsers)
      .values({
        profileId: instance.profileId,
        authUserId: GLOBAL_USER_PUBLIC,
      })
      .returning();

    if (!publicProfileUser) {
      throw new Error('Failed to create public profileUser');
    }

    await db.insert(profileUserToAccessRoles).values({
      profileUserId: publicProfileUser.id,
      accessRoleId: publicParticipantRole.id,
    });

    const publicCaller = createCaller(await createTestContextWithSession(null));

    const result = await publicCaller.decision.getInstance({
      instanceId: instance.instance.id,
    });

    expect(result.id).toBe(instance.instance.id);
    expect(result.access?.read).toBe(true);
    expect(result.access?.admin).toBe(false);
    expect(result.access?.submitProposals).toBe(false);
    expect(result.access?.vote).toBe(false);
  });
});
describeDecisionAccessTierGating('getInstance', {
  noJwtNonPublic: accessTierGatingCell(
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
        caller.decision.getInstance({ instanceId: instance.instance.id }),
      ).rejects.toMatchObject({ cause: { name: 'UnauthorizedError' } });
    },
  ),

  anonJwtNonPublic: accessTierGatingCell(
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
        caller.decision.getInstance({ instanceId: instance.instance.id }),
      ).rejects.toMatchObject({ cause: { name: 'UnauthorizedError' } });
    },
  ),

  userJwtNonPublic: accessTierGatingCell(
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
        caller.decision.getInstance({ instanceId: instance.instance.id }),
      ).rejects.toMatchObject({ cause: { name: 'UnauthorizedError' } });
    },
  ),

  networkJwtNonPublic: accessTierGatingCell(
    'admits network member and returns the instance',
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

      const result = await caller.decision.getInstance({
        instanceId: instance.instance.id,
      });
      expect(result.id).toBe(instance.instance.id);
    },
  ),
});

describeDecisionAccessTierGating('getLegacyInstance', {
  noJwtNonPublic: accessTierGatingCell(
    'rejects no-JWT caller on non-public instance',
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

      await expectFailsAccessTierGate(
        caller.decision.getLegacyInstance({ instanceId: instance.instance.id }),
        'none',
      );
    },
  ),

  anonJwtNonPublic: accessTierGatingCell(
    'rejects anon-JWT caller on non-public instance',
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

      await expectFailsAccessTierGate(
        caller.decision.getLegacyInstance({ instanceId: instance.instance.id }),
        'anon',
      );
    },
  ),

  userJwtNonPublic: accessTierGatingCell(
    'rejects user-JWT caller on non-public instance',
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

      await expectFailsAccessTierGate(
        caller.decision.getLegacyInstance({ instanceId: instance.instance.id }),
        'user',
      );
    },
  ),

  networkJwtNonPublic: accessTierGatingCell(
    'admits network-JWT caller on non-public instance',
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

      // getLegacyInstance is @deprecated and its legacy output encoder only
      // accepts the pre-v2 processSchema shape. createDecisionSetup builds
      // v2 schemas, so output validation fails — but the call passes the
      // gate, which is what this matrix asserts.
      let caught: unknown;
      try {
        await caller.decision.getLegacyInstance({
          instanceId: instance.instance.id,
        });
      } catch (err) {
        caught = err;
      }
      expect((caught as { cause?: { name?: string } })?.cause?.name).not.toBe(
        'UnauthorizedError',
      );
    },
  ),
});
