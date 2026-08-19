'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Input,
  LoadingState,
  PageHeader,
  Table,
  Td,
  Th,
  Tr,
  Value,
  type BadgeTone,
} from '@/components/ui';

type CountDetail = Awaited<ReturnType<typeof trpc.stocktake.get.query>>;
type Line = CountDetail['lines'][number];

const LARGE_VARIANCE_HINT_THRESHOLD = 0.1;

const STATUS_TONES: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  IN_PROGRESS: 'accent',
  SUBMITTED: 'warning',
  APPROVED: 'positive',
  REJECTED: 'danger',
};

/**
 * The actual "stocktake sheet" the plan Phase 7 describes — lines already arrive ordered by
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

  if (loading) return <LoadingState />;
  if (error && !detail) return <ErrorNotice>{error}</ErrorNotice>;
  if (!detail) return null;

  const { count, lines } = detail;

  return (
    <>
      <PageHeader
        title="Stock count"
        description="Compared against the balance from when this count started, not today's balance."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={STATUS_TONES[count.status] ?? 'neutral'}>
              {count.status.toLowerCase().replace(/_/g, ' ')}
            </Badge>
            <Link href="/inventory/stocktake">
              <Button variant="ghost">Back</Button>
            </Link>
          </div>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {count.status !== 'APPROVED' && count.status !== 'REJECTED' && (
        <Card className="mb-6 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="text-sm text-content-muted">
            {count.status === 'DRAFT' && 'Starting the count freezes the theoretical balance for every line.'}
            {count.status === 'IN_PROGRESS' && 'Enter a counted quantity for every line, then submit.'}
            {count.status === 'SUBMITTED' && 'Approving posts adjustment movements to the ledger.'}
          </p>
          <div className="flex gap-2">
            {count.status === 'DRAFT' && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  runAction(
                    () => trpc.stocktake.start.mutate({ stockCountId }),
                    'Could not start this count.'
                  )
                }
              >
                Start count
              </Button>
            )}
            {count.status === 'IN_PROGRESS' && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  runAction(
                    () => trpc.stocktake.submit.mutate({ stockCountId }),
                    'Every line must be counted before submitting.'
                  )
                }
              >
                Submit count
              </Button>
            )}
            {count.status === 'SUBMITTED' && (
              <>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    runAction(
                      () => trpc.stocktake.approve.mutate({ stockCountId }),
                      'Could not approve — a large variance may need a reason code, or a surplus line may have no known cost.'
                    )
                  }
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    runAction(
                      () => trpc.stocktake.reject.mutate({ stockCountId }),
                      'Could not reject this count.'
                    )
                  }
                >
                  Reject
                </Button>
              </>
            )}
          </div>
        </Card>
      )}

      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Location</Th>
              <Th>Product</Th>
              <Th align="right">Theoretical</Th>
              <Th align="right">Counted</Th>
              <Th align="right">Variance</Th>
              <Th>Reason</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const theoretical = line.line.theoreticalQuantityT0
                ? Number(line.line.theoreticalQuantityT0)
                : null;
              const varianceValue = line.line.varianceValue ? Number(line.line.varianceValue) : null;
              const varianceQty = line.line.varianceQuantity ? Number(line.line.varianceQuantity) : null;
              const magnitude =
                theoretical && theoretical !== 0 && line.line.varianceQuantity
                  ? Math.abs(Number(line.line.varianceQuantity)) / Math.abs(theoretical)
                  : 0;
              const needsReason = magnitude >= LARGE_VARIANCE_HINT_THRESHOLD && !line.line.reasonCode;

              // A line still owing a reason for a large discrepancy is the row that blocks approval,
              // so it carries the stripe — the thing to act on is visible while scanning, without
              // reading every variance figure.
              return (
                <Tr key={line.line.id} {...(needsReason ? { severity: 'watch' as const } : {})}>
                  <Td className="text-content-muted">{line.storageLocationName ?? 'Unassigned'}</Td>
                  <Td>
                    <span className="font-medium">{line.productName}</span>
                    <span className="ml-2 font-mono text-xs text-content-subtle">{line.productSku}</span>
                  </Td>
                  <Td variant="numeric" className="text-content-muted">
                    {line.line.theoreticalQuantityT0 ?? (
                      <span className="text-content-subtle italic">Not started</span>
                    )}
                  </Td>
                  <Td align="right">
                    {count.status === 'IN_PROGRESS' ? (
                      <div className="flex items-center justify-end gap-2">
                        <Input
                          type="text"
                          inputMode="decimal"
                          defaultValue={line.line.countedQuantity ?? ''}
                          onChange={(event) =>
                            setCounted(new Map(counted).set(line.line.id, event.target.value))
                          }
                          className="w-24 text-right"
                        />
                        <Button type="button" disabled={busy} onClick={() => handleEnterCount(line)}>
                          Save
                        </Button>
                      </div>
                    ) : (
                      // An uncounted line is genuinely uncounted, not zero — counting it as zero
                      // would post a full-stock write-off.
                      <Value value={line.line.countedQuantity} />
                    )}
                  </Td>
                  <Td variant="numeric">
                    {varianceQty === null ? (
                      <span className="italic text-unknown">Not counted</span>
                    ) : (
                      <span className="font-medium">
                        {varianceQty > 0 ? '+' : ''}
                        {line.line.varianceQuantity}
                        {varianceValue !== null && (
                          <span className="ml-1 text-xs text-content-subtle">
                            ({varianceValue.toFixed(2)})
                          </span>
                        )}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {line.line.reasonCode ? (
                      <span className="text-sm text-content-muted">{line.line.reasonCode}</span>
                    ) : needsReason ? (
                      <div className="flex items-center gap-2">
                        {count.status === 'SUBMITTED' ? (
                          <>
                            <Input
                              type="text"
                              placeholder="Reason required"
                              onChange={(event) =>
                                setReasons(new Map(reasons).set(line.line.id, event.target.value))
                              }
                              className="w-36"
                            />
                            <Button type="button" disabled={busy} onClick={() => handleSetReason(line)}>
                              Save
                            </Button>
                          </>
                        ) : (
                          <Badge tone="warning">Reason required</Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-content-subtle">—</span>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
