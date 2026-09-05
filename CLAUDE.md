# Store Blindern Poker website

Rules for anyone (human or AI) working in this repo.

## Voice and style

- **No em dashes. Ever.** Not in site copy, docs, commit messages, or code comments. Use a comma, a colon, a hyphen, or rewrite the sentence. Avoid en dashes too; write time ranges as "18:00 to 20:30".
- Keep AI-flavoured prose out: no "delve", "seamless", "elevate", "vibrant", "it's not just X, it's Y", no decorative emoji, no hype.
- The club's voice is set by the founder's "All in" letter: plain, warm, concrete, first person plural, dry humour. Short sentences. Facts over adjectives.
- The club is always "Store Blindern Poker". English first; Norwegian translation comes later.

## Design

`docs/DESIGN_SYSTEM.md` is binding for anything visual. Read it before touching CSS or
markup. The short version: warm earth tones on near-black, one brass accent, crisp visible
borders (never rgba white at 8 percent), a single 4px radius everywhere, Newsreader +
Instrument Sans + JetBrains Mono (never Inter), snappy `cubic-bezier(0.16, 1, 0.3, 1)`
motion on named properties, and no cookie-cutter card grids.

## Hard rules

- This is a points-only club. No money, no payment features, no currency language. Buy-ins, rebuys, and stacks are chips and season points, never cash.
- Pseudonyms are the only public identity. Real names and emails live in the database, admin-only, and must never appear in this repo.
- Honour system: features catch mistakes and make things visible. Do not build anti-cheat hardening.
- No framework, no build step. Vanilla HTML, CSS, and JS. Vendored libraries only (js/vendor/), no runtime CDN dependencies.
- Scoring rules live in the database (Supabase), not in application code.

## Facts for copy

- Legal: STORE BLINDERN POKER, org.nr 936 041 973, a registered student association at the University of Oslo (Brønnøysund, 27 Aug 2025).
- Contact: it@storeblindernpoker.org. Domain: storeblindernpoker.org. Hosting: Cloudflare Pages from main, no build step.
- Nights run Fridays about 18:00 to 20:30, Blindern campus. Beginner course and beginner table at the welcome rounds.
- Season = semester. Everyone starts at 40,000 points. Nightly: 5,000 attendance bonus, buy-in up to the night's stack (default 10,000), one re-buy, report your final stack. Points never go below zero.
- The champion wins a custom season chip, small prizes, and bragging rights.
