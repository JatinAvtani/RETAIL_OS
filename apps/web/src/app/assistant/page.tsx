'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useStores } from '@/lib/use-stores';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNotice, Input, LoadingState, PageHeader, Value } from '@/components/ui';

type AskResult = Awaited<ReturnType<typeof trpc.assistant.ask.mutate>>;
/** Derived from the router's own return type, never redeclared — a hand-copied shape here would be
 * free to drift from what the API actually sends. */
type MetricCitation = Extract<AskResult, { kind: 'bundle' }>['citations']['metrics'][number];
type ConversationSummary = Awaited<ReturnType<typeof trpc.assistant.listConversations.query>>[number];
type ConversationDetail = Awaited<ReturnType<typeof trpc.assistant.getConversation.query>>;

/** A live answer carries `intent`; one rebuilt from stored history does not, because it was never
 * persisted. Making it optional keeps that distinction honest in the type system instead of forcing
 * the reload path to invent a value. */
type BundleTurnResult = Omit<Extract<AskResult, { kind: 'bundle' }>, 'intent'> & {
  intent?: Extract<AskResult, { kind: 'bundle' }>['intent'];
};

type TurnResult = Exclude<AskResult, { kind: 'bundle' }> | BundleTurnResult;

type Turn = {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  result?: TurnResult;
};

type Briefing = Awaited<ReturnType<typeof trpc.assistant.briefing.query>>;

const SAMPLE_QUESTIONS = [
  'What was my net revenue this month?',
  'Why did my food cost go up?',
  'Which items have the worst contribution margin?',
];

/**
 * The first real UI for the entire AI assistant (everything before it built real,
 * tested library code with zero visible surface until now). Deliberately renders the SAME split
 * `narrateAndValidate`/`buildRefusal` gives every other caller — grounded prose when it exists,
 * structured figures/refusal reasons when it doesn't — rather than inventing a third "nicer"
 * presentation that could imply certainty the backend itself doesn't have. A cited metric value
 * always renders through `Value` (mono, tabular-nums, "Not known" for a genuine unknown — never a
 * fabricated zero, I7), matching every other numeric surface in this app; this page introduces NO
 * new number-formatting logic of its own.
 *
 * Two-column layout — a conversation history rail plus the active thread — matching the rest of the
 * app's page structure (`PageHeader` + `Card`/`CardHeader` sectioning) rather than a single bare
 * chat box. `listConversations`/`getConversation` already existed with no caller before this pass.
 */
