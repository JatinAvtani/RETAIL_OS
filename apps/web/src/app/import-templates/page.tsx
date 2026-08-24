'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Badge, Button, Card, EmptyState, ErrorNotice, PageHeader, SkeletonRows, Table, Td, Th, Tr, type BadgeTone } from '@/components/ui';

type CatalogCsvImportRow = Awaited<ReturnType<typeof trpc.catalogCsvImport.list.query>>[number];
type ImportType = CatalogCsvImportRow['importType'];

const STATUS_TONES: Record<CatalogCsvImportRow['status'], BadgeTone> = {
  UPLOADED: 'neutral',
  MAPPED: 'accent',
  IMPORTED: 'positive',
  FAILED: 'danger',
};

const IMPORT_TYPE_LABELS: Record<ImportType, string> = { PRODUCT: 'Products', SUPPLIER: 'Suppliers', RECIPE: 'Recipes' };

/**
 * bulk CSV import for products, suppliers, and recipes — an alternative on-ramp to
 * earlier work/invoice-derived auto-detection, for a tenant that already has a catalog in a
 * spreadsheet. Deliberately its own top-level route (not nested under /products, /suppliers,
 * /recipes, or /onboarding) — this project's own established layout-nesting lesson (a child route
 * under an existing AuthGuard layout doubles the AppShell), applied proactively, matching
 * /confirm-detected and /first-finding-report's precedent. Recipes were a deliberately deferred
 * follow-up when products/suppliers first shipped — a recipe CSV row references an EXISTING
 * product with no auto-create path, and is structurally multi-row-per-entity (one recipe + N
 * ingredient rows), a genuinely different shape than products/suppliers' one-row-per-entity CSVs.
 */
export default function ImportTemplatesPage() {
  const router = useRouter();
  const [importType, setImportType] = useState<ImportType>('PRODUCT');
  const [imports, setImports] = useState<CatalogCsvImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback((type: ImportType) => {
    setLoading(true);
    setError(null);
    trpc.catalogCsvImport.list
      .query({ importType: type })
      .then(setImports)
      .catch(() => setError('Could not load imports.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(importType), [load, importType]);

  const handleFile = async (file: File) => {
    setUploading(true);
    setError(null);

    try {
      const { uploadUrl, key } = await trpc.catalogCsvImport.requestUpload.mutate({ importType });

      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        body: file,
      });
      if (!putResponse.ok) {
        throw new Error('Upload to storage failed.');
      }

      const { importId } = await trpc.catalogCsvImport.confirmUpload.mutate({ importType, key });
      router.push(`/import-templates/${importId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed.';
      setError(message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Import templates"
        description="Upload a CSV of products, suppliers, or recipes. Match the columns once, preview, then import."
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <div className="mb-4 flex gap-2">
        {(['PRODUCT', 'SUPPLIER', 'RECIPE'] as const).map((type) => (
          <Button
            key={type}
            type="button"
            variant={importType === type ? 'primary' : 'secondary'}
            onClick={() => setImportType(type)}
          >
            {IMPORT_TYPE_LABELS[type]!}
          </Button>
        ))}
      </div>

      <Card className="mb-6 max-w-2xl p-6">
        <div className="flex flex-wrap items-end gap-3">
          <Button type="button" variant="primary" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
            {uploading ? 'Uploading…' : `Upload ${IMPORT_TYPE_LABELS[importType]!.toLowerCase()} CSV`}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = '';
            }}
          />
        </div>
      </Card>

      <Card>
        {loading && <SkeletonRows columns={4} />}
        {!loading && !error && imports.length === 0 && (
          <EmptyState
            title={`No ${IMPORT_TYPE_LABELS[importType]!.toLowerCase()} imports yet`}
            hint={`Upload a CSV to bulk-add ${IMPORT_TYPE_LABELS[importType]!.toLowerCase()}.`}
          />
        )}
        {!loading && !error && imports.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Uploaded</Th>
                <Th>Status</Th>
                <Th>Rows</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {imports.map((row) => (
                <Tr key={row.id}>
                  <Td className="text-content-muted">{new Date(row.createdAt).toLocaleString()}</Td>
                  <Td>
                    <Badge tone={STATUS_TONES[row.status]!}>{row.status.toLowerCase()}</Badge>
                  </Td>
                  <Td className="text-content-muted">{row.status === 'IMPORTED' ? `${row.importedRowCount ?? 0} imported` : '—'}</Td>
                  <Td align="right">
                    <Link href={`/import-templates/${row.id}`} className="text-sm font-medium text-accent hover:underline">
                      {row.status === 'UPLOADED' ? 'Map columns' : 'View'}
                    </Link>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
