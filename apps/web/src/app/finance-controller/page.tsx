'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import {
 Badge,
 Button,
 Card,
 CardHeader,
 EmptyState,
 ErrorNotice,
 Input,
 LoadingState,
 PageHeader,
 Value,
} from '@/components/ui';

type Finding = Awaited<ReturnType<typeof trpc.financeController.listFindings.query>>[number];
type InvestigationDetail = Awaited<ReturnType<typeof trpc.financeController.getInvestigation.query>>;
/** `trace`/`draft` are stored as opaque JSONB (`packages/db/src/schema/investigations.ts`), so the
 * router's own return type carries them as `unknown` — these mirror `@retailos/assistant`'s real
 * `InvestigationStep`/`ActionDraftResult` shapes for rendering only, cast at the one read site below
 * rather than trusted as already-typed (the same "JSONB round-trip, re-validate at the boundary"
 * discipline this codebase applies wherever a JSONB column crosses back into typed code). */
type InvestigationStep = {
 hop: number;
 question: string;
 narration: string | null;
 sufficiency: 'SUFFICIENT' | 'NEEDS_FOLLOWUP' | 'HOP_LIMIT_REACHED' | 'GROUNDING_FAILED';
};
type DraftLine = { candidateId: string; label: string; quantity: string; unitLabel: string };

/**
 * A proactive investigation's `question` is machine-composed: the finding quoted verbatim, then the
 * analytical prompt appended (`investigation-trigger-processor.ts` builds it). The full string is
 * the right thing to show in the DETAIL panel — it's exactly what the pipeline was asked — but in
 * the list it buries the finding under boilerplate repeated on every row, and a lot-expiry finding
 * can quote dozens of products.
 *
 * So the list shows just the quoted finding, trimmed to its first sentence. Falls back to the whole
 * string for an on-demand question, which has no quoted part and is already the user's own words.
 */
const findingSummary = (question: string): string => {
 const quoted = /^Finding:\s*"([\s\S]*?)"\s*(?:What|$)/.exec(question);
 const text = (quoted?.[1] ?? question).trim();
 const firstSentence = /^(.*?[.!?])\s/.exec(text);
 return (firstSentence?.[1] ?? text).trim();
};

/**
 * the Finance Controller's own real UI — a standalone page, deliberately not a
 * mode of /assistant (the epic's own confirmed design decision). Renders the SAME real, persisted
 * `investigations` rows the proactive sweep and on-demand `investigate` mutation
 * both write — no separate presentation logic invents a nicer shape than what's actually stored.
 * Every cited figure inside a trace step's narration already passed the grounding validator before
 * it was ever persisted (I1) — this page renders that text verbatim, adding no new number-formatting
 * of its own for narration; only the draft's own quantity/label fields (real domain values, never
 * model output) get `Value`'s standard mono rendering.
 */
