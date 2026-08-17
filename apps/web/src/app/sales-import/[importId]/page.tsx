'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Badge, Button, Card, ErrorNotice, Field, Input, LoadingState, PageHeader, Select, Table, Td, Th, Tr } from '@/components/ui';

type CsvImportDetail = Awaited<ReturnType<typeof trpc.csvImport.get.query>>;
type SavedMapping = Awaited<ReturnType<typeof trpc.csvImport.savedMappings.query>>[number];
type DetectedHeaders = { headers: string[]; sampleRows: string[][]; delimiter: string };

const REQUIRED_FIELDS = [
  { key: 'occurredAt', label: 'Date / time' },
  { key: 'posItemName', label: 'Item name' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'unitPrice', label: 'Unit price' },
] as const;

const OPTIONAL_FIELDS = [
  { key: 'discount', label: 'Discount' },
  { key: 'lineTotal', label: 'Line total' },
  { key: 'currency', label: 'Currency' },
] as const;

/**
 * The mapping + commit screen — the real work of 006-10's flow. `detectedHeaders` is only present
 * once (recorded by `confirmUpload`, read back here rather than re-parsed) — this page never
 * downloads or parses the file itself, matching the "server verifies bytes once" boundary the
 * upload step already established. Committing is blocked until every REQUIRED field has a mapped
 * column — `commit` itself would reject a missing required field, but catching it here means the
 * human sees why before spending a round trip.
 */
export default function CsvImportDetailPage() {
  const params = useParams<{ importId: string }>();

  const [importRow, setImportRow] = useState<CsvImportDetail | null>(null);
  const [savedMappings, setSavedMappings] = useState<SavedMapping[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [saveAsLabel, setSaveAsLabel] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submittingMapping, setSubmittingMapping] = useState(false);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    Promise.all([trpc.csvImport.get.query({ importId: params.importId }), trpc.csvImport.savedMappings.query()])
      .then(([row, mappings]) => {
        setImportRow(row);
        setSavedMappings(mappings);
        const existing = row.columnMapping as Record<string, string> | null;
        if (existing) setMapping(existing);
      })
      .catch(() => setError('Could not load this import.'))
      .finally(() => setLoading(false));
  }, [params.importId]);

  const applySavedMapping = (label: string) => {
    const found = savedMappings.find((m) => m.label === label);
    if (found) setMapping(found.columnMapping as Record<string, string>);
  };

  const handleSubmitMapping = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmittingMapping(true);
    try {
      const columnMapping = {
        occurredAt: mapping.occurredAt ?? '',
        posItemName: mapping.posItemName ?? '',
        quantity: mapping.quantity ?? '',
        unitPrice: mapping.unitPrice ?? '',
        ...(mapping.discount && { discount: mapping.discount }),
        ...(mapping.lineTotal && { lineTotal: mapping.lineTotal }),
        ...(mapping.currency && { currency: mapping.currency }),
      };
      const updated = await trpc.csvImport.submitColumnMapping.mutate({
        importId: params.importId,
        columnMapping,
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
      await trpc.csvImport.commit.mutate({ importId: params.importId });
      const refreshed = await trpc.csvImport.get.query({ importId: params.importId });
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
  const canCommit = REQUIRED_FIELDS.every((field) => Boolean(mapping[field.key]));

  return (
    <>
      <PageHeader
        title="Sales import"
        actions={
          <Link href="/sales-import">
            <Button variant="ghost">Back to imports</Button>
          </Link>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm text-content-muted">Status</span>
        <Badge tone={importRow.status === 'IMPORTED' ? 'positive' : importRow.status === 'FAILED' ? 'danger' : 'accent'}>
          {importRow.status.toLowerCase()}
        </Badge>
      </div>

      {importRow.status === 'IMPORTED' && (
        <Card className="mb-6 max-w-2xl p-6">
          <h2 className="mb-3 text-sm font-semibold text-content">Import complete</h2>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-content-subtle">Imported</div>
              <div className="tabular text-lg font-semibold text-positive">{importRow.importedRowCount ?? 0}</div>
            </div>
            <div>
              <div className="text-content-subtle">Quarantined</div>
              <div className="tabular text-lg font-semibold text-warning">{importRow.quarantinedRowCount ?? 0}</div>
            </div>
            <div>
              <div className="text-content-subtle">Skipped</div>
              <div className="tabular text-lg font-semibold text-content-muted">{importRow.skippedRowCount ?? 0}</div>
            </div>
          </div>
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
                  <Select
                    className="w-56"
                    defaultValue=""
                    onChange={(e) => e.target.value && applySavedMapping(e.target.value)}
                  >
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
                {[...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].map((field) => (
                  <Field key={field.key} label={`${field.label}${OPTIONAL_FIELDS.some((f) => f.key === field.key) ? ' (optional)' : ''}`}>
                    <Select
                      value={mapping[field.key] ?? ''}
                      onChange={(e) => setMapping((current) => ({ ...current, [field.key]: e.target.value }))}
                    >
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
                  placeholder="e.g. Toast weekly export"
                />
              </Field>

              <div className="flex items-center gap-2 border-t border-border pt-5">
                <Button type="submit" variant="secondary" disabled={submittingMapping || !canCommit}>
                  {submittingMapping ? 'Saving…' : 'Save mapping'}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={committing || importRow.status !== 'MAPPED'}
                  onClick={handleCommit}
                >
                  {committing ? 'Importing…' : 'Commit import'}
                </Button>
              </div>
              {importRow.status === 'UPLOADED' && (
                <p className="text-xs text-content-subtle">Save the mapping first, then commit.</p>
              )}
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
