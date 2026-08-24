'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Badge, Button, Card, ErrorNotice, Field, Input, LoadingState, PageHeader, Select, StepRail, Table, Td, Th, Tr, Value } from '@/components/ui';

type CatalogCsvImportDetail = Awaited<ReturnType<typeof trpc.catalogCsvImport.get.query>>;
type SavedMapping = Awaited<ReturnType<typeof trpc.catalogCsvImport.savedMappings.query>>[number];
type CommitResult = Awaited<ReturnType<typeof trpc.catalogCsvImport.commit.mutate>>;
type DetectedHeaders = { headers: string[]; sampleRows: string[][]; delimiter: string };

const PRODUCT_REQUIRED_FIELDS = [
  { key: 'sku', label: 'SKU' },
  { key: 'name', label: 'Name' },
  { key: 'unit', label: 'Unit (kg / g / l / ml / each / mg)' },
  { key: 'type', label: 'Type (INGREDIENT / SELLABLE / BOTH)' },
] as const;
const PRODUCT_OPTIONAL_FIELDS = [{ key: 'category', label: 'Category' }] as const;

const SUPPLIER_REQUIRED_FIELDS = [{ key: 'name', label: 'Name' }] as const;
const SUPPLIER_OPTIONAL_FIELDS = [
  { key: 'paymentTerms', label: 'Payment terms' },
  { key: 'leadTimeDaysContracted', label: 'Lead time (days)' },
  { key: 'minOrderValue', label: 'Minimum order value' },
] as const;

const RECIPE_REQUIRED_FIELDS = [
  { key: 'recipeName', label: 'Recipe name' },
  { key: 'yieldQuantity', label: 'Yield quantity' },
  { key: 'yieldUnit', label: 'Yield unit (kg / g / l / ml / each / mg)' },
  { key: 'componentProductName', label: 'Ingredient (existing product name)' },
  { key: 'componentQuantity', label: 'Ingredient quantity' },
  { key: 'componentUnit', label: 'Ingredient unit (kg / g / l / ml / each / mg)' },
] as const;
const RECIPE_OPTIONAL_FIELDS = [
  {
    key: 'wasteFactor',
    label: 'Waste factor (>= 1)',
    hint: 'A multiplier for trim/spillage — 1.1 means this ingredient uses 10% more than the recipe quantity alone. Leave unmapped to assume no extra waste.',
  },
] as const;

/**
 * Mirrors `/sales-import/[importId]`'s exact mapping+preview+commit shape (I2) — the only real
 * difference is which field set applies, driven off `importRow.importType` once loaded. This page
 * never downloads or parses the file itself; `detectedHeaders` was recorded once at `confirmUpload`
 * time and is only ever read back here.
 */
