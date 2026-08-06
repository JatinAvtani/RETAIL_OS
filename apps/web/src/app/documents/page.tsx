'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { Badge, Card, EmptyState, ErrorNotice, LoadingState, PageHeader, Select, Table, Th, Td, Tr, Value } from '@/components/ui';

type DocumentRow = Awaited<ReturnType<typeof trpc.documents.list.query>>[number];

type UploadState = { fileName: string; status: 'uploading' | 'done' | 'error'; message?: string };

const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

const statusTone = (status: DocumentRow['status']) => {
  if (status === 'POSTED' || status === 'APPROVED' || status === 'AUTO_APPROVED') return 'positive' as const;
  if (status === 'REJECTED') return 'danger' as const;
  if (status === 'REVIEW_REQUIRED') return 'warning' as const;
  return 'neutral' as const;
};

const statusLabel: Record<DocumentRow['status'], string> = {
  UPLOADED: 'Uploaded',
  PROCESSING: 'Processing',
  REVIEW_REQUIRED: 'Needs review',
  AUTO_APPROVED: 'Auto-approved',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  POSTED: 'Posted',
};

/**
 * 007-02 (plan.md Phase 1): upload a supplier document (PDF or a phone photo — the exact two shapes
 * EPIC-002's extraction spike measured accuracy against), presigned direct-to-S3, drag-drop, bulk.
 * 007-04 classifies each document synchronously during upload (real Gemini vision call) — `type`
 * reflects that classification when it succeeded, and stays `OTHER` (with no confidence shown) when
 * it didn't run (no API key) or failed, matching how `confirmUpload` behaves either way. Extraction
 * (007-05/06) and posting still don't exist — a classified type is not yet an extracted invoice.
 */
export default function DocumentsPage() {
  const { stores, selectedStoreId, setSelectedStoreId, loading: storesLoading } = useStores();
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    if (!selectedStoreId) return;
    setLoading(true);
    setError(null);
    trpc.documents.list
      .query({ storeId: selectedStoreId })
      .then(setDocuments)
      .catch(() => setError('Could not load documents.'))
      .finally(() => setLoading(false));
  }, [selectedStoreId]);

  useEffect(() => {
    load();
  }, [load]);

  const uploadOne = async (file: File) => {
    if (!selectedStoreId) return;
    setUploads((current) => [...current, { fileName: file.name, status: 'uploading' }]);

    try {
      const { uploadUrl, key } = await trpc.documents.requestUpload.mutate({ storeId: selectedStoreId });

      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (!putResponse.ok) {
        throw new Error('Upload to storage failed.');
      }

      await trpc.documents.confirmUpload.mutate({ storeId: selectedStoreId, key });

      setUploads((current) =>
        current.map((u) => (u.fileName === file.name && u.status === 'uploading' ? { ...u, status: 'done' } : u))
      );
      load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed.';
      setUploads((current) =>
        current.map((u) => (u.fileName === file.name && u.status === 'uploading' ? { ...u, status: 'error', message } : u))
      );
    }
  };

  const uploadFiles = (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    setUploads([]);
    for (const file of files) {
      void uploadOne(file);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files.length > 0) {
      uploadFiles(event.dataTransfer.files);
    }
  };

  return (
    <>
      <PageHeader
        title="Documents"
        description="Upload supplier invoices — PDF or a photo. Each one is classified automatically; nothing is extracted or posted yet."
        actions={
          !storesLoading && stores.length > 0 ? (
            <Select value={selectedStoreId} onChange={(event) => setSelectedStoreId(event.target.value)} className="w-auto">
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </Select>
          ) : null
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {!storesLoading && stores.length === 0 && (
        <Card>
          <EmptyState title="No stores available." />
        </Card>
      )}

      {!storesLoading && stores.length > 0 && (
        <Card className="mb-6">
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
              isDragging ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent'
            }`}
          >
            <p className="text-sm font-medium text-content">Drag and drop invoices here, or click to browse</p>
            <p className="mt-1 text-xs text-content-muted">PDF, JPEG, or PNG — you can select multiple files at once</p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_TYPES.join(',')}
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) uploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {uploads.length > 0 && (
            <ul className="mt-4 space-y-1 text-sm">
              {uploads.map((upload, i) => (
                <li key={`${upload.fileName}-${i}`} className="flex items-center justify-between">
                  <span className="text-content">{upload.fileName}</span>
                  {upload.status === 'uploading' && <span className="text-content-muted">Uploading…</span>}
                  {upload.status === 'done' && <Badge tone="positive">Uploaded</Badge>}
                  {upload.status === 'error' && <Badge tone="danger">{upload.message ?? 'Failed'}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card>
        {(loading || storesLoading) && <LoadingState />}
        {!loading && !error && stores.length > 0 && documents.length === 0 && (
          <EmptyState title="No documents yet" hint="Upload an invoice above to get started." />
        )}
        {!loading && !error && documents.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Uploaded</Th>
                <Th>Type</Th>
                <Th>Classification confidence</Th>
                <Th>Status</Th>
                <Th align="right">Size</Th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <Tr key={doc.id}>
                  <Td>{new Date(doc.createdAt).toLocaleString()}</Td>
                  <Td className="text-content-muted">{doc.type}</Td>
                  <Td>
                    <Value
                      value={doc.classificationConfidence !== null ? `${(Number(doc.classificationConfidence) * 100).toFixed(0)}%` : null}
                    />
                  </Td>
                  <Td>
                    <Badge tone={statusTone(doc.status)}>{statusLabel[doc.status]}</Badge>
                  </Td>
                  <Td align="right" className="tabular text-content-muted">
                    {(Number(doc.sizeBytes) / 1024).toFixed(0)} KB
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
