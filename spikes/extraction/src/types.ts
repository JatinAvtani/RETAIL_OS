export interface InvoiceLine {
  sku: string | null;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  lineTotal: string;
}

export interface InvoiceGroundTruth {
  file: string;
  supplier: string;
  documentNumber: string;
  documentDate: string; // YYYY-MM-DD
  currency: string;
  lines: InvoiceLine[];
  discount: string | null;
  subtotal: string;
  tax: string;
  total: string;
  notes?: string;
}