export default function CatalogCsvImportDetailPage() {
  const params = useParams<{ importId: string }>();

  const [importRow, setImportRow] = useState<CatalogCsvImportDetail | null>(null);
  const [savedMappings, setSavedMappings] = useState<SavedMapping[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [saveAsLabel, setSaveAsLabel] = useState('');
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submittingMapping, setSubmittingMapping] = useState(false);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    trpc.catalogCsvImport.get
      .query({ importId: params.importId })
      .then(async (row) => {
        setImportRow(row);
        const existing = row.columnMapping as Record<string, string> | null;
        if (existing) setMapping(existing);
        const mappings = await trpc.catalogCsvImport.savedMappings.query({ importType: row.importType });
        setSavedMappings(mappings);
      })
      .catch(() => setError('Could not load this import.'))
      .finally(() => setLoading(false));
  }, [params.importId]);

  const applySavedMapping = (label: string) => {
    const found = savedMappings.find((m) => m.label === label);
    if (found) setMapping(found.columnMapping as Record<string, string>);
  };

  const requiredFields =
    importRow?.importType === 'SUPPLIER' ? SUPPLIER_REQUIRED_FIELDS : importRow?.importType === 'RECIPE' ? RECIPE_REQUIRED_FIELDS : PRODUCT_REQUIRED_FIELDS;
  const optionalFields =
    importRow?.importType === 'SUPPLIER' ? SUPPLIER_OPTIONAL_FIELDS : importRow?.importType === 'RECIPE' ? RECIPE_OPTIONAL_FIELDS : PRODUCT_OPTIONAL_FIELDS;

  const handleSubmitMapping = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!importRow) return;
    setError(null);
    setSubmittingMapping(true);
    try {
      const columnMapping: Record<string, string> = {};
      for (const field of requiredFields) columnMapping[field.key] = mapping[field.key] ?? '';
      for (const field of optionalFields) if (mapping[field.key]) columnMapping[field.key] = mapping[field.key]!;

      const updated = await trpc.catalogCsvImport.submitColumnMapping.mutate({
        importId: params.importId,
        columnMapping: columnMapping as never,
        ...(saveAsLabel.trim() && { saveAsLabel: saveAsLabel.trim() }),
      });
      setImportRow(updated);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Could not save the column mapping.';
      setError(message);
    } finally {
      setSubmittingMapping(false);
    }
  };

  const handleCommit = async () => {
    setError(null);
    setCommitting(true);
    try {
      const result = await trpc.catalogCsvImport.commit.mutate({ importId: params.importId });
      setCommitResult(result);
      const refreshed = await trpc.catalogCsvImport.get.query({ importId: params.importId });
      setImportRow(refreshed);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Import failed.';
      setError(message);
    } finally {
      setCommitting(false);
    }
  };

  if (loading) return <LoadingState />;
  if (!importRow) return <ErrorNotice>{error ?? 'Import not found.'}</ErrorNotice>;

  const detected = importRow.detectedHeaders as DetectedHeaders | null;
  const canCommit = requiredFields.every((field) => Boolean(mapping[field.key]));
  const backHref = '/import-templates';

  return (
    <>
      <PageHeader
        title={importRow.importType === 'SUPPLIER' ? 'Supplier import' : importRow.importType === 'RECIPE' ? 'Recipe import' : 'Product import'}
        actions={
          <Link href={backHref}>
            <Button variant="ghost">Back to imports</Button>
          </Link>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <StepRail
        steps={['Map columns', 'Preview rows', 'Commit']}
        current={importRow.status === 'IMPORTED' ? 2 : importRow.status === 'MAPPED' ? 1 : 0}
      />

      {importRow.status === 'FAILED' && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm text-content-muted">Status</span>
          <Badge tone="danger">Failed</Badge>
        </div>
      )}

      {importRow.status === 'IMPORTED' && (
        <Card className="mb-6 max-w-2xl p-6">
          <h2 className="mb-3 text-sm font-semibold text-content">Import complete</h2>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Imported</div>
              <div className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-content">
                <Value value={importRow.importedRowCount} />
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Skipped</div>
              <div className="mt-1.5 font-mono text-lg font-semibold tabular-nums text-content">
                <Value value={importRow.skippedRowCount} />
              </div>
            </div>
          </div>
          <p className="mt-4 text-xs text-content-subtle">
            {importRow.importType === 'RECIPE'
              ? 'A skipped recipe had a missing/unrecognized field, an ingredient that does not match an existing product by name, or would have created a cycle. Fix the source file and re-upload to retry.'
              : 'A skipped row had a missing/unrecognized field, an unresolvable unit, or a SKU that already exists. Fix the source file and re-upload to retry those rows.'}
          </p>
          {importRow.importType === 'RECIPE' && commitResult && 'skippedGroups' in commitResult && commitResult.skippedGroups.length > 0 && (
            <div className="mt-4 border-t border-border pt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-subtle">Skipped recipes</h3>
              <ul className="space-y-1 text-sm">
                {commitResult.skippedGroups.map((g, i) => (
                  <li key={i} className="text-content-muted">
                    <span className="font-medium text-content">{g.recipeName}</span> — {g.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {importRow.status === 'FAILED' && importRow.errorSummary && <ErrorNotice>{importRow.errorSummary}</ErrorNotice>}

      {(importRow.status === 'UPLOADED' || importRow.status === 'MAPPED') && detected && (
        <>
          <Card className="mb-6 max-w-3xl p-6">
            <form onSubmit={handleSubmitMapping} className="space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-content">Map columns</h2>
                {savedMappings.length > 0 && (
                  <Select className="w-56" defaultValue="" onChange={(e) => e.target.value && applySavedMapping(e.target.value)}>
                    <option value="">Apply a saved mapping…</option>
                    {savedMappings.map((m) => (
                      <option key={m.id} value={m.label}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {[...requiredFields, ...optionalFields].map((field) => (
                  <Field
                    key={field.key}
                    label={`${field.label}${optionalFields.some((f) => f.key === field.key) ? ' (optional)' : ''}`}
                    {...('hint' in field && field.hint ? { hint: field.hint } : {})}
                  >
                    <Select value={mapping[field.key] ?? ''} onChange={(e) => setMapping((current) => ({ ...current, [field.key]: e.target.value }))}>
                      <option value="">— not mapped —</option>
                      {detected.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </div>

              <Field label="Save this mapping for next time (optional)">
                <Input
                  type="text"
                  value={saveAsLabel}
                  onChange={(e) => setSaveAsLabel(e.target.value)}
                  placeholder="e.g. Main supplier catalog export"
                />
              </Field>

              <div className="flex items-center gap-2 border-t border-border pt-5">
                <Button type="submit" variant="secondary" disabled={submittingMapping || !canCommit}>
                  {submittingMapping ? 'Saving…' : 'Save mapping'}
                </Button>
                <Button type="button" variant="primary" disabled={committing || importRow.status !== 'MAPPED'} onClick={handleCommit}>
                  {committing ? 'Importing…' : 'Commit import'}
                </Button>
              </div>
              {importRow.status === 'UPLOADED' && <p className="text-xs text-content-subtle">Save the mapping first, then commit.</p>}
            </form>
          </Card>

          <Card className="max-w-3xl overflow-x-auto p-6">
            <h2 className="mb-3 text-sm font-semibold text-content">Preview — first {detected.sampleRows.length} rows</h2>
            <Table>
              <thead>
                <tr>
                  {detected.headers.map((header) => (
                    <Th key={header}>{header}</Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detected.sampleRows.map((row, index) => (
                  <Tr key={index}>
                    {row.map((cell, cellIndex) => (
                      <Td key={cellIndex} className="text-content-muted">
                        {cell}
                      </Td>
                    ))}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
