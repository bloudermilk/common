import { getLatestSelectionForProposal } from '@op/common';
import { proposalSelectionSchema } from '@op/common/client';
import { z } from 'zod';

import { openProcedure, router } from '../../../trpcFactory';

export const getLatestSelectionForProposalRouter = router({
  /**
   * Returns a proposal's selection record (allocation + rank) from the latest
   * successful result run, or `null`.
   */
  getLatestSelectionForProposal: openProcedure()
    .input(
      z.object({
        proposalId: z.uuid(),
      }),
    )
    .output(proposalSelectionSchema.nullable())
    .query(async ({ ctx, input }) => {
      const { user } = ctx;
      const { proposalId } = input;

      return getLatestSelectionForProposal({
        proposalId,
        user,
      });
    }),
});
