import { createPublicParticipantRole } from '@op/common';
import { GLOBAL_USER_PUBLIC } from '@op/core';
import { db, eq } from '@op/db/client';
import {
  ProcessStatus,
  ProposalStatus,
  profileUserToAccessRoles,
  profileUsers,
  users,
} from '@op/db/schema';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { appRouter } from '../..';
import { TestDecisionsDataManager } from '../../../test/helpers/TestDecisionsDataManager';
import {
  accessTierGatingCell,
  describeDecisionAccessTierGating,
} from '../../../test/helpers/gating/decision';
import { schemaWithoutPipeline } from '../../../test/helpers/pipelineSchemas';
import {
  createAuthenticatedCaller,
  createTestContextWithSession,
  createTestUser,
} from '../../../test/supabase-utils';
import { createCallerFactory } from '../../../trpcFactory';

const createCaller = createCallerFactory(appRouter);

describe.concurrent('listProposalSubmitters', () => {
  it('deduplicates submitters across multiple proposals by the same author', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);
    const setup = await testData.createDecisionSetup({
      processSchema: schemaWithoutPipeline,
      instanceCount: 1,
      status: ProcessStatus.PUBLISHED,
    });
    const instanceId = setup.instances[0]!.instance.id;
    const { userEmail } = setup;
    const caller = await createAuthenticatedCaller(userEmail);

    // Same user submits two proposals → should appear once in the face pile.
    for (let i = 1; i <= 2; i++) {
      await testData.createProposal({
        userEmail,
        processInstanceId: instanceId,
        proposalData: { title: `Proposal ${i} ${task.id}` },
        status: ProposalStatus.SUBMITTED,
      });
    }

    await testData.advancePhase({
      instanceId,
      fromPhaseId: 'submission',
      toPhaseId: 'review',
    });

    const result = await caller.decision.listProposalSubmitters({
      processInstanceId: instanceId,
    });

    expect(result.submitters).toHaveLength(1);
  });

  it('excludes submitters whose only proposal is a draft', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);
    const setup = await testData.createDecisionSetup({
      processSchema: schemaWithoutPipeline,
      instanceCount: 1,
      status: ProcessStatus.PUBLISHED,
    });
    const instanceId = setup.instances[0]!.instance.id;
    const { userEmail } = setup;
    const caller = await createAuthenticatedCaller(userEmail);

    // Draft is never submitted — submitter must not appear.
    await testData.createProposal({
      userEmail,
      processInstanceId: instanceId,
      proposalData: { title: `Draft ${task.id}` },
    });

    await testData.advancePhase({
      instanceId,
      fromPhaseId: 'submission',
      toPhaseId: 'review',
    });

    const result = await caller.decision.listProposalSubmitters({
      processInstanceId: instanceId,
    });

    expect(result.submitters).toHaveLength(0);
  });

  it('includes invited collaborators on the same proposal', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);
    const setup = await testData.createDecisionSetup({
      processSchema: schemaWithoutPipeline,
      instanceCount: 1,
      status: ProcessStatus.PUBLISHED,
    });
    const instanceId = setup.instances[0]!.instance.id;
    const { userEmail } = setup;
    const caller = await createAuthenticatedCaller(userEmail);

    // Owner creates a proposal — they appear in the face pile by default.
    const proposal = await testData.createProposal({
      userEmail,
      processInstanceId: instanceId,
      proposalData: { title: `Collab proposal ${task.id}` },
    });

    // Add a second user as a collaborator on the proposal's profile —
    // mirrors what acceptProposalInvite does when an invitee joins.
    const collaboratorEmail = `${task.id}-collab-${randomUUID()}@oneproject.org`;
    const collabAuth = await createTestUser(collaboratorEmail).then(
      (res) => res.user,
    );
    if (!collabAuth) {
      throw new Error('Failed to create collaborator auth user');
    }
    testData.trackAuthUserForCleanup(collabAuth.id);

    const [collabUserRecord] = await db
      .select()
      .from(users)
      .where(eq(users.authUserId, collabAuth.id));
    if (collabUserRecord?.profileId) {
      testData.trackProfileForCleanup(collabUserRecord.profileId);
    }

    await db.insert(profileUsers).values({
      profileId: proposal.profileId,
      authUserId: collabAuth.id,
      email: collaboratorEmail,
    });

    await caller.decision.submitProposal({ proposalId: proposal.id });

    await testData.advancePhase({
      instanceId,
      fromPhaseId: 'submission',
      toPhaseId: 'review',
    });

    const result = await caller.decision.listProposalSubmitters({
      processInstanceId: instanceId,
    });

    expect(result.submitters).toHaveLength(2);
  });

  it('allows a no-JWT (public) caller to list submitters for a public decision', async ({
    task,
    onTestFinished,
  }) => {
    const testData = new TestDecisionsDataManager(task.id, onTestFinished);
    const setup = await testData.createDecisionSetup({
      processSchema: schemaWithoutPipeline,
      instanceCount: 1,
      status: ProcessStatus.PUBLISHED,
    });
    const instance = setup.instances[0];
    if (!instance) {
      throw new Error('No instance created');
    }
    const instanceId = instance.instance.id;
    const { userEmail } = setup;

    await testData.createProposal({
      userEmail,
      processInstanceId: instanceId,
      proposalData: { title: `Public submitter ${task.id}` },
      status: ProposalStatus.SUBMITTED,
    });

    await testData.advancePhase({
      instanceId,
      fromPhaseId: 'submission',
      toPhaseId: 'review',
    });

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

    const result = await publicCaller.decision.listProposalSubmitters({
      processInstanceId: instanceId,
    });

    expect(result.submitters).toHaveLength(1);
  });
});
describeDecisionAccessTierGating('listProposalSubmitters', {
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
        caller.decision.listProposalSubmitters({
          processInstanceId: instance.instance.id,
        }),
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
        caller.decision.listProposalSubmitters({
          processInstanceId: instance.instance.id,
        }),
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
        caller.decision.listProposalSubmitters({
          processInstanceId: instance.instance.id,
        }),
      ).rejects.toMatchObject({ cause: { name: 'UnauthorizedError' } });
    },
  ),

  networkJwtNonPublic: accessTierGatingCell(
    'admits network member and returns submitters',
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

      const result = await caller.decision.listProposalSubmitters({
        processInstanceId: instance.instance.id,
      });
      expect(result.submitters).toBeDefined();
    },
  ),
});
