/* Store Blindern Poker: runtime configuration.
 *
 * The two placeholder strings below are patched at deploy time (or by an
 * admin editing this file) with the real Supabase project URL and the
 * PUBLISHABLE anon key. The anon key is public by design, it grants only
 * what Row Level Security allows, which for anonymous visitors is the
 * leaderboard view and nothing else.
 *
 * While the placeholders are still in place, every page falls back to its
 * static content and no network request is made.
 */
window.SBP_CONFIG = {
  SUPABASE_URL: "https://owlwcotwxjwskhzbukwn.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_FYiKY6ECOOSJLTJjn4BTmg_b4r8y91W",

  /* Google sign-in stays hidden until the OAuth consent screen is published
   * to Production and tested on a real phone. Flip to true to show the
   * button on login.html, no other change needed. */
  GOOGLE_ENABLED: false
};
