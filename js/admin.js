/* Store Blindern Poker: admin.html behaviour (organiser console).
 *
 * Gate: signed in AND is_admin() RPC true. Everything else is read/refused
 * server-side anyway (SECURITY DEFINER RPCs self-check), the client gate
 * only decides what to render.
 *
 * RPCs used here: create_night (TEN arguments since migration 0012, the
 * 8-argument version was dropped), update_night (NULL means "leave this
 * field alone", '' clears a text field), open_night, close_reporting, settle_night,
 * check_in(p_night_id, p_member_id), admin proxy path, no p_code needed,
 * report_entry(p_night_id, p_final_stack, p_rebuy_chips, p_member_id,
 * p_note), add_adjustment(p_night_id, p_member_id, p_delta_points, p_kind,
 * p_reason), get_night_code(p_night_id) for the TV takeover,
 * void_rebuy(p_night_id, p_member_id) to undo a bank top-up whose slip was
 * never honoured, is_super_admin() once at boot, and for super admins only
 * grant_admin(p_member_id) / revoke_admin(p_member_id).
 * Reads: v_seasons, nights (named columns, never *), entries, adjustments,
 * members (admin RLS), v_member_directory (empty unless admin; the ONLY
 * place real names and emails may render).
 *
 * The screen that matters as the night winds up is WHO HAS NOT REPORTED, it is the
 * loudest block on the page. The balance indicator (chips in vs out) is
 * informational and never blocks settling: imbalances are recorded, the
 * night settles anyway, corrections happen during the week.
 */