export default function AssistantPage() {
  const { selectedStoreId } = useStores();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadConversations = () => {
    trpc.assistant.listConversations
      .query()
      .then(setConversations)
      .catch(() => setConversationsError('Could not load your conversation history.'));
  };

  useEffect(() => {
    loadConversations();
  }, []);

  useEffect(() => {
    if (!selectedStoreId) return;
    setBriefingLoading(true);
    trpc.assistant.briefing
      .query({ storeId: selectedStoreId })
      .then(setBriefing)
      // A briefing that fails to load is hidden entirely rather than rendered as "no exceptions" —
      // an empty briefing means a genuinely calm day, and a failed one must never be able to say that.
      .catch(() => setBriefing(null))
      .finally(() => setBriefingLoading(false));
  }, [selectedStoreId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, threadLoading]);

  const turnsFromDetail = (detail: ConversationDetail): Turn[] =>
    detail.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      // A reloaded turn shows its real figures, real citations and real grounded flag — all of which
      // were genuinely persisted or are derivable from the stored bundle. `intent` and `refusal`
      // were NOT persisted on the message row, so they are deliberately omitted here rather than
      // guessed: showing a fabricated intent badge would be a claim the record cannot support.
      ...(m.role === 'ASSISTANT' && m.groundingBundle && m.citations
        ? {
            result: {
              conversationId: detail.conversation.id,
              kind: 'bundle' as const,
              text: m.content,
              grounded: (m.validationResult as { grounded?: boolean } | null)?.grounded ?? false,
              bundle: m.groundingBundle as Extract<AskResult, { kind: 'bundle' }>['bundle'],
              refusal: null,
              citations: m.citations,
            },
          }
        : {}),
    }));

  const openConversation = (id: string) => {
    if (id === conversationId) return;
    setError(null);
    setThreadLoading(true);
    setConversationId(id);
    trpc.assistant.getConversation
      .query({ conversationId: id })
      .then((detail) => setTurns(turnsFromDetail(detail)))
      .catch(() => setError('Could not load that conversation.'))
      .finally(() => setThreadLoading(false));
  };

  const startNewConversation = () => {
    setConversationId(undefined);
    setTurns([]);
    setError(null);
  };

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length === 0 || loading) return;

    const userTurn: Turn = { id: `${nextId.current++}`, role: 'USER', content: trimmed };
    setTurns((prev) => [...prev, userTurn]);
    setQuestion('');
    setLoading(true);
    setError(null);

    trpc.assistant.ask
      .mutate({ question: trimmed, ...(conversationId ? { conversationId } : {}) })
      .then((result) => {
        const isNewConversation = conversationId === undefined;
        setConversationId(result.conversationId);
        // `error.reason` is the RAW provider error message (e.g. a Gemini 429/503 body) — never
        // meant for display; `unsupported.reason` is a real, honest, already-user-facing sentence
        // (see pipeline.ts's UNSUPPORTED_REASONS). Collapsing both into one string, as an earlier
        // draft of this page did, put a raw JSON quota-error blob directly in front of a user —
        // caught by actually looking at a live screenshot, not by any test.
        const content =
          result.kind === 'bundle'
            ? (result.grounded && result.text) || 'No information was found to answer this question.'
            : result.kind === 'unsupported'
              ? result.reason
              : "The assistant couldn't reach the model right now. Please try again in a moment.";
        setTurns((prev) => [...prev, { id: `${nextId.current++}`, role: 'ASSISTANT', content, result }]);
        if (isNewConversation) loadConversations();
      })
      .catch(() => setError('Something went wrong asking the assistant. Please try again.'))
      .finally(() => setLoading(false));
  };

  return (
    <>
      <PageHeader
        title="Assistant"
        description="Ask a question about your business. Every figure it cites comes from the metric catalog and is checked before you see it — never invented."
        actions={
          <Button variant="secondary" onClick={startNewConversation} disabled={turns.length === 0 && !conversationId}>
            New conversation
          </Button>
        }
      />

      {(briefingLoading || briefing) && (
        <Card className="mb-6">
          <CardHeader
            title="Today's briefing"
            actions={
              briefing && !briefing.quiet && briefing.exceptions.length > 0 ? (
                <Badge tone={briefing.grounded ? 'accent' : 'neutral'}>
                  {briefing.exceptions.length} to review
                </Badge>
              ) : null
            }
          />
          {briefingLoading && <LoadingState label="Checking for exceptions…" />}
          {!briefingLoading && briefing && <BriefingBody briefing={briefing} />}
        </Card>
      )}

      {/* Both columns share one height so the rail and the thread bottom out on the same line —
          `items-stretch` plus a min-height on the row, rather than each card sizing itself. */}
      <div className="grid items-start gap-6 lg:min-h-[calc(100vh-13rem)] lg:grid-cols-[280px_minmax(0,1fr)] lg:items-stretch">
        {/* Below `lg` the grid stacks, so the rail must size to its content — stretching it there
            leaves a tall band of dead space above the thread. It only shares the thread's height
            once the two genuinely sit side by side. */}
        <Card className="flex min-h-0 flex-col lg:max-h-none">
          <CardHeader title="History" />
          {conversationsError && (
            <p className="px-5 py-4 text-xs text-content-subtle">{conversationsError}</p>
          )}
          {!conversationsError && conversations === null && <LoadingState label="Loading…" />}
          {!conversationsError && conversations !== null && conversations.length === 0 && (
            <EmptyState title="No conversations yet" hint="Ask a question to start your first one." />
          )}
          {!conversationsError && conversations !== null && conversations.length > 0 && (
            <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => openConversation(c.id)}
                    className={
                      'w-full border-l-[3px] px-5 py-3 text-left text-sm transition-colors ' +
                      (c.id === conversationId
                        ? 'border-l-accent bg-accent-soft font-medium text-content'
                        : 'border-l-transparent text-content-muted hover:bg-surface-sunken')
                    }
                  >
                    <p className="line-clamp-2">{c.title ?? 'New conversation'}</p>
                    <p className="mt-1 font-mono text-xs text-content-subtle">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Stacked, the thread carries its own height; side by side it takes the row's instead. */}
        <Card className="flex min-h-[60vh] flex-col lg:min-h-0">
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {threadLoading && <LoadingState label="Loading conversation…" />}
            {!threadLoading && turns.length === 0 && (
              <div className="flex h-full flex-col justify-center">
                <EmptyState
                  title="Ask anything about your numbers"
                  hint="Try one of the questions below, or type your own."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      {SAMPLE_QUESTIONS.map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => submit(q)}
                          className="rounded-control border border-border-strong bg-surface-sunken px-3 py-1.5 text-xs text-content-muted transition-colors hover:bg-surface-raised hover:text-content"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  }
                />
              </div>
            )}
            {!threadLoading &&
              turns.map((turn) => <MessageBubble key={turn.id} turn={turn} />)}
            {loading && (
              <div className="flex items-center gap-2 text-sm text-content-muted">
                <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                Thinking…
              </div>
            )}
          </div>

          {error && (
            <div className="px-5">
              <ErrorNotice>{error}</ErrorNotice>
            </div>
          )}

          <form
            className="flex items-center gap-2 border-t border-border px-5 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit(question);
            }}
          >
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question…"
              className="flex-1"
              autoFocus
              disabled={loading}
            />
            <Button type="submit" variant="primary" disabled={question.trim().length === 0 || loading}>
              Ask
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}

