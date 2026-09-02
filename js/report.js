/* Store Blindern Poker: report.html behaviour. THE critical screen.
 *
 * A member on a phone, on flaky campus wifi, as the night winds up around
 * 20:30, must be able to:
 *   check in → enter final stack → review → send → receipt.
 * ONE number is asked for. Everything else on the screen is a fact already
 * on record.
 *
 * Resilience contract:
 *   - Every keystroke is saved to a localStorage draft; a force-quit loses
 *     nothing.
 *   - Submitting queues the payload in the localStorage outbox FIRST, then
 *     sends. The (night_id, member_id) pair is the idempotency key and
 *     matches the server's upsert, so retries and duplicates are harmless.
 *   - Transient failures retry forever with backoff+jitter; after 5 attempts
 *     the screen escalates to "Couldn't send, show this to an organiser"
 *     with the payload in 24px type (while still retrying underneath).
 *   - Permanent failures (night settled, signed out) stop retrying and show
 *     the organiser card with an honest reason.
 *
 * Check-in is gated by the night code, VALIDATED SERVER-SIDE by check_in()
 * (the client cannot read nights.code, so it never verifies locally): the
 * QR on the venue TV opens /report?n=CODE pre-filled; others type the 5
 * characters. The code is required at CHECK-IN ONLY, top-up and
 * final-stack reporting hang off the existing entry with no re-entry.
 *
 * Server RPCs used: check_in(p_night_id, p_code), report_entry(p_night_id,
 * p_final_stack, p_rebuy_chips), rebuy_quote(p_night_id, p_current_stack),
 * take_rebuy(p_night_id, p_current_stack, p_amount). Reads: nights (named
 * columns, never *), entries, season_scores, season_enrollments, seasons
 * (all through RLS).
 *
 * THE BANK. Chips only change hands against a SLIP: a full-screen takeover
 * with one giant number, the pseudonym, and a live clock (so a screenshot
 * cannot pass as fresh). Buy-in slip after check-in; top-up slip after
 * take_rebuy. A top-up is therefore always something already on record, so
 * the report NEVER asks about one, it only ever states it. Two ways it gets
 * on record: rebuy_at set means the bank issued it and there is a slip to
 * re-show; rebuy_chips set with rebuy_at null means an organiser handed the
 * chips over without the app and typed it into admin.html. Both are facts
 * this screen reports back unchanged. The client sends entry.rebuy_chips,
 * never a member-typed number and never a bare 0, because a 0 would wipe an
 * organiser's record (report_entry only protects the bank's own number).
 */