(function () {
  'use strict';

  var S = window.SBP;
  if (!S) { return; }

  var $ = function (id) { return document.getElementById(id); };

  var ctx = {
    season: null,     // v_seasons row (is_current)
    nights: [],       // nights rows, newest first
    night: null,      // selected night
    entries: [],      // entries for the selected night
    rsvps: [],        // v_night_rsvps rows for the selected night
    rsvpState: 'idle',// idle | loading | ready | failed
    members: [],      // [{id, pseudonym, key}]
    membersByKey: {}, // normalised pseudonym -> member
    membersById: {},  // id -> member
    bulkPlan: null,   // validated bulk-paste lines awaiting apply
    pollTimer: null,
    isSuper: false,   // is_super_admin(), asked once at boot
    directory: [],    // v_member_directory rows (admin-only names + emails)
    dirState: 'idle', // idle | ready | failed (skeleton is the idle look)
    dirShowRemoved: false, // false = current members (the default), true = removed only
    nightsShowRemoved: false // same switch for the nights list
  };

  function msg(el, text, kind) {
    if (!el) { return; }
    el.textContent = text || '';
    el.className = 'form-msg' + (kind ? ' form-msg--' + kind : '');
  }

  function showState(name) {
    ['state-config', 'state-loading', 'state-denied', 'console'].forEach(function (id) {
      S.show($(id), id === name);
    });
  }

  function rpc(name, args) {
    return S.client().rpc(name, args || {}).then(function (r) {
      if (r.error) { throw r.error; }
      return Array.isArray(r.data) ? r.data[0] : r.data;
    });
  }

  /* ------------------------------------------------------------------
   * Data loading
   * ------------------------------------------------------------------ */

  function loadSeason() {
    return S.currentSeason().then(function (season) {
      ctx.season = season;
      $('season-line').textContent = season
        ? season.name + ' · everyone starts on 40,000 points'
        : 'No current season. Create one in the Supabase table editor.';
      return season;
    });
  }

  function loadMembers() {
    return S.client().from('members')
      .select('id,pseudonym,is_active')
      .eq('is_active', true)
      .order('pseudonym', { ascending: true })
      .then(function (r) {
        if (r.error) { throw r.error; }
        ctx.members = (r.data || [])
          .filter(function (m) { return m.pseudonym; })
          .map(function (m) {
            return { id: m.id, pseudonym: m.pseudonym, key: S.normPseudonym(m.pseudonym) };
          });
        ctx.membersByKey = {};
        ctx.membersById = {};
        ctx.members.forEach(function (m) {
          ctx.membersByKey[m.key] = m;
          ctx.membersById[m.id] = m;
        });
        $('member-list').innerHTML = ctx.members.map(function (m) {
          return '<option value="' + S.escapeHtml(m.pseudonym) + '"></option>';
        }).join('');
      });
  }

  function loadNights() {
    if (!ctx.season) { ctx.nights = []; renderNights(); return Promise.resolve(); }
    // Named columns: even for admins, select('*') on nights fails under the
    // column-level grant that hides nights.code (admins read the code via
    // the get_night_code RPC instead).
    return S.client().from('nights').select(S.NIGHT_COLS)
      .eq('season_id', ctx.season.season_id)
      .order('played_on', { ascending: false })
      .then(function (r) {
        if (r.error) { throw r.error; }
        ctx.nights = r.data || [];
        renderNights();
        // Keep the selected night's row fresh after lifecycle actions.
        if (ctx.night) {
          var updated = ctx.nights.filter(function (n) { return n.id === ctx.night.id; })[0];
          if (updated) { ctx.night = updated; }
        }
      });
  }

  function loadEntries() {
    if (!ctx.night) { return Promise.resolve(); }
    return S.client().from('entries').select('*')
      .eq('night_id', ctx.night.id)
      .then(function (r) {
        if (r.error) { throw r.error; }
        ctx.entries = (r.data || []).filter(function (e) { return !e.voided_at; });
        renderDetail();
      });
  }

  function refreshAll() {
    return Promise.all([
      loadNights(),
      // Members MUST refresh too. People claim pseudonyms during the night,
      // especially the first one. Without this they stay invisible to the
      // console until a full page reload: the entries table calls them
      // "(unknown member)", and neither the proxy forms nor bulk paste can
      // find them, which is exactly when an organiser needs them most.
      loadMembers().catch(function () { /* keep the last good roster */ }),
      ctx.night ? loadEntries() : Promise.resolve(),
      ctx.night ? loadAdjustments() : Promise.resolve(),
      // loadRsvps() swallows its own failures, so a headcount that will not
      // load can never fail this Promise.all and stop the rest refreshing.
      ctx.night ? loadRsvps() : Promise.resolve()
    ]).then(function () { if (ctx.night) { renderDetail(); } });
  }

  /* ------------------------------------------------------------------
   * Nights list
   * ------------------------------------------------------------------ */

  function nightRemoved(n) { return !!(n && n.deleted_at); }

  /* Removing a night is soft, so this list has the same two views the
   * member directory has: the live nights, which is the default, and the
   * removed ones. The count sits on the toggle whichever way it points, so
   * a removed night is never invisible, only out of the way. */
  function renderNights() {
    var box = $('nights-list');
    var live = ctx.nights.filter(function (n) { return !nightRemoved(n); });
    var gone = ctx.nights.filter(nightRemoved);

    // Nothing removed means nothing to switch to, so the view snaps back.
    if (!gone.length) { ctx.nightsShowRemoved = false; }

    var toggle = $('nights-removed-toggle');
    if (toggle) {
      S.show(toggle, gone.length > 0);
      toggle.setAttribute('aria-pressed', ctx.nightsShowRemoved ? 'true' : 'false');
      toggle.textContent = ctx.nightsShowRemoved
        ? 'Show current (' + S.fmt(live.length) + ')'
        : 'Show removed (' + S.fmt(gone.length) + ')';
    }

    var pool = ctx.nightsShowRemoved ? gone : live;
    if (!pool.length) {
      box.innerHTML = '<div class="card"><p class="card__text">' +
        (ctx.nightsShowRemoved
          ? 'No removed nights.'
          : (gone.length
              ? 'Every night has been removed. "Show removed" lists them, and Restore puts one back.'
              : 'No nights yet: create the first one above.')) +
        '</p></div>';
      return;
    }
    box.innerHTML = pool.map(function (n) {
      var sel = ctx.night && ctx.night.id === n.id;
      return '<button type="button" class="night-row' + (sel ? ' night-row--selected' : '') +
        (nightRemoved(n) ? ' row--removed' : '') +
        '" data-night="' + n.id + '">' +
        '<span><span class="night-row__title">' +
          S.escapeHtml(n.title || 'Night ' + n.night_no) + '</span><br>' +
          '<span class="night-row__meta">' + S.escapeHtml(n.played_on) +
          ' · stack ' + S.fmt(n.stack_size) + ' · bonus +' + S.fmt(n.attendance_bonus) +
          (n.capacity ? ' · ' + S.fmt(n.capacity) + ' seats' : '') +
          (n.counts_as_round ? '' : ' · does not count as a round') + '</span></span>' +
        (nightRemoved(n)
          ? '<span class="badge badge--muted">removed</span>'
          : '<span class="status-pill status-pill--' + n.status + '">' + n.status + '</span>') +
        '</button>';
    }).join('');
  }

  $('nights-removed-toggle').addEventListener('click', function () {
    ctx.nightsShowRemoved = !ctx.nightsShowRemoved;
    renderNights();
  });

  $('nights-list').addEventListener('click', function (e) {
    var row = e.target.closest('.night-row');
    if (!row) { return; }
    var night = ctx.nights.filter(function (n) { return n.id === row.getAttribute('data-night'); })[0];
    if (!night) { return; }
    selectNight(night);
  });

  function selectNight(night) {
    ctx.night = night;
    ctx.entries = [];
    ctx.rsvps = [];
    ctx.rsvpState = 'idle';
    rsvpMsg('', '');
    ctx.bulkPlan = null;
    S.show($('bulk-preview-wrap'), false);
    S.show($('bulk-apply-btn'), false);
    msg($('bulk-msg'), '', '');
    msg($('lifecycle-msg'), '', '');
    S.show($('remove-night-confirm'), false);
    msg($('adjust-msg'), '', '');
    S.show($('settle-confirm'), false);
    // Whatever was typed belonged to the night you just left. The form
    // refills from the new one when it is opened again.
    closeEdit();
    renderNights();
    S.show($('night-detail'), true);
    renderDetail();
    loadEntries();
    loadAdjustments();
    loadRsvps();
    armPolling();
    $('night-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* Live-ish while a night is running: refresh entries every 45 s, and the
   * RSVPs with them. People do answer late ("on my way"), and a roll call
   * that compares fresh check-ins against a stale list of who was coming
   * would name the wrong people to go looking for. */
  function armPolling() {
    if (ctx.pollTimer) { clearInterval(ctx.pollTimer); ctx.pollTimer = null; }
    if (ctx.night && (ctx.night.status === 'open' || ctx.night.status === 'reconciling')) {
      ctx.pollTimer = setInterval(function () {
        if (!document.hidden) { loadEntries(); loadRsvps(); }
      }, 45000);
    }
  }

  /* ------------------------------------------------------------------
   * Night detail
   * ------------------------------------------------------------------ */

  function pseudonymOf(memberId) {
    var m = ctx.membersById[memberId];
    return m ? m.pseudonym : '(unknown member)';
  }

  function renderDetail() {
    var n = ctx.night;
    if (!n) { return; }

    $('detail-title').textContent = n.title || ('Night ' + n.night_no);
    $('detail-meta').textContent = n.played_on +
      ' · stack ' + S.fmt(n.stack_size) +
      ' · bonus +' + S.fmt(n.attendance_bonus) +
      (n.capacity ? ' · ' + S.fmt(n.capacity) + ' seats' : '') +
      (n.counts_as_round ? '' : ' · does not count as a round');
    var removed = nightRemoved(n);
    var pill = $('detail-status');
    pill.textContent = removed ? 'removed' : n.status;
    pill.className = removed ? 'badge badge--muted'
                             : 'status-pill status-pill--' + n.status;

    renderVenue(n);
    // The edit controls follow the same rule the server does: everything
    // except a settled or void night can be edited (P0060 is the refusal).
    S.show($('toggle-edit'), editableNight(n) && !nightRemoved(n));
    if (!editableNight(n)) { closeEdit(); }
    syncEditFrozen();

    // A removed night is a record, not a night. Nothing on it can be run,
    // opened or edited; the only way forward is Restore. Removing and
    // restoring are super-admin work, same as removing a member.
    S.show($('btn-remove-night'), ctx.isSuper && !removed);
    S.show($('btn-restore-night'), ctx.isSuper && removed);
    if (removed) { closeEdit(); S.show($('settle-confirm'), false); }

    // Lifecycle buttons by status. Draft → open. Open → close/settle.
    // Reconciling → settle (or reopen). Settled → reopen for corrections.
    S.show($('btn-open'), !removed && n.status === 'draft');
    S.show($('btn-close'), !removed && n.status === 'open');
    S.show($('btn-settle'), !removed && (n.status === 'open' || n.status === 'reconciling'));
    S.show($('btn-reopen'), !removed && (n.status === 'reconciling' || n.status === 'settled'));
    $('btn-reopen').textContent = n.status === 'settled'
      ? 'Reopen for corrections' : 'Reopen check-in';
    // The TV takeover: available for any live-ish night (showing it for a
    // draft lets organisers put it on the screen before doors open).
    S.show($('btn-code'), !removed && n.status !== 'void');

    // The numbers of the night, computed from live entries the same way
    // recompute_season() will: unreported final stacks count as zero.
    var entries = ctx.entries;
    var reported = entries.filter(function (e) { return e.reported; });
    var unreported = entries.filter(function (e) { return !e.reported; });
    var chipsIn = entries.reduce(function (a, e) { return a + e.buyin_chips + e.rebuy_chips; }, 0);
    var chipsOut = entries.reduce(function (a, e) { return a + (e.final_stack || 0); }, 0);
    var deviation = chipsOut - chipsIn;

    $('mini-stats').innerHTML =
      stat(entries.length, 'checked in', '') +
      stat(reported.length, 'reported', reported.length === entries.length && entries.length ? 'ok' : '') +
      stat(unreported.length, 'not reported', unreported.length ? 'alert' : 'ok') +
      '<div class="mini-stat ' + (deviation !== 0 && reported.length ? 'mini-stat--alert' : 'mini-stat--ok') + '">' +
        '<div class="mini-stat__value ' + (deviation !== 0 ? 'deviation--bad' : 'deviation--zero') + '">' +
          S.fmtSigned(deviation) + '</div>' +
        '<div class="mini-stat__label">chips out − in<br>' +
          S.fmt(chipsOut) + ' − ' + S.fmt(chipsIn) + '</div></div>';

    // WHO HAS NOT REPORTED, the block organisers read aloud before people
    // leave. Unreported entries settle as a ZERO final stack.
    var nr = $('notreported');
    var names = $('notreported-names');
    if (!entries.length) {
      nr.className = 'notreported';
      $('notreported-title').textContent = 'Nobody has checked in yet';
      names.innerHTML = '<span class="help">Check-ins appear here as they happen.</span>';
    } else if (unreported.length) {
      nr.className = 'notreported';
      $('notreported-title').textContent =
        'Not reported yet (' + unreported.length + '): chase before they leave';
      names.innerHTML = unreported.map(function (e) {
        return '<span class="notreported__name">' +
          S.escapeHtml(pseudonymOf(e.member_id)) + '</span>';
      }).join('');
    } else {
      nr.className = 'notreported notreported--clear';
      $('notreported-title').textContent = 'Everyone has reported ✓';
      names.innerHTML = '';
    }
    renderNudge();

    // Entries table.
    var body = $('entries-body');
    if (!entries.length) {
      body.innerHTML = '<tr><td colspan="5" style="color: var(--text-tertiary);">No entries yet.</td></tr>';
    } else {
      var sorted = entries.slice().sort(function (a, b) {
        if (a.reported !== b.reported) { return a.reported ? 1 : -1; }
        return pseudonymOf(a.member_id).localeCompare(pseudonymOf(b.member_id));
      });
      body.innerHTML = sorted.map(function (e) {
        var status = e.reported
          ? '<span class="badge badge--ok">reported' +
            (e.reported_via !== 'self' ? ' · ' + S.escapeHtml(e.reported_via) : '') + '</span>'
          : '<span class="badge badge--warn">not reported</span>';
        // rebuy_at set = the top-up was issued live at the bank, so the
        // number is the server's record, not somebody's memory. Those rows
        // get the badge and the undo: void_rebuy exists precisely because a
        // recorded top-up may never have been handed over.
        var bank = !!e.rebuy_at;
        return '<tr>' +
          '<td>' + S.escapeHtml(pseudonymOf(e.member_id)) + '</td>' +
          '<td class="num">' + S.fmt(e.buyin_chips) + '</td>' +
          '<td class="num">' + S.fmt(e.rebuy_chips) +
            (bank ? ' <span class="badge badge--gold">bank</span>' : '') + '</td>' +
          '<td class="num">' + (e.reported ? S.fmt(e.final_stack || 0) : '…') + '</td>' +
          '<td>' + status +
            (bank
              ? ' <button type="button" class="btn btn--ghost" style="padding: 6px 10px;"' +
                ' data-void-member="' + S.escapeHtml(e.member_id) + '">Void top-up…</button>'
              : '') + '</td>' +
        '</tr>';
      }).join('');
    }

    // The headcount block reads ctx.entries too (the roll call compares who
    // said yes against who is actually here), so it redraws whenever the
    // entries do. Wrapped: it is an addition to this page, and nothing in it
    // is allowed to take the entries table or the lifecycle bar with it.
    try { renderRsvp(); } catch (e) { /* the rest of the console stands */ }
  }

  function stat(value, label, tone) {
    return '<div class="mini-stat' + (tone ? ' mini-stat--' + tone : '') + '">' +
      '<div class="mini-stat__value">' + S.fmt(value) + '</div>' +
      '<div class="mini-stat__label">' + S.escapeHtml(label) + '</div></div>';
  }

  /* ------------------------------------------------------------------
   * The venue, and editing a night
   *
   * Until migration 0012 the room lived in data/events.json, so changing it
   * meant a git commit and a deploy: impossible for a non-technical
   * successor, and impossible for anybody standing in a corridor at 17:40
   * when the room has just moved. It is a database field now, and the public
   * events page reads it from v_upcoming_nights, so confirming a room is a
   * form on this page.
   *
   * update_night() reads NULL as "leave this alone", so only changed fields
   * are sent, and an EMPTY STRING as "clear this field". Two refusals are
   * handled by name (both via S.friendlyError, which passes the server's own
   * sentence through):
   *   P0060 the night is settled or void, reopen it first
   *   P0061 somebody has checked in, so the date, stack size, attendance
   *         bonus and the two scoring switches are frozen
   *
   * The frozen fields are DISABLED here rather than left open to be rejected
   * on save. The freeze is a fact about the night, not an error to discover
   * afterwards: entries were booked against those numbers at check-in, and
   * moving them now would score the early players by one rule and the late
   * ones by another. Title, location, map link and notes never freeze, which
   * is right, because they are the fields that change late.
   * ------------------------------------------------------------------ */

  function venueOf(n) { return String((n && n.location) || '').trim(); }

  /* An empty venue and a literal "TBD" mean the same thing to everybody who
   * reads this site, so they read the same here. */
  function venueSet(n) {
    var v = venueOf(n);
    return !!v && v.toLowerCase() !== 'tbd';
  }

  /* Only a real web link becomes a link. The field is admin-typed, so this is
   * about a typo rendering as a dead or dangerous href, not about defence. */
  function mapHref(url) {
    var u = String(url == null ? '' : url).trim();
    return /^https?:\/\//i.test(u) ? u : '';
  }

  function renderVenue(n) {
    var el = $('detail-location');
    if (!el) { return; }
    if (!venueSet(n)) {
      // Brass, not silence. A night with no room is a job somebody has to do
      // before Friday, and it has to be readable at a glance in this header.
      el.className = 'night-venue night-venue--unset';
      el.textContent = venueOf(n)
        ? 'Venue still says "' + venueOf(n) + '": set the room here'
        : 'No venue set yet: set the room here';
      return;
    }
    var href = mapHref(n.location_url);
    el.className = 'night-venue';
    el.innerHTML = S.escapeHtml(venueOf(n)) +
      (href
        ? ' <a class="night-venue__map" href="' + S.escapeHtml(href) +
          '" target="_blank" rel="noopener">map &#8599;</a>'
        : '');
  }

  function editableNight(n) {
    return !!n && n.status !== 'settled' && n.status !== 'void';
  }

  /* How many people are in the night, for the freeze. entry_count is written
   * by recompute_season and can lag a check-in that happened 10 seconds ago,
   * so the live rows count too and the larger number wins: erring towards
   * "frozen" only ever costs an organiser a reopen, while erring the other
   * way offers an edit the server is going to refuse. */
  function checkedInCount() {
    var fromRow = Number(ctx.night && ctx.night.entry_count) || 0;
    return Math.max(fromRow, ctx.entries.length);
  }

  /* kind is deliberately NOT in this list: update_night does not freeze it. */
  var FROZEN_IDS = ['edit-date', 'edit-stack', 'edit-bonus', 'edit-counts', 'edit-affects'];

  function syncEditFrozen() {
    var frozen = checkedInCount();
    var note = $('edit-frozen');
    FROZEN_IDS.forEach(function (id) {
      var el = $(id);
      if (el) { el.disabled = frozen > 0; }
    });
    if (!note) { return; }
    if (frozen > 0) {
      note.textContent = frozen + (frozen === 1 ? ' player has' : ' players have') +
        ' checked in, so the date, stack size, attendance bonus and the two ' +
        'scoring switches are locked: they were used to book those entries. ' +
        'Title, location, map link, seats and notes still change.';
      S.show(note, true);
    } else {
      note.textContent = '';
      S.show(note, false);
    }
  }

  function fillEdit() {
    var n = ctx.night;
    if (!n) { return; }
    $('edit-title').value = n.title || '';
    $('edit-location').value = n.location || '';
    $('edit-location-url').value = n.location_url || '';
    $('edit-notes').value = n.notes || '';
    $('edit-capacity').value = n.capacity == null ? '' : String(n.capacity);
    $('edit-date').value = String(n.played_on || '').slice(0, 10);
    $('edit-kind').value = n.kind || 'tournament';
    $('edit-stack').value = n.stack_size == null ? '' : String(n.stack_size);
    $('edit-bonus').value = n.attendance_bonus == null ? '' : String(n.attendance_bonus);
    $('edit-counts').checked = !!n.counts_as_round;
    $('edit-affects').checked = !!n.affects_points;
    syncEditFrozen();
  }

  function editIsOpen() {
    var f = $('edit-form');
    return !!f && !f.hidden;
  }

  function openEdit() {
    if (!editableNight(ctx.night)) { return; }
    // Filled on OPEN only, never on the 45-second poll: refilling under a
    // typing organiser would eat the room they were halfway through entering.
    fillEdit();
    msg($('edit-msg'), '', '');
    S.show($('edit-form'), true);
    $('toggle-edit').setAttribute('aria-expanded', 'true');
    $('toggle-edit').textContent = 'Close editor';
    $('edit-location').focus();
  }

  function closeEdit() {
    var f = $('edit-form');
    if (!f) { return; }
    S.show(f, false);
    msg($('edit-msg'), '', '');
    $('toggle-edit').setAttribute('aria-expanded', 'false');
    $('toggle-edit').textContent = 'Edit details';
  }

  $('toggle-edit').addEventListener('click', function () {
    if (editIsOpen()) { closeEdit(); } else { openEdit(); }
  });
  $('edit-cancel').addEventListener('click', closeEdit);

  /* A trimmed text field, or null when it did not change. An emptied box
   * returns '', which is how update_night clears the column. */
  function textChange(id, current) {
    var typed = String($(id).value || '').trim();
    var now = String(current == null ? '' : current).trim();
    return typed === now ? null : typed;
  }

  $('edit-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var n = ctx.night;
    if (!n) { return; }
    var frozen = checkedInCount() > 0;
    var args = { p_night_id: n.id };
    var changed = 0;

    function put(key, value) {
      if (value === null || value === undefined) { return; }
      args[key] = value;
      changed += 1;
    }

    put('p_title', textChange('edit-title', n.title));
    put('p_location', textChange('edit-location', n.location));
    put('p_location_url', textChange('edit-location-url', n.location_url));
    put('p_notes', textChange('edit-notes', n.notes));

    // Seats never freeze: the cap changes nothing already scored, and a
    // room swap on the day is exactly when it needs changing. An emptied
    // box means no limit, which update_night is told with a 0.
    var capRaw = String($('edit-capacity').value || '').trim();
    var cap;
    if (capRaw === '') {
      cap = 0;
    } else {
      cap = S.parseChips(capRaw);
      if (cap === null || cap < 1) {
        msg($('edit-msg'), 'Seats must be a whole number of players, e.g. 38. ' +
          'Leave it empty for no limit.', 'error');
        return;
      }
    }
    if (cap !== (n.capacity == null ? 0 : Number(n.capacity))) { put('p_capacity', cap); }

    if ($('edit-kind').value !== n.kind) { put('p_kind', $('edit-kind').value); }

    // The frozen five are not read at all when the night has entries: the
    // inputs are disabled, so whatever they hold is stale by definition.
    if (!frozen) {
      var date = $('edit-date').value;
      if (!date) {
        msg($('edit-msg'), 'A night needs a date.', 'error');
        return;
      }
      if (date !== String(n.played_on || '').slice(0, 10)) { put('p_played_on', date); }

      var stack = S.parseChips($('edit-stack').value);
      if (stack === null) {
        msg($('edit-msg'), 'Stack size must be a whole number of chips, e.g. 10000.', 'error');
        return;
      }
      if (stack !== Number(n.stack_size)) { put('p_stack_size', stack); }

      var bonus = S.parseChips($('edit-bonus').value);
      if (bonus === null) {
        msg($('edit-msg'), 'Attendance bonus must be a whole number, e.g. 5000.', 'error');
        return;
      }
      if (bonus !== Number(n.attendance_bonus)) { put('p_attendance_bonus', bonus); }

      if ($('edit-counts').checked !== !!n.counts_as_round) {
        put('p_counts_as_round', $('edit-counts').checked);
      }
      if ($('edit-affects').checked !== !!n.affects_points) {
        put('p_affects_points', $('edit-affects').checked);
      }
    }

    if (!changed) {
      msg($('edit-msg'), 'Nothing changed, so nothing was sent.', 'ok');
      return;
    }

    var wasVenue = venueSet(n);
    msg($('edit-msg'), 'Saving…', 'busy');
    rpc('update_night', args)
      .then(function (night) {
        if (night) { ctx.night = night; }
        msg($('edit-msg'), args.p_location !== undefined && !wasVenue && venueSet(ctx.night)
          ? 'Saved ✓. The events page shows the room now.'
          : 'Saved ✓', 'ok');
        return refreshAll();
      })
      .then(function () {
        // Show what the server actually stored, not what was typed: an empty
        // box that cleared a field should come back empty, and a trimmed
        // value should come back trimmed.
        if (editIsOpen()) { fillEdit(); }
      })
      .catch(function (err) {
        msg($('edit-msg'), S.friendlyError(err), 'error');
        // If the refusal was the freeze (P0061), somebody checked in while
        // this form was open. Redraw so the locked fields look locked.
        loadEntries().catch(function () { syncEditFrozen(); });
      });
  });

  /* ------------------------------------------------------------------
   * Who said they are coming
   *
   * The decision this serves is taken in advance: the headcount decides
   * how many tables go up, and whether stack_size has to come down because
   * there are not enough chips for that many opening buy-ins. So the block
   * renders for a draft night as well, and is hidden once the night is
   * settled or void, when the entries are the record and an intention is
   * only history.
   *
   * Read: v_night_rsvps, authenticated only, one row per answer with the
   * member's pseudonym. The two counts are summed from those same rows
   * rather than read from v_upcoming_nights, which carries the identical
   * pair but only for nights whose played_on is still in the future: an
   * organiser reconciling on Saturday morning would get nothing from it.
   * One query covers every unsettled night, and a count summed from the
   * rows underneath it can never disagree with the list it heads.
   *
   * Nothing here writes. set_rsvp() always acts on the caller, so there is
   * no answer-on-behalf path in the database and there is deliberately no
   * control here that would pretend otherwise. Getting a player into a
   * night is the proxy check-in's job.
   *
   * Names: only the people who said yes are ever listed. A decline is a
   * number, here as on the public page. Nobody needs a roll of who said no.
   * ------------------------------------------------------------------ */

  var RSVP_SKELETON =
    '<p class="visually-hidden" role="status">Loading the headcount.</p>' +
    '<div class="skeleton-table" aria-hidden="true">' +
      '<div class="skeleton-table__row">' +
        '<span class="skeleton skeleton--name"></span>' +
        '<span class="skeleton skeleton--num"></span></div>' +
      '<div class="skeleton-table__row">' +
        '<span class="skeleton skeleton--name"></span>' +
        '<span class="skeleton skeleton--num"></span></div>' +
    '</div>';

  function rsvpMsg(text, kind) {
    var el = $('rsvp-admin-msg');
    if (!el) { return; }
    el.textContent = text || '';
    el.className = 'rsvp__msg' + (kind === 'error' ? ' rsvp__msg--error' : '');
  }

  /* Settled and void nights are done: the entries below are the truth by
   * then, and who once meant to come adds nothing. */
  function rsvpTracked(night) {
    return !!night && night.status !== 'settled' && night.status !== 'void';
  }

  function rsvpEmpty(text) {
    return '<div class="empty-state">' +
      '<div class="empty-state__icon">&#9824;</div>' +
      '<p class="empty-state__text">' + S.escapeHtml(text) + '</p></div>';
  }

  function loadRsvps() {
    var n = ctx.night;
    if (!n) { return Promise.resolve(); }
    if (!rsvpTracked(n)) {
      ctx.rsvps = [];
      ctx.rsvpState = 'idle';
      renderRsvp();
      return Promise.resolve();
    }
    var id = n.id;
    // A poll keeps the numbers on screen while it runs: only a first load
    // shows the skeleton, so the block does not flash every 45 seconds.
    if (ctx.rsvpState !== 'ready') { ctx.rsvpState = 'loading'; renderRsvp(); }

    return S.client().from('v_night_rsvps').select('pseudonym,response')
      .eq('night_id', id)
      .then(function (r) {
        if (r.error) { throw r.error; }
        if (!ctx.night || ctx.night.id !== id) { return; }  // switched nights
        ctx.rsvps = r.data || [];
        ctx.rsvpState = 'ready';
        rsvpMsg('', '');
        renderRsvp();
      })
      .catch(function (err) {
        if (!ctx.night || ctx.night.id !== id) { return; }
        // Keep the last good roll call on screen if there is one: a poll
        // that fails on room wifi must not blank the list at 19:00.
        if (ctx.rsvpState === 'ready') {
          rsvpMsg('That last refresh failed, so this headcount may be out of ' +
            'date: ' + S.friendlyError(err), 'error');
          return;
        }
        ctx.rsvps = [];
        ctx.rsvpState = 'failed';
        rsvpMsg(S.friendlyError(err), 'error');
        renderRsvp();
      });
  }

  function renderRsvp() {
    var n = ctx.night;
    var sec = $('rsvp-admin');
    var box = $('rsvp-admin-body');
    if (!sec || !box) { return; }

    if (!rsvpTracked(n)) {
      S.show(sec, false);
      rsvpMsg('', '');
      return;
    }
    S.show(sec, true);

    if (ctx.rsvpState === 'idle' || ctx.rsvpState === 'loading') {
      box.innerHTML = RSVP_SKELETON;
      return;
    }
    if (ctx.rsvpState === 'failed') {
      box.innerHTML = rsvpEmpty('No headcount right now. Refresh to try again: ' +
        'everything else on this page works without it.');
      return;
    }

    var going = [];
    var notGoing = 0;
    ctx.rsvps.forEach(function (r) {
      if (r.response === 'going' && r.pseudonym) { going.push(r.pseudonym); }
      else if (r.response === 'not_going') { notGoing += 1; }
    });
    going.sort(function (a, b) { return String(a).localeCompare(String(b)); });

    if (!going.length && !notGoing) {
      box.innerHTML = rsvpEmpty('Nobody has answered yet. Members answer on the ' +
        'events page, and only for themselves.');
      return;
    }

    // Who is actually in the room, by normalised pseudonym, from the entries
    // this console already holds. No second query: one member, one entry.
    // A member who has since been deactivated is not in membersById, so an
    // entry of theirs cannot be matched and they stay on the "not here yet"
    // list. Rare, and it errs towards looking for somebody who is already in.
    var hereKeys = {};
    ctx.entries.forEach(function (e) {
      var m = ctx.membersById[e.member_id];
      if (m) { hereKeys[m.key] = true; }
    });
    var goingKeys = {};
    going.forEach(function (p) { goingKeys[S.normPseudonym(p)] = true; });

    var missing = going.filter(function (p) { return !hereKeys[S.normPseudonym(p)]; });
    var walkins = ctx.entries.filter(function (e) {
      var m = ctx.membersById[e.member_id];
      return !m || !goingKeys[m.key];
    }).length;

    // Two modes, one shape. Before the doors open the last two numbers are
    // the chip question; from "Open night" onwards they are the roll call.
    var live = n.status === 'open' || n.status === 'reconciling';
    var stack = Number(n.stack_size) || 0;
    var html = '<div class="mini-stats">' +
      stat(going.length, n.capacity ? ('coming of ' + S.fmt(n.capacity)) : 'coming', '') +
      stat(notGoing, 'cannot make it', '') +
      (live
        ? stat(going.length - missing.length, 'here already',
            (going.length && !missing.length) ? 'ok' : '') +
          stat(missing.length, 'not here yet', missing.length ? 'alert' : 'ok')
        : stat(stack, 'chips per buy-in', '') +
          stat(going.length * stack, 'chips to seat them', '')) +
      '</div>';

    // Worth saying out loud: the events page has stopped taking answers
    // and somebody will ask why. The door is a separate question.
    if (n.capacity && going.length >= n.capacity) {
      html += '<p class="help">Every seat is taken, so nobody else can answer on ' +
        'the events page. That never blocks the door: if somebody turns up, check ' +
        'them in below as normal, or raise the seats in Edit details.</p>';
    }

    // The line an organiser reads at 19:00: who said they were coming and is
    // not in the room. Same brass block as "not reported", because it asks
    // for the same thing, somebody to go and find a person.
    if (n.status === 'open' && going.length) {
      if (missing.length) {
        html += '<div class="notreported">' +
          '<h3>Said yes, not here yet (<span class="mono">' + missing.length +
            '</span>): the ones to look for</h3>' +
          '<div class="notreported__names">' +
            missing.map(function (p) {
              return '<span class="notreported__name">' + S.escapeHtml(p) + '</span>';
            }).join('') +
          '</div></div>';
      } else {
        html += '<div class="notreported notreported--clear">' +
          '<h3>Everyone who said yes is here ✓</h3></div>';
      }
    }

    if (going.length) {
      html += '<p class="help">Coming, alphabetically:</p>' +
        '<ul class="rsvp__list">' +
          going.map(function (p) {
            return '<li class="rsvp__who">' + S.escapeHtml(p) + '</li>';
          }).join('') +
        '</ul>';
    } else {
      html += '<p class="help">Nobody has said yes yet.</p>';
    }

    if (live && walkins) {
      html += '<p class="help"><span class="mono">' + walkins +
        '</span> checked in without answering, so the headcount reads low.</p>';
    }

    html += '<p class="rsvp__hint">Members answer for themselves and only for ' +
      'themselves; there is no way to set this for somebody else. To put a ' +
      'player into the night, use Check someone in below.</p>';

    box.innerHTML = html;
  }

  /* ------------------------------------------------------------------
   * Lifecycle actions
   * ------------------------------------------------------------------ */

  function lifecycle(rpcName, busyText) {
    msg($('lifecycle-msg'), busyText, 'busy');
    rpc(rpcName, { p_night_id: ctx.night.id })
      .then(function (night) {
        if (night) { ctx.night = night; }
        msg($('lifecycle-msg'), 'Done ✓', 'ok');
        return refreshAll();
      })
      .then(armPolling)
      .catch(function (err) {
        msg($('lifecycle-msg'), S.friendlyError(err), 'error');
      });
  }

  $('btn-open').addEventListener('click', function () { lifecycle('open_night', 'Opening…'); });
  $('btn-reopen').addEventListener('click', function () { lifecycle('open_night', 'Reopening…'); });
  $('btn-close').addEventListener('click', function () { lifecycle('close_reporting', 'Closing reporting…'); });

  /* Settle is two taps, with the honest numbers in between. */
  $('btn-settle').addEventListener('click', function () {
    var unreported = ctx.entries.filter(function (e) { return !e.reported; }).length;
    var chipsIn = ctx.entries.reduce(function (a, e) { return a + e.buyin_chips + e.rebuy_chips; }, 0);
    var chipsOut = ctx.entries.reduce(function (a, e) { return a + (e.final_stack || 0); }, 0);
    var dev = chipsOut - chipsIn;
    var parts = [];
    parts.push(ctx.entries.length + ' entries');
    parts.push(unreported
      ? unreported + ' NOT reported (they settle as a zero stack)'
      : 'everyone reported');
    parts.push(dev === 0 ? 'chips balance' : 'chip imbalance ' + S.fmtSigned(dev) +
      ' (recorded, never a blocker)');
    $('settle-confirm-text').textContent = 'Settle: ' + parts.join(' · ') + '.';
    S.show($('settle-confirm'), true);
  });

  $('btn-settle-cancel').addEventListener('click', function () {
    S.show($('settle-confirm'), false);
  });

  $('btn-settle-really').addEventListener('click', function () {
    S.show($('settle-confirm'), false);
    msg($('lifecycle-msg'), 'Settling and recomputing the season…', 'busy');
    rpc('settle_night', { p_night_id: ctx.night.id })
      .then(function (night) {
        if (night) { ctx.night = night; }
        msg($('lifecycle-msg'), 'Settled ✓. The leaderboard is up to date.', 'ok');
        return refreshAll();
      })
      .then(armPolling)
      .catch(function (err) {
        msg($('lifecycle-msg'), S.friendlyError(err), 'error');
      });
  });

  /* ------------------------------------------------------------------
   * Removing a night
   *
   * Soft, exactly like removing a member: deleted_at is stamped, every
   * entry and adjustment stays where it is, and the season is recomputed
   * without the night. Restore reverses all of it. Super admins only.
   *
   * This is the tool for a night that should never have existed, a test
   * fixture or a duplicate. It is NOT the tool for a wrong result: a
   * number somebody reported wrongly is fixed by reporting it again for
   * them, which corrects the chips and the points together.
   * ------------------------------------------------------------------ */

  $('btn-remove-night').addEventListener('click', function () {
    var n = ctx.night;
    if (!n) { return; }
    var count = checkedInCount();
    $('remove-night-text').textContent =
      'Remove "' + (n.title || 'Night ' + n.night_no) + '"' +
      (count ? ', and its ' + count + (count === 1 ? ' entry' : ' entries') : '') +
      '? Nothing is deleted' +
      (n.status === 'settled' ? ', and the season is recomputed without it' : '') +
      '. Restore puts it all back.';
    S.show($('remove-night-confirm'), true);
  });

  $('btn-remove-cancel').addEventListener('click', function () {
    S.show($('remove-night-confirm'), false);
  });

  $('btn-remove-really').addEventListener('click', function () {
    S.show($('remove-night-confirm'), false);
    nightRemoval('delete_night',
      'Removing the night and recomputing the season…',
      'Removed ✓. "Show removed" lists it, and Restore puts it back.');
  });

  $('btn-restore-night').addEventListener('click', function () {
    nightRemoval('restore_night',
      'Restoring the night and recomputing the season…',
      'Restored ✓. The season counts it again.');
  });

  /* delete_night returns void, so PostgREST answers 204 with no body and
   * rpc() resolves with null. Neither answer is trusted anyway: refreshAll
   * re-reads the nights list, and loadNights re-points ctx.night at the
   * fresh row, so the pill and the buttons follow the server. */
  function nightRemoval(rpcName, busyText, okText) {
    if (!ctx.night) { return; }
    msg($('lifecycle-msg'), busyText, 'busy');
    rpc(rpcName, { p_night_id: ctx.night.id })
      .then(refreshAll)
      .then(function () { msg($('lifecycle-msg'), okText, 'ok'); })
      .catch(function (err) {
        msg($('lifecycle-msg'), S.friendlyError(err), 'error');
      });
  }

  /* ------------------------------------------------------------------
   * Chasing the players who have not reported
   *
   * Friday proved the need: six of thirty-eight walked off without a
   * number, and chasing them meant naming people in a public channel from
   * memory, which named somebody who had already reported.
   *
   * Every mail carries that member's OWN figures, because the useful
   * sentence is not "you forgot" but "this is what silence costs you".
   * ------------------------------------------------------------------ */

  var NUDGE_RECENT_MS = 30 * 60 * 1000;

  function nudgeable() {
    var n = ctx.night;
    if (!n || nightRemoved(n)) { return []; }
    // A settled or void night cannot take a report, so asking for one would
    // be sending people to a screen that refuses them.
    if (n.status === 'settled' || n.status === 'void') { return []; }
    return ctx.entries.filter(function (e) { return !e.reported; });
  }

  function renderNudge() {
    var list = nudgeable();
    S.show($('nudge-bar'), list.length > 0);
    if (!list.length) {
      S.show($('nudge-confirm'), false);
      msg($('nudge-msg'), '', '');
      return;
    }
    $('nudge-btn').textContent = 'Email the ' + list.length +
      (list.length === 1 ? ' player' : ' players') + ' who have not reported';
    var recent = list.filter(function (e) {
      return e.reminder_sent_at &&
        Date.now() - new Date(e.reminder_sent_at).getTime() < NUDGE_RECENT_MS;
    }).length;
    $('nudge-note').textContent = recent
      ? recent + ' of them were emailed in the last half hour and will be left alone.'
      : '';
  }

  $('nudge-btn').addEventListener('click', function () {
    var list = nudgeable();
    if (!list.length) { return; }
    $('nudge-confirm-text').textContent =
      'Email ' + list.length + (list.length === 1 ? ' player' : ' players') +
      ' their own figures and the deadline? They get one mail each.';
    S.show($('nudge-confirm'), true);
  });

  $('nudge-cancel').addEventListener('click', function () {
    S.show($('nudge-confirm'), false);
  });

  /* functions.invoke reports any non-2xx as a bare "non-2xx status code" and
   * leaves the body unread. This function answers refusals with a sentence
   * worth showing an organiser (no sender set up yet, organisers only), so
   * dig it out rather than showing the shrug. */
  function invokeNudge() {
    return S.client().functions.invoke('notify-unreported', {
      body: { night_id: ctx.night.id }
    }).then(function (r) {
      if (!r.error) { return r.data || {}; }
      var res = r.error.context;
      if (res && typeof res.json === 'function') {
        return res.json().then(function (b) {
          var e = new Error((b && (b.message || b.error)) || r.error.message);
          e.body = b;
          throw e;
        }, function () { throw r.error; });
      }
      throw r.error;
    });
  }

  $('nudge-really').addEventListener('click', function () {
    S.show($('nudge-confirm'), false);
    msg($('nudge-msg'), 'Sending...', 'busy');
    invokeNudge().then(function (d) {
      var parts = [];
      var bad = (d.failed && d.failed.length) ? d.failed.length : 0;
      if (d.sent) { parts.push('Emailed ' + d.sent); }
      if (d.skipped) { parts.push(d.skipped + ' skipped, mailed in the last half hour'); }
      if (d.no_address) { parts.push(d.no_address + ' with no address on file'); }
      if (bad) {
        parts.push(bad + ' failed (' + d.failed.map(function (x) {
          return x.pseudonym;
        }).join(', ') + ')');
      }
      if (!parts.length) { parts.push(d.message || 'Nobody to email'); }
      msg($('nudge-msg'), parts.join(' - ') + (bad ? '' : ' OK'), bad ? 'error' : 'ok');
      // Re-read so reminder_sent_at is current and a second press knows.
      return loadEntries();
    }).catch(function (err) {
      msg($('nudge-msg'), S.friendlyError(err), 'error');
    });
  });

  /* ------------------------------------------------------------------
   * Night-code takeover, the QR + giant code, made for a TV across a room.
   *
   * The code lives in nights.code, generated server-side when the night is
   * created and readable ONLY through the admin get_night_code() RPC (the
   * column is excluded from the members' grant, so the API never hands it
   * to someone on their sofa). check_in() validates what members type.
   * The QR encodes https://storeblindernpoker.org/report?n=CODE;
   * report.html reads ?n= and pre-fills the code field.
   * ------------------------------------------------------------------ */

  function showCodeTakeover() {
    var n = ctx.night;
    if (!n) { return; }

    $('code-night').textContent = (n.title || 'Night ' + n.night_no) + ' · ' + n.played_on;
    $('code-big').textContent = '· · · · ·';
    $('code-qr').innerHTML = '';

    S.show($('code-takeover'), true);
    document.body.classList.add('no-scroll');
    // Best effort real fullscreen for the TV; the fixed overlay is already
    // a takeover if the browser refuses.
    var el = $('code-takeover');
    try {
      if (el.requestFullscreen) { el.requestFullscreen().catch(function () {}); }
    } catch (e) { /* overlay is enough */ }

    rpc('get_night_code', { p_night_id: n.id }).then(function (code) {
      // Ignore a late response if the admin switched nights meanwhile.
      if (!ctx.night || ctx.night.id !== n.id || $('code-takeover').hidden) { return; }
      code = String(code || '');
      $('code-big').textContent = code.split('').join(' ');
      try {
        // qrcode-generator (vendored): type 0 = auto-size, 'M' = 15% error
        // correction, comfortable for a TV shot from across a room.
        var qr = window.qrcode(0, 'M');
        qr.addData('https://storeblindernpoker.org/report?n=' + code);
        qr.make();
        $('code-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      } catch (e) {
        // No QR (vendored file missing?), the giant code alone still works.
        $('code-qr').innerHTML = '';
      }
    }).catch(function (err) {
      $('code-big').textContent = '…';
      msg($('lifecycle-msg'), 'Could not fetch the night code: ' + S.friendlyError(err), 'error');
      hideCodeTakeover();
    });
  }

  function hideCodeTakeover() {
    S.show($('code-takeover'), false);
    document.body.classList.remove('no-scroll');
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(function () {});
      }
    } catch (e) { /* fine */ }
  }

  $('btn-code').addEventListener('click', showCodeTakeover);
  $('code-close').addEventListener('click', hideCodeTakeover);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('code-takeover').hidden) { hideCodeTakeover(); }
  });
  // Leaving browser fullscreen (Esc handled by the browser) keeps the
  // overlay consistent: if fullscreen ends while the takeover is up, keep
  // the overlay, organisers may want it windowed on the TV.

  /* ------------------------------------------------------------------
   * Adjustments, corrections with a reason, on the record.
   * Friday's job: +5,000 Welcome Round points per attendee, reason visible.
   * ------------------------------------------------------------------ */

  /* Signed points parser: "+5000", "-2 500", "5000". Null if not a number. */
  function parseSigned(raw) {
    var s = String(raw == null ? '' : raw).replace(/[\s  .,']/g, '').replace('−', '-');
    if (!/^[+-]?\d+$/.test(s)) { return null; }
    var n = parseInt(s, 10);
    return isNaN(n) ? null : n;
  }

  function loadAdjustments() {
    if (!ctx.night) { return Promise.resolve(); }
    return S.client().from('adjustments').select('*')
      .eq('night_id', ctx.night.id)
      .order('created_at', { ascending: false })
      .then(function (r) {
        if (r.error) { throw r.error; }
        renderAdjustments(r.data || []);
      })
      .catch(function () { /* history is a nicety; the form still works */ });
  }

  function renderAdjustments(rows) {
    var box = $('adjust-history');
    if (!rows.length) {
      box.innerHTML = '<p class="help">No adjustments recorded for this night.</p>';
      return;
    }
    box.innerHTML =
      '<div class="table-wrapper"><table class="table table--compact"><thead>' +
      '<tr><th>Who</th><th class="num">Points</th><th>Kind</th><th>Reason</th></tr>' +
      '</thead><tbody>' +
      rows.map(function (a) {
        return '<tr>' +
          '<td>' + S.escapeHtml(a.member_id ? pseudonymOf(a.member_id) : '(night note)') + '</td>' +
          '<td class="num">' + S.fmtSigned(a.delta_points) + '</td>' +
          '<td>' + S.escapeHtml(a.kind) + '</td>' +
          '<td>' + S.escapeHtml(a.reason) + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';
  }

  $('adjust-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var nameRaw = $('adjust-name').value.trim();
    var delta = parseSigned($('adjust-delta').value);
    var kind = $('adjust-kind').value;
    var reason = $('adjust-reason').value.trim();

    if (!reason) {
      msg($('adjust-msg'), 'A reason is required: it shows up in history.', 'error');
      return;
    }
    if (delta === null) {
      msg($('adjust-msg'), 'Points must be a whole number, e.g. 5000 or -2500.', 'error');
      return;
    }

    var member = null;
    if (nameRaw) {
      member = ctx.membersByKey[S.normPseudonym(nameRaw)];
      if (!member) {
        msg($('adjust-msg'), 'No member with that pseudonym.', 'error');
        return;
      }
    } else if (delta !== 0) {
      msg($('adjust-msg'), 'A night-level note carries no points. Name a member, or set the amount to 0.', 'error');
      return;
    }

    msg($('adjust-msg'), 'Recording…', 'busy');
    rpc('add_adjustment', {
      p_night_id: ctx.night.id,
      p_member_id: member ? member.id : null,
      p_delta_points: delta,
      p_kind: kind,
      p_reason: reason
    }).then(function () {
      msg($('adjust-msg'),
        (member ? member.pseudonym + ' ' + S.fmtSigned(delta) + ' recorded ✓' : 'Night note recorded ✓') +
        (ctx.night.status === 'settled' ? '. Season recomputed.' : '. Applies when the night settles.'),
        'ok');
      $('adjust-name').value = '';
      $('adjust-delta').value = '0';
      $('adjust-reason').value = '';
      return loadAdjustments();
    }).catch(function (err) {
      msg($('adjust-msg'), S.friendlyError(err), 'error');
    });
  });

  /* ------------------------------------------------------------------
   * Create night
   * ------------------------------------------------------------------ */

  $('toggle-create').addEventListener('click', function () {
    var f = $('create-form');
    S.show(f, f.hidden);
    if (!f.hidden && !$('create-date').value) {
      // Default to the coming Friday, nights are Fridays all semester.
      var d = new Date();
      var add = (5 - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + add);
      $('create-date').value = d.toISOString().slice(0, 10);
    }
  });

  $('create-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!ctx.season) {
      msg($('create-msg'), 'No current season to attach the night to.', 'error');
      return;
    }
    var date = $('create-date').value;
    if (!date) { msg($('create-msg'), 'Pick a date.', 'error'); return; }
    var stack = S.parseChips($('create-stack').value);
    var bonus = S.parseChips($('create-bonus').value);
    var kind = $('create-kind').value;
    msg($('create-msg'), 'Creating…', 'busy');
    // create_night takes ten arguments since migration 0012: the venue is a
    // database field now, and the 8-argument version was DROPPED, so a call
    // that leaves p_location and p_location_url off fails outright.
    rpc('create_night', {
      p_season_id: ctx.season.season_id,
      p_played_on: date,
      p_title: $('create-title').value.trim() || null,
      p_kind: kind,
      p_stack_size: stack === null ? null : stack,
      p_attendance_bonus: bonus === null ? null : bonus,
      p_counts_as_round: kind === 'tournament',
      p_affects_points: $('create-affects').checked,
      p_location: $('create-location').value.trim() || null,
      p_location_url: $('create-location-url').value.trim() || null
    }).then(function (night) {
      msg($('create-msg'), 'Created as draft ✓. Open it when doors open.', 'ok');
      $('create-title').value = '';
      $('create-location').value = '';
      $('create-location-url').value = '';
      return loadNights().then(function () {
        if (night) { selectNight(night); }
      });
    }).catch(function (err) {
      msg($('create-msg'), S.friendlyError(err), 'error');
    });
  });

  /* ------------------------------------------------------------------
   * Season rollover. Twice a year, guarded by a typed confirmation.
   * ------------------------------------------------------------------ */

  $('season-toggle').addEventListener('click', function () {
    var form = $('season-form');
    S.show(form, form.hidden);
    if (!form.hidden && ctx.season) {
      $('season-current').textContent =
        'Current season: ' + ctx.season.name + ' (' + ctx.season.rounds + ' settled rounds so far).';
    }
  });

  $('season-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('season-name').value.trim();
    var slug = $('season-slug').value.trim().toLowerCase();
    var starts = $('season-starts').value;
    var pts = S.parseChips($('season-points').value);
    if (!name || !slug || !starts) {
      msg($('season-msg'), 'Name, slug and first night are all required.', 'error');
      return;
    }
    var current = ctx.season ? ctx.season.name : 'the current season';
    var typed = window.prompt(
      'This permanently freezes ' + current + ' and starts "' + name + '".\n' +
      'Type the new season name to confirm:');
    if (typed === null) { return; }
    if (typed.trim() !== name) {
      msg($('season-msg'), 'Confirmation text did not match. Nothing was changed.', 'error');
      return;
    }
    msg($('season-msg'), 'Starting the new season…', 'busy');
    rpc('start_season', {
      p_slug: slug, p_name: name, p_starts_on: starts,
      p_starting_points: pts === null ? 40000 : pts
    }).then(function () {
      msg($('season-msg'), 'Done. Reloading…', 'ok');
      window.location.reload();
    }).catch(function (err) {
      msg($('season-msg'), S.friendlyError(err), 'error');
    });
  });

  /* ------------------------------------------------------------------
   * Proxy check-in / report
   * ------------------------------------------------------------------ */

  function resolveMember(inputEl, msgEl) {
    var member = ctx.membersByKey[S.normPseudonym(inputEl.value)];
    if (!member) {
      msg(msgEl, 'No member with that pseudonym. New player? They can sign ' +
        'up and claim it themselves in 20 seconds.', 'error');
      return null;
    }
    return member;
  }

  $('proxy-checkin-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var member = resolveMember($('proxy-checkin-name'), $('proxy-checkin-msg'));
    if (!member) { return; }
    msg($('proxy-checkin-msg'), 'Checking in ' + member.pseudonym + '…', 'busy');
    rpc('check_in', { p_night_id: ctx.night.id, p_member_id: member.id })
      .then(function () {
        msg($('proxy-checkin-msg'), member.pseudonym + ' checked in ✓', 'ok');
        $('proxy-checkin-name').value = '';
        return loadEntries();
      })
      .catch(function (err) {
        msg($('proxy-checkin-msg'), S.friendlyError(err), 'error');
      });
  });

  $('proxy-report-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var member = resolveMember($('proxy-report-name'), $('proxy-report-msg'));
    if (!member) { return; }
    var rebuy = S.parseChips($('proxy-report-rebuy').value);
    var finalStack = S.parseChips($('proxy-report-final').value);
    if (finalStack === null) {
      msg($('proxy-report-msg'), 'Final stack is required (0 for a bust).', 'error');
      return;
    }
    msg($('proxy-report-msg'), 'Saving…', 'busy');
    rpc('report_entry', {
      p_night_id: ctx.night.id,
      p_final_stack: finalStack,
      p_rebuy_chips: rebuy === null ? 0 : rebuy,
      p_member_id: member.id
    }).then(function () {
      msg($('proxy-report-msg'), member.pseudonym + ' recorded ✓', 'ok');
      $('proxy-report-name').value = '';
      $('proxy-report-rebuy').value = '0';
      $('proxy-report-final').value = '';
      return loadEntries();
    }).catch(function (err) {
      msg($('proxy-report-msg'), S.friendlyError(err), 'error');
    });
  });

  /* ------------------------------------------------------------------
   * Bulk paste, "pseudonym, rebuy, final" per line, from the paper sheet
   * ------------------------------------------------------------------ */

  function parseBulk(text) {
    var lines = text.split(/\r?\n/);
    var plan = [];
    lines.forEach(function (raw, i) {
      var line = raw.trim();
      if (!line) { return; }
      var parts = line.split(/[,;\t]+/).map(function (p) { return p.trim(); });
      var item = { lineNo: i + 1, raw: line, ok: false };

      if (parts.length < 2) {
        item.error = 'need at least "pseudonym, final"';
        plan.push(item); return;
      }
      var name = parts[0];
      var rebuy, finalStack;
      if (parts.length === 2) {
        rebuy = 0;
        finalStack = S.parseChips(parts[1]);
      } else {
        rebuy = S.parseChips(parts[1]);
        finalStack = S.parseChips(parts[2]);
      }
      var member = ctx.membersByKey[S.normPseudonym(name)];
      item.pseudonym = name;
      item.member = member || null;
      item.rebuy = rebuy;
      item.final = finalStack;
      if (!member) { item.error = 'unknown pseudonym'; }
      else if (rebuy === null) { item.error = 'bad top-up number'; }
      else if (finalStack === null) { item.error = 'bad final stack'; }
      else { item.ok = true; }
      plan.push(item);
    });
    return plan;
  }

  $('bulk-preview-btn').addEventListener('click', function () {
    var plan = parseBulk($('bulk-input').value);
    if (!plan.length) {
      msg($('bulk-msg'), 'Nothing to preview, paste some lines first.', 'error');
      S.show($('bulk-preview-wrap'), false);
      S.show($('bulk-apply-btn'), false);
      return;
    }
    ctx.bulkPlan = plan;
    var good = plan.filter(function (p) { return p.ok; }).length;
    $('bulk-preview-body').innerHTML = plan.map(function (p) {
      return '<tr>' +
        '<td>' + S.escapeHtml(p.member ? p.member.pseudonym : (p.pseudonym || p.raw)) + '</td>' +
        '<td class="num">' + (p.rebuy === null || p.rebuy === undefined ? '…' : S.fmt(p.rebuy)) + '</td>' +
        '<td class="num">' + (p.final === null || p.final === undefined ? '…' : S.fmt(p.final)) + '</td>' +
        '<td class="' + (p.ok ? 'bulk-line--ok' : 'bulk-line--bad') + '">' +
          (p.ok ? '✓ ready' : '✗ ' + S.escapeHtml(p.error)) + '</td>' +
      '</tr>';
    }).join('');
    S.show($('bulk-preview-wrap'), true);
    $('bulk-apply-count').textContent = '(' + good + ' of ' + plan.length + ')';
    S.show($('bulk-apply-btn'), good > 0);
    msg($('bulk-msg'), good === plan.length
      ? 'All lines check out. Apply writes them one by one.'
      : (plan.length - good) + ' line(s) will be skipped: fix and re-preview, or apply the rest.',
      good === plan.length ? 'ok' : 'error');
  });

  $('bulk-apply-btn').addEventListener('click', function () {
    if (!ctx.bulkPlan) { return; }
    var todo = ctx.bulkPlan.filter(function (p) { return p.ok; });
    if (!todo.length) { return; }
    var btn = $('bulk-apply-btn');
    btn.disabled = true;
    var done = 0, failed = [];

    // Sequential on purpose: one clear failure line beats 30 racing calls
    // on room wifi. report_entry checks in implicitly, so one call per line.
    function next() {
      var item = todo.shift();
      if (!item) {
        btn.disabled = false;
        S.show($('bulk-apply-btn'), false);
        msg($('bulk-msg'),
          'Applied ' + done + ' line(s)' +
          (failed.length ? '. FAILED: ' + failed.join('; ') : ' ✓'),
          failed.length ? 'error' : 'ok');
        if (!failed.length) { $('bulk-input').value = ''; S.show($('bulk-preview-wrap'), false); }
        loadEntries();
        return;
      }
      msg($('bulk-msg'), 'Writing ' + item.member.pseudonym + '…', 'busy');
      rpc('report_entry', {
        p_night_id: ctx.night.id,
        p_final_stack: item.final,
        p_rebuy_chips: item.rebuy,
        p_member_id: item.member.id,
        p_note: 'bulk paste'
      }).then(function () {
        done += 1;
        next();
      }).catch(function (err) {
        failed.push(item.member.pseudonym + ' (' + S.friendlyError(err) + ')');
        next();
      });
    }
    next();
  });

  /* ------------------------------------------------------------------
   * Void a bank top-up
   *
   * The undo for a slip that was never handed over: the member tapped
   * "take top-up", the record was written, and then the queue moved on or
   * the chip case was empty. void_rebuy() is admin-only server-side; the
   * button renders on any entry whose rebuy_at is set.
   * ------------------------------------------------------------------ */

  $('entries-body').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-void-member]');
    if (!btn || !ctx.night) { return; }
    var memberId = btn.getAttribute('data-void-member');
    var entry = ctx.entries.filter(function (en) { return en.member_id === memberId; })[0];
    if (!entry) { return; }
    var ok = window.confirm(
      'Void the recorded top-up of ' + S.fmt(entry.rebuy_chips) + ' chips for ' +
      pseudonymOf(memberId) + '?\n\nOnly do this if the chips were never actually ' +
      'handed over. Their slip stays on their phone but stops counting.');
    if (!ok) { return; }
    btn.disabled = true;
    msg($('entries-msg'), 'Voiding the top-up…', 'busy');
    rpc('void_rebuy', { p_night_id: ctx.night.id, p_member_id: memberId })
      .then(function () {
        msg($('entries-msg'), 'Top-up voided for ' + pseudonymOf(memberId) + ' ✓', 'ok');
        return loadEntries();
      })
      .catch(function (err) {
        btn.disabled = false;
        msg($('entries-msg'), S.friendlyError(err), 'error');
      });
  });

  /* ------------------------------------------------------------------
   * Member directory + roles
   *
   * v_member_directory is the one read on the whole site that carries real
   * names and emails, and the database keeps it admin-only (it comes back
   * empty for anyone else). Search filters client-side: 110 rows is
   * nothing, and an organiser mid-night gets instant answers.
   *
   * Roles: is_super_admin() is asked once at boot. Supers get an Action
   * column with grant/revoke buttons; plain admins get the directory
   * read-only. Super admins themselves are managed in the SQL editor, and
   * the server refuses to touch them anyway, so their action cell is just
   * a muted note. Every failure stays inside this section: the console
   * above works fine with no directory at all.
   *
   * Removing a member is a SOFT delete (delete_member), so this list has two
   * views: the current members, which is the default, and the removed ones,
   * reached by the toggle above the table. Both come out of the same single
   * fetch, filtered on deleted_at here, so switching costs no query. The
   * removed count sits on the toggle whichever view you are in: a removed
   * member is still a member of the club's records, and forgetting they are
   * there is the failure this design is trying to avoid.
   * ------------------------------------------------------------------ */

  var DIR_COLS = 'member_id,pseudonym,real_name,first_name,last_name,' +
    'name_looks_like_pseudonym,email,joined_on,is_active,deleted_at,' +
    'nights_recorded,claimed,is_admin,is_super';

  function isSuperAdmin() {
    var c = S.client();
    if (!c) { return Promise.resolve(false); }
    return c.rpc('is_super_admin').then(function (r) {
      if (r.error) { return false; }
      return r.data === true;
    }).catch(function () { return false; });
  }

  function dirColspan() { return ctx.isSuper ? 6 : 5; }

  function loadDirectory() {
    return S.client().from('v_member_directory').select(DIR_COLS)
      .order('pseudonym', { ascending: true })
      .then(function (r) {
        if (r.error) { throw r.error; }
        ctx.directory = r.data || [];
        ctx.dirState = 'ready';
        msg($('members-msg'), '', '');
        renderDirectory();
      })
      .catch(function (err) {
        if (ctx.dirState === 'ready') {
          // Keep the last good list on screen; just say the refresh failed.
          msg($('members-msg'), 'That refresh failed, so this list may be out of date: ' +
            S.friendlyError(err), 'error');
          return;
        }
        ctx.dirState = 'failed';
        $('members-count').textContent = '';
        $('members-body').innerHTML = '<tr><td colspan="' + dirColspan() +
          '" style="color: var(--text-tertiary);">The directory did not load: ' +
          S.escapeHtml(S.friendlyError(err)) +
          ' Refresh to try again; everything else on this page works without it.</td></tr>';
      });
  }

  /* The name cell. Members now give a first name and a last name on their own
   * step, so where the split exists it is spelled out under the full name: an
   * organiser checking a record against a student card should not have to
   * guess which half is which. Rows the database flagged
   * (name_looks_like_pseudonym) are the ones stored before that step existed,
   * where somebody typed their pseudonym into the name box. They need a human
   * to ask and fix, so they are badged, not hidden. */
  function nameCell(m) {
    var full = String(m.real_name || '').trim();
    var first = String(m.first_name || '').trim();
    var last = String(m.last_name || '').trim();
    var out = '';

    if (full) {
      out += '<div>' + S.escapeHtml(full) + '</div>';
    } else {
      out += '<div style="color: var(--cream-mute);">no name yet</div>';
    }
    if (first || last) {
      out += '<div class="mono" style="font-size: 0.75rem; color: var(--cream-mute);">' +
        'first: ' + S.escapeHtml(first || '?') +
        ' · last: ' + S.escapeHtml(last || '?') + '</div>';
    }
    if (m.name_looks_like_pseudonym) {
      out += '<span class="badge badge--warn" style="margin-top: 4px;">' +
        'looks like their pseudonym</span>';
    }
    return out;
  }

  function isRemoved(m) { return !!m.deleted_at; }
  function liveMembers() { return ctx.directory.filter(function (m) { return !isRemoved(m); }); }
  function removedMembers() { return ctx.directory.filter(isRemoved); }

  /* deleted_at is a timestamptz. The day is all an organiser needs here, and
   * the ISO prefix is the same shape as joined_on in the column beside it. */
  function removedOn(m) { return String(m.deleted_at || '').slice(0, 10); }

  function nightsPhrase(n) {
    var v = Number(n) || 0;
    return S.fmt(v) + (v === 1 ? ' night' : ' nights');
  }

  function renderDirectory() {
    if (ctx.dirState !== 'ready') { return; }
    var body = $('members-body');

    S.show($('members-actions-th'), !!ctx.isSuper);

    var live = liveMembers();
    var removed = removedMembers();

    // Nothing removed means nothing to switch to. If the last removed member
    // was just restored, fall back to the current list rather than showing an
    // empty view with no way out.
    if (!removed.length) { ctx.dirShowRemoved = false; }

    var toggle = $('members-removed-toggle');
    S.show(toggle, removed.length > 0);
    toggle.setAttribute('aria-pressed', ctx.dirShowRemoved ? 'true' : 'false');
    toggle.textContent = ctx.dirShowRemoved
      ? 'Back to current members (' + S.fmt(live.length) + ')'
      : 'Show removed (' + S.fmt(removed.length) + ')';

    var total = live.length;
    var claimed = live.filter(function (m) { return m.claimed; }).length;
    var flagged = live.filter(function (m) { return m.name_looks_like_pseudonym; }).length;
    var removedNote = removed.length ? ', ' + S.fmt(removed.length) + ' removed' : '';
    $('members-count').textContent = total
      ? S.fmt(total) + (total === 1 ? ' member, ' : ' members, ') +
        (claimed === 1 ? '1 with an account' : S.fmt(claimed) + ' with accounts') +
        (flagged ? ', ' + S.fmt(flagged) + (flagged === 1 ? ' name to check' : ' names to check') : '') +
        removedNote
      : (removed.length ? 'No current members' + removedNote : 'No members yet');

    var pool = ctx.dirShowRemoved ? removed : live;

    if (!pool.length) {
      body.innerHTML = '<tr><td colspan="' + dirColspan() +
        '" style="color: var(--text-tertiary);">' +
        (removed.length
          ? 'Every member on the roster has been removed. "Show removed" lists them, and Restore puts one back.'
          : 'The directory came back empty.') +
        '</td></tr>';
      return;
    }

    var q = String($('members-search').value || '').trim().toLowerCase();
    var rows = !q ? pool : pool.filter(function (m) {
      return String(m.pseudonym || '').toLowerCase().indexOf(q) !== -1 ||
             String(m.real_name || '').toLowerCase().indexOf(q) !== -1 ||
             String(m.first_name || '').toLowerCase().indexOf(q) !== -1 ||
             String(m.last_name || '').toLowerCase().indexOf(q) !== -1;
    });

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="' + dirColspan() +
        '" style="color: var(--text-tertiary);">No ' +
        (ctx.dirShowRemoved ? 'removed member' : 'current member') + ' matches "' +
        S.escapeHtml(q) + '".</td></tr>';
      return;
    }

    body.innerHTML = rows.map(function (m) {
      var gone = isRemoved(m);
      var badges = [];
      // "removed" leads, and it is a word, not a colour: the muted row alone
      // would not survive a screenshot, a colour-blind reader, or a phone in
      // sunlight across the table.
      if (gone) { badges.push('<span class="badge badge--muted">removed</span>'); }
      if (m.is_super) { badges.push('<span class="badge badge--gold">super admin</span>'); }
      else if (m.is_admin) { badges.push('<span class="badge badge--gold">admin</span>'); }
      if (!m.claimed) { badges.push('<span class="badge badge--muted">no account yet</span>'); }
      // Removal sets is_active false itself, so on a removed row "inactive"
      // would only repeat the badge above it.
      if (!m.is_active && !gone) { badges.push('<span class="badge badge--muted">inactive</span>'); }

      var status = badges.join(' ');
      // Reads on from the badge above it: "removed / since 2026-08-30". The
      // word itself is not repeated, because the badge and this line are one
      // sentence to anyone reading the cell, screen reader included.
      if (gone) {
        status += '<div class="mono" style="font-size: 0.75rem; color: var(--cream-mute); margin-top: 4px;">' +
          'since ' + S.escapeHtml(removedOn(m)) +
          (Number(m.nights_recorded) > 0
            ? ' · ' + S.escapeHtml(nightsPhrase(m.nights_recorded)) + ' on record'
            : '') + '</div>';
      }

      var action = '';
      if (ctx.isSuper) {
        var bits = [];
        if (gone) {
          bits.push('<button type="button" class="btn btn--secondary" style="padding: 6px 12px;"' +
            ' data-member-act="restore" data-member="' + S.escapeHtml(m.member_id) +
            '">Restore</button>');
        } else if (m.is_super) {
          // Managed in the SQL editor only; the server refuses anyway.
          bits.push('<span style="color: var(--cream-mute); font-size: 0.85rem;">super admin</span>');
        } else if (m.is_admin) {
          bits.push('<button type="button" class="btn btn--danger" style="padding: 6px 12px;"' +
            ' data-role-act="revoke" data-member="' + S.escapeHtml(m.member_id) +
            '">Remove organiser</button>');
        } else if (m.claimed) {
          bits.push('<button type="button" class="btn btn--secondary" style="padding: 6px 12px;"' +
            ' data-role-act="grant" data-member="' + S.escapeHtml(m.member_id) +
            '">Make organiser</button>');
        }
        // Organisers get no Remove button: delete_member refuses them (P0051)
        // until their organiser access is taken away, and the same rule keeps
        // the button off your own row, since everyone reading this page is an
        // organiser. Unclaimed non-admins still get Remove, unlike the role
        // button: a roster row entered by mistake is exactly what it is for.
        // "Remove member", not "Remove". The column already carries a clay
        // "Remove organiser" on other rows, and of the two this is the bigger
        // step, so it must not be the one with the shorter, vaguer label.
        if (!gone && !m.is_admin && !m.is_super) {
          bits.push('<button type="button" class="btn btn--danger" style="padding: 6px 12px;"' +
            ' data-member-act="remove" data-member="' + S.escapeHtml(m.member_id) +
            '">Remove member</button>');
        }
        action = '<td><div class="row-actions">' + bits.join('') + '</div></td>';
      }

      return '<tr' + (gone ? ' class="row--removed"' : '') + '>' +
        '<td>' + S.escapeHtml(m.pseudonym || '(no pseudonym)') + '</td>' +
        '<td>' + nameCell(m) + '</td>' +
        '<td>' + S.escapeHtml(m.email || '') + '</td>' +
        '<td><span class="mono" style="font-size: 0.85rem;">' +
          S.escapeHtml(m.joined_on || '') + '</span></td>' +
        '<td>' + status + '</td>' +
        action +
      '</tr>';
    }).join('');
  }

  $('members-search').addEventListener('input', renderDirectory);

  $('members-removed-toggle').addEventListener('click', function () {
    ctx.dirShowRemoved = !ctx.dirShowRemoved;
    renderDirectory();
  });

  /* 42501 (not a super admin) and the unclaimed-member refusal both carry a
   * server-written sentence that says exactly what happened; friendlyError's
   * generic 42501 line ("for organisers only") would be wrong here, the
   * caller IS an organiser. So P0-class and 42501 errors speak verbatim. */
  function roleErrorText(err) {
    var code = String((err && err.code) || '');
    if (code === '42501' || /^P0/.test(code)) {
      return String((err && err.message) || 'The server refused.');
    }
    return S.friendlyError(err);
  }

  $('members-body').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-role-act]');
    if (!btn) { return; }
    var id = btn.getAttribute('data-member');
    var m = ctx.directory.filter(function (x) { return x.member_id === id; })[0];
    if (!m) { return; }
    var act = btn.getAttribute('data-role-act');
    var who = m.pseudonym + (m.real_name ? ' (' + m.real_name + ')' : '');
    var text = act === 'grant'
      ? 'Make ' + who + ' an organiser?\n\nThey will run nights, enter results for ' +
        'anyone, and see this directory, real names and emails included.'
      : 'Remove ' + who + ' as organiser?\n\nThey keep their account and their ' +
        'points; they just stop being able to run nights.';
    if (!window.confirm(text)) { return; }
    btn.disabled = true;
    msg($('members-msg'), act === 'grant'
      ? 'Making ' + m.pseudonym + ' an organiser…'
      : 'Removing ' + m.pseudonym + ' as organiser…', 'busy');
    rpc(act === 'grant' ? 'grant_admin' : 'revoke_admin', { p_member_id: id })
      .then(function () {
        // Refresh first: loadDirectory() clears the message line on
        // success, so the confirmation has to land after it.
        return loadDirectory().then(function () {
          msg($('members-msg'), m.pseudonym + (act === 'grant'
            ? ' is now an organiser ✓' : ' is no longer an organiser ✓'), 'ok');
        });
      })
      .catch(function (err) {
        btn.disabled = false;
        msg($('members-msg'), roleErrorText(err), 'error');
      });
  });

  /* ------------------------------------------------------------------
   * Remove and restore a member (super admins only)
   *
   * delete_member() is a soft delete: deleted_at is stamped, is_active goes
   * false, and not one row is erased. The confirmation says so, because an
   * organiser who believes the button destroys results will never press it,
   * and will keep a wrong roster instead.
   *
   * Two consequences are not obvious from the word "remove", so both are
   * spelled out before anything happens:
   *   - the pseudonym is released, and somebody else can take it. That is
   *     the one part restore cannot promise to undo.
   *   - a member with results drops off the leaderboard until restored. The
   *     confirmation quotes the number of nights, from nights_recorded, so
   *     the size of the change is on screen rather than in someone's head.
   * ------------------------------------------------------------------ */

  /* Pseudonym, and the real name after it when there is one worth adding.
   * Rows flagged name_looks_like_pseudonym hold the pseudonym in the name
   * field, from before the name step existed, and those are exactly the rows
   * an organiser removes, so "Remove Nine High (Nine High)?" would be the
   * common case rather than a corner one. Same comparison the database uses
   * for the flag. */
  function whoLabel(m) {
    var real = String(m.real_name || '').trim();
    if (!real || S.normPseudonym(real) === S.normPseudonym(m.pseudonym)) {
      return m.pseudonym;
    }
    return m.pseudonym + ' (' + real + ')';
  }

  function removeConfirmText(m) {
    var nights = Number(m.nights_recorded) || 0;
    var t = 'Remove ' + whoLabel(m) + ' from the club?\n\n' +
      'Nothing is deleted. Their record stays in the database and you can put ' +
      'them back from this same list, under "Show removed".\n\n' +
      'Their pseudonym "' + m.pseudonym + '" is released, so somebody else can ' +
      'claim it. That is the one part you cannot simply undo.';
    if (nights > 0) {
      t += '\n\nThey have ' + nightsPhrase(nights) + ' on record. Those results stay ' +
        'in the database, but they drop off the leaderboard until you restore them.';
    }
    return t;
  }

  function restoreConfirmText(m) {
    var nights = Number(m.nights_recorded) || 0;
    return 'Restore ' + whoLabel(m) + '?\n\n' +
      'They go back on the directory' +
      (nights > 0
        ? ' and back on the leaderboard with ' +
          (nights === 1 ? 'the night' : 'all ' + nightsPhrase(nights)) +
          ' they have on record.'
        : '. They have no nights on record yet.') +
      '\n\nThis fails if somebody else has taken their pseudonym in the meantime.';
  }

  /* P0050, P0051 and P0053 are answered by friendlyError with the server's
   * own sentence. 42501 is the exception that has to stay here: the generic
   * line ("for organisers only") is wrong when the caller IS an organiser,
   * just not a super admin, and delete_member says exactly that itself. */
  function memberErrorText(err) {
    var code = String((err && err.code) || '');
    if (code === '42501') {
      var said = String((err && err.message) || 'The server refused.');
      said = said.charAt(0).toUpperCase() + said.slice(1);
      return /[.!?]$/.test(said) ? said : said + '.';
    }
    return S.friendlyError(err);
  }

  /* P0053 means the pseudonym has a new holder. The server cannot name them
   * without leaking a member id, but this list already has every row, so
   * look the holder up and say who it is. Admin page only, so a real name
   * may render here. */
  function restoreErrorText(err, m) {
    if (String((err && err.code) || '') !== 'P0053') { return memberErrorText(err); }
    var key = S.normPseudonym(m.pseudonym);
    var holder = ctx.directory.filter(function (x) {
      return !isRemoved(x) && x.member_id !== m.member_id &&
        S.normPseudonym(x.pseudonym) === key;
    })[0];
    if (!holder) { return memberErrorText(err); }
    return 'The pseudonym "' + m.pseudonym + '" is taken now: it belongs to ' +
      (holder.real_name ? holder.real_name : 'another member') +
      '. Rename one of them first, then restore.';
  }

  $('members-body').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-member-act]');
    if (!btn) { return; }
    var id = btn.getAttribute('data-member');
    var m = ctx.directory.filter(function (x) { return x.member_id === id; })[0];
    if (!m) { return; }
    var act = btn.getAttribute('data-member-act');
    if (!window.confirm(act === 'remove' ? removeConfirmText(m) : restoreConfirmText(m))) { return; }
    btn.disabled = true;
    msg($('members-msg'), (act === 'remove' ? 'Removing ' : 'Restoring ') +
      m.pseudonym + '…', 'busy');
    // delete_member returns void, so PostgREST answers 204 with no body and
    // rpc() resolves with undefined. That is success, not a failure.
    rpc(act === 'remove' ? 'delete_member' : 'restore_member', { p_member_id: id })
      .then(function () {
        // The ROSTER has to be reloaded too, not just the directory. ctx.members
        // feeds the pickers: the member-list datalist, proxy check-in, proxy
        // report and bulk paste. Without this a removed member stays offerable
        // there until somebody presses Refresh, and check_in() does not filter
        // on is_active, so they can be seated into tonight's night and then
        // never appear on the leaderboard. The restore direction is the one
        // that bites at the door: a member you just put back would stay
        // unfindable in the check-in box.
        //
        // Refresh first: loadDirectory() clears the message line on success,
        // so the confirmation has to land after it.
        return Promise.all([
          loadDirectory(),
          loadMembers().catch(function () { /* keep the last good roster */ })
        ]).then(function () {
          msg($('members-msg'), act === 'remove'
            ? m.pseudonym + ' removed. Nothing was deleted: "Show removed" puts them back ✓'
            : m.pseudonym + ' is back on the directory and the leaderboard ✓', 'ok');
        });
      })
      .catch(function (err) {
        btn.disabled = false;
        msg($('members-msg'), act === 'remove'
          ? memberErrorText(err) : restoreErrorText(err, m), 'error');
      });
  });

  /* ------------------------------------------------------------------
   * Refresh + boot
   * ------------------------------------------------------------------ */

  $('refresh-btn').addEventListener('click', function () {
    msg($('lifecycle-msg'), '', '');
    refreshAll();
    // Separate on purpose: the directory swallows its own failures, and a
    // directory that will not load must never stop the night refreshing.
    loadDirectory();
  });

  $('denied-signout').addEventListener('click', function () {
    S.signOut().then(function () { window.location.replace('login.html'); });
  });

  /* S.isAdmin() answers false on ANY failure, which is right for the pages
   * that only use it to decide whether to show an organiser link. Here it is
   * the gate for the whole console, and "the database is unreachable" must
   * not be rendered as "this account isn't on the organiser list": an
   * organiser told that at 18:00 on a Friday goes hunting for the wrong
   * problem. is_admin() returns a plain boolean and never raises for a
   * non-organiser, so a rejection here really does mean the call failed, and
   * it falls through to boot's catch, which says the console could not load
   * and to refresh. */
  function amIAdmin() {
    return rpc('is_admin').then(function (v) { return v === true; });
  }

  function boot() {
    if (!S.configured()) {
      showState('state-config');
      return;
    }
    S.requireAuth('admin.html').then(function () {
      return amIAdmin();
    }).then(function (admin) {
      if (!admin) {
        showState('state-denied');
        return;
      }
      // isSuperAdmin() never rejects (false on any failure), so a hiccup in
      // the role check can only hide the role buttons, never block the boot.
      return Promise.all([
        loadSeason(),
        loadMembers(),
        isSuperAdmin().then(function (v) { ctx.isSuper = v; })
      ])
        .then(loadNights)
        .then(function () {
          S.show($('refresh-btn'), true);
          showState('console');
          // Fire and forget: loadDirectory() catches everything itself, and
          // the console must stand whole even if the directory never loads.
          loadDirectory();
          // Preselect the most relevant night: open > reconciling > next draft.
          var pick = null;
          ['open', 'reconciling', 'draft'].some(function (st) {
            var found = ctx.nights.filter(function (n) { return n.status === st; });
            if (found.length) {
              // draft: the soonest; open/reconciling: newest first already
              pick = st === 'draft' ? found[found.length - 1] : found[0];
              return true;
            }
            return false;
          });
          if (pick) { selectNight(pick); }
        });
    }).catch(function (err) {
      $('state-denied').querySelector('.card__title').textContent = 'Could not load the console';
      $('state-denied').querySelector('.card__text').textContent =
        S.friendlyError(err) + ' Refresh to try again.';
      showState('state-denied');
    });
  }

  boot();
})();
