# Store Blindern Poker website

The public website and member tools for **Store Blindern Poker**, the student
poker association at the University of Oslo. Live at
[storeblindernpoker.org](https://storeblindernpoker.org).

We play for **points, never money**, the site exists to show events, explain
the points system, publish the pseudonymous leaderboard, and let members
report their results from their phones on Friday nights.

## How it's built

- **Plain HTML, CSS and JavaScript. No framework, no build step, no
  `node_modules`.** What is in the repo is what is served. If you can edit a
  text file, you can maintain this site.
- **Supabase** (Postgres + auth) backs the members area and the live
  leaderboard. The browser talks to it via the vendored copy of
  `supabase-js` in `js/vendor/supabase.js`, no CDN dependency at runtime.
- **Cloudflare Pages** serves the site as static files.

## Repository layout

```
index.html         Landing page
events.html        Upcoming + past nights (rendered from data/events.json)
leaderboard.html   Season standings (live from Supabase, static fallback)
rules.html         The points system, explained
login.html         Member sign-in
report.html        Night reporting (members)
admin.html         Night administration (organisers)
css/style.css      The whole design system, palette, chrome, components
js/app.js          Public-page behaviour (countdown, events, leaderboard)
js/sb.js           Supabase client + auth helpers (night code lives server-side)
js/outbox.js       Offline-safe retry queue for night reports
js/login.js        login.html behaviour (sign in / sign up / claim)
js/report.js       report.html behaviour (check-in, report, receipt)
js/admin.js        admin.html behaviour (night lifecycle, QR code display)
js/config.js       Supabase URL + publishable anon key (see below)
js/vendor/         Vendored supabase-js + qrcode-generator UMD bundles
data/events.json   The events list, edit this to announce a night
assets/img/        Photos (face-free; see IMAGE-CREDITS.json)
supabase/          Database migration + smoke test
docs/HANDOVER.md   Accounts, access and procedures for the next maintainer
```

## Editing content

### Announce or edit an event

Edit `data/events.json`. Each event looks like:

```json
{
  "id": "evt-f26-02",
  "title": "Fall 2026: Round 2",
  "date": "2026-09-11",
  "time": "18:00",
  "timeNote": "",
  "location": "Blindern Campus, Nils Henrik Abels Hus, Abelstua",
  "locationUrl": "https://link.mazemap.com/BgdNsCdA",
  "registrationUrl": "",
  "description": "One or two friendly sentences.",
  "status": "upcoming"
}
```

Rules of thumb:

- `id` must be unique across the whole file (`evt-f26-NN` for Fall 2026).
- `status` is `"upcoming"` or `"past"`. Events whose night has passed are
  shown as past automatically, but flip the flag when you get the chance.
- Dates are `YYYY-MM-DD`; times are 24-hour Oslo time.
- The homepage countdown always points at the soonest upcoming event,
  no other change needed.
- Never mention money, prices or currency in event copy. Points only.

### Change page copy

The text lives directly in the HTML files, open the page, find the words,
change them. The header and footer are copy-pasted identically across all
pages **on purpose** (no templating): if you change one, change all of them.

### Images

All photos in `assets/img/` are verified face-free and listed in
`assets/img/IMAGE-CREDITS.json`. Each image ships in three widths
(`name@480`, `name@960`, full-size) in both `.webp` and `.jpg`. Photos of
people must not be published without consent, see the privacy notes in
`docs/HANDOVER.md`.

## Configuration

`js/config.js` carries two placeholder strings, `__SUPABASE_URL__` and
`__SUPABASE_ANON_KEY__`, which are replaced with the project's real values
at deploy time (or committed directly, the anon key is *publishable by
design*; all real protection lives in the database's row-level security).
While the placeholders are present, the public pages simply use their static
fallbacks and make no network calls.

## Deploys

Pushing to `main` is deploying. Cloudflare Pages watches the `main` branch
of this repository and publishes it as-is, there is no build command, no
pipeline, and nothing to install. A change is normally live within a minute.

Preview: any pull request gets its own preview URL from Cloudflare Pages
before it is merged.

## What must never be committed

Real names, email addresses, rosters, exports, credentials, or anything
else member-identifying. Members are pseudonymous in public **by design**;
personal data lives only in the database, behind row-level security. The
`.gitignore` blocks the known-dangerous paths, but the rule is broader:
**if it identifies a member, it does not go in git.**

## For the next maintainer

Start with `docs/HANDOVER.md`, it lists every account the club runs on,
who holds access, and the operational procedures (adding an admin, running a
night, restoring a paused Supabase project).
