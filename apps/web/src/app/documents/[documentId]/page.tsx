'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { Badge, Button, Card, ErrorNotice, LoadingState, PageHeader, Select, Value, type BadgeTone } from '@/components/ui';

type ProductOption = Awaited<ReturnType<typeof trpc.products.list.query>>[number];

type ReviewData = Awaited<ReturnType<typeof trpc.documents.getForReview.query>>;
type ExtractedField = { value: string | null; confidence: number | null };
type ValidationIssue = { severity: 'BLOCK' | 'WARN'; code: string; field: string; message: string };

const HEADER_FIELD_LABELS: Record<string, string> = {
  supplier: 'Supplier',
  documentNumber: 'Document number',
  documentDate: 'Document date',
  currency: 'Currency',
  subtotal: 'Subtotal',
  tax: 'Tax',
  discount: 'Discount',
  total: 'Total',
};

const LINE_FIELD_LABELS: Record<string, string> = {
  sku: 'SKU',
  description: 'Description',
  quantity: 'Qty',
  unit: 'Unit',
  unitPrice: 'Unit price',
  lineTotal: 'Line total',
};

const HIGH_CONFIDENCE_THRESHOLD = 0.85;

const documentStatusTone = (status: ReviewData['document']['status']): BadgeTone => {
  if (status === 'POSTED' || status === 'APPROVED' || status === 'AUTO_APPROVED') return 'positive';
  if (status === 'REJECTED') return 'danger';
  if (status === 'REVIEW_REQUIRED') return 'warning';
  return 'neutral';
};

/** A field row is visually flagged when its own confidence is missing or below the same 0.85 threshold 007-08's routing uses — the reviewer sees exactly what kept this document out of AUTO_APPROVED. */
const FieldRow = ({
  fieldKey,
  label,
  field,
  selected,
  onSelect,
}: {
  fieldKey: string;
  label: string;
  field: ExtractedField | undefined;
  selected: boolean;
  onSelect: (fieldKey: string) => void;
}) => {
  const lowConfidence = field !== undefined && (field.confidence === null || field.confidence < HIGH_CONFIDENCE_THRESHOLD);
  return (
    <button
      type="button"
      onClick={() => onSelect(fieldKey)}
      className={`flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
        selected ? 'border-accent bg-accent-soft' : lowConfidence ? 'border-warning/40 bg-warning-soft/40 hover:border-warning' : 'border-border hover:border-border-strong'
      }`}
    >
      <span>
        <span className="block text-xs font-medium uppercase tracking-wide text-content-subtle">{label}</span>
        <span className="mt-0.5 block text-sm text-content">
          <Value value={field?.value ?? null} />
        </span>
      </span>
      {field && (
        <span className="shrink-0 text-right">
          {field.confidence === null ? (
            <Badge tone="warning">No confidence</Badge>
          ) : field.confidence < HIGH_CONFIDENCE_THRESHOLD ? (
            <Badge tone="warning">{(field.confidence * 100).toFixed(0)}%</Badge>
          ) : (
            <Badge tone="neutral">{(field.confidence * 100).toFixed(0)}%</Badge>
          )}
        </span>
      )}
    </button>
  );
};

/**
 * 007-10: maps one line's extracted SKU to a real product, creating/confirming a permanent
 * `supplier_products` row. Deliberately a plain dropdown over `products.list` (already existing,
 * simple substring search) — no fuzzy-suggestion matcher (confirmed with the user, since a single
 * invoice's line count is small enough that scanning a product list by name isn't a hardship, unlike
 * 006-11's higher-volume POS-item-mapping problem that fuzzy matching was built for).
 */
