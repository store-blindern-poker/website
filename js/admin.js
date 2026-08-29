/* Store Blindern Poker: admin.html behaviour (organiser console).
 *
 * Gate: signed in AND is_admin() RPC true. Everything else is read/refused
 * server-side anyway (SECURITY DEFINER RPCs self-check), the client gate
 * only decides what to render.
 *
 * RPCs used here: create_night, open_night, close_reporting, settle_night,
 * check_in(p_night_id, p_member_id), admin proxy path, no p_code needed,
 * report_entry(p_night_id, p_final_stack, p_rebuy_chips, p_member_id,
 * p_note), add_adjustment(p_night_id, p_member_id, p_delta_points, p_kind,
 * p_reason), get_night_code(p_night_id) for the TV takeover.
 * Reads: v_seasons, nights (named columns, never *), entries, adjustments,
 * members (admin RLS).
 *
 * The screen that matters at 22:30 is WHO HAS NOT REPORTED, it is the
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
    members: [],      // [{id, pseudonym, key}]
    membersByKey: {}, // normalised pseudonym -> member
    membersById: {},  // id -> member
    bulkPlan: null,   // validated bulk-paste lines awaiting apply
    pollTimer: null
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
      ctx.night ? loadEntries() : Promise.resolve(),
      ctx.night ? loadAdjustments() : Promise.resolve()
    ]).then(function () { if (ctx.night) { renderDetail(); } });
  }

  /* ------------------------------------------------------------------
   * Nights list
   * ------------------------------------------------------------------ */

  function renderNights() {
    var box = $('nights-list');
    if (!ctx.nights.length) {
      box.innerHTML = '<div class="card"><p class="card__text">No nights yet: ' +
        'create the first one above.</p></div>';
      return;
    }
    box.innerHTML = ctx.nights.map(function (n) {
      var sel = ctx.night && ctx.night.id === n.id;
      return '<button type="button" class="night-row' + (sel ? ' night-row--selected' : '') +
        '" data-night="' + n.id + '">' +
        '<span><span class="night-row__title">' +
          S.escapeHtml(n.title || 'Night ' + n.night_no) + '</span><br>' +
          '<span class="night-row__meta">' + S.escapeHtml(n.played_on) +
          ' · stack ' + S.fmt(n.stack_size) + ' · bonus +' + S.fmt(n.attendance_bonus) +
          (n.counts_as_round ? '' : ' · does not count as a round') + '</span></span>' +
        '<span class="status-pill status-pill--' + n.status + '">' + n.status + '</span>' +
        '</button>';
    }).join('');
  }

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
    ctx.bulkPlan = null;
    S.show($('bulk-preview-wrap'), false);
    S.show($('bulk-apply-btn'), false);
    msg($('bulk-msg'), '', '');
    msg($('lifecycle-msg'), '', '');
    msg($('adjust-msg'), '', '');
    S.show($('settle-confirm'), false);
    renderNights();
    S.show($('night-detail'), true);
    renderDetail();
    loadEntries();
    loadAdjustments();
    armPolling();
    $('night-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* Live-ish while a night is running: refresh entries every 45 s. */
  function armPolling() {
    if (ctx.pollTimer) { clearInterval(ctx.pollTimer); ctx.pollTimer = null; }
    if (ctx.night && (ctx.night.status === 'open' || ctx.night.status === 'reconciling')) {
      ctx.pollTimer = setInterval(function () {
        if (!document.hidden) { loadEntries(); }
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
      (n.counts_as_round ? '' : ' · does not count as a round');
    var pill = $('detail-status');
    pill.textContent = n.status;
    pill.className = 'status-pill status-pill--' + n.status;

    // Lifecycle buttons by status. Draft → open. Open → close/settle.
    // Reconciling → settle (or reopen). Settled → reopen for corrections.
    S.show($('btn-open'), n.status === 'draft');
    S.show($('btn-close'), n.status === 'open');
    S.show($('btn-settle'), n.status === 'open' || n.status === 'reconciling');
    S.show($('btn-reopen'), n.status === 'reconciling' || n.status === 'settled');
    $('btn-reopen').textContent = n.status === 'settled'
      ? 'Reopen for corrections' : 'Reopen check-in';
    // The TV takeover: available for any live-ish night (showing it for a
    // draft lets organisers put it on the screen before doors open).
    S.show($('btn-code'), n.status !== 'void');

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
        return '<tr>' +
          '<td>' + S.escapeHtml(pseudonymOf(e.member_id)) + '</td>' +
          '<td class="num">' + S.fmt(e.buyin_chips) + '</td>' +
          '<td class="num">' + S.fmt(e.rebuy_chips) + '</td>' +
          '<td class="num">' + (e.reported ? S.fmt(e.final_stack || 0) : '…') + '</td>' +
          '<td>' + status + '</td>' +
        '</tr>';
      }).join('');
    }
  }

  function stat(value, label, tone) {
    return '<div class="mini-stat' + (tone ? ' mini-stat--' + tone : '') + '">' +
      '<div class="mini-stat__value">' + S.fmt(value) + '</div>' +
      '<div class="mini-stat__label">' + S.escapeHtml(label) + '</div></div>';
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
    rpc('create_night', {
      p_season_id: ctx.season.season_id,
      p_played_on: date,
      p_title: $('create-title').value.trim() || null,
      p_kind: kind,
      p_stack_size: stack === null ? null : stack,
      p_attendance_bonus: bonus === null ? null : bonus,
      p_counts_as_round: kind === 'tournament',
      p_affects_points: $('create-affects').checked
    }).then(function (night) {
      msg($('create-msg'), 'Created as draft ✓. Open it when doors open.', 'ok');
      $('create-title').value = '';
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
   * Refresh + boot
   * ------------------------------------------------------------------ */

  $('refresh-btn').addEventListener('click', function () {
    msg($('lifecycle-msg'), '', '');
    refreshAll();
  });

  $('denied-signout').addEventListener('click', function () {
    S.signOut().then(function () { window.location.replace('login.html'); });
  });

  function boot() {
    if (!S.configured()) {
      showState('state-config');
      return;
    }
    S.requireAuth('admin.html').then(function () {
      return S.isAdmin();
    }).then(function (admin) {
      if (!admin) {
        showState('state-denied');
        return;
      }
      return Promise.all([loadSeason(), loadMembers()])
        .then(loadNights)
        .then(function () {
          S.show($('refresh-btn'), true);
          showState('console');
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
