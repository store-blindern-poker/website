/* Store Blindern Poker: report.html behaviour. THE critical screen.
 *
 * A member on a phone, on flaky campus wifi, as the night winds up around
 * 20:30, must be able to:
 *   check in → play → top up → close the round → hand the chips back.
 * ONE number is asked for. Everything else on the screen is a fact already
 * on record.
 *
 * The screen is a hub with three errands hanging off it. #state-report is
 * home: it states what is on record and offers the buy-in slip, the bank and
 * the way out. The top-up and the closing count each get their own state, so
 * each screen carries exactly one instruction and exactly one brass action.
 * The h1 is that instruction, in the imperative, rewritten on every state
 * change: "You are checked in" is not something an anxious first timer can
 * obey, "Go and play" is.
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
 * take_rebuy; closing slip after the report, which is the only one that
 * counts chips BACK. A top-up is therefore always something already on
 * record, so the report NEVER asks about one, it only ever states it. Two
 * ways it gets on record: rebuy_at set means the bank issued it and there is
 * a slip to re-show; rebuy_chips set with rebuy_at null means an organiser
 * handed the chips over without the app and typed it into admin.html. Both
 * are facts this screen reports back unchanged. The client sends
 * entry.rebuy_chips, never a member-typed number and never a bare 0, because
 * a 0 would wipe an organiser's record (report_entry only protects the
 * bank's own number).
 */
