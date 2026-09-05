'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { formatMoney, humanizeEnum } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  cx,
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
              {humanizeEnum(count.status)}
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

      {/* Desktop/tablet-landscape: the full table. Hidden below `sm` — a 6-column table with two
          inline input+button pairs cannot reflow onto a narrow screen without either horizontal
          scroll hiding the row's own product label (a real usability failure, not a style
          preference) or shrinking controls below a usable touch size. The `<CountRowCard>` list
          below is a genuinely separate layout for that width, not a CSS-only reflow of this one. */}
      <Card className="hidden sm:block">
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
              const row = computeRowState(line);
              return (
                <Tr key={line.line.id} {...(row.needsReason ? { severity: 'watch' as const } : {})}>
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
                    {row.varianceQty === null ? (
                      <span className="italic text-unknown">Not counted</span>
                    ) : (
                      <span className="font-medium">
                        {row.varianceQty > 0 ? '+' : ''}
                        {line.line.varianceQuantity}
                        {row.varianceValue !== null && (
                          <span className="ml-1 text-xs text-content-subtle">
                            ({formatMoney(row.varianceValue, undefined, { precision: 'currency' })})
                          </span>
                        )}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {line.line.reasonCode ? (
                      <span className="text-sm text-content-muted">{humanizeEnum(line.line.reasonCode)}</span>
                    ) : row.needsReason ? (
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

      {/* Mobile/tablet-portrait: one card per line, stacked, no horizontal scroll — the product
          name never scrolls away from the input a manager is actively counting into, and every
          control is `size="lg"` for a real touch target. */}
      <div className="space-y-3 sm:hidden">
        {lines.map((line) => (
          <CountRowCard
            key={line.line.id}
            line={line}
            row={computeRowState(line)}
            status={count.status}
            busy={busy}
            reasonDraft={reasons.get(line.line.id) ?? ''}
            onCountedChange={(value) => setCounted(new Map(counted).set(line.line.id, value))}
            onReasonChange={(value) => setReasons(new Map(reasons).set(line.line.id, value))}
            onSaveCount={() => handleEnterCount(line)}
            onSaveReason={() => handleSetReason(line)}
          />
        ))}
      </div>
    </>
  );
}

const computeRowState = (line: Line) => {
  const theoretical = line.line.theoreticalQuantityT0 ? Number(line.line.theoreticalQuantityT0) : null;
  const varianceValue = line.line.varianceValue ?? null;
  const varianceQty = line.line.varianceQuantity ? Number(line.line.varianceQuantity) : null;
  const magnitude =
    theoretical && theoretical !== 0 && line.line.varianceQuantity
      ? Math.abs(Number(line.line.varianceQuantity)) / Math.abs(theoretical)
      : 0;
  const needsReason = magnitude >= LARGE_VARIANCE_HINT_THRESHOLD && !line.line.reasonCode;
  return { varianceValue, varianceQty, needsReason };
};

/**
 * One line item's mobile card — the same real fields and actions as the desktop table's row,
 * laid out vertically instead of across columns so nothing needs horizontal scroll to reach.
 * `size="lg"` on every interactive control (the touch-target fix `ui.tsx`'s own `ControlSize`
 * exists for) — this is the first real caller of that size, deliberately not applied to the
 * desktop table above, which is still mouse-operated.
 */
const CountRowCard = ({
  line,
  row,
  status,
  busy,
  reasonDraft,
  onCountedChange,
  onReasonChange,
  onSaveCount,
  onSaveReason,
}: {
  line: Line;
  row: ReturnType<typeof computeRowState>;
  status: CountDetail['count']['status'];
  busy: boolean;
  reasonDraft: string;
  onCountedChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onSaveCount: () => void;
  onSaveReason: () => void;
}) => (
  <Card className={cx('p-4', row.needsReason && 'border-warning/50')}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-medium text-content">{line.productName}</p>
        <p className="font-mono text-xs text-content-subtle">{line.productSku}</p>
        <p className="mt-0.5 text-xs text-content-muted">{line.storageLocationName ?? 'Unassigned'}</p>
      </div>
      {row.needsReason && <Badge tone="warning">Reason required</Badge>}
    </div>

    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      <dt className="text-content-subtle">Theoretical</dt>
      <dd className="text-right font-mono text-content-muted">
        {line.line.theoreticalQuantityT0 ?? <span className="italic text-content-subtle">Not started</span>}
      </dd>
      <dt className="text-content-subtle">Variance</dt>
      <dd className="text-right font-mono">
        {row.varianceQty === null ? (
          <span className="italic text-unknown">Not counted</span>
        ) : (
          <>
            {row.varianceQty > 0 ? '+' : ''}
            {line.line.varianceQuantity}
            {row.varianceValue !== null && (
              <span className="ml-1 text-xs text-content-subtle">
                ({formatMoney(row.varianceValue, undefined, { precision: 'currency' })})
              </span>
            )}
          </>
        )}
      </dd>
    </dl>

    {status === 'IN_PROGRESS' && (
      <div className="mt-3 flex items-center gap-2">
        <Input
          type="text"
          inputMode="decimal"
          size="lg"
          defaultValue={line.line.countedQuantity ?? ''}
          onChange={(event) => onCountedChange(event.target.value)}
          className="flex-1"
          aria-label={`Counted quantity for ${line.productName}`}
        />
        <Button type="button" size="lg" disabled={busy} onClick={onSaveCount}>
          Save
        </Button>
      </div>
    )}
    {status !== 'IN_PROGRESS' && status !== 'DRAFT' && (
      <p className="mt-3 text-sm text-content-muted">
        Counted: <Value value={line.line.countedQuantity} />
      </p>
    )}

    {line.line.reasonCode ? (
      <p className="mt-3 text-sm text-content-muted">Reason: {humanizeEnum(line.line.reasonCode)}</p>
    ) : (
      row.needsReason &&
      status === 'SUBMITTED' && (
        <div className="mt-3 flex items-center gap-2">
          <Input
            type="text"
            size="lg"
            placeholder="Reason required"
            value={reasonDraft}
            onChange={(event) => onReasonChange(event.target.value)}
            className="flex-1"
            aria-label={`Variance reason for ${line.productName}`}
          />
          <Button type="button" size="lg" disabled={busy} onClick={onSaveReason}>
            Save
          </Button>
        </div>
      )
    )}
  </Card>
);
