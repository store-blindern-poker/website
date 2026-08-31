-- 0010: fix the member directory, which returned 42501 for every organiser.
--
-- v_member_directory.name_looks_like_pseudonym calls norm_pseudonym(), and 0001
-- revoked EXECUTE on it from authenticated as part of the deny-by-default
-- lockdown. A view checks TABLE access as its owner but FUNCTION privileges
-- against the CALLER, so that one generated column failed for everybody.
-- Selecting only plain columns worked, which is why the console rendered while
-- the Members section showed "That action is for organisers only".
--
-- norm_pseudonym is a pure text helper (lowercase, strip whitespace). It reads
-- no data and reveals nothing a client could not compute itself. Keeping it
-- ungranted while a granted view depended on it was the mistake.
--
-- member_balance, gen_night_code and trg_nights_code stay internal: those read
-- data or mutate state.
--
-- LESSON, worth repeating in review: if you add a generated column to a view,
-- query that view AS THE ROLE THAT USES IT. Grants on the view do not cover the
-- functions inside it.
--
-- Applied to production as: grant_norm_pseudonym_for_directory

grant execute on function public.norm_pseudonym(text) to authenticated;

comment on function public.norm_pseudonym(text) is
  'Pure comparison helper: lowercase, whitespace stripped. Granted to authenticated because v_member_directory evaluates it. Safe: no data access.';