(function () {
  'use strict';

  var S = window.SBP;
  var OB = window.SBPOutbox;
  if (!S || !OB) { return; }

  var $ = function (id) { return document.getElementById(id); };

  /* THE most important line in this file. S.show no-ops on null, so a state
   * div missing from this array is never hidden: two screens render stacked,
   * with no console error and no visual clue on a phone at 20:30. */
  var states = ['state-config', 'state-loading', 'state-nopseudonym',
                'state-nonight', 'state-checkin', 'state-report',
                'state-topup', 'state-close',
                'state-receipt', 'state-settled'];

  function showState(name) {
    // A slip is a takeover over ONE screen. Changing screens underneath it
    // would strand it with its timer running and the body unscrollable, so
    // it always closes first. Every slip in this file is opened AFTER its
    // state change, never before.
    if (!$('slip').hidden) { closeSlip(); }
    states.forEach(function (id) { S.show($(id), id === name); });
    var o = stateOrder(name);
    setOrder(o.order, o.sub);
    // Focus, not aria-live: this announces the new heading once and puts a
    // screen reader at the top of the new screen. A live region as well
    // would announce it twice.
    $('standing-order').focus();
  }

  /* ------------------------------------------------------------------
   * The standing order: the h1, and the one line under it.
   * ------------------------------------------------------------------ */
  function setOrder(order, sub) {
    $('standing-order').textContent = order;
    var s = $('standing-sub');
    s.textContent = sub || '';
    S.show(s, !!sub);
  }

  /* One default per state, resolved INSIDE showState so a screen can never
   * inherit the previous screen's instruction. Two states compute theirs,
   * because their instruction depends on the entry and the outbox. */
  var ORDER_DEFAULTS = {
    'state-config':      { order: 'Not connected yet.', sub: '' },
    'state-loading':     { order: 'Tonight', sub: 'Loading tonight’s round.' },
    'state-nopseudonym': { order: 'Pick your pseudonym.', sub: 'It is the only name ever shown in public.' },
    'state-nonight':     { order: 'No round tonight.', sub: '' },
    'state-checkin':     { order: 'Type tonight’s code.', sub: 'It is on the screen at the front, five characters.' },
    'state-topup':       { order: 'Count your chips.', sub: 'Count everything in front of you right now, then type the total.' },
    'state-close':       { order: 'Count your chips.', sub: 'Count everything in front of you and type the total.' },
    'state-settled':     { order: 'Tonight is settled.', sub: '' }
  };

  /* Club custom, not a database column, and deliberately not a gate. It also
   * appears verbatim in the #topup-open copy in report.html: change both or
   * neither. Nothing anywhere compares it to a clock. */
  var BREAK_TIME_TEXT = 'around 19:15';

  function stateOrder(name) {
    if (name === 'state-report')  { return hubOrder(); }
    if (name === 'state-receipt') { return receiptOrder(); }
    return ORDER_DEFAULTS[name] || { order: 'Tonight', sub: '' };
  }

  function hubOrder() {
    // shownNumbers(), not reportedNumbers(): a queue the browser evicted
    // must not turn "You have reported." into "Go and play." for somebody
    // who reported at 20:30 and is holding the phone to prove it.
    if (shownNumbers()) {
      if (sendVerdict() === 'unknown') {
        // The receipt says exactly this. The hub is the other screen
        // carrying the number and the only other route to the closing slip,
        // so it must not tell the same member, in the same breath, that
        // everything is filed.
        return { order: 'Show your numbers to an organiser.',
                 sub: 'This phone can no longer tell whether your report was sent. Your count is on the card below.' };
      }
      if (reportingClosed()) {
        // "Close the round again" is an offer past the deadline, and the card
        // three lines below has just hidden the button that would do it.
        return { order: 'You have reported.',
                 sub: 'Reporting has closed, so an organiser makes any change to your numbers now.' };
      }
      return { order: 'You have reported.',
               sub: 'Your numbers are in. If you play on, close the round again with the new total.' };
    }
    var n = ctx.night;
    if (reportingClosed()) {
      return { order: 'Show your numbers to an organiser.',
               sub: 'Reporting has closed. An organiser can still enter your final stack.' };
    }
    if (n && n.status !== 'open') {
      return { order: 'Count your chips.',
               sub: 'The round is over. Count what is in front of you and report the total.' };
    }
    // A member who has already topped up must not read a line offering one
    // at 19:20. The offer card disappears in the same breath; this is the
    // heading agreeing with it.
    if (recordedRebuy() > 0) {
      return { order: 'Go and play.',
               sub: 'Your top-up is on record. Close the round when you are done.' };
    }
    // rebuy_cap_chips 0: the season points are all in play, so the bank has
    // nothing for this member and never had tonight. Sending them to it at
    // 19:15 is a promise the screen already knows it cannot keep. The card
    // below says the same thing in full.
    if (ctx.entry && !ctx.entry.rebuy_cap_chips) {
      return { order: 'Go and play.',
               sub: 'Your points are all in play, so there is no top-up tonight.' };
    }
    return { order: 'Go and play.',
             /* "The bank OPENS at" reads as a start time, and there is no
              * start time: take_rebuy has no time gate and the button is
              * live from 18:00. A member reading this at 18:10 concluded
              * the bank was shut, which is the opposite of the rule, and it
              * contradicted the top-up card 600px below saying there is
              * nothing to miss. Says when it usually happens instead. */
             sub: 'Most people top up at the first break, ' + BREAK_TIME_TEXT + '.' };
  }

  function receiptOrder() {
    var job = myJob();
    var nums = shownNumbers();
    if (jobStuck()) {
      return { order: 'Show this to an organiser.',
               sub: 'Your numbers are safe on this phone. An organiser can type them in.' };
    }
    if (sendVerdict() === 'unknown') {
      return { order: 'Show this to an organiser.',
               sub: 'This phone can no longer tell whether your report was sent.' };
    }
    // Past the deadline with nothing left in the queue: this is the morning
    // after. The chips went back last night, so "Hand your chips back." is a
    // stale instruction, and the only thing that can still change anything is
    // an organiser. A report still queued never reaches here, because
    // jobStuck() answers first for it.
    if (reportingClosed()) {
      return { order: 'You have reported.',
               sub: 'Reporting has closed, so an organiser makes any change to your numbers now.' };
    }
    if (nums && nums.final === 0) {
      return { order: 'Show an organiser you are done.',
               sub: 'You busted, so there are no chips to hand back. The closing slip is your tick off the list.' };
    }
    if (job && job.status !== 'sent') {
      return { order: 'Hand your chips back.',
               sub: tabOnly()
                 ? 'Show the closing slip as you hand them over. This phone would not save the report, so keep this tab open.'
                 : 'Show the closing slip as you hand them over. The report keeps sending by itself.' };
    }
    return { order: 'Hand your chips back.',
             sub: 'Show the closing slip as you hand them over.' };
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

  /* Reporting is over for this night. nights.reports_close_at is a server
   * fact and the server enforces it (report_entry raises P0021), so this is
   * the page agreeing with the server in advance instead of offering a
   * button it already knows will be refused. Read in one place by the hub
   * order, the status card, the bank card, the way out and the close screen,
   * because those five used to work it out separately and disagreed on
   * screen. It is NOT the top-up break, which is guidance and never a gate. */
  function reportingClosed() {
    var n = ctx.night;
    var t = (n && n.reports_close_at) ? new Date(n.reports_close_at) : null;
    return !!(t && !isNaN(t) && Date.now() >= t.getTime());
  }

  /* The organisers have closed the books. report_entry raises P0003 from
   * here on, so a report still sitting in this phone's queue is never going
   * to land, however long it retries. */
  function nightSettled() {
    return !!(ctx.night && ctx.night.status === 'settled');
  }

  /* The server will refuse this send whatever the network does: P0003 on a
   * settled night, P0021 past the deadline. Read wherever the screen is about
   * to promise a send, offer a retry, or offer a route to one, because the
   * one thing that cannot help in either case is trying again. */
  function sendRefused() {
    return nightSettled() || reportingClosed();
  }

  /* "09:00 today", for copy that has to name the deadline inside a sentence.
   * renderDeadline builds its own line with a mono span, so this one is
   * deliberately plain text. */
  function closedAtWords() {
    var n = ctx.night;
    var t = (n && n.reports_close_at) ? new Date(n.reports_close_at) : null;
    if (!t || isNaN(t)) { return ''; }
    return osloClock(t, false) + ' ' + osloDayWord(t);
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

  /* "Fri 5 September", for the slip's night line. A date, not a clock: the
   * played_on column is a plain date with no time in it. */
  function osloDateWords(playedOn) {
    if (!playedOn) { return ''; }
    var d = new Date(playedOn + 'T00:00:00');
    if (isNaN(d)) { return String(playedOn); }
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Oslo', weekday: 'short', day: 'numeric', month: 'long'
      }).format(d);
    } catch (err) { return String(playedOn); }
  }

  /* ------------------------------------------------------------------
   * Outbox sender: one rpc call, honest error classification.
   * ------------------------------------------------------------------ */

  /* The top-up on record can change AFTER a report is queued. An organiser
   * hands chips across the table at 20:33 and types the number into
   * admin.html while this phone is still retrying on bad wifi, which is the
   * same bad wifi the outbox exists for, so the two go together more often
   * than not. The payload was frozen at Send with whatever was on record
   * then, and report_entry defends the BANK’s number (rebuy_at set) but
   * overwrites an ORGANISER’s (rebuy_at null) with whatever the parameter
   * says, so posting the frozen 0 would quietly write the organiser’s 4,000
   * down to nothing, with the receipt still reading the record and showing
   * no sign of it. So the figure is re-read from the server on EVERY
   * attempt, immediately before the post. The read can never fail the send:
   * any error falls back to the queued figure, which is what would have gone
   * anyway. The member’s own number, p_final_stack, is never touched here.
   *
   * This is also why the payload is rebuilt rather than mutated in place:
   * the outbox has already written the job to localStorage by the time the
   * sender sees it, so a mutation would not persist, and reportedNumbers()
   * reads p_final_stack straight off that same object. */
  function freshRebuy(job) {
    var frozen = job.payload;
    return S.myEntry(job.night_id, job.member_id).then(function (row) {
      if (!row) { return frozen; }
      // Keep the screen honest too: every ledger on it reads the record
      // through recordedRebuy(), never the frozen payload.
      if (ctx.night && row.night_id === ctx.night.id) { ctx.entry = row; }
      var live = row.rebuy_chips || 0;
      if (live === frozen.p_rebuy_chips) { return frozen; }
      return {
        p_night_id: frozen.p_night_id,
        p_final_stack: frozen.p_final_stack,
        p_rebuy_chips: live
      };
    }).catch(function () { return frozen; });
  }

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
      return freshRebuy(job).then(function (payload) {
        return c.rpc('report_entry', payload);
      }).then(function (r) {
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

  /* Has this phone ever completed a check-in? The note it gates is one
   * sentence of reassurance on the one screen where a first timer is standing
   * still with time to read it. A failed read (private mode) shows the note,
   * because a redundant sentence is always better than a missing one. */
  var EVER_KEY = 'sbp.checkedin.ever';

  function neverCheckedIn() {
    try {
      return !window.localStorage.getItem(EVER_KEY);
    } catch (e) { return true; }
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
    /* The pill says what a MEMBER can do, not what nights.status holds.
     *
     * Those are two different facts and they disagree for a whole morning:
     * past reports_close_at the column still reads 'open', because the
     * organisers have not settled yet, while this phone can no longer send
     * anything. The pill is the first thing read on the screen, so a green
     * OPEN three lines above "Show your numbers to an organiser" left the
     * banner as the one element contradicting every other part of the page.
     *
     * The column is not touched and is not being misreported: admin.html
     * still shows nights.status raw, which is the screen where the
     * lifecycle status is the fact that matters. Here it is not.
     *
     * Settled is excluded because 'settled' is already the truer word. */
    var pill = $('night-status');
    if (reportingClosed() && n.status !== 'settled') {
      // One word: 'reporting closed' wrapped the pill to two lines at 375px.
      // The card below already says it three times over.
      pill.textContent = 'closed';
      pill.className = 'status-pill status-pill--reconciling';
    } else {
      pill.textContent = n.status === 'reconciling' ? 'closing' : n.status;
      pill.className = 'status-pill status-pill--' + n.status;
    }
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
  var slipKind = null;        // which slip is up, for the per-second refresh
  var slipSendText = '';      // last written verdict, so the live region only
                              // announces a real change
  var slipAgeAt = null;       // when this slip's fact was recorded, in ms
  var slipAgeReshow = false;  // whether to prefix the age line with RE-SHOW
  var slipAgeText = '';       // last written age line, so the tick only
                              // touches the DOM on a real change
  var wakeLock = null;        // Screen Wake Lock sentinel, where supported

  /* Which way the chips move, read first and read from arm's length. Buy-in
   * and top-up are chips leaving the bank, so the slip says GIVE. Closing is
   * chips coming back, so it says COLLECT FROM and counts in chips back. */
  var SLIP_KICKER    = { buyin: 'Buy-in', topup: 'Top-up', closing: 'Closing' };
  var SLIP_DIRECTION = { buyin: 'GIVE',   topup: 'GIVE',   closing: 'COLLECT FROM' };
  var SLIP_UNIT      = { buyin: 'chips',  topup: 'chips',  closing: 'chips back' };

  /* Colour is faster than a word at four metres in bad light, and the words
   * carry the same information independently, so a colour-blind organiser
   * loses nothing: brass and felt also differ hard in lightness. Brass on
   * --on-brass is about 8.2:1, cream on --felt about 11:1. Both survive a
   * dimmed phone at 20:35. */
  var SLIP_BAND = {
    buyin:   { text: 'GIVE CHIPS OUT',  cls: 'slip__band--give' },
    topup:   { text: 'GIVE CHIPS OUT',  cls: 'slip__band--give' },
    closing: { text: 'TAKE CHIPS BACK', cls: 'slip__band--take' }
  };

  var SLIP_AGE_VERB = { buyin: 'Checked in', topup: 'Taken at the bank', closing: 'Reported' };

  /* Date.now() minus a server timestamp, so a phone twenty minutes fast prints
   * "checked in 20 minutes ago" on a fresh slip. It is clamped so it can never
   * print a negative, it GATES NOTHING, and the live clock beside it already
   * reads wrong against the room's clock, which is the tell. Do not ever turn
   * this line into a lock or a colour. */
  function ageWords(ms) {
    if (ms < 90000) { return 'just now'; }
    if (ms < 3600000) {
      var n = Math.max(1, Math.round(ms / 60000));
      return n === 1 ? '1 minute ago' : n + ' minutes ago';
    }
    var h = Math.floor(ms / 3600000);
    var m = Math.round((ms % 3600000) / 60000);
    if (m === 60) { h += 1; m = 0; }
    if (m === 0) { return h === 1 ? '1 hour ago' : h + ' hours ago'; }
    return (h === 1 ? '1 hour' : h + ' hours') + ' ' +
           (m === 1 ? '1 minute' : m + ' minutes') + ' ago';
  }

  /* The age line, in #slip-stamp. "RE-SHOW, checked in 52 minutes ago" is
   * what catches an honest double count at a busy bank. It is a leaf: it
   * writes one DOM property and calls nothing. */
  function slipAgeLine() {
    if (slipAgeAt === null) { return; }
    var verb = SLIP_AGE_VERB[slipKind] || 'Issued';
    var words = ageWords(Date.now() - slipAgeAt);
    var text = slipAgeReshow
      ? 'RE-SHOW · ' + verb.toLowerCase() + ' ' + words
      : verb + ' ' + words;
    if (text !== slipAgeText) { $('slip-stamp').textContent = text; slipAgeText = text; }
  }

  function slipTick() {
    $('slip-clock').textContent = osloClock(new Date(), true);
    // Re-rendered every second so a slip held up for five minutes cannot
    // still claim it was issued just now.
    slipAgeLine();
    // The closing slip is the only one whose meaning can change while it is
    // being read: the queue can deliver it mid-conversation. It rides the
    // clock's own tick, so the organiser never has to close and reopen to
    // find out whether it arrived. A leaf: it must not call renderSync or
    // renderReceipt, which is the cycle that once blew the stack.
    if (slipKind === 'closing') { slipSendLine(); }
  }

  /* The runbook already tells organisers to check that a stranger's phone
   * said Sent. Put it on the slip, in colour, instead of in a small pill in
   * the corner of the screen behind it. */
  function slipSendLine() {
    var note = $('slip-note');
    var text, kind;
    switch (sendVerdict()) {
      case 'sent':
        text = 'SENT. The server has this number.'; kind = 'ok'; break;
      case 'failed':
        text = 'NOT SENT. Enter this one by hand.'; kind = 'alert'; break;
      case 'unknown':
        // An absence of information, never dressed up as a send. Brass, the
        // same not-yet colour as a report still on its way, because that is
        // what it is: unfinished, not refused.
        text = 'NOT CONFIRMED. This phone cannot tell, ask an organiser.';
        kind = 'pending'; break;
      default:
        if (sendRefused()) {
          // Queued, but the server has stopped taking it: the night was
          // settled or the deadline passed while this sat in the queue.
          // "Still trying" is true and useless. This is the line an organiser
          // reads across the chip case, and what they need from it is that
          // this number is theirs to type in.
          text = 'NOT SENT. Enter this one by hand.'; kind = 'alert';
        } else if (tabOnly()) {
          // localStorage refused the write, so the queue is in memory and
          // dies with the tab. The slip must not say "saved" about it either:
          // this note is read at the bank, by the person who can fix it.
          text = 'NOT SENT YET. In this tab only, keep it open.'; kind = 'pending';
        } else {
          text = 'NOT SENT YET. Saved on this phone, still trying.'; kind = 'pending';
        }
    }
    note.className = 'slip__note slip__note--' + kind;
    if (text !== slipSendText) { note.textContent = text; slipSendText = text; }
    S.show(note, true);
  }

  /* opts: { kind: 'buyin' | 'topup' | 'closing', amount, note (string html-safe
   * parts built here), becomes (number|null), reshow (bool), issuedAt
   * (iso|null) } */
  function openSlip(opts) {
    if (!ctx.member || !ctx.night) { return; }
    var root = $('slip');
    slipKind = opts.kind;
    slipSendText = '';

    // Direction before anything else, because it is the one thing that must
    // not be got wrong. className is rebuilt wholesale, so no layout class
    // may be hung on this element in markup.
    var band = SLIP_BAND[opts.kind];
    var bandEl = $('slip-band');
    bandEl.textContent = (opts.kind === 'closing' && opts.amount === 0)
      ? 'NOTHING TO TAKE BACK'
      : band.text;
    bandEl.className = 'slip__band ' + band.cls;

    var kicker = SLIP_KICKER[opts.kind];
    if (opts.reshow) { kicker += ' · re-show'; }
    $('slip-kicker').textContent = kicker;

    $('slip-give').textContent = SLIP_DIRECTION[opts.kind] + ' ' + ctx.member.pseudonym;
    $('slip-amount').textContent = S.fmt(opts.amount);
    $('slip-unit').textContent = SLIP_UNIT[opts.kind];
    $('slip-night').textContent =
      (ctx.night.title || ('Night ' + ctx.night.night_no)) +
      ' · ' + osloDateWords(ctx.night.played_on);

    var note = $('slip-note');
    // Reset the class first: a previous closing slip's colour must not leak
    // onto a buy-in note.
    note.className = 'slip__note';
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

    root.classList.toggle('slip--reshow', !!opts.reshow);
    // Brass means the bank pays out, cream means the bank counts in.
    root.classList.toggle('slip--take', opts.kind === 'closing');

    // The age line. No parsable timestamp means no line at all: "Checked in
    // NaN" is worse than silence, and the clay kicker still marks a re-show
    // on its own. slipTick below writes the text.
    var issued = opts.issuedAt ? new Date(opts.issuedAt) : null;
    slipAgeAt = (issued && !isNaN(issued)) ? issued.getTime() : null;
    slipAgeReshow = !!opts.reshow;
    slipAgeText = '';
    S.show($('slip-stamp'), slipAgeAt !== null);

    // The closing slip's verdict is written by this first tick, which is why
    // the note block above leaves it hidden: nothing else fills it in.
    slipTick();
    if (slipTimer) { clearInterval(slipTimer); }
    slipTimer = setInterval(slipTick, 1000);

    slipReturnFocus = document.activeElement;
    S.show(root, true);
    document.body.classList.add('no-scroll');
    $('slip-close').focus();
    requestWakeLock();
  }

  /* A phone that sleeps in the bank queue turns a two second handover into a
   * twenty second fumble with a lock screen. Silent where unsupported (older
   * iOS has no Screen Wake Lock API at all), and the slip works exactly the
   * same without it. */
  function requestWakeLock() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen')
          .then(function (l) { wakeLock = l; })
          .catch(function () { /* denied or unsupported: the slip still works */ });
      }
    } catch (e) { /* older browsers throw on the property access itself */ }
  }

  // Browsers drop the lock when the tab hides, so take it again on the way
  // back if the slip is still up.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !$('slip').hidden) {
      requestWakeLock();
    }
  });

  function closeSlip() {
    if (slipTimer) { clearInterval(slipTimer); slipTimer = null; }
    slipKind = null;
    slipSendText = '';
    slipAgeAt = null;
    slipAgeText = '';
    try {
      if (wakeLock) { wakeLock.release(); }
    } catch (e) { /* already released, or the tab lost it on the way here */ }
    wakeLock = null;
    S.show($('slip'), false);
    document.body.classList.remove('no-scroll');
    if (slipReturnFocus && slipReturnFocus.focus &&
        document.contains(slipReturnFocus)) {
      slipReturnFocus.focus();
    }
    slipReturnFocus = null;
  }

  /* Dismissing a slip by hand. The slip re-reads the verdict on its own tick,
   * so by the time it is put away it can know something the screen behind it
   * does not: a report that landed while it was up, or a queue that emptied
   * under storage pressure. OB.onChange cannot help with the second one,
   * because a store the browser evicted fires no event in the tab that lost
   * it. Re-render on the way out, so the receipt can never contradict the
   * slip the organiser has just read. showState calls closeSlip directly
   * instead, because there the screen underneath is rebuilt anyway. */
  function dismissSlip() {
    closeSlip();
    renderSync();
  }

  $('slip-close').addEventListener('click', dismissSlip);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('slip').hidden) { dismissSlip(); }
  });

  /* The slip is a dialog with one focusable child, so the trap is one branch:
   * Tab can only ever land back on Close. */
  $('slip').addEventListener('keydown', function (e) {
    if (e.key === 'Tab') { e.preventDefault(); $('slip-close').focus(); }
  });

  function openBuyinSlip(reshow) {
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
      reshow: !!reshow,
      // entries.created_at is the check-in moment. A re-upsert of check_in
      // only bumps updated_at, so this stays the time the chips were booked.
      issuedAt: ctx.entry.created_at
    });
  }

  function openTopupSlip(reshow) {
    var e = ctx.entry;
    // The guard that stops an organiser-recorded top-up from ever printing a
    // slip for chips the bank never issued.
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

  /* The handover artefact. It renders from the report that was just made, so
   * there is nothing new to store and no migration behind it. */
  function openClosingSlip(reshow) {
    // The same fallback the receipt uses. A queue evicted under storage
    // pressure must not take the handover artefact off the screen with it:
    // the slip's own note already reads NOT CONFIRMED in that case, which is
    // exactly what an organiser needs to be looking at.
    var nums = reportedNumbers() || lastReported;
    if (!nums) { return; }
    var job = myJob();
    var at = job ? job.queued_at
                 : (ctx.entry && ctx.entry.reported ? ctx.entry.updated_at : null);
    openSlip({
      kind: 'closing',
      amount: nums.final,
      becomes: null,
      reshow: !!reshow,
      issuedAt: at
    });
  }

  $('buyin-slip-btn').addEventListener('click', function () { openBuyinSlip(true); });
  $('topup-reshow-btn').addEventListener('click', function () { openTopupSlip(true); });
  $('closing-slip-btn').addEventListener('click', function () { openClosingSlip(true); });
  // The same slip from home. Reporting, tapping Change my report, then Not
  // yet used to land on a hub with no route back to the one artefact the
  // organiser needs at 20:35.
  $('hub-slip-btn').addEventListener('click', function () { openClosingSlip(true); });

  /* ------------------------------------------------------------------
   * Sync pill + organiser card, driven by the outbox
   * ------------------------------------------------------------------ */
  function myJob() {
    if (!ctx.night || !ctx.member) { return null; }
    return OB.get(ctx.night.id, ctx.member.id);
  }

  /* js/outbox.js falls back to an in-memory queue when localStorage refuses
   * a write: iOS private browsing, or a full origin quota. That fallback is
   * correct and deliberate, but nothing in it reaches the UI, so the receipt
   * printed the strongest reassurance on the site, "Saved on this phone", over
   * a queue that dies with the tab. Do not take the words on trust: ask the
   * store whether the job we are about to reassure somebody about is actually
   * in it. A read that throws is the same answer, from the same cause. */
  var OUTBOX_KEY = 'sbp.outbox.v1';

  function tabOnly() {
    var job = myJob();
    if (!job || job.status === 'sent') { return false; }
    try {
      var raw = window.localStorage.getItem(OUTBOX_KEY);
      var store = raw ? JSON.parse(raw) : null;
      return !(store && typeof store === 'object' && store[job.key]);
    } catch (e) {
      return true;
    }
  }

  /* Has the server got this number? Four answers, and NO JOB AT ALL is
   * deliberately not one of the good ones. A job can vanish without ever
   * having been sent: a browser evicting site data under storage pressure
   * with the tab still open reads back as an empty store and throws nothing,
   * so outbox.js never falls back to memory and simply sees no job. Mapping
   * that absence to SENT would print the strongest reassurance on the site,
   * in the felt colour, on the one screen an organiser reads before chips
   * move, about a number the server may not hold. The server’s own entries
   * row is the only thing that may say SENT without a job behind it. It is a
   * leaf, safe to call from the slip’s per-second tick: it reads the queue and
   * the entry and renders nothing. */
  function sendVerdict() {
    var job = myJob();
    if (job) {
      if (job.status === 'sent')   { return 'sent'; }
      if (job.status === 'failed') { return 'failed'; }
      return 'pending';
    }
    if (ctx.entry && ctx.entry.reported) { return 'sent'; }
    return 'unknown';
  }

  /* The last real answer reportedNumbers() gave during THIS page load. A
   * browser evicting site data under storage pressure empties the outbox with
   * the tab still open and throws nothing, so the next read comes back null
   * and the member's own count would vanish off the receipt at the exact
   * moment the page admits it cannot confirm the send. That is the one screen
   * where the numbers matter most, because reading them to an organiser is
   * the only thing left to do. Never persisted and never sent: it is a memory
   * of this page load and nothing else. */
  var lastReported = null;

  /* This phone HAD a report and can no longer find it in any store. Distinct
   * from "nothing reported yet", which is every member's state at 18:30 and
   * is not something to raise on screen. */
  function reportLost() {
    return !!lastReported && sendVerdict() === 'unknown';
  }

  /* The numbers to PRINT, which is not always the numbers a store can still
   * find. Every screen that carries the member's own count reads through
   * this: the receipt, the closing slip, the hub's status strip, the hub's
   * standing order and the way-out card. They used to disagree, so an
   * eviction took the number off the hub and the route to the slip with it,
   * while the receipt kept both. */
  function shownNumbers() {
    return reportedNumbers() || lastReported;
  }

  /* This phone is holding a report the server has not confirmed. Distinct
   * from "has reported": the entry row may say nothing at all. It is the test
   * for whether a screen may be replaced by a card that carries neither the
   * number nor anybody to show it to. */
  function heldUnsent() {
    var job = myJob();
    return !!(job && job.status !== 'sent') || reportLost();
  }

  /* Escalated: permanently refused, or quiet enough for long enough that
   * "it will go through" has stopped being an honest thing to say. */
  function jobStuck() {
    var job = myJob();
    if (!job || job.status === 'sent') { return false; }
    // Refused, or refused in advance. A queue still retrying into a settled
    // night or a passed deadline is retrying into a wall: every attempt comes
    // back P0003 or P0021 inside a frame. The screen escalates now rather
    // than going on promising the report will arrive, because a settled night
    // is the exact moment the number is about to be lost for good.
    if (job.status === 'failed' || sendRefused()) { return true; }
    return job.attempts >= OB.STUCK_AFTER_ATTEMPTS;
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
      } else if (reportLost()) {
        // The queue held this report a moment ago and holds nothing now. The
        // pill is the one piece of chrome that outlives every state, so it
        // says what the slip and the receipt say instead of disappearing: a
        // pill that quietly vanishes reads as "nothing pending, all fine".
        // Brass, the same not-yet colour as a report still on its way,
        // because that is what this is: unfinished, not refused.
        pill.className = 'sync-pill sync-pill--queued';
        text.textContent = 'Not confirmed';
        S.show(pill, true);
      } else {
        S.show(pill, false);
      }
      // NO early return to the caller here. The receipt follow-up used to sit
      // below it, so the one case where the job disappears from the store was
      // also the one case that never re-rendered the receipt.
      renderReceiptIfUp();
      return;
    }
    // "Saved on this phone" is only true when the phone saved it. When
    // localStorage refused the write the outbox is holding this in memory and
    // it dies with the tab, so the pill names the tab instead, which is also
    // the instruction: do not close it.
    var queuedText;
    if (tabOnly()) {
      queuedText = 'In this tab only, sending';
    } else if (navigator.onLine === false) {
      queuedText = 'Saved on this phone, offline';
    } else {
      queuedText = 'Saved on this phone, sending soon';
    }
    var map = {
      queued: ['sync-pill--queued', queuedText],
      sending: ['sync-pill--sending', 'Sending…'],
      sent: ['sync-pill--sent', 'Sent ✓'],
      failed: ['sync-pill--failed', 'Not sent']
    };
    var m = map[job.status] || map.queued;
    // Once the screen has escalated, ''sending soon'' is a promise the queue has
    // already broken five times. The pill is chrome: it sits above every
    // state and must not argue with the standing order underneath it, which
    // by then reads ''Show this to an organiser.'' The colour does not move,
    // because nothing has been refused, only delayed past the point where
    // waiting quietly is still the right advice.
    if (job.status === 'queued' && jobStuck()) {
      m = ['sync-pill--queued',
           sendRefused() ? 'Not sent, show an organiser'
             : (tabOnly() ? 'In this tab only, not sent yet'
                          : 'Saved on this phone, not sent yet')];
    }
    pill.className = 'sync-pill ' + m[0];
    text.textContent = m[1];
    S.show(pill, true);

    renderReceiptIfUp();
  }

  /* Receipt state follows the queue whenever it is on screen. A leaf on
   * purpose: renderReceipt() must never call renderSync() back, which is the
   * mutual recursion that once blew the stack on boot. */
  function renderReceiptIfUp() {
    if (!$('state-receipt').hidden) { renderReceipt(); }
  }

  OB.onChange(function () { renderSync(); });

  /* A WATCH, not a poll, and the reason it has to exist.
   *
   * The queue can change with nothing at all to announce it. js/outbox.js
   * emits on every write it makes, but kick() returns without emitting once
   * nothing is due, so OB.onChange goes quiet the moment the store empties;
   * and a store the BROWSER evicts under storage pressure fires no event in
   * the tab that lost it either. The only other clock on this page is the
   * slip's own per-second tick, which runs solely while a slip is open. One
   * step off that path, which is the ordinary shape of the night (report,
   * read the receipt, pocket the phone), a receipt sat saying "you can put
   * your phone away" about a report in no store, for as long as the tab was
   * left up.
   *
   * So it re-reads the queue every second and re-renders ONLY when the answer
   * has actually changed. A member sitting still never has the screen move
   * under them, and nothing on it can go on being wrong for longer than a
   * second. It touches localStorage and nothing else: no network, ever. */
  var syncSig = null;
  var hubSig = null;

  /* What the pill and the receipt read out of the queue. Both are rewritten
   * in place, so a change here costs a member nothing but the truth. */
  function queueSignature() {
    var job = myJob();
    return [job ? job.status : '-',
            job ? job.attempts : '-',
            sendVerdict(),
            jobStuck() ? 'stuck' : '-',
            tabOnly() ? 'tab' : '-',
            navigator.onLine === false ? 'off' : 'on'].join('|');
  }

  /* What the HUB reads, which is deliberately less. job.attempts and the flip
   * from queued to sending and back appear nowhere on that screen, and they
   * change on every retry, so re-rendering the hub on them moved the screen
   * under a member who was sitting still while nothing they could see had
   * changed. The deadline is in here because 09:00 passing rewrites the whole
   * card with no queue event behind it. */
  function hubSignature() {
    var nums = shownNumbers();
    var d = loadDraft();
    return [sendVerdict(),
            myJob() ? 'job' : '-',
            nums ? nums.final : '-',
            recordedRebuy(),
            reportingClosed() ? 'closed' : '-',
            (d && d.final) || '-'].join('|');
  }

  function watchQueue() {
    // At the bank. The slip is a takeover with its own tick and its own
    // verdict line, and re-rendering the hub underneath it would close it.
    if (!$('slip').hidden) { return; }
    var sig = queueSignature();
    if (sig !== syncSig) { syncSig = sig; renderSync(); }
    // The hub carries the same number, the same standing order and the only
    // other route to the closing slip, and it is where a member sits between
    // the report and the walk to the bank. renderHub, never enterReport: this
    // is the screen they are already on, so nothing may take focus or move
    // the scroll under their thumb.
    if ($('state-report').hidden || !ctx.night || !ctx.entry) { return; }
    // renderHub writes hubSig itself, so arriving by tap primes it too and
    // the first tick after a deliberate render is a no-op.
    if (hubSignature() === hubSig) { return; }
    renderHub();
  }

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
    S.show($('first-night-note'), neverCheckedIn());
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
        try {
          window.localStorage.setItem(EVER_KEY, '1');
        } catch (e) { /* private mode: the first-night note shows again, no harm */ }
        enterReport();
        // The first thing the player does after checking in is collect
        // chips, so the buy-in slip opens itself. Focus lands on a control
        // that is actually on screen first, because openSlip remembers
        // document.activeElement and closeSlip hands focus back to it.
        $('buyin-slip-btn').focus();
        openBuyinSlip(false);
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

  /* Home. States what is on record and offers the three errands: the buy-in
   * slip, the bank, and the way out. */
  /* The hub's facts, on the screen the member is already looking at.
   *
   * Split out of enterReport because showState() ends by focusing the h1,
   * which on a phone scrolls the page back to the top. That is right when the
   * member asked for this screen and wrong when a retry ticked underneath
   * them: a report retrying on bad wifi bumps the queue every 2, 4, 8, 16 then
   * 32 seconds, and every one of those threw somebody reading the way-out card
   * back to the top with the button gone from under their thumb. Nothing here
   * takes focus, moves the scroll or touches #final-input. */
  function renderHub() {
    var n = ctx.night, e = ctx.entry;
    $('report-bonus').textContent = '+' + S.fmt(n.attendance_bonus);
    $('report-buyin').textContent = S.fmt(e.buyin_chips) + ' chips';

    // Five-way, because "10,000 chips" alone cannot tell an allowance from a
    // top-up already taken, and the difference is what the member walks to
    // the bank on.
    var cap;
    if (bankMode()) {
      var rt = new Date(e.rebuy_at);
      cap = S.fmt(recordedRebuy()) + ' chips, taken ' +
        (isNaN(rt) ? '…' : osloClock(rt, false));
    } else if (organiserRebuy()) {
      cap = S.fmt(recordedRebuy()) + ' chips, recorded by an organiser';
    } else if (reportingClosed()) {
      // The night status can still read 'open' after the deadline, so this
      // has to be asked before the three branches below it or the row reads
      // "not taken yet" about a bank that shut hours ago.
      cap = 'bank closed';
    } else if (n.status === 'open' && !e.rebuy_cap_chips) {
      cap = 'no allowance left tonight';
    } else if (n.status === 'open') {
      // Deliberately NOT a number. rebuy_cap_chips is the points ceiling
      // alone; the real ceiling is the smaller of that and the chip room, and
      // only rebuy_quote knows it. Printing the points figure here promises a
      // number the bank may not honour to somebody already in the queue.
      cap = 'not taken yet';
    } else {
      cap = 'bank closed';
    }
    $('report-cap').textContent = cap;

    var nums = shownNumbers();
    $('report-reported').textContent = nums ? S.fmt(nums.final) + ' chips' : 'not yet';

    renderTopup();
    renderCloseCta();
    // showState resolves the standing order on the way in. Re-rendering in
    // place has to ask for it, or the h1 keeps yesterday's instruction over
    // today's card.
    var o = hubOrder();
    setOrder(o.order, o.sub);
    hubSig = hubSignature();
  }

  /* Arriving at the hub by a tap. The state change and the one thing that
   * belongs to arriving rather than to the facts: the count in the field. */
  function enterReport() {
    var e = ctx.entry;
    renderHub();

    // Prefill the one input: server row wins if already reported, else the
    // local draft, else whatever is already in the field (which is what lets
    // "Change my report" preload the last number). A top-up, if any, is
    // stated by the bank card above and is never something this form fills in.
    var draft = loadDraft();
    if (e.reported) {
      $('final-input').value = e.final_stack === null ? '' : String(e.final_stack);
    } else if (draft) {
      $('final-input').value = draft.final;
      $('bust-btn').classList.toggle('btn--bust--on', draft.busted);
    }

    showState('state-report');
  }

  /* Close is available from the moment of check-in and never goes away: the
   * member who busts at 18:40 must be able to go home without hunting. It is
   * a SCREEN, not an action. Two more deliberate taps (Review, then Send)
   * stand between it and anything being recorded, and "Not yet, back to
   * tonight" is right there, so an accidental tap costs nothing. It stays
   * secondary while the night is open because a member who has checked in is
   * playing, and this screen must not push them toward the exit. */
  function renderCloseCta() {
    var nums = shownNumbers();
    var reported = !!nums;
    var closed = reportingClosed();
    var label = $('close-card-label');
    var text = $('close-card-text');
    var slipBtn = $('hub-slip-btn');
    var btn = $('close-start-btn');

    // Both classNames are rebuilt wholesale here, so spacing lives on the
    // wrappers in report.html and never on these buttons.
    if (reported) {
      label.textContent = '3 · Reported';
      // job.queued_at is this phone's own moment of sending; the server row's
      // updated_at covers a report made on an earlier visit.
      var job = myJob();
      var when = job ? job.queued_at
                     : (ctx.entry && ctx.entry.reported ? ctx.entry.updated_at : null);
      var t = when ? new Date(when) : null;
      text.textContent = 'You reported ' + S.fmt(nums.final) + ' chips' +
        (t && !isNaN(t) ? ' at ' + osloClock(t, false) : '') +
        '. Show the closing slip as you hand your chips back.' +
        (closed ? ' Reporting closed at ' + closedAtWords() +
                  ', so an organiser makes any change to it now.' : '');
      // The queue held this report a moment ago and holds nothing now. The
      // number and the slip stay, because reading them to an organiser is all
      // that is left to do, and the card says so instead of implying the
      // whole thing is filed. Same words and same demotion as the receipt.
      if (sendVerdict() === 'unknown') {
        text.textContent = 'You reported ' + S.fmt(nums.final) + ' chips. ' +
          'This phone can no longer tell whether that reached the server: ' +
          'show the closing slip and read the number to an organiser.';
      }
      // The slip is the artefact the organiser needs while the chips come
      // back, so it takes the screen's one brass fill and the way back into
      // the form is forced secondary, whatever the night status says. On an
      // unconfirmed report the one thing to do is not a control, so the brass
      // comes off, exactly as it does on the receipt.
      slipBtn.className = sendVerdict() === 'unknown'
        ? 'btn btn--secondary btn--block'
        : 'btn btn--primary btn--block btn--lg';
      S.show(slipBtn, true);
      btn.textContent = 'Change my report';
      btn.className = 'btn btn--secondary btn--block';
      // Past the deadline the server refuses report_entry with P0021, so
      // "Change my report" is a route to a form that cannot send. The
      // sentence above says who to talk to instead.
      S.show(btn, !closed);
    } else if (closed) {
      // Nothing on this phone can reach the server any more, so the card
      // carries no control at all: it names the deadline, says why the two
      // buttons are gone, and gives the one thing that still works. The
      // standing order above it already reads "Show your numbers to an
      // organiser."
      label.textContent = '3 · Reporting has closed';
      text.textContent = 'Reporting closed at ' + closedAtWords() +
        ', so this phone can no longer send your final stack, and the bank ' +
        'has shut. Count your chips and read the total to an organiser: they ' +
        'can still enter it for you.';
      S.show(slipBtn, false);
      S.show(btn, false);
    } else {
      label.textContent = '3 · Close the round';
      text.textContent = 'When you are done for the night, count your chips ' +
        'and report the total. You get a closing slip to show an organiser ' +
        'while you hand the chips back. No rush: reporting stays open until ' +
        'the morning after.';
      S.show(slipBtn, false);
      S.show(btn, true);
      btn.textContent = 'Close my round';
      // Once the organisers move the night off 'open', closing IS the only
      // thing left, so the button earns the screen's one brass fill. One
      // server fact, no phone clock.
      var late = !ctx.night || ctx.night.status !== 'open';
      btn.className = late ? 'btn btn--primary btn--block btn--lg'
                           : 'btn btn--secondary btn--block';
    }

    // The visible half of the resilience contract. A force quit mid count
    // keeps the number, and until now nothing said so.
    var d = loadDraft();
    var note = $('hub-draft-note');
    if (!reported && d && d.final) {
      note.textContent = 'You started closing the round. Your count of ' +
        d.final + ' is saved on this phone.';
      S.show(note, true);
    } else {
      S.show(note, false);
    }
  }

  /* Catching an honest mistake, not accusing anybody: closing while the round
   * is still running is the one error nothing downstream catches, because a
   * reported member drops off the organisers' "not reported yet" list and
   * nobody chases them. */
  function renderCloseIntro() {
    var el = $('close-intro');
    if (reportingClosed()) {
      // Asked first. This branch used to be missing entirely, so the intro
      // read "The round is still running" directly above a deadline line
      // that read, in clay, that reporting had closed.
      el.textContent = 'Reporting has closed, so nothing sent from here will be accepted. Show your numbers to an organiser and they can enter them.';
    } else if (reportedNumbers()) {
      el.textContent = 'You already reported. Change the number and send again: the new report replaces the old one.';
    } else if (ctx.night && ctx.night.status === 'open') {
      el.textContent = 'The round is still running. Only close if you are done playing for tonight.';
    } else {
      el.textContent = 'The organisers are closing the night. Report your final stack now.';
    }
  }

  /* The close screen's send route, withdrawn when the server will refuse it.
   * #close-intro and #deadline-line are statements of fact and #review-btn is
   * a route to a send, so all three follow the deadline rather than the
   * moment enterClose happened to run. A tab left open overnight had the
   * intro still reading "the round is still running" over a live brass Send
   * that report_entry answers with P0021. #final-input is never touched here:
   * a member typing a chip count must not have the field move under their
   * thumb, and the count is still worth having for the organiser. */
  function renderCloseRoute() {
    var closed = reportingClosed();
    S.show($('review-btn'), !closed);
    S.show($('close-next-help'), !closed);
    S.show($('submit-btn'), !closed);
    $('close-no-send').textContent = closed
      ? 'Reporting closed at ' + closedAtWords() + ', so nothing can be sent ' +
        'from this phone now. Count your chips and read the total to an ' +
        'organiser: they can still enter it for you.'
      : '';
    S.show($('close-no-send'), closed);
    if (closed && !$('review-panel').hidden) {
      // The review sheet is a route to the same send, so a member who was
      // already looking at it when the deadline passed goes back to the form
      // and its explanation rather than sitting in front of a Send button
      // that cannot work.
      S.show($('review-panel'), false);
      S.show($('report-form'), true);
      setOrder(ORDER_DEFAULTS['state-close'].order, ORDER_DEFAULTS['state-close'].sub);
    }
  }

  function enterTopup() {
    S.show($('topup-flow'), true);   // renderTopup hid it on the way home
    topupReset();
    showState('state-topup');
  }

  /* Only ever reached by a deliberate tap. It never touches #final-input,
   * which is what lets Change my report preload the last number and have it
   * survive, and what keeps the draft intact across a trip to the hub. */
  function enterClose() {
    renderCloseIntro();
    renderDeadline();
    renderCloseRoute();
    msg($('final-msg'), '', '');
    $('bust-btn').classList.toggle('btn--bust--on',
      S.parseChips($('final-input').value) === 0);
    S.show($('review-panel'), false);
    S.show($('report-form'), true);
    showState('state-close');
  }

  $('close-start-btn').addEventListener('click', function () { enterClose(); });
  $('close-back-btn').addEventListener('click', function () { enterReport(); });

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

  /* Set the moment this page load fires its first "Take it", and never
   * cleared. On a slow connection a second tap gets away before the first
   * answer lands; take_rebuy is row-locked, so the later taps come back
   * P0023 and route through topupAlreadyDone. That refusal is one tap
   * landing twice, not somebody looking at a slip for the second time, so
   * the slip it opens is this member's FIRST slip. Clay RE-SHOW is the one
   * alarm colour on the slip and it must never point at a member who did
   * nothing but tap a laggy button, while an organiser reads it across the
   * table. A genuine re-show comes from "Show the slip again" and calls
   * openTopupSlip(true) directly, so it still reads RE-SHOW. */
  var topupTakenHere = false;

  /* Five faces, and #topup-flow is the one that now lives in #state-topup:
   * this list spans two state divs on purpose. */
  function topupFace(name) {
    ['topup-open', 'topup-flow', 'topup-done', 'topup-organiser',
     'topup-closed', 'topup-none', 'topup-over']
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
    } else if (reportingClosed()) {
      // Reporting is over, so the bank has shut. Asked BEFORE the open-night
      // branch, because the night status can still read 'open' past the
      // deadline and the offer would come back with it. The card says why it
      // is gone: a member who watched a button disappear goes hunting for it,
      // which is the ambiguity this screen exists to remove.
      topupFace('topup-closed');
    } else if (ctx.night && ctx.night.status === 'open') {
      // No allowance: the season points are all in play, so there is no offer
      // to make and never was tonight. The card used to vanish outright,
      // which left a 1-2-3 list reading 1, 3, with a two word status row four
      // lines up as the only trace. Same treatment as the closed bank: say
      // which reason it was.
      if (!e.rebuy_cap_chips) { topupFace('topup-none'); return; }
      topupFace('topup-open');
    } else {
      // Night reconciling or beyond: the bank has packed up, while reporting
      // is still running. It gets its own face for the same reason.
      topupFace('topup-over');
    }
  }

  function topupReset() {
    topupQuote = null;
    S.show($('topup-step-count'), true);
    S.show($('topup-step-quote'), false);
    msg($('topup-msg'), '', '');
  }

  /* The bank flow said "already topped up" (this phone raced its own second
   * tap, or an organiser entered it). The recorded row is the truth: fetch
   * it, re-render, and open its slip. Marked RE-SHOW only when the top-up on
   * record was not this page load's own doing. */
  function topupAlreadyDone() {
    return S.myEntry(ctx.night.id, ctx.member.id).then(function (row) {
      if (row) { ctx.entry = row; }
      enterReport();
      if (bankMode()) { openTopupSlip(!topupTakenHere); }
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

  $('topup-start-btn').addEventListener('click', function () { enterTopup(); });

  $('topup-cancel-btn').addEventListener('click', function () {
    topupReset();
    enterReport();
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
        // A step change inside one state, so the order line is set here and
        // not by showState.
        setOrder('Choose how much to take.',
                 'One top-up per night, points for chips 1:1, up to tonight’s stack.');
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
    setOrder(ORDER_DEFAULTS['state-topup'].order, ORDER_DEFAULTS['state-topup'].sub);
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
    // From here on a P0023 belongs to this tap, not to a slip already seen.
    topupTakenHere = true;
    // take_rebuy is row-locked server-side: a double tap cannot issue two.
    // p_current_stack is the server's own echo from the quote, never the live
    // field, so editing the count after quoting cannot slip past the ceiling.
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
        $('topup-reshow-btn').focus();
        openTopupSlip(false);
      })
      .catch(topupError)
      .finally(function () { btn.removeAttribute('aria-busy'); });
  });

  /* ---------------- review ---------------- */

  var reviewed = null; // { final, rebuy } as validated for sending

  $('report-form').addEventListener('submit', function (e) {
    e.preventDefault();

    // The deadline can pass between the render that withdrew Review and the
    // tap that reaches it, and a hidden submit button is still a submit
    // button to a keyboard. Re-render instead of opening a review sheet whose
    // Send has already been taken away: #close-no-send says why and stays
    // said.
    if (reportingClosed()) {
      renderCloseIntro();
      renderDeadline();
      renderCloseRoute();
      return;
    }

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

    // The form goes away while the sheet is up, so the screen has one brass
    // action instead of two, and #submit-btn is the only thing left to tap.
    S.show($('report-form'), false);
    S.show($('review-panel'), true);
    setOrder('Check the maths, then send.', '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('edit-btn').addEventListener('click', function () {
    S.show($('review-panel'), false);
    S.show($('report-form'), true);
    setOrder(ORDER_DEFAULTS['state-close'].order, ORDER_DEFAULTS['state-close'].sub);
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
    // Handing the chips back is the next physical act, so the slip that
    // proves it opens itself, with focus first on a control that is on screen.
    $('closing-slip-btn').focus();
    openClosingSlip(false);
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
      lastReported = { final: job.payload.p_final_stack, rebuy: recordedRebuy() };
    } else if (ctx.entry && ctx.entry.reported) {
      lastReported = { final: ctx.entry.final_stack || 0, rebuy: recordedRebuy() };
    } else {
      return null;
    }
    return lastReported;
  }

  function renderReceipt() {
    var job = myJob();

    // One reading of where this report stands, shared by every face below, by
    // the brass rule and by the organiser card, so they cannot disagree with
    // each other or with the standing order. Stuck is a permanent refusal, or
    // enough quiet retries that "it will go through" has stopped being an
    // honest thing to say.
    //
    // It is read HERE, first. It used to be read six lines under a guard on
    // reportedNumbers(), which answers null in exactly the unknown case, so
    // the unknown face, the brass rule and the standing order at the tail
    // were all unreachable: when the queue emptied under storage pressure
    // this card carried on saying "you can put your phone away" while the
    // slip held up in front of it already read NOT CONFIRMED.
    var verdict = sendVerdict();
    var stuck = jobStuck();

    // The numbers survive the queue losing them, because reading them to an
    // organiser is the whole of what is left to do on an unknown report.
    var nums = shownNumbers();
    if (!nums) { return; }

    var icon = $('receipt-icon');
    var title = $('receipt-title');
    var sub = $('receipt-sub');

    if (verdict === 'sent') {
      icon.textContent = '✓';
      icon.className = 'receipt__icon';
      title.textContent = 'Report received';
      sub.textContent = 'Your numbers are in. The leaderboard updates once the organisers settle the night.';
    } else if (verdict === 'failed') {
      icon.textContent = '!';
      icon.className = 'receipt__icon receipt__icon--saved';
      title.textContent = 'Report not sent';
      sub.textContent = 'Your numbers are safe on this phone, but the server said no.';
    } else if (verdict === 'unknown') {
      // No job in the store, and no reported row on the server. The strongest
      // thing this phone can honestly say is that it does not know. Never
      // dress an absence of information up as a send, and never tell anybody
      // to put their phone away about it.
      icon.textContent = '?';
      icon.className = 'receipt__icon receipt__icon--saved';
      title.textContent = 'Not confirmed';
      sub.textContent = 'This phone can no longer tell whether your report reached the server. Show your numbers to an organiser.';
    } else if (sendRefused()) {
      // Still in the queue, on a settled night or past the deadline. It is
      // not marked refused only because it has not been retried yet:
      // report_entry answers P0003 or P0021 and will keep answering it. A
      // settled night is the moment this number is about to be lost for good,
      // so it is the moment the screen must stop saying it is on its way and
      // start pointing at somebody who can still do something.
      icon.textContent = '!';
      icon.className = 'receipt__icon receipt__icon--saved';
      title.textContent = 'Not sent';
      sub.textContent = nightSettled()
        ? 'The night has been settled, so this phone can no longer send it. Show your numbers to an organiser: settled nights can be corrected and settled again.'
        : 'Reporting has closed, so this phone can no longer send it. Show your numbers to an organiser and they can enter them.';
    } else if (stuck) {
      // The standing order above this card already reads "Show this to an
      // organiser." This card used to answer "you can put your phone away"
      // a couple of centimetres under it, so an escalated screen carried
      // three different instructions at the one moment a first timer is
      // standing at the bank with a queue behind them. It still retries
      // underneath and still says so; it just no longer sends anybody home.
      icon.textContent = '!';
      icon.className = 'receipt__icon receipt__icon--saved';
      title.textContent = 'Still not sent';
      sub.textContent = 'It keeps trying by itself, but it has been a while. Show an organiser the numbers at the top of this screen and they can type them in.';
    } else if (tabOnly()) {
      // localStorage refused the write, so the outbox is holding this in
      // memory and it dies with the tab. "Saved on this phone" would be the
      // strongest reassurance on the site printed over nothing at all, and
      // "you can put your phone away" would be the instruction that loses the
      // report. Neither word appears here.
      icon.textContent = '⏳';
      icon.className = 'receipt__icon receipt__icon--saved';
      title.textContent = 'Held in this tab';
      sub.textContent = 'This phone would not save your report, so it exists only in this tab. It is still sending: keep the tab open until this says Report received, and if you are leaving, read your numbers to an organiser first.';
    } else {
      icon.textContent = '⏳';
      icon.className = 'receipt__icon receipt__icon--saved';
      title.textContent = 'Saved on this phone';
      sub.textContent = navigator.onLine === false
        ? 'You look offline. It will send by itself the moment you have signal. Keep this tab around.'
        : 'Sending… it keeps retrying by itself. You can put your phone away.';
    }

    $('receipt-ledger').innerHTML = mathLedger(nums.final, nums.rebuy).html;

    // The screen’s one brass fill, and on an escalated screen it is NOT this
    // button. The single thing to do there is get the numbers in front of an
    // organiser, which is a card and not a control, so the escalated receipt
    // carries no brass fill at all, the way the hub does while the night is
    // quietly running. Rebuilt wholesale, so no layout class may be hung on
    // this button in markup.
    $('closing-slip-btn').className = (stuck || verdict === 'unknown')
      ? 'btn btn--secondary btn--block'
      : 'btn btn--primary btn--block btn--lg';

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
      // The reason, in the club's own words wherever there are any. This is
      // the last line an organiser reads before typing the number in, so it
      // must not end on a raw server string: report_entry raises P0021 with a
      // sentence that starts in lower case, and sb.js has no wording for that
      // code, so friendlyError hands it straight back. The refusal can also
      // arrive while this phone still has the night as open, which is why the
      // job's own error is read here and not just reportingClosed().
      var refusedText = String((job && job.last_error) || '');
      if (job.status === 'failed' && /^reporting /i.test(refusedText)) {
        $('organiser-why').textContent = 'Reporting has closed for tonight, ' +
          'so the server will not take this from your phone any more. An ' +
          'organiser can still enter it.';
      } else if (job.status === 'failed') {
        $('organiser-why').textContent = S.friendlyError({ message: job.last_error });
      } else if (nightSettled()) {
        $('organiser-why').textContent = 'The night has been settled, so the ' +
          'server will not take this from your phone any more. An organiser ' +
          'can enter it in seconds, and a settled night can be corrected and ' +
          'settled again.';
      } else if (reportingClosed()) {
        $('organiser-why').textContent = 'Reporting closed at ' + closedAtWords() +
          ', so the server will not take this from your phone any more. An ' +
          'organiser can still enter it.';
      } else {
        $('organiser-why').textContent = 'Still retrying in the background (' +
          job.attempts + ' attempts so far). The organiser can enter it from ' +
          'this screen in seconds.';
      }
      // "Try sending again" under a sentence that says not to bother is one
      // card carrying two instructions. On a permanent refusal (P0003, P0021)
      // retrying is the one thing known to fail: retryNow clears the flag,
      // the pump is refused again inside a frame, and the screen lands back
      // exactly where it started, which reads as a broken button and gets
      // tapped again. It stays for the stuck-but-transient case, where it is
      // the button that works.
      S.show($('retry-btn'), job.status !== 'failed' && !sendRefused());
      S.show($('organiser-card'), true);
    } else {
      S.show($('organiser-card'), false);
    }

    // Past the deadline report_entry raises P0021, and on a settled night
    // P0003, so "Change my report" is a route to a form that cannot send. The
    // hub already drops that button and says why in the card; this screen now
    // does the same. The sentence lives in an element of its own, because the
    // old explanation was written into #receipt-sub, which every later render
    // rewrites: opening the closing slip and closing it again wiped it, and
    // that is the single most likely next tap on this screen.
    var refused = sendRefused();
    var closedNote = $('receipt-closed-note');
    S.show($('change-btn'), !refused);
    if (refused) {
      closedNote.textContent = nightSettled()
        ? 'The night has been settled, so an organiser makes any change to your numbers now. Settled nights can be corrected and settled again.'
        : 'Reporting closed at ' + closedAtWords() +
          ', so an organiser makes any change to your entry now.';
    }
    S.show(closedNote, refused);

    // The instruction follows the job too, so a report that goes from sending
    // to sent while the receipt is up stops saying "still trying".
    var o = receiptOrder();
    setOrder(o.order, o.sub);

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
    if (sendRefused() ||
        (ctx.night.status !== 'open' && ctx.night.status !== 'reconciling')) {
      // renderReceipt has already hidden this button in these cases, so this
      // is only reachable by a tap that landed between two renders. Re-render
      // rather than writing a sentence into #receipt-sub: that field is
      // rewritten by every later render, so the explanation would vanish the
      // moment the member opened the closing slip and closed it again, which
      // is exactly what happened before. #receipt-closed-note says it and
      // stays said.
      renderReceipt();
      return;
    }
    // Preload the last number so editing starts from what was sent.
    // enterClose never touches #final-input, so this survives; enterReport
    // would re-read the draft over the top of it.
    var nums = shownNumbers();
    if (nums) { $('final-input').value = String(nums.final); }
    enterClose();
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
   * Boot. It never lands on state-topup or state-close: both are reachable
   * only by a deliberate tap, so a reload mid top-up discards a quote that
   * was stale the moment the page went away, and a reload mid count returns
   * to the hub with the draft already in the field and the note saying so.
   * ------------------------------------------------------------------ */

  /* Event driven, never a timer. It fires when the tab comes BACK to the
   * foreground and when the network returns, which is exactly when the screen
   * is most likely to be lying and exactly when the member is looking anew.
   * A poll was considered and rejected: it can move the heading under a reader
   * who is sitting still. Throttled to once per 30 seconds so a flapping
   * connection cannot hammer the database. Every failure is swallowed: a
   * refresh that cannot reach the server leaves the screen exactly as it was. */
  var refreshedAt = 0;

  function refreshCtx() {
    if (!ctx.member || !ctx.night) { return; }
    if (!$('slip').hidden) { return; }              // at the bank, do not move
    if (Date.now() - refreshedAt < 30000) { return; }
    refreshedAt = Date.now();

    var c = S.client();
    if (!c) { return; }
    // Named columns, never select('*'): the column-level grant that hides
    // nights.code makes '*' fail with 42501 for authenticated members, and it
    // would surface as a silent no-op here.
    c.from('nights').select(S.NIGHT_COLS).eq('id', ctx.night.id).limit(1).maybeSingle()
      .then(function (rn) {
        if (rn.error || !rn.data) { return null; }
        ctx.night = rn.data;
        return S.myEntry(ctx.night.id, ctx.member.id);
      })
      .then(function (row) {
        if (row) { ctx.entry = row; }
        if (!$('slip').hidden) { return; }          // opened during the fetch
        // NEVER re-render these two: a member typing a chip count must not
        // have the screen move under their thumb, and enterClose would re-run
        // the draft precedence over what they are typing.
        if (!$('state-close').hidden || !$('state-topup').hidden) {
          nightBanner();
          // #close-intro and #deadline-line are statements of fact, and
          // #review-btn is a route to a send, so all three follow the server.
          // A tab left open across 09:00 used to keep "the round is still
          // running" and a live brass Send on a screen the server had already
          // stopped accepting. #final-input is still never touched.
          if (!$('state-close').hidden) {
            renderCloseIntro();
            renderDeadline();
            renderCloseRoute();
            // The hub card is hidden behind this screen and is where "Not
            // yet, back to tonight" lands. Nothing here is visible, so it
            // costs nothing to keep it true.
            renderCloseCta();
          }
          renderSync();
          return;
        }
        if (ctx.night.status === 'settled' && !heldUnsent()) {
          nightBanner(); enterSettled();
        } else if (ctx.night.status === 'settled') {
          // A report the server has not got must not be wiped off the screen
          // by the night settling. The settled card carries neither the
          // number nor anybody to show it to, and settling is the exact
          // moment that number is about to be lost for good, so the receipt
          // stays up and escalates instead.
          nightBanner();
          if ($('state-receipt').hidden) { renderReceipt(); showState('state-receipt'); }
        }
        // renderHub, not enterReport: 'online' can fire while a thumb is on
        // the way-out card, and the state change would scroll it away.
        else if (!$('state-report').hidden)  { nightBanner(); renderHub(); }
        else                                 { nightBanner(); }
        // The pill is chrome sitting over every state and it reads the same
        // queue the receipt does, so it is refreshed on every path rather
        // than only when a job happens to exist. A job evicted from the store
        // must not leave "sending soon" above a card that has just admitted
        // it cannot tell. renderSync() re-renders the receipt itself when the
        // receipt is the screen, which is why there is no separate call for
        // it here any more.
        renderSync();
      })
      .catch(function () { /* offline, or the night vanished: leave the screen alone */ });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { refreshCtx(); }
  });
  window.addEventListener('online', refreshCtx);

  function boot() {
    if (!S.configured()) {
      showState('state-config');
      return;
    }

    OB.start(sender);
    // After OB.start, never before: start() is what revives an orphaned
    // 'sending' job, and the watch's first reading should be of the queue as
    // the pump will actually see it.
    setInterval(watchQueue, 1000);

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
            // Same rule as refreshCtx, and the reason this branch reads the
            // queue at all: a report still held on this phone outranks the
            // settled card, which carries neither the number nor anybody to
            // show it to. Reloading used to lose even the pill.
            if (heldUnsent()) {
              renderReceipt();
              showState('state-receipt');
            } else {
              enterSettled();
            }
            renderSync();
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
      setOrder('Could not load tonight.', '');
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
