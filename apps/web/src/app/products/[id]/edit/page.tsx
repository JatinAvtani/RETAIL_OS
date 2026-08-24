'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';

type Category = Awaited<ReturnType<typeof trpc.categories.list.query>>[number];

/** Mirrors `products.requestImageUpload`'s own zod enum exactly — the server is the authority; this list only stops an obviously-wrong file before a pointless round trip. */
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

export default function EditProductPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [isPerishable, setIsPerishable] = useState(false);
  const [sku, setSku] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [imageKey, setImageKey] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([trpc.products.get.query({ id: params.id }), trpc.categories.list.query()])
      .then(([product, cats]) => {
        setName(product.name);
        setSku(product.sku);
        setCategoryId(product.categoryId ?? '');
        setIsPerishable(product.isPerishable);
        setImageKey(product.imageKey ?? null);
        setCategories(cats);
      })
      .catch(() => setError('Could not load product.'))
      .finally(() => setLoading(false));
  }, [params.id]);

  /**
   * The same two-step presigned-upload shape the documents and CSV importers use: request a URL,
   * PUT the real bytes straight to object storage (never proxied through the API), then confirm —
   * and only the confirm step, which re-downloads and magic-byte-validates what actually landed,
   * writes `imageKey`. A presigned URL being issued proves nothing about what bytes arrived, which
   * is exactly why the server validates on confirm rather than trusting the declared content-type.
   */
  const handleImageChange = async (file: File) => {
    setImageError(null);
    setUploadingImage(true);
    try {
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type as AcceptedImageType)) {
        setImageError('Choose a JPEG, PNG, or WebP image.');
        return;
      }
      const { uploadUrl, key } = await trpc.products.requestImageUpload.mutate({
        productId: params.id,
        contentType: file.type as AcceptedImageType,
      });
      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putResponse.ok) throw new Error('Upload to storage failed.');

      const updated = await trpc.products.confirmImageUpload.mutate({ productId: params.id, key });
      setImageKey(updated.imageKey ?? key);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Could not upload that image.';
      setImageError(message);
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);

    try {
      await trpc.products.update.mutate({
        id: params.id,
        name,
        categoryId: categoryId || null,
        isPerishable,
      });
      setSaved(true);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingState />;

  return (
    <>
      <PageHeader
        title={name || 'Edit product'}
        description="SKU and base unit can't be changed after creation."
        actions={
          <Link href="/products">
            <Button variant="ghost">Back to products</Button>
          </Link>
        }
      />

      <Card className="max-w-2xl p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {saved && (
            <div className="rounded-card border border-positive/30 bg-positive-soft px-4 py-3 text-sm text-positive">
              Changes saved.
            </div>
          )}

          <div className="flex items-center gap-2 text-sm">
            <span className="text-content-muted">SKU</span>
            <Badge>{sku}</Badge>
            <span className="text-content-subtle">not editable</span>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name">
              <Input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>

            <Field
              label="Category"
              hint={
                <Link href="/categories" className="font-medium text-accent hover:underline">
                  Manage categories
                </Link>
              }
            >
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">None</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <label className="flex items-center gap-2.5 text-sm text-content">
            <input
              type="checkbox"
              checked={isPerishable}
              onChange={(e) => setIsPerishable(e.target.checked)}
              className="size-4 rounded border-border-strong accent-accent"
            />
            Perishable — track expiry dates and use first-expiry-first-out
          </label>

          <div className="border-t border-border pt-5">
            <p className="text-sm font-medium text-content">Product image</p>
            <p className="mt-0.5 text-xs text-content-subtle">
              JPEG, PNG, or WebP. Uploaded straight to storage and verified server-side before it&apos;s
              attached — saved immediately, independently of the form below.
            </p>
            {imageError && (
              <p role="alert" className="mt-2 flex items-center gap-1 text-xs font-medium text-danger">
                <span aria-hidden="true">⚠</span>
                {imageError}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                disabled={uploadingImage}
                onClick={() => imageInputRef.current?.click()}
              >
                {uploadingImage ? 'Uploading…' : imageKey ? 'Replace image' : 'Upload image'}
              </Button>
              {/* No image-read endpoint exists yet, so this deliberately confirms the attachment
                  rather than rendering a preview — showing a broken <img> or a fake thumbnail would
                  be worse than honestly stating what's true. */}
              <span className="text-xs text-content-muted">
                {imageKey ? 'An image is attached to this product.' : 'No image attached yet.'}
              </span>
              <input
                ref={imageInputRef}
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(',')}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImageChange(file);
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-border pt-5">
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save changes'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.push('/products')}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
