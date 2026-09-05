'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { humanizeEnum } from '@/lib/format';
import { Badge, Button, Card, EmptyState, ErrorNotice, PageHeader, SkeletonRows, Select, Table, Td, Th, Tr, Value, type BadgeTone } from '@/components/ui';

type CsvImportRow = Awaited<ReturnType<typeof trpc.csvImport.list.query>>[number];

const STATUS_TONES: Record<CsvImportRow['status'], BadgeTone> = {
  UPLOADED: 'neutral',
  MAPPED: 'accent',
  IMPORTED: 'positive',
  FAILED: 'danger',
};

/**
 * earlier work's own CSV import flow had zero UI anywhere until now (all 8 `csvImport` procedures
 * existed, exercised only by tests). Same presigned-upload shape `documents.requestUpload`/
 * `confirmUpload` already established (direct-to-S3 PUT, bytes verified server-side after) — the
 * one real difference is the fixed `text/csv` content-type `csvImport.requestUpload`'s presigned
 * URL is signed for. `confirmUpload` both creates the row AND detects headers in one step, so a
 * successful upload here goes straight to the mapping screen — there is no intermediate "uploaded,
 * not yet mapped" state a human needs to act on separately.
 */
export default function SalesImportPage() {
  const router = useRouter();
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [imports, setImports] = useState<CsvImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.csvImport.list
      .query()
      .then(setImports)
      .catch(() => setError('Could not load imports.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const handleFile = async (file: File) => {
    if (!selectedStoreId) return;
    setUploading(true);
    setError(null);

    try {
      const { uploadUrl, key } = await trpc.csvImport.requestUpload.mutate({ storeId: selectedStoreId });

      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        body: file,
      });
      if (!putResponse.ok) {
        throw new Error('Upload to storage failed.');
      }

      const { importId } = await trpc.csvImport.confirmUpload.mutate({ storeId: selectedStoreId, key });
      router.push(`/sales-import/${importId}`);
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
        title="Sales import"
        description="Upload a CSV from your POS. Match the columns once, then import."
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card className="mb-6 max-w-2xl p-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[10rem]">
            <label className="mb-1.5 block text-sm font-medium text-content">Store</label>
            <Select value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)} disabled={storesLoading}>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="button"
            variant="primary"
            disabled={!selectedStoreId || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? 'Uploading…' : 'Upload CSV'}
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
        {loading && <SkeletonRows columns={5} />}
        {!loading && !error && imports.length === 0 && (
          <EmptyState title="No imports yet" hint="Upload a CSV to get started." />
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
                    <Badge tone={STATUS_TONES[row.status]}>{humanizeEnum(row.status)}</Badge>
                  </Td>
                  <Td className="text-content-muted">
                    {row.status === 'IMPORTED' ? (
                      row.importedRowCount === null ? (
                        <Value value={null} />
                      ) : (
                        <>
                          {row.importedRowCount} imported
                          {row.quarantinedRowCount !== null && row.quarantinedRowCount > 0
                            ? `, ${row.quarantinedRowCount} quarantined`
                            : ''}
                        </>
                      )
                    ) : (
                      <Value value={null} />
                    )}
                  </Td>
                  <Td align="right">
                    <Link href={`/sales-import/${row.id}`} className="text-sm font-medium text-accent hover:underline">
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
