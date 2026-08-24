import { cx } from './ui';

/**
 * The Vyapaar mark: four bars on a shared baseline, the third rising clear in brass.
 *
 * It states the product in one shape — a row of figures where most sit quiet and one demands
 * attention. That is the exception feed, the dashboard's headline row, and the reason the whole
 * thing exists. The raised bar takes `--color-accent` because that is the rule the entire interface
 * runs on: brass marks the thing to look at, and nothing else is brass.
 *
 * Proportions are deliberate rather than arbitrary. Bars are 5 units wide on an 8-unit pitch, so
 * the gap is always 3 — tight enough to read as one object, open enough to stay distinct at 16px.
 * The resting bars step 8/11/9 in height (uneven, so it reads as real data rather than a decorative
 * ramp) and the accent bar runs to 24, more than double the tallest neighbour, so it wins the eye
 * at any size. Radius is half the bar width, giving a true stadium cap that survives downscaling
 * where a square corner would alias.
 */
export const LogoMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 40 40" role="img" aria-label="Vyapaar" className={cx('block', className)} fill="none">
    <rect x="6" y="24" width="5" height="8" rx="2.5" fill="currentColor" opacity="0.85" />
    <rect x="14" y="21" width="5" height="11" rx="2.5" fill="currentColor" opacity="0.85" />
    <rect x="22" y="8" width="5" height="24" rx="2.5" fill="var(--color-accent)" />
    <rect x="30" y="23" width="5" height="9" rx="2.5" fill="currentColor" opacity="0.85" />
  </svg>
);

/**
 * The wordmark: "Vyapaar" set in the display serif, with a brass bindu over the y.
 *
 * The name is a Hindi word for trade, and the bahi-khata — the cloth-bound ledger Indian traders
 * have kept for centuries — is the direct ancestor of this product. The serif claims that lineage;
 * a grotesque cannot. It is the only place in the interface that face appears, which is deliberate:
 * as a mark it reads as heritage, but loose in the UI it would read as decoration and undo the
 * "cold store, warm accent" premise the palette is built on.
 *
 * MIXED CASE, not caps, and that is specific to this word rather than a general preference. The V
 * ascends and the y descends, so "Vyapaar" has a silhouette a reader recognises before reading it;
 * "VYAPAAR" is a flat rectangle. Caps also turn the doubled `aa` into two identical triangles
 * needing hand-kerning, and leave the bindu floating with no lowercase to sit over. Caps are the
 * better *stamp*, which is why the mock corpus's GST invoice letterheads use them and the interface
 * does not — each setting doing the job it is actually good at.
 *
 * The bindu is the mark over the व, borrowed here as the same "look at this one" signal the accent
 * carries everywhere else. It is sized and positioned in `em`, so it tracks the text at any size
 * instead of drifting, and it is dropped entirely below ~14px where it would render as a smudge
 * rather than a dot.
 */
const Wordmark = ({ className }: { className?: string }) => (
  <span
    className={cx(
      'relative inline-block font-display text-[19px] font-semibold leading-none tracking-[-0.02em] text-content',
      className,
    )}
  >
    Vyapaar
    <span
      aria-hidden="true"
      className="absolute size-[0.13em] rounded-full bg-accent"
      /*
       * Sits above the y's ascender-free stem, in the gap between the V's apex and the cap line.
       * Both values are `em`, so the dot tracks the text at any size rather than drifting — the
       * whole reason it is a positioned span and not a second glyph.
       *
       * 0.946em is the MEASURED centre of the y in Fraunces at this weight — taken from the live
       * page with a canvas TextMetrics run over the real glyph advances, including the negative
       * letter-spacing, rather than estimated from a specimen. Two earlier guesses (0.42em, then
       * 1.02em) put the dot over the V and over the a respectively; both typechecked, rendered, and
       * were simply wrong on screen. Re-measure rather than nudge if the face or tracking changes.
       */
      style={{ left: '0.946em', top: '-0.2em', transform: 'translateX(-50%)' }}
    />
  </span>
);

/**
 * The stacked lockup: mark, wordmark, and the line that says what the name means.
 *
 * This is the full-dress form, for the places with room to introduce the product to someone who
 * has never seen it — the sign-in, sign-up and invitation screens, which are the first thing a
 * visitor meets. It is deliberately NOT what the sidebar uses: the tagline needs vertical room the
 * 48px nav strip does not have, and repeating a brand promise on every screen of an app someone
 * uses daily is noise rather than identity.
 *
 * The Devanagari व्यापार leads the strapline because the name is a real word, not a coinage, and
 * showing it in its own script is the shortest way to say so. The English gloss follows it rather
 * than translating it away. (This is HTML, so the script renders from the system font stack — the
 * transliteration-only rule agreed for the mock corpus exists because the invoice PDF generator is
 * latin1/Courier and physically cannot set Devanagari; it is a constraint of that renderer, not a
 * product-wide style rule.)
 */
export const LogoLockup = ({
  className,
  align = 'center',
}: {
  className?: string;
  /**
   * `left` is for the signed-out brand panel, where the lockup heads a column of ranged-left copy;
   * a centred lockup above left-aligned text reads as a mistake. It is set slightly LARGER than the
   * centred form: on the brand panel the lockup is the brand's own statement rather than a label
   * for the page, and at the smaller size it read as an afterthought above the headline.
   */
  align?: 'center' | 'left';
}) => (
  <span
    className={cx(
      'inline-flex flex-col gap-3',
      align === 'left' ? 'items-start' : 'items-center',
      className
    )}
  >
    <LogoMark className={cx(align === 'left' ? 'size-11' : 'size-12', 'text-content')} />
    <span className={cx('flex flex-col gap-1.5', align === 'left' ? 'items-start' : 'items-center')}>
      <Wordmark className={align === 'left' ? 'text-[30px]' : 'text-[30px]'} />
      {/* `-mr-[0.18em]` cancels the trailing letter-space that `tracking-[0.18em]` adds AFTER the
          final R. Flexbox centres the box including that invisible trailing space, which pushed the
          whole strapline visibly left of the wordmark above it — the previous separator-based fix
          addressed the gap between the words, not this. */}
      <span className="-mr-[0.18em] flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-content-subtle">
        <span className="tracking-normal">व्यापार</span>
        <span aria-hidden="true" className="text-border-strong">·</span>
        <span>Trade, accounted for</span>
      </span>
    </span>
  </span>
);

/**
 * Mark + wordmark. Two ideas, deliberately not competing: the mark is the product's argument (four
 * figures, one demanding attention), the wordmark is its lineage. They share only the brass, which
 * is the rule the whole interface runs on — brass marks the thing to look at, and nothing else is
 * brass.
 */
export const Logo = ({
  className,
  markClassName,
  showWordmark = true,
}: {
  className?: string;
  markClassName?: string;
  showWordmark?: boolean;
}) => (
  <span className={cx('inline-flex items-center gap-2', className)}>
    <LogoMark className={cx('size-7 shrink-0 text-content', markClassName)} />
    {showWordmark && <Wordmark />}
  </span>
);
