'use client';

import { useCallback, useEffect, useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input, LoadingState, PageHeader } from '@/components/ui';

type Tolerances = Awaited<ReturnType<typeof trpc.settings.getMatchTolerances.query>>;

const DEFAULT_PRICE_PERCENT_LABEL = '2%';
const DEFAULT_PRICE_ABSOLUTE_LABEL = '$5';
const DEFAULT_QUANTITY_PERCENT_LABEL = '2%';

/**
 * 008-11 (spec D8, "avoid alert fatigue on cents"): the real settings surface for the three-way
 * match's per-org tolerance override — OWNER-only, confirmed with the user. Each field is a plain
 * decimal (0.02, not "2") to match exactly what `settings.updateMatchTolerances` stores and what
 * `classifyLineMatch` compares against — no unit conversion happens in this UI layer (I6: a
 * percent-to-fraction conversion at the UI boundary is exactly the kind of implicit arithmetic this
 * project avoids). An empty field means "use the default," submitted as `null`, never a fabricated
 * zero.
 */
export default function SettingsPage() {
  const [data, setData] = useState<Tolerances | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [pricePercent, setPricePercent] = useState('');
  const [priceAbsolute, setPriceAbsolute] = useState('');
  const [quantityPercent, setQuantityPercent] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.settings.getMatchTolerances
      .query()
      .then((result) => {
        setData(result);
        setPricePercent(result.matchPriceTolerancePercent ?? '');
        setPriceAbsolute(result.matchPriceToleranceAbsolute ?? '');
        setQuantityPercent(result.matchQuantityTolerancePercent ?? '');
      })
      .catch((err) => {
        const message = err instanceof TRPCClientError ? err.message : 'Could not load settings.';
        setError(message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await trpc.settings.updateMatchTolerances.mutate({
        matchPriceTolerancePercent: pricePercent.trim() === '' ? null : pricePercent.trim(),
        matchPriceToleranceAbsolute: priceAbsolute.trim() === '' ? null : priceAbsolute.trim(),
        matchQuantityTolerancePercent: quantityPercent.trim() === '' ? null : quantityPercent.trim(),
      });
      setData(result);
      setSaved(true);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Could not save settings.';
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Settings" />
        <Card>
          <LoadingState />
        </Card>
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <PageHeader title="Settings" />
        <ErrorNotice>{error}</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description="Organization-wide configuration." />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card className="p-6">
        <h2 className="mb-1 text-sm font-semibold text-content">Three-way match tolerances</h2>
        <p className="mb-4 text-sm text-content-subtle">
          A price or quantity difference within these tolerances is treated as clean, not flagged as
          a variance — avoids alert fatigue on cents. Leave a field blank to use the default.
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Price tolerance (fraction)" hint={`Default ${DEFAULT_PRICE_PERCENT_LABEL}, e.g. 0.02`}>
            <Input
              value={pricePercent}
              onChange={(e) => setPricePercent(e.target.value)}
              placeholder="0.02"
              inputMode="decimal"
            />
          </Field>
          <Field label="Price tolerance (absolute)" hint={`Default ${DEFAULT_PRICE_ABSOLUTE_LABEL}, e.g. 5.00`}>
            <Input
              value={priceAbsolute}
              onChange={(e) => setPriceAbsolute(e.target.value)}
              placeholder="5.00"
              inputMode="decimal"
            />
          </Field>
          <Field label="Quantity tolerance (fraction)" hint={`Default ${DEFAULT_QUANTITY_PERCENT_LABEL}, e.g. 0.02`}>
            <Input
              value={quantityPercent}
              onChange={(e) => setQuantityPercent(e.target.value)}
              placeholder="0.02"
              inputMode="decimal"
            />
          </Field>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button type="button" variant="primary" disabled={saving} onClick={save}>
            Save
          </Button>
          {saved && <span className="text-sm text-positive">Saved.</span>}
        </div>
      </Card>
    </>
  );
}