export default function FinanceControllerPage() {
 const { selectedStoreId } = useStores();
 const [findings, setFindings] = useState<Finding[] | null>(null);
 const [findingsError, setFindingsError] = useState<string | null>(null);
 const [selectedId, setSelectedId] = useState<string | null>(null);
 const [detail, setDetail] = useState<InvestigationDetail | null>(null);
 const [detailLoading, setDetailLoading] = useState(false);
 const [detailError, setDetailError] = useState<string | null>(null);
 const [question, setQuestion] = useState('');
 const [asking, setAsking] = useState(false);
 const [askError, setAskError] = useState<string | null>(null);
 const [approving, setApproving] = useState(false);
 const [approveError, setApproveError] = useState<string | null>(null);
 const [approvedPoId, setApprovedPoId] = useState<string | null>(null);

 const loadFindings = () => {
 trpc.financeController.listFindings.query().then(setFindings).catch(() => setFindingsError('Could not load findings.'));
 };

 useEffect(() => {
 loadFindings();
 }, []);

 const openFinding = (id: string) => {
 setSelectedId(id);
 setDetail(null);
 setDetailError(null);
 setApprovedPoId(null);
 setApproveError(null);
 setDetailLoading(true);
 trpc.financeController.getInvestigation.query({ investigationId: id }).then(setDetail).catch(() => setDetailError('Could not load this investigation.')).finally(() => setDetailLoading(false));
 };

 const ask = () => {
 if (!question.trim()) return;
 setAsking(true);
 setAskError(null);
 trpc.financeController.investigate.mutate({ question, ...(selectedStoreId ? { storeId: selectedStoreId } : {}) }).then((result) => {
 setQuestion('');
 openFinding(result.investigationId);
 loadFindings();
 }).catch(() => setAskError("Couldn't complete the investigation. Please try again.")).finally(() => setAsking(false));
 };

 const approve = () => {
 if (!detail || !detail.storeId) return;
 setApproving(true);
 setApproveError(null);
 trpc.financeController.approveDraftAction.mutate({ investigationId: detail.id, storeId: detail.storeId }).then((result) => {
 setApprovedPoId(result.purchaseOrderId);
 loadFindings();
 }).catch((err: unknown) => setApproveError(err instanceof Error ? err.message : 'Could not approve this draft.')).finally(() => setApproving(false));
 };

 const reject = () => {
 if (!detail) return;
 trpc.financeController.rejectDraftAction.mutate({ investigationId: detail.id }).then(() => {
 openFinding(detail.id);
 loadFindings();
 }).catch(() => setApproveError('Could not reject this draft.'));
 };

 const draft = detail?.draft as { lines: DraftLine[] } | null;
 const trace = (detail?.trace as InvestigationStep[] | null) ?? [];

 return (
 <div>
 <PageHeader
 title="Finance Controller"
 description="Findings the system investigated on its own, plus anything you ask directly — every figure traces back to a real, verified value."
 actions={
 <Link href="/finance-controller/reconciliation" className="text-sm font-medium text-accent hover:underline">
 Batch reconciliation report →
 </Link>
 }
 />

 {askError && <ErrorNotice>{askError}</ErrorNotice>}

 <Card className="mb-6">
 <CardHeader title="Ask a question" />
 <div className="flex gap-2 p-4">
 <Input
 value={question}
 onChange={(e) => setQuestion(e.target.value)}
 onKeyDown={(e) => e.key === 'Enter' && !asking && ask}
 placeholder="e.g. Why did margin drop this month?"
 disabled={asking}
 />
 <Button variant="primary" onClick={ask} disabled={asking || !question.trim()}>
 {asking ? 'Investigating…' : 'Investigate'}
 </Button>
 </div>
 </Card>

 <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(280px,360px)_1fr]">
 <Card>
 <CardHeader title="Findings" />
 {findingsError && <ErrorNotice>{findingsError}</ErrorNotice>}
 {findings === null && !findingsError && <LoadingState label="Loading findings…" />}
 {findings !== null && findings.length === 0 && (
 <EmptyState title="No findings yet" hint="When the system detects something worth investigating, it will appear here automatically." />)}
 {findings !== null && findings.length > 0 && (
 <ul className="divide-y divide-border">
 {findings.map((f) => (
 <li key={f.id}>
 <button
 type="button"
 onClick={() => openFinding(f.id)}
 className={`w-full px-4 py-3 text-left transition-colors hover:bg-surface ${selectedId === f.id ? 'bg-surface-sunken' : ''}`}
 >
 <p className="line-clamp-3 text-sm text-content">{findingSummary(f.question)}</p>
 <p className="mt-1 text-xs text-content-subtle">{new Date(f.createdAt).toLocaleString()}</p>
 </button>
 </li>))}
 </ul>)}
 </Card>

 <Card>
 <CardHeader title="Investigation" />
 {selectedId === null && (
 <EmptyState title="Select a finding" hint="Pick one from the list, or ask a question above." />)}
 {selectedId !== null && detailLoading && <LoadingState label="Loading investigation…" />}
 {detailError && <ErrorNotice>{detailError}</ErrorNotice>}

 {detail && !detailLoading && (
 <div className="p-4">
 <p className="mb-4 text-sm font-medium text-content">{detail.question}</p>

 {detail.status === 'FAILED' && (
 // A stable, honest sentence — never the raw provider error (`detail.error` may be a
 // raw JSON error body, e.g. a Gemini 503 payload), matching `assistant.ts`'s own
 // established "never leak a raw provider error to the user" discipline exactly.
 <ErrorNotice>
 This investigation could not be completed — the model may be temporarily
 unavailable. Try asking again in a moment.
 </ErrorNotice>)}

 {detail.status === 'REJECTED' && (
 <p className="text-sm text-content-subtle">
 This draft action was rejected{detail.error ? `: ${detail.error}` : '.'}
 </p>)}

 {detail.status === 'COMPLETE' && trace.length === 0 && !draft && (
 <p className="text-sm text-content-subtle">
 This question was answered without needing a metric investigation, or no groundable answer was found.
 </p>)}

 <ol className="space-y-4">
 {trace.map((step, i) => (
 <li key={i} className="border-l-2 border-accent/40 pl-4">
 <div className="mb-1 flex items-center gap-2">
 <Badge tone="accent">Step {step.hop}</Badge>
 <Badge tone={step.sufficiency === 'GROUNDING_FAILED' ? 'danger' : 'neutral'}>
 {step.sufficiency.replace(/_/g, ' ').toLowerCase()}
 </Badge>
 </div>
 <p className="text-sm text-content-muted">{step.question}</p>
 <p className="mt-1 text-sm text-content">{step.narration ?? 'This step could not be verified and was not included in the answer.'}</p>
 </li>))}
 </ol>

 {draft && draft.lines.length > 0 && (
 <div className="mt-6 border-t border-border pt-4">
 <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-subtle">Suggested action</p>
 <ul className="mb-3 space-y-1">
 {draft.lines.map((line) => (
 <li key={line.candidateId} className="text-sm text-content">
 {line.label} — <Value value={line.quantity} unit={line.unitLabel} />
 </li>))}
 </ul>
 {approveError && <ErrorNotice>{approveError}</ErrorNotice>}
 {approvedPoId ? (
 <Badge tone="positive">Approved — purchase order created</Badge>) : (
 <div className="flex gap-2">
 <Button variant="primary" onClick={approve} disabled={approving}>
 {approving ? 'Approving…' : 'Approve'}
 </Button>
 <Button variant="secondary" onClick={reject} disabled={approving}>
 Reject
 </Button>
 </div>)}
 </div>)}
 </div>)}
 </Card>
 </div>
 </div>);
}
