import { Channels, UnauthorizedError, joinInstance } from '@op/common';
import { z } from 'zod';

import { getCachedAuthUser } from '../../../supabase/server';
import { commonProcedure, router } from '../../../trpcFactory';

const joinPublicInstanceInputSchema = z.object({
  processInstanceId: z.uuid(),
});

const temporaryAnonymousProcedure = commonProcedure.use(
  async ({ ctx, next }) => {
    const auth = await getCachedAuthUser(ctx);

    if (auth.error || !auth.data.user) {
      throw new UnauthorizedError('Failed to authenticate user');
    }

    // NOTE: Anonymous-JWT/auth gating is owned by the sibling API gating PR. This
    // intentionally accepts any valid Supabase user session until that lands.
    return next({ ctx: { ...ctx, user: auth.data.user } });
  },
);

export const joinPublicInstanceRouter = router({
  joinPublicInstance: temporaryAnonymousProcedure
    .input(joinPublicInstanceInputSchema)
    .output(z.object({ success: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await joinInstance({
        processInstanceId: input.processInstanceId,
        user: ctx.user,
      });

      ctx.registerMutationChannels([
        Channels.decisionInstance(input.processInstanceId),
      ]);

      return { success: true };
    }),
});
