import { LogoLockup } from './logo';

/**
 * The brand side of the signed-out split layout.
 *
 * The pane's job is to answer "what is this?" in one glance, and the honest answer is a *chain*:
 * an invoice line becomes a supplier price, which becomes a product cost, which a recipe turns into
 * a dish cost, which sales turn into margin. That chain is the product — break any link and it
 * cannot answer its own headline question — so drawing it says more than a list of features could,
 * and without a word of marketing copy.
 *
 * Earlier versions of this pane were a headline plus captioned feature bullets, which restated each
 * other and made the screen read as a landing page rather than a sign-in. The diagram replaces all
 * of it.
 *
 * Hidden below `lg` — on a phone the form owns the screen and the lockup inside the card column
 * carries the identity instead.
 */

/** The chain, top to bottom. The last step is the one the product exists to produce. */
const CHAIN = [
  { label: 'Supplier invoice', detail: 'Read line by line' },
  { label: 'Ingredient cost', detail: 'What you actually paid' },
  { label: 'Recipe', detail: 'Cost per dish' },
  { label: 'Contribution margin', detail: 'Traceable to the invoice line' },
] as const;

const CostChain = () => (
  /*
   * A left rail: node, connector beside the text. A centred variant was tried — node above label,
   * everything on one spine — and it made the chain roughly 300px taller, pushing the panel past
   * the viewport into scroll. The rail is what keeps the whole pane on one screen, so the panel's
   * centre-aligned lockup and headline sit above a left-aligned chain by necessity rather than by
   * oversight.
   */
  <ol className="flex flex-col text-left" aria-label="How Vyapaar traces a cost">
    {CHAIN.map((step, index) => {
      const isLast = index === CHAIN.length - 1;
      return (
        <li key={step.label} className="flex gap-5">
          {/* The rail: a node per step, joined by a connector. The final node takes the accent
              because brass marks the thing worth attention everywhere else in this interface, and
              here that is the number the whole chain exists to produce. */}
          <div className="flex flex-col items-center" aria-hidden="true">
            <span
              className={
                isLast
                  ? 'size-3.5 shrink-0 rounded-full bg-accent ring-4 ring-accent/20'
                  : 'size-3.5 shrink-0 rounded-full border-2 border-border-strong bg-surface-raised'
              }
            />
            {!isLast && <span className="w-0.5 flex-1 bg-border-strong/50" />}
          </div>

          <div className={isLast ? 'pb-0' : 'pb-7'}>
            <p
              className={
                isLast
                  ? '-mt-0.5 text-[15px] font-semibold text-content'
                  : '-mt-0.5 text-[15px] font-medium text-content'
              }
            >
              {step.label}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-content-muted">{step.detail}</p>
          </div>
        </li>
      );
    })}
  </ol>
);

export const AuthIntro = () => (
  <section className="hidden max-w-[30rem] flex-col items-center text-center lg:flex" aria-label="About Vyapaar">
    <LogoLockup />

    <h1 className="mt-10 max-w-[15ch] text-[2.75rem] font-bold leading-[1.08] tracking-[-0.025em] text-balance text-content">
      Know where your margin went.
    </h1>

    <div className="mt-9">
      <CostChain />
    </div>
  </section>
);
