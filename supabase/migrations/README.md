# Migrations

Apply in numeric order to rebuild the database from nothing. Together these files
are what production runs. Production was built by applying them in this order,
so the two should never drift.

| File | What it does |
|---|---|
| `0001_init.sql` | Everything: tables, RLS, the scoring function, the write RPCs, seed |
| `0002_standalone_nights_and_seasons.sql` | `affects_points` for stand-alone nights, `start_season()` |
| `0003_pin_search_path.sql` | Pins `search_path` on four internal helpers |
| `0004_rsvps.sql` | RSVP table, `set_rsvp()`, the two views, public count vs member names |
| `0005_pseudonym_change_deadline.sql` | `change_pseudonym()` and the per-season lock |
| `0006_reporting_closes_next_morning.sql` | `reports_close_at`, defaults to 09:00 the next day |
| `0007_live_rebuy.sql` | Top-ups as a live transaction at the bank |
| `0008_roles_directory_names.sql` | Super admins, the member directory, names |
| `0009_split_first_last_name.sql` | First and last name as separate fields |
| `0010_grant_norm_pseudonym.sql` | Fixes the directory: a view needs EXECUTE on the functions it calls |

## The rule that matters

**Never change the database without adding a file here.** It is genuinely tempting
to run one quick statement in the Supabase SQL editor and move on. Do that twice and
this directory stops describing reality, and the next person cannot rebuild or even
read what the system does. Migrations 0003 to 0007 were nearly lost that way: they
were applied to production directly and back-filled only when a review noticed the
gap.

If you do apply something by hand, write the file the same day. To check the two
still agree:

```sql
select version, name from supabase_migrations.schema_migrations order by version;
```

That list should match the table above, in order.

## Applying them

Either paste each file into the Supabase SQL editor in order, or use the CLI:

```bash
supabase link --project-ref <ref>
supabase db push
```

## Things worth knowing before you edit

- **RLS is deny-by-default.** `0001` revokes everything from `anon` and `authenticated`
  first, then grants back a narrow surface. If you add a table, it gets no access until
  you write a policy AND a grant.
- **Every write goes through a `SECURITY DEFINER` RPC.** No client has INSERT or UPDATE
  on any table. Identity comes from `auth.uid()`, never from a client-supplied id.
- **`nights.code` is excluded from the column grant on purpose.** A member reading the
  attendance code from home would defeat check-in. Admins read it via `get_night_code()`.
  This is why the client must always select nights by named columns; `select('*')` fails.
- **The views deliberately run as owner** so they bypass RLS. That is how the public
  leaderboard works while `anon` has no access to any base table. Supabase's linter flags
  them. Do not "fix" it by setting `security_invoker = true`: the leaderboard goes empty.
- **`recompute_season()` rebuilds from raw entries every time.** There is no incremental
  path to get subtly wrong. Scoring constants live on the `nights` row, not in the code,
  so changing a bonus is an UPDATE, not a deploy.
- **Supabase rejects `UPDATE` without a `WHERE` clause** over the API. Two bookkeeping
  updates in `recompute_season()` carry `where true` for exactly this reason.
