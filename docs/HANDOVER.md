# HANDOVER: Store Blindern Poker infrastructure

> **Who this is for:** the next IT lead. Read this top to bottom once, then
> keep it open on Friday nights. If something here is wrong or stale, fixing
> this document *is* part of the job.
>
> **Status:** skeleton. Items marked `TODO` are filled in as accounts are
> finalised. Credentials are NEVER written in this file, they live in the
> club's Bitwarden vault; this file only says *where* things are and *who*
> has access.

---

## 1. Account inventory

Every service the club runs on. Rule: **every account has at least two
humans with access**, and no account is registered to a personal student
email or personal payment card.

| Service | Registered to | Purpose | Second holder | Notes |
|---|---|---|---|---|
| **Cloudflare** | `TODO` | Domain `storeblindernpoker.org` (registrar + DNS), Pages hosting, Email Routing for `@storeblindernpoker.org` addresses | `TODO` | Do NOT register the Cloudflare account itself on an `@storeblindernpoker.org` address, its recovery mail would depend on the routing it controls. `TODO:` domain renewal date, payer, auto-renew status. |
| **GitHub organisation** `store-blindern-poker` | `TODO` | The `website` repository (public). Pushing to `main` deploys. | `TODO` | Two org owners minimum. Nothing personal is ever committed, see §4. |
| **Supabase** | `it@storeblindernpoker.org` | Database + auth (members, nights, leaderboard). EU region. | `TODO` (second org Owner) | Free tier pauses after inactivity, see §5.3. |
| **Google account** | `it@storeblindernpoker.org` | Google Cloud project for the "Sign in with Google" OAuth client | `TODO` (second project owner) | OAuth consent screen must stay **published to Production**, scopes `openid email profile` only. |
| **Bitwarden vault** | `TODO` | Shared credential store for all of the above | `TODO` | The only place passwords are written down. `TODO:` emergency-access setup. |
| Facebook group / Discord server | `TODO` | Community channels | `TODO` | List current admins/moderators. |

`TODO:` write, for each row, the recovery email and 2FA method actually
configured, and verify each one at the start of every semester.

## 2. People

| Role | Name | Reachable at | Since |
|---|---|---|---|
| IT lead ("CTO") | `TODO` | `TODO` | `TODO` |
| Second admin | `TODO` | `TODO` | `TODO` |
| Board contact | `TODO` | `TODO` | `TODO` |

Handover checklist when the IT lead changes: `TODO` (transfer Bitwarden
access, rotate personal sessions, update this table, dry-run one settle).

## 3. The website

- **Hosting:** Cloudflare Pages, deploys automatically from `main` on the
  GitHub `store-blindern-poker/website` repository. No build step: the repo
  *is* the site.
- **Domain:** `storeblindernpoker.org` at Cloudflare. `TODO:` DNS record
  list export location.
- **Email:** Cloudflare Email Routing forwards `it@storeblindernpoker.org`
  (and `TODO:` any other addresses, e.g. `styret@`, `personvern@`) to
  `TODO`.
- **Configuration:** `js/config.js` needs the Supabase project URL and the
  publishable anon key. `TODO:` document exactly how the placeholders are
  patched on deploy (commit vs. Pages build hook).

## 4. Privacy rules (non-negotiable)

1. Members are **pseudonymous in public**. Real names and emails exist only
   in the `member_private` table in Supabase, readable by admins only.
2. **Nothing member-identifying is ever committed to git**, exported into
   the repo, pasted into an issue, or stored in a backup that lives in git.
3. The legacy Python scoring pipeline (`main.py` + `pointSystem/Inputs/`)
   is **retired**. Do not resurrect it, it required a plaintext file of
   real names, which is exactly the leak this system was built to end.
4. Photos with recognisable faces are not published without consent.
   Everything currently in `assets/img/` is verified face-free.
5. `TODO:` privacy notice (`privacy.html`), required before the site is
   publicised further; needs a working controller contact address.

## 5. Procedures

### 5.1 Add or remove an admin

Admins are granted **only** by SQL in the Supabase SQL editor, there is
deliberately no button for this anywhere in the UI.

```sql
-- TODO: verify against the final schema before first use.
insert into public.admins (member_id)
select id from public.members where pseudonym = 'THE_PSEUDONYM';

-- Remove:
delete from public.admins
 where member_id = (select id from public.members where pseudonym = 'THE_PSEUDONYM');
```

### 5.2 Run a Friday night

`TODO:` step-by-step (open the night in admin.html → check-ins → close
reporting → chase the not-reported list → settle). Until written, the
printed night procedure in the chip box is authoritative, **the paper
sheets are filled in every night regardless of whether the site works.**

**The night code (check-in gate).** Every night has a 5-character code
(letters/digits, never 0/O/1/I). In admin.html, select the night and press
**Display code**, a full-screen dark page shows a QR plus the code in giant
type; put that on the venue TV. Scanning the QR opens
`https://storeblindernpoker.org/report?n=CODE` with the code pre-filled;
everyone else types the 5 characters (case doesn't matter). The code is
required **only at check-in**; top-up and final-stack reporting never ask
again, and admin proxy check-ins bypass it entirely. Technical note: the
code is *generated server-side* when the night row is created and stored in
`nights.code`. Members can never read it through the API (the column is
excluded from their grant); admins read it via the `get_night_code()` RPC,
which is what the Display code screen calls, and `check_in()` validates
what members type, case-insensitively. Nothing to configure. It is an
honour-system presence check, not anti-cheat.

### 5.3 Supabase free-tier pause (will happen every summer)

The free project pauses after ~a week of inactivity. Symptom: the public
leaderboard silently shows its last baked-in fallback and sign-in fails.
Fix: log into the Supabase dashboard → project → **Restore**. Takes a
minute or two. `TODO:` who gets the pause warning emails.

### 5.4 Backups

`TODO:` automated dump/export job does not exist yet. Until it does, the
paper sheets from each night are the only second copy of results, they are
kept `TODO: where`, for `TODO: how long`.

### 5.5 Start a new season

`TODO:` create the season row, set `is_current`, verify everyone re-enrols
at 40,000 on first check-in, freeze the old season, export a final
leaderboard snapshot for the hall of fame.

## 6. Known debts and sharp edges

- `TODO:` GitHub history of the *old* repository contained real-name files;
  track the status of the removal request and the account ownership
  escalation.
- No staging environment: schema migrations go straight to production. Test
  against a rehearsal night before touching anything on a Friday.
- The public leaderboard's static fallback goes stale whenever the database
  is unreachable, refresh the baked JSON once a season (`TODO:` export
  button / procedure).