/**
 * The daily briefing — ranked exceptions plus, when the model produced grounded prose, the
 * connective sentences over them. The exception list renders regardless: prose is the optional half
 * (the model writes only connective text), so a quota failure or a validator rejection costs the
 * narration, never the facts. `text` is shown ONLY when `grounded` is true, matching the same
 * fail-closed contract every other narration surface in this app honours.
 */
const BriefingBody = ({ briefing }: { briefing: Briefing }) => {
  if (briefing.quiet) {
    return (
      <EmptyState
        title="Nothing needs your attention"
        hint="No exceptions were found for this store. This is a real result, not a missing check."
      />
    );
  }

  if (briefing.exceptions.length === 0) {
    return (
      <EmptyState
        title="No exceptions could be computed"
        hint="You may not have permission to see them, or the underlying data is incomplete."
      />
    );
  }

  return (
    <div>
      {briefing.text && briefing.grounded && (
        <p className="border-b border-border px-5 py-4 text-sm leading-relaxed text-content">{briefing.text}</p>
      )}
      {!briefing.grounded && (
        <p className="border-b border-border px-5 py-3 text-xs text-content-subtle">
          Showing the exceptions on their own — the written summary could not be verified against
          these figures, so it is not displayed.
        </p>
      )}
      <ul className="divide-y divide-border">
        {briefing.exceptions.map((e) => {
          const citation = briefing.citations.metrics.find((c) => c.metricId === e.result.metricId);
          return (
            <li key={e.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Badge tone={e.severity === 'danger' ? 'danger' : 'warning'}>
                    {e.severity === 'danger' ? 'Urgent' : 'Review'}
                  </Badge>
                  <span className="text-sm text-content">{e.label}</span>
                </div>
                {/* The figure comes straight from the executed metric — this component never
                    recomputes or reformats it into a different number. */}
                <span className="text-sm">
                  <Value value={formatFigure(e.result.value)} />
                </span>
              </div>
              {citation && <CitationPanel citation={citation} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const MessageBubble = ({ turn }: { turn: Turn }) => {
  const isUser = turn.role === 'USER';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          // The assistant's own turn runs wider than the user's — it carries the cited figures,
          // sources and refusal reasons, which need room to stay legible; a user question never does.
          isUser
            ? 'max-w-[75%] rounded-card bg-accent-soft px-4 py-3 text-sm text-content'
            : 'max-w-[90%] rounded-card border border-border bg-surface-raised px-4 py-3 text-sm text-content'
        }
      >
        <p className="whitespace-pre-wrap">{turn.content}</p>
        {turn.result && turn.result.kind === 'bundle' && <BundleDetails result={turn.result} />}
        {turn.result && turn.result.kind === 'unsupported' && (
          <div className="mt-2">
            <Badge tone="neutral">{turn.result.intent}</Badge>
          </div>
        )}
      </div>
    </div>
  );
};

/** Row counts below this get an honest small-sample note, mirroring `SMALL_SAMPLE_ROW_THRESHOLD`. */
const SMALL_SAMPLE_ROWS = 20;

/**
 * Trims a metric's storage precision (`2310.0000`) to two decimal places for display. Purely
 * presentational and deliberately conservative: it never rounds away a significant digit, never
 * appends a currency symbol (the bundle carries `unit: 'CURRENCY'` but not WHICH currency — a
 * guessed symbol would be a fabricated fact), and passes anything unparseable through untouched
 * rather than risking a mangled figure.
 */
const formatFigure = (value: string): string => {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtDate = (iso: string | Date) => new Date(iso).toLocaleDateString();

/**
 * "How this was calculated" for one figure — the metric's own plain-English definition, the exact
 * period, its freshness, and the real source tables and row counts behind it. Every field is
 * computed server-side by `buildCitations` from the grounding bundle; nothing here is generated, so
 * a citation cannot disagree with the figure it backs. Collapsed by default (following the
 * dashboard's own drill-through pattern) — proof should be one click away, not competing with the
 * answer for attention.
 */
const CitationPanel = ({ citation }: { citation: MetricCitation }) => {
  const [open, setOpen] = useState(false);
  const rows = citation.totalRowCount;
  const smallSample = citation.unknownReason === undefined && citation.sources.length > 0 && rows < SMALL_SAMPLE_ROWS;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] font-medium text-accent transition-colors hover:underline"
        aria-expanded={open}
      >
        {open ? 'Hide how this was calculated' : 'How this was calculated'}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 rounded-control border border-border bg-surface-raised px-2.5 py-2 text-[11px]">
          {citation.explanation ? (
            <p className="text-content-muted">{citation.explanation}</p>
          ) : (
            // Never the metric id dressed up as prose — an unregistered metric genuinely has no
            // plain-English definition, and saying so is more useful than inventing one.
            <p className="italic text-unknown">No plain-English definition is registered for this metric.</p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-content-subtle">
            <dt>Period</dt>
            <dd className="font-mono tabular-nums text-content-muted">
              {fmtDate(citation.period.from)} – {fmtDate(citation.period.to)}
            </dd>
            <dt>Data as of</dt>
            <dd className="font-mono tabular-nums text-content-muted">
              {new Date(citation.freshness).toLocaleString()}
            </dd>
          </dl>
          {citation.sources.length > 0 ? (
            <div>
              <p className="font-semibold uppercase tracking-wide text-content-subtle">Sources</p>
              <ul className="mt-0.5 space-y-0.5">
                {citation.sources.map((s) => (
                  <li key={s.table} className="flex justify-between gap-3 text-content-muted">
                    <span className="font-mono">{s.table}</span>
                    <span className="font-mono tabular-nums">
                      {s.rowCount} {s.rowCount === 1 ? 'row' : 'rows'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-content-subtle">This metric reported no source tables.</p>
          )}
          {smallSample && (
            <p className="text-warning">
              Based on {rows} {rows === 1 ? 'row' : 'rows'} — a small sample.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

const BundleDetails = ({ result }: { result: BundleTurnResult }) => {
  const { bundle, refusal, grounded, citations } = result;
  const knownMetrics = bundle.metrics.filter((m) => m.value !== 'unknown');
  const citationFor = (metricId: string) => citations?.metrics.find((c) => c.metricId === metricId);

  return (
    <div className="mt-3 space-y-3">
      {!grounded && <Badge tone="unknown">Response not verified — showing raw figures instead</Badge>}

      {/* A stacked list, not a grid: an expandable citation panel inside a grid cell either leaves an
          orphan cell on an odd count or forces its neighbour to the expanded row's height. Each
          figure owns a full-width row, so opening one moves nothing else. */}
      {knownMetrics.length > 0 && (
        <div className="grid gap-px overflow-hidden rounded-control border border-border bg-border">
          {knownMetrics.map((m) => {
            const citation = citationFor(m.metricId);
            return (
              <div key={m.metricId} className="bg-surface-sunken px-2.5 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-content-subtle">
                  {m.metricId.replace(/_/g, ' ')}
                </p>
                <p className="mt-0.5 text-sm">
                  {m.unit === 'PERCENTAGE' ? (
                    <Value value={formatFigure(m.value)} unit="%" />
                  ) : (
                    <Value value={formatFigure(m.value)} />
                  )}
                </p>
                {citation && <CitationPanel citation={citation} />}
              </div>
            );
          })}
        </div>
      )}

      {bundle.passages.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Sources</p>
          {bundle.passages.map((p, i) => (
            <div
              key={`${p.sourceId}-${i}`}
              className="rounded-control border border-border bg-surface-sunken px-2.5 py-1.5 text-xs text-content-muted"
            >
              {p.text}
            </div>
          ))}
        </div>
      )}

      {refusal && refusal.items.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
            {refusal.fullyUnanswerable ? 'Could not be answered' : 'Partially answered'}
          </p>
          {refusal.items.map((item, i) => (
            <div
              key={`${item.metricId}-${i}`}
              className="flex items-start gap-2 rounded-control border border-dashed border-border-strong px-2.5 py-1.5 text-xs"
            >
              <Badge tone="unknown">{item.category.replace(/_/g, ' ')}</Badge>
              <div>
                <p className="text-content-muted">{item.reason}</p>
                <p className="mt-0.5 text-content-subtle">{item.remedy}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
