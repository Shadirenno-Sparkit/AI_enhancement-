import { Router } from 'express';
import { z } from 'zod';
import type { ProfileResponse } from '@aiapp/shared';
import { FACT_CATEGORIES } from '@aiapp/shared';
import { audit } from '../../repo/audit.js';
import {
  buildLifeContext,
  confirmFact,
  deleteFact,
  listFacts,
  profileCompleteness,
  upsertFact,
} from '../../repo/profile.js';
import { badRequest, notFound } from '../../util/errors.js';
import { asyncHandler, currentUser, rateLimit, requireAuth } from '../middleware.js';

/**
 * The life context graph API (spec §8.6).
 *
 * This is the most personal data the app holds, so the route surface is
 * deliberately small and entirely user-driven: read it, add to it, confirm what
 * was proposed, delete anything. There is no endpoint that writes a confirmed
 * fact without the user's action — the analyzer's discoveries can only ever
 * enter as pending proposals, via the pipeline.
 */
export const profileRouter = Router();
profileRouter.use(requireAuth);

const factSchema = z.object({
  category: z.enum(FACT_CATEGORIES),
  key: z.string().min(1).max(60),
  value: z.string().min(1).max(500),
  detail: z.string().max(1000).nullish(),
});

/** GET /v1/profile — everything known, everything pending, and where the gaps are. */
profileRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const all = listFacts(user.userId);
    const context = buildLifeContext(user.userId);
    const { completeness, gaps } = profileCompleteness(user.userId);

    const body: ProfileResponse = {
      facts: all.filter((fact) => fact.confirmed),
      pending: all.filter((fact) => !fact.confirmed),
      brief: context.brief,
      completeness,
      gaps,
    };
    res.json(body);
  }),
);

/** POST /v1/profile/facts — state something about yourself. */
profileRouter.post(
  '/facts',
  rateLimit({ capacity: 120, refillPerSecond: 1, key: 'profile' }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const parsed = factSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('That fact is missing a category, key or value.', parsed.error.flatten().fieldErrors);

    const fact = upsertFact({
      userId: user.userId,
      category: parsed.data.category,
      key: parsed.data.key,
      value: parsed.data.value,
      detail: parsed.data.detail ?? null,
      source: 'user_stated',
    });
    if (!fact) throw badRequest('That fact could not be saved.');

    audit({ userId: user.userId, event: 'profile.fact_added', detail: `${fact.category}/${fact.key}` });
    res.status(201).json({ fact });
  }),
);

/** POST /v1/profile/facts/{id}/confirm — accept something the analyzer proposed. */
profileRouter.post(
  '/facts/:factId/confirm',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const fact = confirmFact(user.userId, String(req.params['factId']));
    if (!fact) throw notFound('No such fact.');

    audit({ userId: user.userId, event: 'profile.fact_confirmed', detail: `${fact.category}/${fact.key}` });
    res.json({ fact });
  }),
);

/**
 * DELETE /v1/profile/facts/{id} — remove a fact, or reject a proposal.
 * The same call serves both: a rejected proposal is simply a fact that is gone.
 */
profileRouter.delete(
  '/facts/:factId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const removed = deleteFact(user.userId, String(req.params['factId']));
    if (!removed) throw notFound('No such fact.');

    audit({ userId: user.userId, event: 'profile.fact_removed' });
    res.status(204).end();
  }),
);

/** POST /v1/profile/bulk — onboarding writes several facts at once. */
profileRouter.post(
  '/bulk',
  rateLimit({ capacity: 20, refillPerSecond: 1 / 10, key: 'profile-bulk' }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const parsed = z.object({ facts: z.array(factSchema).max(60) }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Expected a list of facts.', parsed.error.flatten().fieldErrors);

    const saved = parsed.data.facts
      .map((fact) =>
        upsertFact({
          userId: user.userId,
          category: fact.category,
          key: fact.key,
          value: fact.value,
          detail: fact.detail ?? null,
          source: 'onboarding',
        }),
      )
      .filter((fact) => fact !== null);

    audit({ userId: user.userId, event: 'profile.bulk_added', detail: `${saved.length} facts` });
    res.status(201).json({ saved: saved.length });
  }),
);
