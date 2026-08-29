/* Store Blindern Poker: report.html behaviour. THE critical screen.
 *
 * A member on a phone, on flaky campus wifi, at 22:30, must be able to:
 *   check in → enter top-up → enter final stack → review → send → receipt.
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
 * p_final_stack, p_rebuy_chips). Reads: nights (named columns, never *),
 * entries, season_scores, season_enrollments, seasons (all through RLS).
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

  function saveDraft() {
    try {
      window.localStorage.setItem(draftKey(), JSON.stringify({
        rebuy: $('rebuy-input').value,
        final: $('final-input').value,
        busted: $('bust-btn').classList.contains('quickpick--active'),
        updated: Date.now()
      }));
    } catch (e) { /* private mode: drafts just don't survive a reload */ }
  }

  function loadDraft() {
    try {
      var raw = window.localStorage.getItem(draftKey());
      return raw ? JSON.parse(raw) : null;
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
      ledgerRow('Top-up', rebuy > 0 ? '−' + S.fmt(rebuy) : '0', { minus: rebuy > 0 }) +
      ledgerRow('Final stack', '+' + S.fmt(finalStack), { plus: finalStack > 0 }) +
      ledgerRow('Net for tonight', S.fmtSigned(net),
                { total: true, plus: net > 0, minus: net < 0 });
    return { html: html, net: net };
  }

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
    $('report-cap').textContent = S.fmt(e.rebuy_cap_chips) + ' chips';
    $('rebuy-max').textContent = 'Full top-up (' + S.fmt(e.rebuy_cap_chips) + ')';

    // Prefill: server row wins if already reported; else the local draft.
    var draft = loadDraft();
    if (e.reported) {
      $('rebuy-input').value = String(e.rebuy_chips || 0);
      $('final-input').value = e.final_stack === null ? '' : String(e.final_stack);
    } else if (draft) {
      $('rebuy-input').value = draft.rebuy || '0';
      $('final-input').value = draft.final || '';
      $('bust-btn').classList.toggle('quickpick--active', !!draft.busted);
    }

    // Cap of zero → the only honest answer is "None".
    disableQuickpicksAboveCap();
    syncQuickpickHighlight();
    S.show($('review-panel'), false);
    showState('state-report');
  }

  function disableQuickpicksAboveCap() {
    var cap = ctx.entry ? ctx.entry.rebuy_cap_chips : 0;
    Array.prototype.forEach.call(
      document.querySelectorAll('#rebuy-quickpicks .quickpick'),
      function (btn) {
        var v = btn.getAttribute('data-rebuy');
        if (v === 'max') { btn.disabled = cap <= 0; return; }
        btn.disabled = Number(v) > cap;
      });
  }

  function syncQuickpickHighlight() {
    var cur = S.parseChips($('rebuy-input').value);
    var cap = ctx.entry ? ctx.entry.rebuy_cap_chips : 0;
    Array.prototype.forEach.call(
      document.querySelectorAll('#rebuy-quickpicks .quickpick'),
      function (btn) {
        var v = btn.getAttribute('data-rebuy');
        var val = v === 'max' ? cap : Number(v);
        btn.classList.toggle('quickpick--active', cur !== null && cur === val);
      });
  }

  $('rebuy-quickpicks').addEventListener('click', function (e) {
    var btn = e.target.closest('.quickpick');
    if (!btn || btn.disabled) { return; }
    var v = btn.getAttribute('data-rebuy');
    var cap = ctx.entry ? ctx.entry.rebuy_cap_chips : 0;
    $('rebuy-input').value = String(v === 'max' ? cap : Number(v));
    msg($('rebuy-msg'), '', '');
    syncQuickpickHighlight();
    saveDraft();
  });

  $('rebuy-input').addEventListener('input', function () {
    msg($('rebuy-msg'), '', '');
    syncQuickpickHighlight();
    saveDraft();
  });

  $('bust-btn').addEventListener('click', function () {
    $('final-input').value = '0';
    $('bust-btn').classList.add('quickpick--active');
    msg($('final-msg'), 'Busted stack recorded as 0.', 'ok');
    saveDraft();
  });

  $('final-input').addEventListener('input', function () {
    var v = S.parseChips($('final-input').value);
    $('bust-btn').classList.toggle('quickpick--active', v === 0);
    msg($('final-msg'), '', '');
    saveDraft();
  });

  /* ---------------- review ---------------- */

  var reviewed = null; // { final, rebuy } as validated for sending

  $('report-form').addEventListener('submit', function (e) {
    e.preventDefault();

    var rebuy = S.parseChips($('rebuy-input').value);
    if (rebuy === null) { rebuy = 0; }
    var cap = ctx.entry.rebuy_cap_chips;
    if (rebuy > cap) {
      rebuy = cap;
      $('rebuy-input').value = String(cap);
      msg($('rebuy-msg'), 'Top-ups max out at ' + S.fmt(cap) + ' tonight, adjusted.', 'error');
      syncQuickpickHighlight();
    }

    var finalStack = S.parseChips($('final-input').value);
    if (finalStack === null) {
      msg($('final-msg'), 'Type your final stack, or tap “I busted” if it is 0.', 'error');
      $('final-input').focus();
      return;
    }

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
    $('rebuy-input').focus();
  });

  $('submit-btn').addEventListener('click', function () {
    if (!reviewed) { return; }
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

  function reportedNumbers() {
    var job = myJob();
    if (job) {
      return { final: job.payload.p_final_stack, rebuy: job.payload.p_rebuy_chips };
    }
    if (ctx.entry && ctx.entry.reported) {
      return { final: ctx.entry.final_stack || 0, rebuy: ctx.entry.rebuy_chips || 0 };
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
    renderSync();
  }

  $('retry-btn').addEventListener('click', function () {
    OB.retryNow(ctx.night.id, ctx.member.id);
    renderReceipt();
  });

  $('change-btn').addEventListener('click', function () {
    if (ctx.night.status === 'open' || ctx.night.status === 'reconciling') {
      // Preload the last numbers so editing starts from what was sent.
      var nums = reportedNumbers();
      if (nums) {
        $('rebuy-input').value = String(nums.rebuy);
        $('final-input').value = String(nums.final);
      }
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
