'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';

type CountDetail = Awaited<ReturnType<typeof trpc.stocktake.get.query>>;
type Line = CountDetail['lines'][number];

const LARGE_VARIANCE_HINT_THRESHOLD = 0.1;

/**
 * The actual "stocktake sheet" plan.md Phase 7 describes — lines already arrive ordered by
 * physical storage location from `stocktake.get` (`findLinesOrderedByStorageLocation`), so this
 * page renders them in that order as-is rather than re-sorting client-side.
 */
export default function StocktakeDetailPage() {
  const params = useParams<{ stockCountId: string }>();
  const stockCountId = params.stockCountId;

  const [detail, setDetail] = useState<CountDetail | null>(null);
  const [counted, setCounted] = useState<Map<string, string>>(new Map());
  const [reasons, setReasons] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.stocktake.get
      .query({ stockCountId })
      .then(setDetail)
      .catch(() => setError('Could not load this stock count.'))
      .finally(() => setLoading(false));
  }, [stockCountId]);

  useEffect(() => {
    load();
  }, [load]);

  const runAction = async (action: () => Promise<unknown>, failureMessage: string) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      load();
    } catch {
      setError(failureMessage);
    } finally {
      setBusy(false);
    }
  };

  const handleEnterCount = async (line: Line) => {
    const value = counted.get(line.line.id);
    if (!value) return;
    await runAction(
      () => trpc.stocktake.enterCount.mutate({ stockCountLineId: line.line.id, countedQuantity: value }),
      'Could not save this count.'
    );
  };

  const handleSetReason = async (line: Line) => {
    const value = reasons.get(line.line.id);
    if (!value) return;
    await runAction(
      () => trpc.stocktake.setLineReason.mutate({ stockCountLineId: line.line.id, reasonCode: value }),
      'Could not save this reason.'
    );
  };

  if (loading) return <p>Loading...</p>;
  if (error && !detail) return <p role="alert">{error}</p>;
  if (!detail) return null;

  const { count, lines } = detail;

  return (
    <main>
      <h1>Stock count — {count.scope}</h1>
      <nav>
        <Link href="/inventory/stocktake">Back to stocktakes</Link>
      </nav>
      <p>
        Status: <strong>{count.status}</strong>
      </p>
      {error && <p role="alert">{error}</p>}

      <div>
        {count.status === 'DRAFT' && (
          <button type="button" disabled={busy} onClick={() => runAction(() => trpc.stocktake.start.mutate({ stockCountId }), 'Could not start this count.')}>
            Start count (freezes theoretical quantities)
          </button>
        )}
        {count.status === 'IN_PROGRESS' && (
          <button type="button" disabled={busy} onClick={() => runAction(() => trpc.stocktake.submit.mutate({ stockCountId }), 'Every line must be counted before submitting.')}>
            Submit count
          </button>
        )}
        {count.status === 'SUBMITTED' && (
          <>
            <button type="button" disabled={busy} onClick={() => runAction(() => trpc.stocktake.approve.mutate({ stockCountId }), 'Could not approve — a large variance may need a reason code, or a surplus line may have no known cost.')}>
              Approve
            </button>{' '}
            <button type="button" disabled={busy} onClick={() => runAction(() => trpc.stocktake.reject.mutate({ stockCountId }), 'Could not reject this count.')}>
              Reject
            </button>
          </>
        )}
      </div>

      <table>
        <thead>
          <tr>
            <th>Storage location</th>
            <th>Product</th>
            <th>Theoretical (T0)</th>
            <th>Counted</th>
            <th>Variance</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const theoretical = line.line.theoreticalQuantityT0 ? Number(line.line.theoreticalQuantityT0) : null;
            const varianceValue = line.line.varianceValue ? Number(line.line.varianceValue) : null;
            const magnitude =
              theoretical && theoretical !== 0 && line.line.varianceQuantity
                ? Math.abs(Number(line.line.varianceQuantity)) / Math.abs(theoretical)
                : 0;
            const needsReason = magnitude >= LARGE_VARIANCE_HINT_THRESHOLD && !line.line.reasonCode;

            return (
              <tr key={line.line.id}>
                <td>{line.storageLocationName ?? 'Unassigned'}</td>
                <td>{line.productName} ({line.productSku})</td>
                <td>{line.line.theoreticalQuantityT0 ?? 'Not yet started'}</td>
                <td>
                  {count.status === 'IN_PROGRESS' ? (
                    <>
                      <input
                        type="text"
                        inputMode="decimal"
                        defaultValue={line.line.countedQuantity ?? ''}
                        onChange={(event) => setCounted(new Map(counted).set(line.line.id, event.target.value))}
                      />{' '}
                      <button type="button" disabled={busy} onClick={() => handleEnterCount(line)}>
                        Save
                      </button>
                    </>
                  ) : (
                    (line.line.countedQuantity ?? '—')
                  )}
                </td>
                <td>
                  {line.line.varianceQuantity ?? '—'}
                  {varianceValue !== null && ` (${varianceValue.toFixed(2)})`}
                </td>
                <td>
                  {line.line.reasonCode ?? (needsReason ? 'Required' : '—')}
                  {count.status === 'SUBMITTED' && needsReason && (
                    <>
                      {' '}
                      <input
                        type="text"
                        placeholder="Reason"
                        onChange={(event) => setReasons(new Map(reasons).set(line.line.id, event.target.value))}
                      />{' '}
                      <button type="button" disabled={busy} onClick={() => handleSetReason(line)}>
                        Save reason
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
