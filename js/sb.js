/* Store Blindern Poker: Supabase client + auth helpers.
 *
 * Loaded (after js/config.js and js/vendor/supabase.js) by the member-facing
 * pages: login.html, report.html, admin.html. Everything hangs off a single
 * window.SBP namespace. No build step, no modules, script-tag order is the
 * dependency graph.
 *
 * Design rules baked in here:
 *   - The site must render something honest in EVERY state, including
 *     "config placeholders not patched yet" and "vendored bundle failed to
 *     load". Callers check SBP.configured() first and show a notice instead
 *     of dead buttons.
 *   - Session reads are local (supabase-js keeps the session in
 *     localStorage), so state checks work offline. Only actual data calls
 *     touch the network.
 */
(function () {
  'use strict';

  var cfg = window.SBP_CONFIG || {};
  var _client = null;

  function configured() {
    return !!(
      cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
      String(cfg.SUPABASE_URL).indexOf('__') !== 0 &&
      String(cfg.SUPABASE_ANON_KEY).indexOf('__') !== 0 &&
      window.supabase && window.supabase.createClient
    );
  }

  function client() {
    if (!configured()) { return null; }
    if (!_client) {
      _client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // The password flow needs no URL detection; harmless if Google is
          // enabled later (it uses the PKCE flow's own callback handling).
          detectSessionInUrl: true
        }
      });
    }
    return _client;
  }

  /* ---------------- session ---------------- */

  function getSession() {
    var c = client();
    if (!c) { return Promise.resolve(null); }
    return c.auth.getSession().then(function (r) {
      return (r.data && r.data.session) || null;
    }).catch(function () { return null; });
  }

  function signOut() {
    var c = client();
    if (!c) { return Promise.resolve(); }
    return c.auth.signOut().catch(function () { /* local sign-out still clears */ });
  }

  /* Redirect to the login page if there is no session. `nextPage` must be a
   * bare page name (e.g. 'report.html'), it round-trips through a query
   * string and login.js only honours a whitelist, so nothing can redirect
   * off-site. Resolves with the session when signed in. */
  function requireAuth(nextPage) {
    return getSession().then(function (session) {
      if (!session) {
        window.location.replace('login.html?next=' + encodeURIComponent(nextPage || ''));
        return new Promise(function () { /* navigation in flight; never settles */ });
      }
      return session;
    });
  }

  /* ---------------- identity ---------------- */

  /* The signed-in user's member row (or null before the pseudonym claim).
   * RLS already narrows plain members to their own row, but ADMINS can read
   * every row, so filter on auth_user_id explicitly, or an organiser's
   * "my member" would be whoever the database returned first. */
  function getMyMember() {
    var c = client();
    if (!c) { return Promise.resolve(null); }
    return getSession().then(function (session) {
      if (!session || !session.user) { return null; }
      return c.from('members').select('id,pseudonym,joined_on,is_active')
        .eq('auth_user_id', session.user.id)
        .limit(1).maybeSingle()
        .then(function (r) {
          if (r.error) { throw r.error; }
          return r.data || null;
        });
    });
  }

  function isAdmin() {
    var c = client();
    if (!c) { return Promise.resolve(false); }
    return c.rpc('is_admin').then(function (r) {
      if (r.error) { return false; }
      return r.data === true;
    }).catch(function () { return false; });
  }

  /* ---------------- season / night reads ---------------- */

  function currentSeason() {
    var c = client();
    if (!c) { return Promise.resolve(null); }
    return c.from('v_seasons').select('*').eq('is_current', true)
      .limit(1).maybeSingle()
      .then(function (r) {
        if (r.error) { throw r.error; }
        return r.data || null;
      });
  }

  /* Every readable column of nights, BY NAME. The nights table has a
   * column-level grant that deliberately excludes `code` (the check-in
   * code): PostgREST expands select('*') to ALL columns, code included,
   * which fails with 42501 for authenticated. So: never select('*') on
   * nights, use this list. */
  var NIGHT_COLS = 'id,season_id,night_no,played_on,title,kind,status,' +
    'counts_as_round,affects_points,stack_size,attendance_bonus,entry_count,' +
    'unreported_count,chips_in,chips_out,chip_balance,opened_at,closed_at,' +
    'settled_at,settled_by,revision,created_at,reports_close_at';

  /* Tonight's night, if any: an 'open' night wins, else a 'reconciling' one
   * (members may still report while the organisers reconcile). */
  function activeNight() {
    var c = client();
    if (!c) { return Promise.resolve(null); }
    return c.from('nights')
      .select(NIGHT_COLS)
      .in('status', ['open', 'reconciling'])
      .order('played_on', { ascending: false })
      .limit(2)
      .then(function (r) {
        if (r.error) { throw r.error; }
        var rows = r.data || [];
        var open = rows.filter(function (n) { return n.status === 'open'; });
        return open[0] || rows[0] || null;
      });
  }

  /* My entry for a night (or null). member_id is filtered explicitly,
   * RLS narrows plain members to their own rows, but admins see everyone's,
   * and this must never return somebody else's entry. */
  function myEntry(nightId, memberId) {
    var c = client();
    if (!c) { return Promise.resolve(null); }
    return c.from('entries').select('*')
      .eq('night_id', nightId).eq('member_id', memberId)
      .limit(1).maybeSingle()
      .then(function (r) {
        if (r.error) { throw r.error; }
        return r.data || null;
      });
  }

  /* My settled season balance, with honest fallbacks: season_scores row if I
   * have played, else my enrollment's starting points, else the season
   * default. Returns { points, source }. */
  function myBalance(seasonId, memberId) {
    var c = client();
    if (!c) { return Promise.resolve(null); }
    return c.from('season_scores').select('points,nights_played')
      .eq('season_id', seasonId).eq('member_id', memberId)
      .limit(1).maybeSingle()
      .then(function (r) {
        if (!r.error && r.data) {
          return { points: Number(r.data.points), source: 'scores' };
        }
        return c.from('season_enrollments').select('starting_points')
          .eq('season_id', seasonId).eq('member_id', memberId)
          .limit(1).maybeSingle()
          .then(function (r2) {
            if (!r2.error && r2.data) {
              return { points: Number(r2.data.starting_points), source: 'enrollment' };
            }
            return c.from('seasons').select('starting_points').eq('id', seasonId)
              .limit(1).maybeSingle()
              .then(function (r3) {
                var p = (!r3.error && r3.data) ? Number(r3.data.starting_points) : 40000;
                return { points: p, source: 'season-default' };
              });
          });
      })
      .catch(function () { return null; });
  }

  /* ---------------- error classification ----------------
   * The outbox needs to know: is this worth retrying (network hiccup,
   * server blip) or is it final (night settled, not signed in, bad input)?
   * Postgres/PostgREST errors carry a `code`; raw fetch failures do not. */
  function isPermanentError(err) {
    if (!err) { return false; }
    var code = String(err.code || '');
    var msg = String(err.message || '').toLowerCase();
    if (!code) {
      // No code: almost always a network-level failure. Retry.
      return false;
    }
    // Postgres SQLSTATE classes that mean "the server understood and said
    // no": raised exceptions (P0...), constraint violations (23...), data
    // errors (22...), permissions (42501), auth (28000), frozen (55006),
    // and PostgREST request errors (PGRST...).
    if (/^(P0|22|23|28|42|55)/.test(code)) { return true; }
    if (/^PGRST/.test(code)) {
      // PGRST301 = JWT expired, a fresh token fixes it, so retry that one.
      return code !== 'PGRST301';
    }
    // Unknown code: be safe and keep retrying unless the message is clearly
    // a server-side rejection.
    return msg.indexOf('not open') !== -1 || msg.indexOf('settled') !== -1;
  }

  /* Friendly copy for the errors members actually hit. */
  function friendlyError(err) {
    var msg = String((err && err.message) || err || 'Something went wrong');
    var code = String((err && err.code) || '');
    if (code === '23505' || /already taken/i.test(msg)) {
      return 'That pseudonym is already taken, pick another.';
    }
    if (code === '28000' || /not signed in/i.test(msg)) {
      return 'You are signed out. Sign in again, then retry.';
    }
    if (code === 'P0003' || /night_settled/i.test(msg)) {
      return 'Tonight has already been settled. Show your numbers to an organiser instead.';
    }
    // Raised with the default P0001 by set_my_name() and
    // admin_set_member_details(). Checked BEFORE the P0001 line below, or a
    // long name would be answered with "the night is not open".
    if (/name is too long/i.test(msg)) {
      return 'That name is too long. Use the name on your student card, nothing extra.';
    }
    if (code === 'P0001' || /night is not open/i.test(msg)) {
      return 'The night is not open for reporting right now. An organiser can enter it for you.';
    }
    if (code === 'P0010') {
      return 'Type tonight\'s 5-character code: it\'s on the screen at the front, next to the QR.';
    }
    if (code === 'P0011') {
      return 'That code doesn\'t match tonight. Check the screen at the front, or ask an organiser to check you in.';
    }
    if (code === 'P0040') {
      return 'That is your pseudonym, not your name. Put the name on your student card here: only organisers see it.';
    }
    if (code === 'P0041') {
      return 'We need both a first and a last name.';
    }
    if (code === '42501' || /admin only/i.test(msg)) {
      return 'That action is for organisers only.';
    }
    if (/invalid login credentials/i.test(msg)) {
      return 'Wrong email or password. Check both and try again.';
    }
    if (/user already registered/i.test(msg)) {
      return 'That email already has an account. Use the Sign in tab instead.';
    }
    if (/password should be at least/i.test(msg)) {
      return 'The password is too short: use at least 6 characters.';
    }
    if (/rate limit/i.test(msg)) {
      return 'Too many attempts right now. Wait a minute and try again.';
    }
    if (/failed to fetch|fetch failed|networkerror|load failed/i.test(msg)) {
      return 'No connection. Your phone may be offline. Nothing was lost.';
    }
    return msg;
  }

  /* ---------------- environment ---------------- */

  /* In-app browsers (Facebook, Instagram, Messenger, TikTok...) break OAuth
   * and sometimes localStorage. We can't fix them; we can tell people. */
  function isInAppWebview() {
    var ua = navigator.userAgent || '';
    if (/(FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|TikTok|BytedanceWebview|Snapchat|LinkedInApp|MessengerLiteForiOS)/i.test(ua)) {
      return true;
    }
    // iOS WKWebView heuristic: iPhone/iPad UA without the Safari token.
    if (/iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) {
      return true;
    }
    // Android WebView convention: the "; wv)" token.
    if (/Android/.test(ua) && /; wv\)/.test(ua)) {
      return true;
    }
    return false;
  }

  /* ---------------- small utilities ---------------- */

  function fmt(n) {
    if (n === null || n === undefined || isNaN(Number(n))) { return '…'; }
    try { return Number(n).toLocaleString('en-GB'); } catch (e) { return String(n); }
  }

  function fmtSigned(n) {
    var v = Number(n) || 0;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* The same comparator the database uses for pseudonyms:
   * lowercase, all whitespace removed. */
  function normPseudonym(p) {
    return String(p == null ? '' : p).trim().toLowerCase().replace(/\s+/g, '');
  }

  /* ---------------- per-night attendance code ----------------
   * Each night has a 5-character code (unambiguous alphabet, no 0/O/1/I/L),
   * generated SERVER-SIDE when the night row is created and stored in
   * nights.code. Members can never read it through the API, they get it
   * from the venue TV (admin.html shows it via the get_night_code RPC as a
   * QR + giant text) and check_in() validates what they type, raising
   * P0010 (missing) or P0011 (wrong). The client never derives or verifies
   * the code locally; it only normalises what was typed and sends it.
   *
   * This is an honour-system club: the code proves "I am in the room and
   * read the screen", catching mistyped check-ins from home. It is NOT
   * anti-cheat, anyone in the room can share it, which is the point. */
  var CODE_LENGTH = 5;

  /* Forgiving normaliser for typed codes: uppercase, strip everything that
   * is not a letter or digit (spaces, dashes people add while reading).
   * Matches the server's own normalisation in check_in(). */
  function normCode(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /* Parse a typed number: strips spaces, thin spaces, commas and dots used
   * as thousand separators. Returns a non-negative integer or null. */
  function parseChips(raw) {
    var s = String(raw == null ? '' : raw).replace(/[\s  .,']/g, '');
    if (s === '') { return null; }
    if (!/^\d+$/.test(s)) { return null; }
    var n = parseInt(s, 10);
    return isNaN(n) ? null : n;
  }

  function show(el, on) {
    if (!el) { return; }
    if (on === undefined) { on = true; }
    el.hidden = !on;
  }

  /* Sanitise a ?next= page value: bare known page names only. */
  function safeNextPage(raw) {
    var allowed = ['report.html', 'admin.html', 'leaderboard.html', 'index.html', 'events.html', 'rules.html'];
    return allowed.indexOf(raw) !== -1 ? raw : 'report.html';
  }

  window.SBP = {
    config: cfg,
    configured: configured,
    client: client,
    getSession: getSession,
    signOut: signOut,
    requireAuth: requireAuth,
    getMyMember: getMyMember,
    isAdmin: isAdmin,
    currentSeason: currentSeason,
    activeNight: activeNight,
    myEntry: myEntry,
    myBalance: myBalance,
    isPermanentError: isPermanentError,
    friendlyError: friendlyError,
    isInAppWebview: isInAppWebview,
    fmt: fmt,
    fmtSigned: fmtSigned,
    escapeHtml: escapeHtml,
    normPseudonym: normPseudonym,
    normCode: normCode,
    CODE_LENGTH: CODE_LENGTH,
    NIGHT_COLS: NIGHT_COLS,
    parseChips: parseChips,
    show: show,
    safeNextPage: safeNextPage
  };
})();
