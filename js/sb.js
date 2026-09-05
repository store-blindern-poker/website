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
    'settled_at,settled_by,revision,created_at,reports_close_at,' +
    'location,location_url,notes,capacity,deleted_at';

  /* The night this screen opens on: the NEWEST night still taking reports,
   * open or reconciling (members may still report while the organisers
   * reconcile). Not necessarily today's: nothing closes reporting but
   * settling, so an unsettled night is still an answer days later, which is
   * what the other-night card in js/report.js exists to handle.
   *
   * It used to read two rows and prefer an 'open' night over a 'reconciling'
   * one whatever the dates said. That was safe while only one night could be
   * unsettled at a time. Two can now, and the preference inverts the answer
   * at the worst possible moment: an organiser closing reporting on tonight's
   * round at 20:30 moves it to 'reconciling', and last week's still-open
   * round would then become the night every phone at the table opened on.
   * Newest wins, full stop. The older night is still reachable, through the
   * card, which is the whole point of it.
   *
   * deleted_at is filtered for the same reason outstandingNights() filters
   * it: delete_night() leaves status alone, and nights_read lets an ADMIN see
   * removed rows, so an organiser would otherwise land on a night they had
   * just removed. */
  function activeNight() {
    var c = client();
    if (!c) { return Promise.resolve(null); }
    return c.from('nights')
      .select(NIGHT_COLS)
      .in('status', ['open', 'reconciling'])
      .is('deleted_at', null)
      .order('played_on', { ascending: false })
      .limit(1)
      .then(function (r) {
        if (r.error) { throw r.error; }
        var rows = r.data || [];
        return rows[0] || null;
      });
  }

  /* The nights this member still owes a report on, oldest first.
   *
   * Reporting used to close at 09:00 the morning after, so two nights could
   * never be open at once and activeNight()'s answer was the only night a
   * member could possibly have meant. Reporting now runs until an organiser
   * settles, so somebody can be carrying an unreported entry on a night that
   * is no longer the newest one, and nothing on the report screen would ever
   * put it in front of them again.
   *
   * member_id is filtered explicitly for the same reason myEntry() does it:
   * RLS narrows a plain member to their own rows, but an ADMIN reads
   * everyone's, so without it an organiser opening /report would be offered
   * somebody else's unfinished night. This never enumerates anybody, it asks
   * only about rows the caller owns.
   *
   * select('*') on entries, because the caller hands the row it gets back
   * straight to ctx.entry and every screen reads a full row. Nights are named
   * columns as always: '*' fails with 42501 under the grant that hides
   * nights.code.
   *
   * The status and deleted_at filters are what keep a settled, void or
   * removed night out of the answer entirely, so nothing downstream needs
   * copy for a night that cannot be reported on. delete_night() leaves status
   * alone and nights_read lets an admin see removed rows, so the deleted_at
   * filter is doing real work and not decoration.
   *
   * Resolves { nights: [rows], entries: { night_id: row } }. NEVER rejects:
   * this is an extra, and a member who cannot load it must still get exactly
   * the screen they get today. */
  function outstandingNights(memberId) {
    var c = client();
    var empty = { nights: [], entries: {} };
    if (!c || !memberId) { return Promise.resolve(empty); }
    return c.from('entries')
      .select('*')
      .eq('member_id', memberId)
      .eq('reported', false)
      .is('voided_at', null)
      /* NEWEST FIRST, and the order is not decoration. reported = false is
       * true of every night a member ever walked away from, settled ones
       * included, and those are filtered out one query later, by which point
       * the cap has already been applied. A chronic non-reporter with a
       * season of them behind her would hand PostgREST an unordered set and
       * take back whichever twelve it felt like, so the one night she can
       * still fix could be the one left out. Newest first puts the still-open
       * nights at the front of the cap, where they belong. */
      .order('created_at', { ascending: false })
      .limit(12)
      .then(function (r) {
        if (r.error) { throw r.error; }
        var rows = r.data || [];
        if (!rows.length) { return empty; }
        var byNight = {};
        var ids = [];
        rows.forEach(function (e) {
          byNight[e.night_id] = e;
          ids.push(e.night_id);
        });
        return c.from('nights')
          .select(NIGHT_COLS)
          .in('id', ids)
          .in('status', ['open', 'reconciling'])
          .is('deleted_at', null)
          .order('played_on', { ascending: true })
          .then(function (rn) {
            if (rn.error) { throw rn.error; }
            return { nights: rn.data || [], entries: byNight };
          });
      })
      .catch(function () { return empty; });
  }

  /* One night by id, for a link that names one. Named columns for the 42501
   * reason above. Resolves null on anything at all going wrong, because the
   * caller falls back to the night it already has. */
  function nightById(nightId) {
    var c = client();
    if (!c || !nightId) { return Promise.resolve(null); }
    return c.from('nights').select(NIGHT_COLS).eq('id', nightId)
      .limit(1).maybeSingle()
      .then(function (r) {
        if (r.error) { throw r.error; }
        return r.data || null;
      })
      .catch(function () { return null; });
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
    /* Not "tonight". Reporting has no deadline, so a night can be settled
     * days after it was played, and this is what the late reporter sees. */
    if (code === 'P0003' || /night_settled/i.test(msg)) {
      return 'The night has already been settled. Show your numbers to an organiser instead.';
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
    /* Removing and restoring a member (delete_member, restore_member).
     * P0050 you cannot remove your own account
     * P0051 that member is an organiser, remove their access first
     * P0053 somebody else now uses that pseudonym
     * All three are written server-side for the one person who sees them, an
     * organiser mid-task, and each names the fix. Rewriting them here would
     * only make them vaguer, so they pass through with a capital letter.
     * The night-edit codes below join them for the same reason. */
    /* Editing a night (update_night).
     * P0060 the night is settled or void, reopen it first
     * P0061 somebody has checked in, so the date, the stack, the bonus and
     *       the two scoring switches are frozen. The server counts the
     *       players and says how many, which is the part that makes an
     *       organiser believe it, so the sentence passes through whole.
     * P0062 moving the date would leave a reporting deadline standing before
     *       the night it belongs to. Nothing in the database sets a deadline
     *       on its own any more, so this only ever fires on a night somebody
     *       set one on by hand, and the sentence names both the time it is
     *       set to and the two ways out.
     * Same rule as the block above: the server wrote these for the one
     * person who reads them, and each names the fix. */
    /* Two more that carry their own fix and pass through whole:
     * P0030 that night is full, and it says how full. NOT P0022: take_rebuy
     *       already uses that one for "check in first", and js/report.js
     *       branches on it.
     * P0070 that night has been removed */
    if (code === 'P0050' || code === 'P0051' || code === 'P0053' ||
        code === 'P0060' || code === 'P0061' || code === 'P0062' ||
        code === 'P0030' || code === 'P0070') {
      var said = msg.charAt(0).toUpperCase() + msg.slice(1);
      return /[.!?]$/.test(said) ? said : said + '.';
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
    outstandingNights: outstandingNights,
    nightById: nightById,
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
