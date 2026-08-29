-- 0003: pin search_path on the four internal helpers.
--
-- Supabase's linter flags any function without an explicit search_path: a role
-- with a mutable search_path could shadow a referenced object. The SECURITY
-- DEFINER RPCs already set theirs inline; these four are the internal helpers
-- that did not.
--
-- Applied to production as: pin_search_path_internal_functions

alter function public.norm_pseudonym(text)       set search_path = public, pg_temp;
alter function public.member_balance(uuid, uuid) set search_path = public, pg_temp;
alter function public.gen_night_code()           set search_path = public, pg_temp;
alter function public.trg_nights_code()          set search_path = public, pg_temp;
