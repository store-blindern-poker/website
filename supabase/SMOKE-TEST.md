# Anon-key smoke test - run it, do not assume it

Run this after applying `migrations/0001_init.sql`, and again after **every**
future migration. It proves, with the actual anon key over the actual REST
API, that an unauthenticated visitor can read the two public views and touch
**nothing else** - no reads and no writes on any base table.

Why this matters: `member_private` holds real names and emails with only
grants + RLS between them and the internet. A future migration that adds a
permissive policy or a stray grant will not be caught by any linter. This
test catches it. It takes under a minute.

## Setup

Use any POSIX shell (Git Bash on Windows is fine). Fill in both values from
**Supabase Dashboard → Settings → API**:

```bash
K="PASTE_ANON_PUBLISHABLE_KEY_HERE"          # the anon/publishable key - public by design
U="https://PASTE_PROJECT_REF.supabase.co/rest/v1"
```

The nine base tables under test:

```bash
TABLES="members member_private admins seasons season_enrollments nights entries adjustments season_scores"
```

## 1. Reads - every base table must be refused

```bash
echo "== ANON READS (all must be refused) =="
for t in $TABLES; do
  printf '%-22s' "$t"
  curl -s -o /tmp/sbp_body -w 'HTTP %{http_code}  ' \
       "$U/$t?select=*&limit=1" \
       -H "apikey: $K" -H "Authorization: Bearer $K"
  head -c 140 /tmp/sbp_body; echo
done
```

**Must return, for every one of the nine tables:** HTTP `401` or `403` with a
body containing `"code":"42501"` and `permission denied for table <name>`.

**FAIL if:** any line returns HTTP `200`. Even `200` with `[]` is a failure
under this design - it means a table grant to `anon` has crept back in and
only RLS is left standing. Find the grant and revoke it.

## 2. Writes - every base table must be refused

```bash
echo "== ANON WRITES (all must be refused) =="
for t in $TABLES; do
  printf '%-22s' "$t"
  curl -s -o /tmp/sbp_body -w 'HTTP %{http_code}  ' \
       -X POST "$U/$t" \
       -H "apikey: $K" -H "Authorization: Bearer $K" \
       -H "Content-Type: application/json" \
       -d '{}'
  head -c 140 /tmp/sbp_body; echo
done
```

**Must return, for every table:** HTTP `401` or `403` with `"code":"42501"`
(`permission denied`). Never `201`, never a constraint or not-null error  - 
a constraint error would mean the INSERT privilege itself exists and only
the payload was bad.

### 2b. The self-promotion probe (from the plan - keep it verbatim)

An anon caller trying to make themselves an admin, plus an update and a
delete probe. All three must be refused the same way:

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST "$U/admins" \
     -H "apikey: $K" -H "Authorization: Bearer $K" \
     -H "Content-Type: application/json" \
     -d '{"member_id":"00000000-0000-0000-0000-000000000000"}'

curl -s -w '\nHTTP %{http_code}\n' -X PATCH \
     "$U/entries?id=eq.00000000-0000-0000-0000-000000000000" \
     -H "apikey: $K" -H "Authorization: Bearer $K" \
     -H "Content-Type: application/json" \
     -d '{"note":"smoke"}'

curl -s -w '\nHTTP %{http_code}\n' -X DELETE \
     "$U/admins?member_id=eq.00000000-0000-0000-0000-000000000000" \
     -H "apikey: $K" -H "Authorization: Bearer $K"
```

**Must return:** `401`/`403` with `"code":"42501"` each time.

## 3. RPCs - anon can call nothing

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST "$U/rpc/claim_pseudonym" \
     -H "apikey: $K" -H "Authorization: Bearer $K" \
     -H "Content-Type: application/json" \
     -d '{"p_pseudonym":"SmokeTest"}'

curl -s -w '\nHTTP %{http_code}\n' -X POST "$U/rpc/settle_night" \
     -H "apikey: $K" -H "Authorization: Bearer $K" \
     -H "Content-Type: application/json" \
     -d '{"p_night_id":"00000000-0000-0000-0000-000000000000"}'
```

**Must return:** an error - `401`/`403` with `"code":"42501"` (or `404` if
PostgREST hides unexecutable functions from the schema cache). Never `200`.
(For `claim_pseudonym`, even a signed-in caller would be fine here - but the
**anon** key must be refused outright.)

## 4. The member-facing view is signed-in only

```bash
curl -s -w '\nHTTP %{http_code}\n' "$U/v_unclaimed_pseudonyms?select=*" \
     -H "apikey: $K" -H "Authorization: Bearer $K"
```

**Must return:** `401`/`403` with `"code":"42501"` - this view is granted to
`authenticated` only. A `200` here leaks the pseudonym roster to the open
internet.

## 5. The two public views - the ONLY things anon may read

```bash
curl -s -w '\nHTTP %{http_code}\n' "$U/v_leaderboard?select=*&order=rank.asc" \
     -H "apikey: $K" -H "Authorization: Bearer $K"

curl -s -w '\nHTTP %{http_code}\n' "$U/v_seasons?select=*" \
     -H "apikey: $K" -H "Authorization: Bearer $K"
```

**Must return:**

- `v_leaderboard`: HTTP `200` with a JSON array. `[]` is correct until the
  first night is settled; after settling it must contain only these fields:
  `season_id, pseudonym, points, highest_points, lowest_points,
  nights_played, rank, previous_rank`. If a `member_id`, real name, or email
  ever appears here, stop and fix the view before doing anything else.
- `v_seasons`: HTTP `200` with a JSON array containing the `fall-2026` row.

## 6. Pass/fail summary

| Check | Expected |
|---|---|
| GET each of the 9 base tables | 401/403, code `42501`, for **all 9** |
| POST each of the 9 base tables | 401/403, code `42501`, for **all 9** |
| POST /admins, PATCH /entries, DELETE /admins | 401/403, code `42501` |
| POST /rpc/claim_pseudonym, /rpc/settle_night (anon) | 401/403/404 error, never 200 |
| GET /v_unclaimed_pseudonyms (anon) | 401/403, code `42501` |
| GET /v_leaderboard | 200, JSON array, pseudonym + points fields only |
| GET /v_seasons | 200, JSON array with `fall-2026` |

Any deviation from this table blocks launch until explained and fixed.

## 7. After the curl run

1. Open **Supabase Dashboard → Advisors** and review every warning. Two are
   *expected and deliberate*: `v_leaderboard`/`v_seasons`/`v_unclaimed_pseudonyms`
   are SECURITY DEFINER-style (owner-rights) views - that is how column-level
   privacy is achieved here. Never "fix" them by setting
   `security_invoker = true`; it would empty the public leaderboard. Any
   *other* advisor warning must be cleared for real.
2. Grep the live policies for permissiveness - in the SQL editor:

   ```sql
   select tablename, policyname, qual
     from pg_policies
    where schemaname = 'public' and qual = 'true';
   ```

   The **only** acceptable row is `seasons / seasons_read`. A `using (true)`
   policy on any other table is invisible to the linter and is the realistic
   way real names leak later.
3. Confirm RLS is still enabled everywhere:

   ```sql
   select relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
   ```

   **Must return zero rows.**

## Out of scope here

Signed-in behaviour (a non-admin member must not be able to read other
members' entries, call `settle_night`, etc.) is exercised by the Thursday
rehearsal script with real accounts - it needs a real login token and is not
part of this anon smoke test.
