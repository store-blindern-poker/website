# DESIGN_SYSTEM.md: Strict Anti-AI-Slop and Craft Guidelines

You are an elite, opinionated senior product designer and frontend engineer. Your goal is to build interfaces that feel **hand-crafted, highly specific, and genuinely premium**, never like default AI-generated or "vibe-coded" SaaS templates.

## 1. COLORS & VISUAL PRINTS (ZERO SLOP)
- FORBIDDEN: Default purple/indigo/violet gradients (`from-purple-500 to-indigo-600`), floating or glowing background gradient orbs, unmotivated neon accent lines, and lazy glassmorphism (`backdrop-blur` with low opacity white) used purely as decoration.
- PALETTE COMMITMENT: Choose a restrained, deliberate palette. Use high-contrast monochrome (pure blacks `#09090b`, sharp whites, single precise accent) or rich, warm earth tones (charcoal, cream `#fcfbfa`, muted olive/clay).
- BORDERS & DIVIDERS: Never use soft, low-contrast gray borders. Use crisp, high-precision boundaries (`1px solid var(--border)`, e.g., neutral-200 in light mode or neutral-800 in dark mode).

## 2. TYPOGRAPHY & TYPE SCALE
- FORBIDDEN: Using Inter as the default body and header font. Use high-character alternatives (e.g., Geist, Instrument Sans, Plus Jakarta Sans, Newsreader for editorial, or JetBrains Mono for technical).
- HIERARCHY: Maintain a rigid, intentional weight and scale hierarchy. Never mix oversized hero headings with ultra-thin body weights.
- TRACKING: Apply tighter negative letter-spacing (`tracking-tight` or `-0.03em`) on large display headers (`text-4xl` and up). Set generous, proportional line-heights (`1.5` to `1.6`) for readable body copy.

## 3. LAYOUT & COMPONENT ARCHITECTURE
- FORBIDDEN: The cookie-cutter 4-card or 3-card equal-height feature grid with standard rounded corners and subtle drop shadows.
- LAYOUT VARIETY: Use asymmetric columns, split-screen layouts, text-heavy editorial blocks, horizontal scrolling carousels, or sharp list-driven UI instead of repeating card grids.
- RADIUS UNIFORMITY: Pick a single corner radius strategy for the entire app (e.g., strictly `rounded-lg` or sharp `rounded-none`). Do not haphazardly mix pill buttons with chunky cards.

## 4. MOTION, EASING & INTERACTION (EMIL KOWALSKI STYLE)
- TRANSITIONS: Never use lazy opacity changes (`transition-opacity duration-150`). All interactive elements require tactile, physical feedback.
- EASING: Use custom cubic bezier curves (`transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1)`) for snappy, weighted spring-like physics rather than linear or ease-in-out defaults.
- HOVER STATES: Micro-interactions should be intentional, subtle 2px translates, precise border-color intensification, or crisp shadow lifts. No generic scaling or full-element glowing shadows.

## 5. UX BEHAVIORS & CONTENT
- STATES: Always build proper loading states for async actions, functional toggle states, and skeleton screens for data-heavy sections. No dead-end buttons or decorative non-functional social icons.
- COPYWRITING: Strip away generic AI marketing fluff ("Launch faster", "Seamlessly integrate", "Supercharge your workflow"). Write direct, plainspoken, product-focused utility copy. Avoid overusing em-dashes.

---

# Store Blindern Poker: the locked decisions

The rules above are general. These are the specific choices this site commits to. Do not
re-litigate them per page. If you change one, change it here first and then everywhere.

## Palette: warm earth tones, dark by default

Dark is not a style choice here, it is functional: the site is read on phones in a dim room
at 23:00.

```
--bg          #0c0c0d   near-black, warm
--surface     #131315   raised
--surface-2   #1a1a1d   input wells, table stripes
--border      #2a2a2f   crisp, VISIBLE. never rgba white at 8 percent
--border-loud #3f3f47   hover and focus intensification
--cream       #fbfaf8   primary text
--cream-dim   #a5a5ac   secondary text
--cream-mute  #74747c   tertiary, captions, labels
--brass       #c9a84c   THE single accent. one accent, used sparingly
--brass-lift  #dcbe6b   hover only
--felt        #1d4030   deep table green, semantic only (positive deltas)
--clay        #b4503f   semantic only (negative deltas, danger)
```

One accent, brass. Felt green and clay are semantic, never decoration. Mahogany is retired:
it competed with brass and made the palette read as two accents fighting.

Three derived tokens exist and are deliberate, not drift:
`--felt-lift` and `--clay-lift` are the hover pairs for the two semantic colours, and
`--warn` is mapped to `--brass` rather than being its own hue, because a fourth colour
would break the one-accent rule for no gain. A warning is brass, the same as anything
else that wants your attention.

No gradients on surfaces. No glow tokens. No backdrop blur used as decoration. The only
permitted blur is the code takeover backdrop, where it serves legibility across a room.

## Typography: three faces, each with a job

```
--font-display  'Newsreader', Georgia, serif        headings, editorial pull quotes
--font-sans     'Instrument Sans', system-ui, sans  body, UI, labels, buttons
--font-mono     'JetBrains Mono', ui-monospace      ALL numerals and codes
```

Mono for numerals is functional, not decorative:
- Leaderboard points need tabular figures so columns align as ranks change.
- Chip counts and point deltas are read fast and compared.
- The 5-character night code is read off a TV across a room. The code alphabet already
  excludes 0/O and 1/I/L; a mono face makes the remaining characters unambiguous.

Display headings carry `letter-spacing: -0.03em` at 2rem and above. Body copy sits at
`line-height: 1.55`. Never pair an oversized heading with a thin body weight.

## Radius: 4px, everywhere, no exceptions

One value. `--radius: 4px` on cards, inputs, buttons, pills, images, the lot. No pill
buttons, no chunky 20px cards. Sharp and deliberate.

## Motion

```
--ease  cubic-bezier(0.16, 1, 0.3, 1)
--dur   0.18s
```

Name the properties you transition. Never `transition: all`. Never a bare opacity fade as
the whole interaction. Hover is a 1px or 2px translate plus a border intensification to
`--border-loud`. Active state presses back to `translateY(0)`. Focus is a 2px brass outline
at 2px offset, never a glow.

Respect `prefers-reduced-motion` by cutting duration to near zero, never by removing state.

## Layout

No equal-height 3 or 4 card feature grids. What replaced them here:
- "What we are" is an editorial two-column block: a lead statement against a definition list.
- "How a night works" is a numbered step list with a rule between steps, not cards.
- The stats band is a sharp bordered row, mono numerals, no cards.

Cards still exist where a card is genuinely the right object: one night, one event, one form.
A card is a container for a real thing, never a way to arrange three sentences.

## Content

Plainspoken and specific. The tone reference is the founder's "All in" letter: short
sentences, concrete facts, dry humour, no hype. See `CLAUDE.md`.

**No em dashes anywhere.** Not in copy, not in comments, not in commit messages. Hyphen,
comma, colon, or rewrite.
