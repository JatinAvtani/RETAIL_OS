'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Card, Value } from './ui';

type Health = Awaited<ReturnType<typeof trpc.onboarding.getHealth.query>>;

/**
 * The setup health panel: one score, and the specific things standing between the org and a real
 * margin figure.
 *
 * `onboarding.getHealth` and the whole eight-dimension scoring model behind it were built and
 * registered on the API, but nothing in the UI ever called them — so the score, its per-step ratios
 * and its blocker list were invisible to every user. This is that entry point. Found by auditing
 * tRPC procedures against their web callers, the same class of gap as the Google sign-in button
 * that existed on the server with no link to it.
 *
 * The blockers are the point, not the score. Each one already arrives as a sentence naming a real
 * measured quantity ("Only 40% of detected products are confirmed"), computed in
 * `packages/domain`'s `computeOnboardingHealth` from honest inputs — so this component renders them
 * verbatim rather than re-deriving or re-wording anything. A number shown here is a number the
 * domain layer computed (I2).
 *
 * Failure is silent by design: setup guidance is supplementary to the steps below it on the page,
 * and a failed health query must not blank out the wizard itself.
 */
export const OnboardingHealthPanel = () => {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    trpc.onboarding.getHealth
      .query()
      .then(setHealth)
      .catch(() => undefined);
  }, []);

  if (!health) return null;

  const complete = health.score === 100;

  return (
    <Card className="mb-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <h2 className="text-sm font-semibold text-content">Setup health</h2>
          <p className="mt-1 text-sm text-content-muted">
            {complete
              ? 'Every step is done — your margin figures are running on complete data.'
              : 'How much of the data behind your margin figures is in place.'}
          </p>
        </div>
        {/* `Value` carries the mono/tabular numeric face every measured figure in this interface
            uses, and its own null handling — the score is a real computed number, so it renders
            through the same component as any other. */}
        <div className="flex items-baseline gap-1.5 text-2xl font-semibold text-content">
          <Value value={health.score} />
          <span className="text-sm font-normal text-content-subtle">/ 100</span>
        </div>
      </div>

      {/* A meter, not a decorative bar: it encodes the same number shown above, so the figure is
          readable at a glance and precisely at the same time. */}
      <div
        role="meter"
        aria-valuenow={health.score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Setup health score"
        className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className={complete ? 'h-full rounded-full bg-positive' : 'h-full rounded-full bg-accent'}
          style={{ width: `${health.score}%` }}
        />
      </div>

      {health.blockers.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
          {health.blockers.map((blocker) => (
            <li key={blocker} className="flex gap-2.5 text-sm text-content-muted">
              <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              {blocker}
            </li>
          ))}
        </ul>
      )}

      {/* "Stalled" is a distinct fact from "incomplete" — the domain layer only sets it when setup
          actually started and then went quiet, never for an org that simply hasn't begun. */}
      {health.stalled && (
        <p className="mt-4 border-t border-border pt-4 text-sm text-warning">
          Setup has been paused for a while. Picking up the steps below will get your first real
          margin finding moving again.
        </p>
      )}
    </Card>
  );
};