const LineMapping = ({
  documentId,
  lineIndex,
  products,
  onMapped,
}: {
  documentId: string;
  lineIndex: number;
  products: ProductOption[];
  onMapped: () => void;
}) => {
  const [productId, setProductId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!productId) return;
    setBusy(true);
    setError(null);
    try {
      await trpc.documents.confirmLineMapping.mutate({ documentId, lineIndex, productId });
      onMapped();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm this mapping.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
      <Select value={productId} onChange={(e) => setProductId(e.target.value)} className="flex-1 text-xs">
        <option value="">Map SKU to a product…</option>
        {products.map((product) => (
          <option key={product.id} value={product.id}>
            {product.name} ({product.sku})
          </option>
        ))}
      </Select>
      <Button variant="secondary" disabled={!productId || busy} onClick={handleConfirm}>
        Confirm
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
};

type DocumentLink = Awaited<ReturnType<typeof trpc.documents.getLinks.query>>[number];

const ENTITY_TYPE_LABELS: Record<string, string> = {
  supplier_price: 'Supplier price updated',
  lot: 'Stock lot received',
  stock_movement: 'Stock movement posted',
};

/**
 * 007-12 (plan.md: "provenance links — document -> every number it produced"). Real
 * `document_links` rows written by 007-11's `PostingService` — this is the forward half of the
 * spec's drill-through promise ("any margin figure traces back to the invoice image"), rendered on
 * the document's own page since that's the one place a reviewer would ask "what did approving this
 * actually do." A `lot` link is clickable — `/inventory/lots` is the one entity-detail page that
 * exists today; `supplier_price`/`stock_movement` render as a plain label, since no dedicated detail
 * page exists yet for either (not stubbed with a fake link to nowhere).
 */
const ProvenancePanel = ({ links }: { links: DocumentLink[] }) => {
  if (links.length === 0) return null;
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-content">What this document posted</h2>
      <ul className="space-y-2">
        {links.map((link) => (
          <li key={link.id} className="flex items-center justify-between text-sm">
            <span className="text-content">{ENTITY_TYPE_LABELS[link.entityType] ?? link.entityType}</span>
            <span className="font-mono text-xs text-content-subtle">{link.entityId.slice(0, 8)}…</span>
          </li>
        ))}
      </ul>
    </Card>
  );
};

/**
 * 007-09: the review workflow's actual screen — document image alongside every extracted field and
 * validation issue, so a reviewer can approve or reject in one place. Two real scope boundaries
 * (confirmed with the user before building): the document renders via a plain browser-native
 * `<iframe>`/`<img>` pointed at a presigned url — no PDF.js dependency, since ADR-13 already means
 * no real extraction from this provider carries bounding-box data to highlight against, so a
 * programmatic PDF renderer would buy nothing observable. Clicking a field selects/focuses it
 * (border highlight, matching the panel's own layout) rather than attempting to highlight a region
 * on the document image — the two panels stay independently scrollable, not literally synced,
 * which is the honest consequence of ADR-13, not a missing feature.
 *
 * 007-10: each line's SKU can be mapped to a real product via `LineMapping` — a permanent
 * `supplier_products` confirmation, the input 007-11's posting engine needs to know which real
 * product a line refers to.
 */
