'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Field,
  Input,
  LoadingState,
  PageHeader,
  StepRail,
  WorkflowFooter,
} from '@/components/ui';
import { OnboardingHealthPanel } from '@/components/onboarding-health';

type Progress = Awaited<ReturnType<typeof trpc.onboarding.getProgress.query>>;
type Product = Awaited<ReturnType<typeof trpc.products.list.query>>[number];
type ExistingParLevel = Awaited<ReturnType<typeof trpc.parLevels.listForStore.query>>[number];

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const STEP_LABELS = ['Connect sales', 'Upload invoices', 'Confirm detected', 'Set par levels', 'Done'];

/**
 * Steps 1-2 of the wizard (create organisation, create first store — the plan's own Phase 1) are
 * already handled by `auth.signup` (earlier work), so a caller only ever reaches this page already
 * having both — this page picks up at "connect sales." Every step deep-links to its already-real
 * feature (Square OAuth, CSV import, document upload) rather than reimplementing it (I2) — this
 * page's only new logic is the wizard shell, its progress tracking, and the par-levels step, which
 * genuinely had no UI anywhere yet.
 */
export default function OnboardingPage() {
  const { stores, selectedStoreId, loading: storesLoading } = useStores();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.onboarding.getProgress
      .query()
      .then(setProgress)
      .catch(() => setError('Could not load onboarding progress.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const markStep = async (
    step: 'salesConnectedStatus' | 'invoicesUploadedStatus' | 'entitiesConfirmedStatus' | 'parLevelsSetStatus',
    status: 'DONE' | 'SKIPPED'
  ) => {
    const updated = await trpc.onboarding.setStepStatus.mutate({ step, status });
    setProgress(updated);
  };

  if (loading || storesLoading) {
    return (
      <>
        <PageHeader title="Get set up" description="A few steps to your first real margin finding." />
        <LoadingState />
      </>
    );
  }

  if (error || !progress) {
    return (
      <>
        <PageHeader title="Get set up" description="A few steps to your first real margin finding." />
        <ErrorNotice>{error ?? 'Something went wrong.'}</ErrorNotice>
      </>
    );
  }

  const stepIndex =
    progress.salesConnectedStatus === 'PENDING'
      ? 0
      : progress.invoicesUploadedStatus === 'PENDING'
        ? 1
        : progress.entitiesConfirmedStatus === 'PENDING'
          ? 2
          : progress.parLevelsSetStatus === 'PENDING'
            ? 3
            : 4;

  return (
    <>
      <PageHeader
        title="Get set up"
        description="Connect your sales, upload invoices, and we'll show you where your margin went — usually within 48 hours."
      />
      <StepRail steps={STEP_LABELS} current={stepIndex} />

      <OnboardingHealthPanel />

      <div className="space-y-4">
        <ConnectSalesStep
          storeId={selectedStoreId}
          status={progress.salesConnectedStatus}
          onDone={() => markStep('salesConnectedStatus', 'DONE')}
          onSkip={() => markStep('salesConnectedStatus', 'SKIPPED')}
        />
        <UploadInvoicesStep
          status={progress.invoicesUploadedStatus}
          onDone={() => markStep('invoicesUploadedStatus', 'DONE')}
          onSkip={() => markStep('invoicesUploadedStatus', 'SKIPPED')}
        />
        <ConfirmDetectedStep
          storeId={selectedStoreId}
          status={progress.entitiesConfirmedStatus}
          onDone={() => markStep('entitiesConfirmedStatus', 'DONE')}
          onSkip={() => markStep('entitiesConfirmedStatus', 'SKIPPED')}
        />
        <ParLevelsStep
          storeId={selectedStoreId}
          status={progress.parLevelsSetStatus}
          onDone={() => markStep('parLevelsSetStatus', 'DONE')}
          onSkip={() => markStep('parLevelsSetStatus', 'SKIPPED')}
        />
      </div>

      {stepIndex === 4 && (
        <WorkflowFooter>
          <Link href="/first-finding-report">
            <Button variant="secondary">See your first finding</Button>
          </Link>
          <Link href="/dashboard">
            <Button variant="primary">Go to dashboard</Button>
          </Link>
        </WorkflowFooter>
      )}

      {stores.length === 0 && (
        <ErrorNotice>No store found for your organisation yet — this shouldn't happen after signup.</ErrorNotice>
      )}
    </>
  );
}

const StepStatusBadge = ({ status }: { status: 'PENDING' | 'DONE' | 'SKIPPED' }) => {
  if (status === 'DONE') return <Badge tone="positive">Done</Badge>;
  if (status === 'SKIPPED') return <Badge tone="neutral">Skipped</Badge>;
  return <Badge tone="warning">Not started</Badge>;
};

const StepCard = ({
  title,
  description,
  status,
  children,
  onSkip,
}: {
  title: string;
  description: string;
  status: 'PENDING' | 'DONE' | 'SKIPPED';
  children?: React.ReactNode;
  onSkip?: () => void;
}) => (
  <Card className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold text-content">{title}</h2>
        <p className="mt-1 text-sm text-content-muted">{description}</p>
      </div>
      <StepStatusBadge status={status} />
    </div>
    {status === 'PENDING' && (
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {children}
        {onSkip && (
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        )}
      </div>
    )}
  </Card>
);

const ConnectSalesStep = ({
  storeId,
  status,
  onDone,
  onSkip,
}: {
  storeId: string;
  status: 'PENDING' | 'DONE' | 'SKIPPED';
  onDone: () => void;
  onSkip: () => void;
}) => (
  <StepCard
    title="1. Connect sales"
    description="Connect Square, or upload a sales CSV — either shows us what's selling."
    status={status}
    onSkip={onSkip}
  >
    <a href={storeId ? `${API_URL}/integrations/square/connect?storeId=${storeId}` : undefined}>
      <Button variant="primary" disabled={!storeId}>
        Connect Square
      </Button>
    </a>
    <Link href="/sales-import">
      <Button variant="secondary" onClick={onDone}>
        Upload sales CSV instead
      </Button>
    </Link>
  </StepCard>
);

const UploadInvoicesStep = ({
  status,
  onDone,
  onSkip,
}: {
  status: 'PENDING' | 'DONE' | 'SKIPPED';
  onDone: () => void;
  onSkip: () => void;
}) => (
  <StepCard
    title="2. Upload invoices"
    description="The highest-value step — 90 days of supplier invoices is enough to find real cost changes and overcharges."
    status={status}
    onSkip={onSkip}
  >
    <Link href="/documents">
      <Button variant="primary" onClick={onDone}>
        Upload invoices
      </Button>
    </Link>
  </StepCard>
);

type DetectedProductCandidate = Awaited<ReturnType<typeof trpc.productDetection.detectProducts.query>>[number];
type DetectedSupplierCandidate = Awaited<ReturnType<typeof trpc.productDetection.detectSuppliers.query>>[number];

/**
 * earlier work detect and propose real product/supplier candidates from invoice lines and headers
 * (clustered by supplier SKU / name / description similarity, every proposed field read verbatim
 * from real text, never guessed — I7). Bulk CONFIRMING a proposal into a real product/supplier row
 * is separate, human-gated scope (I9) — this step is read-only, showing what was found and
 * linking to manual catalog entry for now, matching the wizard's own "every step skippable,
 * resumable" design. Supplier detection deliberately has no pack-size/tax-ID/lead-time fields to
 * show — the plan names them, but neither is buildable from real extracted data today (confirmed
 * before building earlier work), so the UI shows only what's real: a name and its evidence count.
 */
const ConfirmDetectedStep = ({
  storeId,
  status,
  onDone,
  onSkip,
}: {
  storeId: string;
  status: 'PENDING' | 'DONE' | 'SKIPPED';
  onDone: () => void;
  onSkip: () => void;
}) => {
  const [productCandidates, setProductCandidates] = useState<DetectedProductCandidate[] | null>(null);
  const [supplierCandidates, setSupplierCandidates] = useState<DetectedSupplierCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status !== 'PENDING' || !storeId) return;
    setLoading(true);
    Promise.all([
      trpc.productDetection.detectProducts.query({ storeId }).catch(() => null),
      trpc.productDetection.detectSuppliers.query({ storeId }).catch(() => null),
    ])
      .then(([products, suppliers]) => {
        setProductCandidates(products);
        setSupplierCandidates(suppliers);
      })
      .finally(() => setLoading(false));
  }, [status, storeId]);

  const nothingDetected =
    !loading && productCandidates?.length === 0 && supplierCandidates?.length === 0;

  return (
    <StepCard
      title="3. Confirm detected products & suppliers"
      description="Detected from your approved invoices, grouped by supplier SKU and description — review, then add each to your catalog."
      status={status}
      onSkip={onSkip}
    >
      {loading && <p className="text-sm text-content-muted">Scanning your invoices…</p>}
      {nothingDetected && (
        <p className="text-sm text-content-muted">
          Nothing detected yet — approve a supplier invoice first, or add products/suppliers directly.
        </p>
      )}
      {!loading && productCandidates && productCandidates.length > 0 && (
        <div className="w-full space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Products</p>
          <ul className="space-y-1.5">
            {productCandidates.slice(0, 5).map((candidate) => (
              <li key={candidate.clusterKey} className="flex items-center justify-between rounded-control border border-border bg-surface-raised px-3 py-2 text-sm">
                <span className="text-content">{candidate.proposedName}</span>
                <span className="flex items-center gap-2 text-xs text-content-subtle">
                  {candidate.proposedPackSize && candidate.proposedUnit && (
                    <span className="font-mono">{candidate.proposedPackSize}{candidate.proposedUnit}</span>
                  )}
                  <Badge tone="accent">{candidate.evidenceLines.length} invoice line{candidate.evidenceLines.length === 1 ? '' : 's'}</Badge>
                </span>
              </li>
            ))}
          </ul>
          {productCandidates.length > 5 && (
            <p className="text-xs text-content-subtle">and {productCandidates.length - 5} more detected.</p>
          )}
        </div>
      )}
      {!loading && supplierCandidates && supplierCandidates.length > 0 && (
        <div className="mt-4 w-full space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Suppliers</p>
          <ul className="space-y-1.5">
            {supplierCandidates.slice(0, 5).map((candidate) => (
              <li key={candidate.clusterKey} className="flex items-center justify-between rounded-control border border-border bg-surface-raised px-3 py-2 text-sm">
                <span className="text-content">{candidate.proposedName}</span>
                <Badge tone="accent">{candidate.evidenceDocumentIds.length} invoice{candidate.evidenceDocumentIds.length === 1 ? '' : 's'}</Badge>
              </li>
            ))}
          </ul>
          {supplierCandidates.length > 5 && (
            <p className="text-xs text-content-subtle">and {supplierCandidates.length - 5} more detected.</p>
          )}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Link href="/confirm-detected">
          <Button variant="primary" onClick={onDone}>
            Review and confirm
          </Button>
        </Link>
      </div>
    </StepCard>
  );
};

const ParLevelsStep = ({
  storeId,
  status,
  onDone,
  onSkip,
}: {
  storeId: string;
  status: 'PENDING' | 'DONE' | 'SKIPPED';
  onDone: () => void;
  onSkip: () => void;
}) => {
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productId, setProductId] = useState('');
  const [parLevel, setParLevel] = useState('');
  const [reorderPoint, setReorderPoint] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [existing, setExisting] = useState<ExistingParLevel[]>([]);

  useEffect(() => {
    if (status !== 'PENDING') return;
    setProductsLoading(true);
    trpc.products.list
      .query()
      .then((result) => {
        setProducts(result);
        if (result[0]) setProductId(result[0].id);
      })
      .finally(() => setProductsLoading(false));
  }, [status]);

  // Reading back what's already set — without this the step was genuinely write-only: a user could
  // save a par level and get no confirmation it landed, then have no way to see it again or notice
  // they'd already set one for that product.
  const refreshExisting = useCallback(() => {
    if (!storeId) return;
    trpc.parLevels.listForStore.query({ storeId }).then(setExisting).catch(() => setExisting([]));
  }, [storeId]);

  useEffect(refreshExisting, [refreshExisting]);

  const save = async () => {
    if (!storeId || !productId) return;
    setSaveError(null);
    setSaving(true);
    try {
      const variants = await trpc.products.getVariants.query({ id: productId });
      const defaultVariant = variants.find((v) => v.isDefault) ?? variants[0];
      if (!defaultVariant) throw new Error('This product has no variant yet.');
      const variantId = defaultVariant.id;

      await trpc.parLevels.set.mutate({
        storeId,
        productId,
        variantId,
        ...(parLevel ? { parLevel } : {}),
        ...(reorderPoint ? { reorderPoint } : {}),
      });
      setParLevel('');
      setReorderPoint('');
      refreshExisting();
      onDone();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save this par level.');
    } finally {
      setSaving(false);
    }
  };

  const productNameById = new Map(products.map((product) => [product.id, product.name]));

  return (
    <StepCard
      title="4. Set par levels"
      description="Optional now — set a reorder threshold for your first product, or come back once you have consumption history."
      status={status}
      onSkip={onSkip}
    >
      {productsLoading ? (
        <p className="text-sm text-content-muted">Loading products…</p>
      ) : products.length === 0 ? (
        <p className="text-sm text-content-muted">Add a product first, then come back here.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Product">
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="w-56 rounded-control border border-border-strong bg-surface-raised px-3 py-1.5 text-sm text-content"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Par level" hint="How much should be on hand at a glance">
            <Input value={parLevel} onChange={(e) => setParLevel(e.target.value)} placeholder="e.g. 20" className="w-28" />
          </Field>
          <Field label="Reorder point" hint="The threshold that should trigger a reorder">
            <Input value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} placeholder="e.g. 10" className="w-28" />
          </Field>
          <Button variant="primary" onClick={save} disabled={saving || (!parLevel && !reorderPoint)}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
      {saveError && <p className="mt-2 text-xs text-danger">{saveError}</p>}
      {!storeId && <p className="mt-2 text-xs text-content-subtle">Select a store above to set par levels.</p>}

      {existing.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Already set</p>
          <ul className="mt-2 space-y-1">
            {existing.map((row) => (
              <li key={`${row.productId}-${row.variantId}`} className="flex flex-wrap gap-x-3 text-sm text-content-muted">
                {/* A par level set for a product that isn't in the current product list (deleted,
                    or simply not loaded) still shows honestly by id rather than vanishing. */}
                <span className="font-medium text-content">
                  {productNameById.get(row.productId) ?? `Product ${row.productId.slice(0, 8)}…`}
                </span>
                <span>par {row.parLevel ?? '—'}</span>
                <span>reorder at {row.reorderPoint ?? '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </StepCard>
  );
};
