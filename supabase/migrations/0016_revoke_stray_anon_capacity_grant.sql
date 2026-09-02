-- 0015 originally granted anon SELECT on nights.capacity. It never needed it:
-- anon has no read policy on nights at all, and v_upcoming_nights runs as its
-- owner, so the view hands out capacity with no base-table grant involved.
--
-- An unused grant on a table anon cannot select from is exactly the kind of
-- line that gets copied by the next person adding a column, so it goes. 0015
-- in this folder is already written the corrected way; this file is what
-- production needed to catch up.
--
-- Applied to production as 20260902093xxx_revoke_stray_anon_capacity_grant.

revoke select (capacity) on public.nights from anon;