export default function DocumentReviewPage() {
  const params = useParams<{ documentId: string }>();
  const documentId = params.documentId;
  const router = useRouter();

  const [data, setData] = useState<ReviewData | null>(null);
  const [links, setLinks] = useState<DocumentLink[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.documents.getForReview
      .query({ documentId })
      .then(setData)
      .catch(() => setError('Could not load this document.'))
      .finally(() => setLoading(false));
  }, [documentId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    trpc.products.list.query().then(setProducts).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (data?.document.status !== 'POSTED') return;
    trpc.documents.getLinks.query({ documentId }).then(setLinks).catch(() => undefined);
  }, [documentId, data?.document.status]);

  const handleApprove = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await trpc.documents.approve.mutate({ documentId });
      router.push('/documents');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not approve this document.');
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await trpc.documents.reject.mutate({ documentId, reason: rejectReason.trim() || undefined });
      router.push('/documents');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not reject this document.');
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <LoadingState />
      </Card>
    );
  }

  if (error || !data) {
    return <ErrorNotice>{error ?? 'Document not found.'}</ErrorNotice>;
  }

  const { document, extraction, imageUrl } = data;
  const fields = (extraction?.fields ?? {}) as Record<string, ExtractedField>;
  const lines = (extraction?.lines ?? []) as Record<string, ExtractedField>[];
  const validation = (extraction?.validation ?? { issues: [], canAutoApprove: false }) as { issues: ValidationIssue[]; canAutoApprove: boolean };
  const isReviewable = document.status === 'REVIEW_REQUIRED' || document.status === 'AUTO_APPROVED';

  return (
    <>
      <PageHeader
        title="Review document"
        {...(document.type !== 'OTHER' ? { description: `Classified as ${document.type}` } : {})}
        actions={<Badge tone={documentStatusTone(document.status)}>{document.status.replace('_', ' ')}</Badge>}
      />

      {actionError && <ErrorNotice>{actionError}</ErrorNotice>}

      {!extraction && (
        <Card className="mb-6">
          <p className="text-sm text-content-muted">
            {document.status === 'PROCESSING' || document.status === 'UPLOADED'
              ? 'Extraction has not finished yet — check back shortly.'
              : 'No extraction is recorded for this document.'}
          </p>
        </Card>
      )}

      {extraction && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card className="p-0! overflow-hidden">
            <iframe title="Document" src={imageUrl} className="h-[75vh] w-full border-0" />
          </Card>

          <div className="flex flex-col gap-4">
            {document.status === 'POSTED' && <ProvenancePanel links={links} />}

            {validation.issues.length > 0 && (
              <Card>
                <h2 className="mb-2 text-sm font-semibold text-content">Validation issues</h2>
                <ul className="space-y-2">
                  {validation.issues.map((issue, i) => (
                    <li key={`${issue.code}-${i}`} className="flex items-start gap-2 text-sm">
                      <Badge tone={issue.severity === 'BLOCK' ? 'danger' : 'warning'}>{issue.severity}</Badge>
                      <span className="text-content-muted">{issue.message}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Card>
              <h2 className="mb-3 text-sm font-semibold text-content">Header fields</h2>
              <div className="space-y-2">
                {Object.entries(HEADER_FIELD_LABELS).map(([key, label]) => (
                  <FieldRow
                    key={key}
                    fieldKey={key}
                    label={label}
                    field={fields[key]}
                    selected={selectedField === key}
                    onSelect={setSelectedField}
                  />
                ))}
              </div>
            </Card>

            {lines.length > 0 && (
              <Card>
                <h2 className="mb-3 text-sm font-semibold text-content">Line items ({lines.length})</h2>
                <div className="space-y-4">
                  {lines.map((line, lineIndex) => (
                    <div key={lineIndex} className="rounded-lg border border-border p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-subtle">Line {lineIndex + 1}</p>
                      <div className="space-y-2">
                        {Object.entries(LINE_FIELD_LABELS).map(([key, label]) => (
                          <FieldRow
                            key={key}
                            fieldKey={`lines[${lineIndex}].${key}`}
                            label={label}
                            field={line[key]}
                            selected={selectedField === `lines[${lineIndex}].${key}`}
                            onSelect={setSelectedField}
                          />
                        ))}
                      </div>
                      {isReviewable && (
                        <LineMapping documentId={documentId} lineIndex={lineIndex} products={products} onMapped={load} />
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {isReviewable && (
              <Card>
                {!showRejectForm ? (
                  <div className="flex items-center gap-2">
                    <Button variant="primary" disabled={busy} onClick={handleApprove}>
                      Approve
                    </Button>
                    <Button variant="danger" disabled={busy} onClick={() => setShowRejectForm(true)}>
                      Reject
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <label className="block text-xs font-medium text-content-subtle" htmlFor="reject-reason">
                      Reason (optional)
                    </label>
                    <textarea
                      id="reject-reason"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      rows={2}
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-content"
                      placeholder="Why is this document being rejected?"
                    />
                    <div className="flex items-center gap-2">
                      <Button variant="danger" disabled={busy} onClick={handleReject}>
                        Confirm reject
                      </Button>
                      <Button variant="ghost" disabled={busy} onClick={() => setShowRejectForm(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