(function () {
  'use strict';

  var S = window.SBP;
  var OB = window.SBPOutbox;
  if (!S || !OB) { return; }

  var $ = function (id) { return document.getElementById(id); };

  var states = ['state-config', 'state-loading', 'state-nopseudonym',
                'state-nonight', 'state-checkin', 'state-report',
                'state-receipt', 'state-settled'];

  function showState(name) {
    states.forEach(function (id) { S.show($(id), id === name); });
  }

  /* Page context, filled during boot. */
  var ctx = {
    member: null,   // my members row
    night: null,    // the active (or just-settled) nights row
    entry: null,    // my entries row for that night, if any
    balance: null   // { points, source } before tonight
  };

  /* The QR on the venue TV encodes /report?n=CODE, read it once so the
   * check-in field arrives pre-filled. Players without a camera type the
   * 5 characters instead. Checked-in players never see the field again. */
  var urlCode = S.normCode(new URLSearchParams(window.location.search).get('n') || '');

  /* Non-null rebuy_at means the BANK issued the top-up, so there is a slip
   * to re-show and the server defends the number against this client. */
  function bankMode() {
    return !!(ctx.entry && ctx.entry.rebuy_at);
  }

  /* The top-up on record, whoever put it there. This is the only top-up
   * figure this screen ever reads, shows or sends. */
  function recordedRebuy() {
    return (ctx.entry && ctx.entry.rebuy_chips) || 0;
  }

  /* An organiser typed it into admin.html after handing chips across the
   * table: a real top-up with no slip behind it. Worth stating, and worth
   * never overwriting. */
  function organiserRebuy() {
    return !bankMode() && recordedRebuy() > 0;
  }

  /* ------------------------------------------------------------------
   * Oslo time. The deadline and the slips are read in one room, in one
   * timezone; the phone's own zone is irrelevant.
   * ------------------------------------------------------------------ */
  function osloClock(date, withSeconds) {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit',
        second: withSeconds ? '2-digit' : undefined, hour12: false
      }).format(date);
    } catch (e) {
      // Ancient browser without timeZone support: local time, honestly.
      return date.toTimeString().slice(0, withSeconds ? 8 : 5);
    }
  }

  function osloDateKey(date) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(date);
    } catch (e) {
      return date.toISOString().slice(0, 10);
    }
  }

  /* "today" / "tomorrow" / "on Friday 5 September", relative to now. */
  function osloDayWord(date) {
    var key = osloDateKey(date);
    if (key === osloDateKey(new Date())) { return 'today'; }
    if (key === osloDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000))) { return 'tomorrow'; }
    try {
      return 'on ' + new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Oslo', weekday: 'long', day: 'numeric', month: 'long'
      }).format(date);
    } catch (e) { return 'on ' + key; }
  }

  /* ------------------------------------------------------------------
   * Outbox sender: one rpc call, honest error classification.
   * ------------------------------------------------------------------ */
  function sender(job) {
    var c = S.client();
    if (!c) {
      var e0 = new Error('Not connected'); e0.permanent = true;
      return Promise.reject(e0);
    }
    return S.getSession().then(function (session) {
      if (!session) {
        var e1 = new Error('Signed out, sign in again to send.');
        e1.permanent = true;
        throw e1;
      }
      return c.rpc('report_entry', job.payload).then(function (r) {
        if (r.error) {
          var err = new Error(r.error.message || 'Send failed');
          err.code = r.error.code;
          err.permanent = S.isPermanentError(r.error);
          throw err;
        }
        // Freshest entry row back from the server (composite return).
        var row = Array.isArray(r.data) ? r.data[0] : r.data;
        if (row && ctx.night && row.night_id === ctx.night.id) {
          ctx.entry = row;
        }
      });
    });
  }

  /* ------------------------------------------------------------------
   * Draft persistence, one draft per (night, member).
   * ------------------------------------------------------------------ */
  function draftKey() {
    return 'sbp.draft.' + (ctx.night ? ctx.night.id : 'none') + '.' +
           (ctx.member ? ctx.member.id : 'anon');
  }

  /* A draft is the one number being typed, nothing else. Top-ups live at
   * the bank, so there is never a top-up worth drafting. */
  function saveDraft() {
    try {
      window.localStorage.setItem(draftKey(), JSON.stringify({
        final: $('final-input').value,
        busted: $('bust-btn').classList.contains('btn--bust--on'),
        updated: Date.now()
      }));
    } catch (e) { /* private mode: drafts just don't survive a reload */ }
  }

  /* Normalised on the way out, so a draft written by the old two-field
   * form (which carried a typed `rebuy`) restores its final stack and its
   * stale top-up is dropped on the floor rather than resurrected. */
  function loadDraft() {
    try {
      var raw = window.localStorage.getItem(draftKey());
      var d = raw ? JSON.parse(raw) : null;
      if (!d || typeof d !== 'object') { return null; }
      return {
        final: (d.final === null || d.final === undefined) ? '' : String(d.final),
        busted: !!d.busted
      };
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------
   * Small render helpers
   * ------------------------------------------------------------------ */
  function msg(el, text, kind) {
    if (!el) { return; }
    el.textContent = text || '';
    el.className = 'form-msg' + (kind ? ' form-msg--' + kind : '');
  }

  function nightBanner() {
    var n = ctx.night;
    if (!n) { S.show($('night-banner'), false); return; }
    $('night-title').textContent = n.title || ('Night ' + n.night_no);
    var d = new Date(n.played_on + 'T00:00:00');
    var meta = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    meta += ' · stack ' + S.fmt(n.stack_size) + ' · bonus +' + S.fmt(n.attendance_bonus);
    $('night-meta').textContent = meta;
    var pill = $('night-status');
    pill.textContent = n.status === 'reconciling' ? 'closing' : n.status;
    pill.className = 'status-pill status-pill--' + n.status;
    S.show($('night-banner'), true);
  }

  function ledgerRow(label, amount, opts) {
    opts = opts || {};
    var cls = 'ledger__amount';
    if (opts.plus) { cls += ' ledger__amount--plus'; }
    if (opts.minus) { cls += ' ledger__amount--minus'; }
    return '<div class="ledger__row' + (opts.total ? ' ledger__row--total' : '') + '">' +
      '<span>' + S.escapeHtml(label) + '</span>' +
      '<span class="' + cls + '">' + S.escapeHtml(amount) + '</span></div>';
  }

  function mathLedger(finalStack, rebuy) {
    var n = ctx.night, e = ctx.entry;
    var bonus = n ? n.attendance_bonus : 0;
    var buyin = e ? e.buyin_chips : 0;
    var net = finalStack - (buyin + rebuy) + bonus;
    var html =
      ledgerRow('Attendance bonus', '+' + S.fmt(bonus), { plus: true }) +
      ledgerRow('Buy-in', '−' + S.fmt(buyin), { minus: true }) +
      ledgerRow(bankMode() ? 'Top-up (bank)' : 'Top-up',
                rebuy > 0 ? '−' + S.fmt(rebuy) : '0', { minus: rebuy > 0 }) +
      ledgerRow('Final stack', '+' + S.fmt(finalStack), { plus: finalStack > 0 }) +
      ledgerRow('Net for tonight', S.fmtSigned(net),
                { total: true, plus: net > 0, minus: net < 0 });
    return { html: html, net: net };
  }

  /* ------------------------------------------------------------------
   * Slips. The screen the player shows the organiser at the chip bank.
   * One giant number, the pseudonym, what it is for, and a live clock
   * so the bank can tell tonight's slip from last week's screenshot.
   * ------------------------------------------------------------------ */
  var slipTimer = null;
  var slipReturnFocus = null;

  function slipTick() {
    $('slip-clock').textContent = osloClock(new Date(), true);
  }

  /* opts: { kind: 'buyin' | 'topup', amount, note (string html-safe parts
   * built here), becomes (number|null), reshow (bool), issuedAt (iso|null) } */
  function openSlip(opts) {
    if (!ctx.member || !ctx.night) { return; }
    var root = $('slip');

    var kicker = opts.kind === 'buyin' ? 'Buy-in' : 'Top-up';
    if (opts.reshow) { kicker += ' · re-show'; }
    $('slip-kicker').textContent = kicker;

    $('slip-give').textContent = 'GIVE ' + ctx.member.pseudonym;
    $('slip-amount').textContent = S.fmt(opts.amount);
    $('slip-night').textContent = ctx.night.title || ('Night ' + ctx.night.night_no);

    var note = $('slip-note');
    if (opts.becomes !== null && opts.becomes !== undefined) {
      note.innerHTML = 'Stack becomes <span class="mono">' +
        S.escapeHtml(S.fmt(opts.becomes)) + '</span>';
      S.show(note, true);
    } else if (opts.note) {
      note.innerHTML = opts.note;
      S.show(note, true);
    } else {
      S.show(note, false);
    }

    var stamp = $('slip-stamp');
    root.classList.toggle('slip--reshow', !!opts.reshow);
    if (opts.reshow && opts.issuedAt) {
      // "Recorded", not "honoured": the row exists, but only the bank
      // knows whether chips already crossed the table for it.
      var t = new Date(opts.issuedAt);
      stamp.textContent = 'Re-show · recorded at ' +
        (isNaN(t) ? String(opts.issuedAt) : osloClock(t, false));
      S.show(stamp, true);
    } else {
      S.show(stamp, false);
    }

    slipTick();
    if (slipTimer) { clearInterval(slipTimer); }
    slipTimer = setInterval(slipTick, 1000);

    slipReturnFocus = document.activeElement;
    S.show(root, true);
    document.body.classList.add('no-scroll');
    $('slip-close').focus();
  }

  function closeSlip() {
    if (slipTimer) { clearInterval(slipTimer); slipTimer = null; }
    S.show($('slip'), false);
    document.body.classList.remove('no-scroll');
    if (slipReturnFocus && slipReturnFocus.focus &&
        document.contains(slipReturnFocus)) {
      slipReturnFocus.focus();
    }
    slipReturnFocus = null;
  }

  $('slip-close').addEventListener('click', closeSlip);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('slip').hidden) { closeSlip(); }
  });

  function openBuyinSlip() {
    if (!ctx.entry) { return; }
    var buyin = ctx.entry.buyin_chips || 0;
    var stack = ctx.night ? ctx.night.stack_size : null;
    openSlip({
      kind: 'buyin',
      amount: buyin,
      // On a short-stack booking the number is deliberately NOT the full
      // stack: say so, so the bank counts the slip and not the habit.
      note: (stack !== null && buyin !== stack)
        ? 'Points-limited buy-in. Tonight\'s full stack is <span class="mono">' +
          S.escapeHtml(S.fmt(stack)) + '</span>.'
        : null,
      becomes: null,
      reshow: false
    });
  }

  function openTopupSlip(reshow) {
    var e = ctx.entry;
    if (!e || !e.rebuy_at) { return; }
    var becomes = (e.rebuy_stack_before !== null && e.rebuy_stack_before !== undefined)
      ? e.rebuy_stack_before + (e.rebuy_chips || 0)
      : null;
    openSlip({
      kind: 'topup',
      amount: e.rebuy_chips || 0,
      becomes: becomes,
      reshow: !!reshow,
      issuedAt: e.rebuy_at
    });
  }

  $('buyin-slip-btn').addEventListener('click', openBuyinSlip);
  $('topup-reshow-btn').addEventListener('click', function () { openTopupSlip(true); });

  /* ------------------------------------------------------------------
   * Sync pill + organiser card, driven by the outbox
   * ------------------------------------------------------------------ */
  function myJob() {
    if (!ctx.night || !ctx.member) { return null; }
    return OB.get(ctx.night.id, ctx.member.id);
  }

  function renderSync() {
    var job = myJob();
    var pill = $('sync-pill');
    var text = $('sync-pill-text');
    if (!job) {
      if (ctx.entry && ctx.entry.reported) {
        pill.className = 'sync-pill sync-pill--sent';
        text.textContent = 'Recorded';
        S.show(pill, true);
      } else {
        S.show(pill, false);
      }
      return;
    }
    var map = {
      queued: ['sync-pill--queued', navigator.onLine === false
        ? 'Saved on this phone, offline'
        : 'Saved on this phone, sending soon'],
      sending: ['sync-pill--sending', 'Sending…'],
      sent: ['sync-pill--sent', 'Sent ✓'],
      failed: ['sync-pill--failed', 'Not sent']
    };
    var m = map[job.status] || map.queued;
    pill.className = 'sync-pill ' + m[0];
    text.textContent = m[1];
    S.show(pill, true);

    // Receipt state follows the job whenever it is on screen.
    if (!$('state-receipt').hidden) { renderReceipt(); }
  }

  OB.onChange(function () { renderSync(); });

  /* ------------------------------------------------------------------
   * States
   * ------------------------------------------------------------------ */

  function enterCheckin() {
    var n = ctx.night;
    $('checkin-bonus').textContent = '+' + S.fmt(n.attendance_bonus);
    $('checkin-stack').textContent = S.fmt(n.stack_size) + ' chips';
    $('checkin-points').textContent = ctx.balance ? S.fmt(ctx.balance.points) : '…';
    // Arrived via the TV's QR? The code is pre-filled; a typo-free tap away.
    // (Only the server can verify it, the client cannot read nights.code.)
    if (urlCode && !$('code-input').value) {
      $('code-input').value = urlCode;
      msg($('checkin-msg'), 'Code filled in from the QR. Just tap Check in.', 'ok');
    }
    showState('state-checkin');
  }

  /* Keep the typed code readable: uppercase as they type. */
  $('code-input').addEventListener('input', function () {
    var el = $('code-input');
    var up = el.value.toUpperCase();
    if (el.value !== up) { el.value = up; }
    msg($('checkin-msg'), '', '');
  });

  $('checkin-btn').addEventListener('click', function () {
    // The night code gates CHECK-IN ONLY: it proves you are in the room and
    // reading the screen. The MATCH is checked by the server (check_in
    // raises P0010/P0011), the client cannot read nights.code, so the only
    // local check is "did you type anything at all".
    var typed = S.normCode($('code-input').value);
    if (!typed) {
      msg($('checkin-msg'), 'Type tonight\'s 5-character code: it\'s on the screen at the front, next to the QR.', 'error');
      $('code-input').focus();
      return;
    }
    var btn = $('checkin-btn');
    btn.disabled = true;
    msg($('checkin-msg'), 'Checking in…', 'busy');
    S.client().rpc('check_in', { p_night_id: ctx.night.id, p_code: typed })
      .then(function (r) {
        if (r.error) { throw r.error; }
        ctx.entry = Array.isArray(r.data) ? r.data[0] : r.data;
        msg($('checkin-msg'), '', '');
        enterReport();
        // The first thing the player does after checking in is collect
        // chips, so the buy-in slip opens itself. Re-openable from the
        // "Show my buy-in slip" button any time while checked in.
        openBuyinSlip();
      })
      .catch(function (err) {
        msg($('checkin-msg'), S.friendlyError(err), 'error');
        if (err && err.code === 'P0011') {
          $('code-input').focus();
          $('code-input').select();
        }
      })
      .finally(function () { btn.disabled = false; });
  });

  function enterReport() {
    var n = ctx.night, e = ctx.entry;
    $('report-bonus').textContent = '+' + S.fmt(n.attendance_bonus);
    $('report-buyin').textContent = S.fmt(e.buyin_chips) + ' chips';
    $('report-cap').textContent = bankMode()
      ? 'taken at the bank'
      : organiserRebuy()
        ? 'taken, recorded by an organiser'
        : S.fmt(e.rebuy_cap_chips) + ' chips';

    // Prefill the one input: server row wins if already reported, else the
    // local draft. A top-up, if any, is stated by the bank card above and
    // is never something this form fills in.
    var draft = loadDraft();
    if (e.reported) {
      $('final-input').value = e.final_stack === null ? '' : String(e.final_stack);
    } else if (draft) {
      $('final-input').value = draft.final;
      $('bust-btn').classList.toggle('btn--bust--on', draft.busted);
    }

    renderTopup();
    renderDeadline();
    S.show($('review-panel'), false);
    showState('state-report');
  }

  /* ------------------------------------------------------------------
   * Deadline line: nights.reports_close_at, shown in Oslo time. The
   * server enforces it (P0021); this line just keeps nobody surprised.
   * ------------------------------------------------------------------ */
  function renderDeadline() {
    var el = $('deadline-line');
    var n = ctx.night;
    if (!n || !n.reports_close_at) { S.show(el, false); return; }
    var t = new Date(n.reports_close_at);
    if (isNaN(t)) { S.show(el, false); return; }
    var when = '<span class="mono">' + S.escapeHtml(osloClock(t, false)) + '</span> ' +
      S.escapeHtml(osloDayWord(t));
    if (Date.now() >= t.getTime()) {
      el.innerHTML = 'Reporting closed at ' + when +
        ' (Oslo time). Show your numbers to an organiser instead.';
      el.className = 'report-deadline report-deadline--closed';
    } else {
      el.innerHTML = 'You can report until ' + when + ' (Oslo time).';
      el.className = 'report-deadline';
    }
    S.show(el, true);
  }

  $('bust-btn').addEventListener('click', function () {
    $('final-input').value = '0';
    $('bust-btn').classList.add('btn--bust--on');
    msg($('final-msg'), 'Busted stack recorded as 0.', 'ok');
    saveDraft();
  });

  $('final-input').addEventListener('input', function () {
    var v = S.parseChips($('final-input').value);
    $('bust-btn').classList.toggle('btn--bust--on', v === 0);
    msg($('final-msg'), '', '');
    saveDraft();
  });

  /* ------------------------------------------------------------------
   * Top-up at the bank. count your chips → rebuy_quote → pick an amount
   * → take_rebuy → slip. Every branch ends in a message or a slip;
   * nothing is ever left spinning.
   * ------------------------------------------------------------------ */
  var topupQuote = null;   // last rebuy_quote result, while step 2 is up

  function topupFace(name) {
    ['topup-open', 'topup-flow', 'topup-done', 'topup-organiser']
      .forEach(function (id) { S.show($(id), id === name); });
    S.show($('topup-card'), !!name);
  }

  function renderTopup() {
    var e = ctx.entry;
    if (!e) { topupFace(null); return; }
    if (e.rebuy_at) {
      // The bank issued it: a quiet record, and the slip on demand.
      $('topup-done-amount').textContent = S.fmt(recordedRebuy());
      var t = new Date(e.rebuy_at);
      $('topup-done-time').textContent = isNaN(t) ? '…' : osloClock(t, false);
      topupFace('topup-done');
    } else if (organiserRebuy()) {
      // Recorded by hand. No slip to show, and no second helping: offering
      // the bank here would let take_rebuy overwrite the organiser's number.
      $('topup-organiser-amount').textContent = S.fmt(recordedRebuy());
      topupFace('topup-organiser');
    } else if (ctx.night && ctx.night.status === 'open') {
      topupFace('topup-open');
    } else {
      // Night reconciling or beyond: the bank has packed up.
      topupFace(null);
    }
  }

  function topupReset() {
    topupQuote = null;
    S.show($('topup-step-count'), true);
    S.show($('topup-step-quote'), false);
    msg($('topup-msg'), '', '');
  }

  /* The bank flow said "already topped up" (this phone raced another tap,
   * or an organiser entered it). The recorded row is the truth: fetch it,
   * re-render, and reopen its slip marked as a re-show. */
  function topupAlreadyDone() {
    return S.myEntry(ctx.night.id, ctx.member.id).then(function (row) {
      if (row) { ctx.entry = row; }
      enterReport();
      if (bankMode()) { openTopupSlip(true); }
    }).catch(function () {
      msg($('topup-msg'),
          'A top-up is already recorded for you tonight. Reload to see it, or ask an organiser.',
          'error');
    });
  }

  function topupError(err) {
    var code = err && err.code;
    if (code === 'P0023') { return topupAlreadyDone(); }
    var text;
    if (code === 'P0022') {
      text = 'You are not checked in to tonight\'s round. Check in first.';
    } else if (code === 'P0001') {
      // The flow stays on screen ON PURPOSE: #topup-msg lives inside
      // #topup-flow, and renderTopup() here would hide the flow and the
      // explanation with it. The offer disappears on the next reload.
      text = 'The night is no longer open, so the bank is closed. An organiser can still help.';
    } else if (code === 'P0024') {
      text = 'No top-up is available: nothing fits between your stack and tonight\'s ceiling.';
    } else if (code === 'P0025') {
      text = S.friendlyError(err) + ' Go back and check the chip count.';
    } else {
      text = S.friendlyError(err);
    }
    msg($('topup-msg'), text, 'error');
    return Promise.resolve();
  }

  $('topup-start-btn').addEventListener('click', function () {
    S.show($('topup-open'), false);
    S.show($('topup-flow'), true);
    topupReset();
    $('topup-stack-input').focus();
  });

  $('topup-cancel-btn').addEventListener('click', function () {
    S.show($('topup-flow'), false);
    topupReset();
    renderTopup();
  });

  $('topup-stack-input').addEventListener('input', function () {
    msg($('topup-msg'), '', '');
  });

  $('topup-quote-btn').addEventListener('click', function () {
    var stack = S.parseChips($('topup-stack-input').value);
    if (stack === null) {
      msg($('topup-msg'), 'Count the chips in front of you and type the total. 0 counts.', 'error');
      $('topup-stack-input').focus();
      return;
    }
    var btn = $('topup-quote-btn');
    btn.setAttribute('aria-busy', 'true');
    msg($('topup-msg'), '', '');
    S.client().rpc('rebuy_quote', { p_night_id: ctx.night.id, p_current_stack: stack })
      .then(function (r) {
        if (r.error) { throw r.error; }
        var q = r.data;
        if (!q || !q.eligible) {
          var reason = q && q.reason;
          if (reason === 'holding_full_stack') {
            msg($('topup-msg'),
                'You are holding tonight\'s full stack (' + S.fmt(q.stack_size) +
                '), so there is nothing to top up.', 'error');
          } else if (reason === 'no_points_left') {
            msg($('topup-msg'),
                'Your season points are spent, so there is no top-up left tonight. You still play what you hold.',
                'error');
          } else {
            msg($('topup-msg'), 'No top-up is available right now.', 'error');
          }
          return;
        }
        topupQuote = q;
        $('topup-max-line').innerHTML = 'You can take up to <span class="mono">' +
          S.escapeHtml(S.fmt(q.max_topup)) + '</span>.';
        $('topup-amount-input').value = String(q.max_topup);
        topupBecomes();
        S.show($('topup-step-count'), false);
        S.show($('topup-step-quote'), true);
      })
      .catch(topupError)
      .finally(function () { btn.removeAttribute('aria-busy'); });
  });

  function topupBecomes() {
    var el = $('topup-becomes');
    if (!topupQuote) { el.textContent = ''; return; }
    var amount = S.parseChips($('topup-amount-input').value);
    if (amount === null || amount <= 0) {
      el.textContent = 'Type how many chips to take.';
      return;
    }
    if (amount > topupQuote.max_topup) {
      el.textContent = 'That is over the ceiling: the most you can take is ' +
        S.fmt(topupQuote.max_topup) + '.';
      return;
    }
    el.innerHTML = 'Your stack becomes <span class="mono">' +
      S.escapeHtml(S.fmt(topupQuote.current_stack + amount)) + '</span>.';
  }

  $('topup-amount-input').addEventListener('input', function () {
    msg($('topup-msg'), '', '');
    topupBecomes();
  });

  $('topup-back-btn').addEventListener('click', function () {
    topupReset();
    $('topup-stack-input').focus();
  });

  $('topup-confirm-btn').addEventListener('click', function () {
    if (!topupQuote) { return; }
    var amount = S.parseChips($('topup-amount-input').value);
    if (amount === null || amount <= 0) {
      msg($('topup-msg'), 'Type how many chips to take, 1 or more.', 'error');
      $('topup-amount-input').focus();
      return;
    }
    if (amount > topupQuote.max_topup) {
      msg($('topup-msg'), 'The most you can take is ' + S.fmt(topupQuote.max_topup) +
          '. Lower the amount.', 'error');
      $('topup-amount-input').focus();
      return;
    }
    var btn = $('topup-confirm-btn');
    btn.setAttribute('aria-busy', 'true');
    msg($('topup-msg'), '', '');
    // take_rebuy is row-locked server-side: a double tap cannot issue two.
    S.client().rpc('take_rebuy', {
      p_night_id: ctx.night.id,
      p_current_stack: topupQuote.current_stack,
      p_amount: amount
    })
      .then(function (r) {
        if (r.error) { throw r.error; }
        ctx.entry = Array.isArray(r.data) ? r.data[0] : r.data;
        topupReset();
        S.show($('topup-flow'), false);
        enterReport();      // re-reads the draft, restates the bank fact
        openTopupSlip(false);
      })
      .catch(topupError)
      .finally(function () { btn.removeAttribute('aria-busy'); });
  });

  /* ---------------- review ---------------- */

  var reviewed = null; // { final, rebuy } as validated for sending

  $('report-form').addEventListener('submit', function (e) {
    e.preventDefault();

    var finalStack = S.parseChips($('final-input').value);
    if (finalStack === null) {
      msg($('final-msg'), 'Type your final stack, or tap “I busted” if it is 0.', 'error');
      $('final-input').focus();
      return;
    }

    // The top-up on record, sent back unchanged. No member ever types this
    // number, so it cannot disagree with the slip. Sending a bare 0 instead
    // would be silent destruction: report_entry keeps the bank's number
    // (rebuy_at set) but happily overwrites an organiser's (rebuy_at null).
    var rebuy = recordedRebuy();

    reviewed = { final: finalStack, rebuy: rebuy };
    var m = mathLedger(finalStack, rebuy);
    $('review-ledger').innerHTML = m.html;

    var note = $('review-balance-note');
    if (ctx.balance) {
      var after = Math.max(0, ctx.balance.points + m.net);
      note.textContent = 'Season points after tonight: about ' + S.fmt(after) +
        (ctx.balance.points + m.net < 0 ? ' (points never drop below zero)' : '') +
        '. Final numbers land when the organisers settle the night.';
      S.show(note, true);
    } else {
      S.show(note, false);
    }

    S.show($('review-panel'), true);
    $('review-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('edit-btn').addEventListener('click', function () {
    S.show($('review-panel'), false);
    $('final-input').focus();
  });

  $('submit-btn').addEventListener('click', function () {
    if (!reviewed) { return; }
    // reviewed.rebuy is the bank's own recorded amount, or 0. Never typed,
    // and report_entry ignores the parameter anyway when rebuy_at is set.
    OB.enqueue(ctx.night.id, ctx.member.id, {
      p_night_id: ctx.night.id,
      p_final_stack: reviewed.final,
      p_rebuy_chips: reviewed.rebuy
    });
    renderReceipt();
    showState('state-receipt');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ---------------- receipt + organiser card ---------------- */

  /* The final stack is this phone's number, so a queued job (not yet sent)
   * is the freshest version of it. The top-up never is: it belongs to the
   * server, and a job can be older than the record, which is how a phone
   * that reported before its owner reached the bank ends up printing a
   * confident "Top-up (bank) 0" on a receipt. The record always wins. */
  function reportedNumbers() {
    var job = myJob();
    if (job) {
      return { final: job.payload.p_final_stack, rebuy: recordedRebuy() };
    }
    if (ctx.entry && ctx.entry.reported) {
      return { final: ctx.entry.final_stack || 0, rebuy: recordedRebuy() };
    }
    return null;
  }

  function renderReceipt() {
    var job = myJob();
    var nums = reportedNumbers();
    if (!nums) { return; }

    var icon = $('receipt-icon');
    var title = $('receipt-title');
    var sub = $('receipt-sub');

    if (!job || job.status === 'sent') {
      icon.textContent = '✓';
      icon.className = 'receipt__icon';
      title.textContent = 'Report received';
      sub.textContent = 'Your numbers are in. The leaderboard updates once the organisers settle the night.';
    } else if (job.status === 'failed') {
      icon.textContent = '!';
      icon.className = 'receipt__icon receipt__icon--saved';
      title.textContent = 'Report not sent';
      sub.textContent = 'Your numbers are safe on this phone, but the server said no.';
    } else {
      icon.textContent = '⏳';
      icon.className = 'receipt__icon receipt__icon--saved';
      title.textContent = 'Saved on this phone';
      sub.textContent = navigator.onLine === false
        ? 'You look offline. It will send by itself the moment you have signal. Keep this tab around.'
        : 'Sending… it keeps retrying by itself. You can put your phone away.';
    }

    $('receipt-ledger').innerHTML = mathLedger(nums.final, nums.rebuy).html;

    // Escalate to the organiser card on permanent failure, or after enough
    // quiet retries that "it'll go through" stops being honest.
    var stuck = job && (job.status === 'failed' ||
      (job.attempts >= OB.STUCK_AFTER_ATTEMPTS && job.status !== 'sent'));
    if (stuck) {
      $('organiser-payload').innerHTML =
        '<div><span class="organiser-payload__label">Pseudonym</span>' +
          S.escapeHtml(ctx.member.pseudonym) + '</div>' +
        '<div><span class="organiser-payload__label">Night</span>' +
          S.escapeHtml((ctx.night.title || 'Night ' + ctx.night.night_no) +
            ' · ' + ctx.night.played_on) + '</div>' +
        '<div><span class="organiser-payload__label">Top-up (chips)</span>' +
          S.fmt(nums.rebuy) + '</div>' +
        '<div><span class="organiser-payload__label">Final stack (chips)</span>' +
          S.fmt(nums.final) + '</div>';
      $('organiser-why').textContent = job.status === 'failed'
        ? S.friendlyError({ message: job.last_error })
        : 'Still retrying in the background (' + job.attempts +
          ' attempts so far). The organiser can enter it from this screen in seconds.';
      S.show($('organiser-card'), true);
    } else {
      S.show($('organiser-card'), false);
    }
    // No renderSync() here. renderSync() calls this function back when the
    // receipt is on screen, so calling it from the tail was mutual recursion:
    // opening the report page with any pending outbox job blew the stack and
    // showed "Could not load tonight" instead of the receipt. renderSync()
    // always runs after this returns anyway.
  }

  $('retry-btn').addEventListener('click', function () {
    OB.retryNow(ctx.night.id, ctx.member.id);
    renderReceipt();
  });

  $('change-btn').addEventListener('click', function () {
    if (ctx.night.status === 'open' || ctx.night.status === 'reconciling') {
      // Preload the last number so editing starts from what was sent.
      var nums = reportedNumbers();
      if (nums) { $('final-input').value = String(nums.final); }
      enterReport();
    } else {
      $('receipt-sub').textContent =
        'Tonight has been settled. Ask an organiser to correct your entry.';
    }
  });

  /* ---------------- settled ---------------- */

  function enterSettled() {
    var e = ctx.entry;
    if (e && e.net_points !== null && e.net_points !== undefined) {
      $('settled-ledger').innerHTML =
        ledgerRow('Your net for the night', S.fmtSigned(e.net_points),
                  { total: true, plus: e.net_points > 0, minus: e.net_points < 0 }) +
        (e.balance_after !== null && e.balance_after !== undefined
          ? ledgerRow('Season points now', S.fmt(e.balance_after), {})
          : '');
      S.show($('settled-ledger'), true);
    } else {
      S.show($('settled-ledger'), false);
    }
    showState('state-settled');
  }

  /* ------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------ */

  function boot() {
    if (!S.configured()) {
      showState('state-config');
      return;
    }

    OB.start(sender);

    S.requireAuth('report.html').then(function () {
      return S.getMyMember();
    }).then(function (member) {
      if (!member || !member.pseudonym) {
        showState('state-nopseudonym');
        return null;
      }
      ctx.member = member;
      $('whoami-name').textContent = member.pseudonym;
      S.show($('whoami-line'), true);
      return S.activeNight();
    }).then(function (night) {
      if (!ctx.member) { return; }

      if (!night) {
        // No open night. If my latest entry belongs to a freshly settled
        // night, show the settled receipt instead of a shrug.
        return latestSettled().then(function (found) {
          if (found) {
            ctx.night = found.night;
            ctx.entry = found.entry;
            nightBanner();
            enterSettled();
          } else {
            showState('state-nonight');
          }
        });
      }

      ctx.night = night;
      nightBanner();

      return Promise.all([
        S.myEntry(night.id, ctx.member.id),
        S.myBalance(night.season_id, ctx.member.id)
      ]).then(function (res) {
        ctx.entry = res[0];
        ctx.balance = res[1];

        var job = myJob();
        if (job && job.status !== 'sent') {
          // A submission is still in flight (or stuck) from a previous
          // visit, land on the receipt, not on a blank form.
          renderReceipt();
          showState('state-receipt');
        } else if (!ctx.entry) {
          enterCheckin();
        } else if (ctx.entry.reported) {
          renderReceipt();
          showState('state-receipt');
        } else {
          enterReport();
        }
        renderSync();
      });
    }).catch(function (err) {
      // Network died mid-boot. If we at least know who they are, keep the
      // page honest; otherwise show the no-night card with a hint.
      var card = $('state-nonight');
      card.querySelector('.card__title').textContent = 'Could not load tonight';
      card.querySelector('.card__text').textContent =
        S.friendlyError(err) + ' Pull to refresh, or use the paper sheet. Nothing is lost.';
      showState('state-nonight');
    });
  }

  /* My most recent entry on a night settled in the last ~2 days.
   * member_id is filtered explicitly: RLS narrows plain members to their own
   * rows, but an ADMIN opening this page would otherwise get someone else's
   * latest entry. */
  function latestSettled() {
    var c = S.client();
    return c.from('entries').select('*')
      .eq('member_id', ctx.member.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .then(function (r) {
        if (r.error || !r.data || !r.data.length) { return null; }
        var entry = r.data[0];
        // Named columns: select('*') on nights fails under the column-level
        // grant that hides nights.code from members.
        return c.from('nights').select(S.NIGHT_COLS).eq('id', entry.night_id)
          .limit(1).maybeSingle()
          .then(function (rn) {
            if (rn.error || !rn.data) { return null; }
            var night = rn.data;
            if (night.status !== 'settled') { return null; }
            var age = Date.now() - new Date(night.played_on + 'T00:00:00').getTime();
            if (age > 2 * 24 * 60 * 60 * 1000) { return null; }
            return { night: night, entry: entry };
          });
      })
      .catch(function () { return null; });
  }

  boot();
})();
