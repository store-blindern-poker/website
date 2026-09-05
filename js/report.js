/* Store Blindern Poker: report.html behaviour. THE critical screen.
 *
 * A member on a phone, on flaky campus wifi, as the night winds up around
 * 20:30, must be able to:
 *   check in → play → re-buy → close the round → hand the chips back.
 * ONE number is asked for. Everything else on the screen is a fact already
 * on record.
 *
 * The screen is a hub with three errands hanging off it. #state-report is
 * home: it states what is on record and offers the buy-in slip, the bank and
 * the way out. The re-buy and the closing count each get their own state, so
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
 * characters. The code is required at CHECK-IN ONLY, re-buy and
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
 * cannot pass as fresh). Buy-in slip after check-in; re-buy slip after
 * take_rebuy; closing slip after the report, which is the only one that
 * counts chips BACK. A re-buy is therefore always something already on
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
                'state-rebuy', 'state-close',
                'state-receipt', 'state-settled'];

  /* ------------------------------------------------------------------
   * Placing a step, and announcing it.
   *
   * The rule, applied everywhere below: the viewport is placed so the next
   * thing to do is on screen, and focus goes to the element that names the
   * step. Scroll happens FIRST and explicitly; focus happens second with
   * preventScroll. Before this, focus() was doing both jobs, and because
   * focus() on the element that is already document.activeElement is a no-op
   * in Chrome, it only scrolled when the member had just typed in a field.
   * That is why "it jumps back to the top" looked intermittent and why it hit
   * the re-buy and the final stack, the two flows that start in an input.
   * ------------------------------------------------------------------ */

  /* Bring a step into view under the fixed nav. NO behavior key on purpose:
   * scrollIntoView then inherits html{scroll-behavior}, so the reduce rule in
   * css/style.css turns every one of these into a snap without this file ever
   * reading matchMedia. The two window.scrollTo({behavior:'smooth'}) calls
   * this replaces could not be turned off at all.
   * Nothing moves while a slip is up: openSlip puts .no-scroll on body and
   * assumes body is the scroller, so a scroll fired under a slip is swallowed
   * and the reader is somewhere else when they dismiss it. That is already
   * how the receipt ended up resting at scrollY 276 instead of 0. */
  function goToView(anchor) {
    if (!anchor || !$('slip').hidden) { return; }
    anchor.scrollIntoView({ block: 'start' });
  }

  /* Place the step, then announce it. focus() IS the announcement channel:
   * #standing-order and the card headings carry no role and no aria-live, and
   * adding one would announce every step twice. A missing element degrades to
   * the standing order, which is today's behaviour, never to silence. */
  function goToStep(anchor, target) {
    var a = anchor || $('standing-order');
    var t = target || a;
    if (!$('slip').hidden) { return; }
    goToView(a);
    if (t && t.focus) { t.focus({ preventScroll: true }); }
  }

  /* The screen we are on. showState places and announces only on a REAL
   * change, because refreshCtx re-enters the hub when the tab comes back and
   * a member scrolled down to the way-out card must not be thrown to the top
   * for it. Until now that was safe by accident, because focus() on the
   * already focused h1 does nothing. Here it has to be said out loud. */
  var currentState = null;

  /* One anchor per state that needs one. Everything else lands on the
   * standing order, which is where it lands today. The close screen is the
   * exception: its card carries the field, and landing on the page top left
   * the brass primary below the fold. */
  var STATE_STEP = {
    'state-close': { anchor: 'final-card', focus: 'final-card-title' }
  };

  /* quiet: the caller is about to open a slip over this screen, so placing
   * and announcing here would be overwritten a millisecond later anyway. */
  function showState(name, quiet) {
    // A slip is a takeover over ONE screen. Changing screens underneath it
    // would strand it with its timer running and the body unscrollable, so
    // it always closes first. Every slip in this file is opened AFTER its
    // state change, never before.
    if (!$('slip').hidden) { closeSlip(); }
    states.forEach(function (id) { S.show($(id), id === name); });
    var o = stateOrder(name);
    setOrder(o.order, o.sub);
    var changed = (name !== currentState);
    currentState = name;
    // The card is chrome sitting over every screen, like #night-banner and
    // #sync-pill, so it follows the one choke point every screen change
    // already goes through. After currentState is written, because the card
    // reads it to go compact on the check-in screen. Before the early return,
    // because a quiet or repeated showState still has to leave it correct.
    renderOutstanding();
    if (quiet || !changed) { return; }
    var st = STATE_STEP[name];
    goToStep(st ? $(st.anchor) : null, st ? $(st.focus) : null);
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
    'state-loading':     { order: 'Tonight', sub: 'Loading tonight\'s round.' },
    'state-nopseudonym': { order: 'Pick your pseudonym.', sub: 'It is the only name ever shown in public.' },
    'state-nonight':     { order: 'No round tonight.', sub: '' },
    'state-checkin':     { order: 'Type tonight\'s code.', sub: 'It is on the screen at the front, five characters.' },
    'state-rebuy':       { order: 'Count your chips.', sub: 'Count everything in front of you right now, then type the total.' },
    'state-close':       { order: 'Count your chips.', sub: 'Count everything in front of you and type the total.' },
    'state-settled':     { order: 'Tonight is settled.', sub: '' }
  };

  /* Club custom, not a database column, and deliberately not a gate. It also
   * appears verbatim in the #rebuy-open copy in report.html: change both or
   * neither. Nothing anywhere compares it to a clock. */
  var BREAK_TIME_TEXT = 'around 19:15';

  function stateOrder(name) {
    if (name === 'state-report')  { return hubOrder(); }
    if (name === 'state-receipt') { return receiptOrder(); }
    if (name === 'state-close')   { return closeOrder(); }
    return ORDER_DEFAULTS[name] || { order: 'Tonight', sub: '' };
  }

  /* The close screen's instruction. "Count everything in front of you" is
   * about chips on a table and there is no table for a round played last
   * Friday: that member is at home with a number they already know, and the
   * only thing left is to send it. #close-intro two lines below has said so
   * since this screen learned about older nights, and the h1 above it was
   * still giving the other instruction.
   *
   * Every route back to the bare form goes through here, not through
   * ORDER_DEFAULTS: enterClose by way of showState, the review sheet standing
   * itself down in renderCloseRoute, and the Edit button. All three used to
   * read the map directly, so fixing one would have left the other two. */
  function closeOrder() {
    if (!isDefaultNight()) {
      return { order: 'Send your final stack.',
               sub: 'Type the total you finished that round with.' };
    }
    return ORDER_DEFAULTS['state-close'];
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
      if (sendRefused()) {
        // "Close the round again" is an offer the server would refuse, and the
        // card three lines below has just hidden the button that would do it.
        // Both reasons read the same here: reporting is closed once the night
        // is settled, deadline or no deadline.
        return { order: 'You have reported.',
                 sub: 'Reporting has closed, so an organiser makes any change to your numbers now.' };
      }
      // "If you play on" is an offer to somebody sitting at a table with
      // chips in front of them, and there is no table for a round played last
      // Friday. The card below already says there is nothing left to hand
      // back, and #close-start-btn still reads "Change my report", so nothing
      // is withdrawn here, only the sentence that would have sent somebody
      // back to a game that finished a week ago. Same words the receipt uses
      // for the same night, so the two screens agree.
      if (!isDefaultNight()) {
        return { order: 'You have reported.',
                 sub: 'Your numbers are in. The organisers settle that round from here.' };
      }
      return { order: 'You have reported.',
               sub: 'Your numbers are in. If you play on, close the round again with the new total.' };
    }
    var n = ctx.night;
    if (sendRefused()) {
      return { order: 'Show your numbers to an organiser.',
               sub: 'Reporting has closed. An organiser can still enter your final stack.' };
    }
    // Asked BEFORE the status branch below, and every other renderer on this
    // page asks it in that order for the same reason: "count what is in front
    // of you" is an instruction about chips on a table, and there are none in
    // front of anybody for a round played a week ago. An older night is
    // reachable in BOTH statuses, open and reconciling, so the status branch
    // would otherwise catch the reconciling half of them and hand back the
    // one sentence this whole change exists to stop printing. "Go and play"
    // and the break-time line at the tail are the same kind of instruction.
    if (!isDefaultNight()) {
      return { order: 'Send your final stack.',
               sub: 'That round is over. Report the total you finished it with.' };
    }
    if (n && n.status !== 'open') {
      return { order: 'Count your chips.',
               sub: 'The round is over. Count what is in front of you and report the total.' };
    }
    // A member who has already taken a re-buy must not read a line offering one
    // at 19:20. The offer card disappears in the same breath; this is the
    // heading agreeing with it.
    if (recordedRebuy() > 0) {
      return { order: 'Go and play.',
               sub: 'Your re-buy is on record. Close the round when you are done.' };
    }
    // rebuy_cap_chips 0: the season points are all in play, so the bank has
    // nothing for this member and never had tonight. Sending them to it at
    // 19:15 is a promise the screen already knows it cannot keep. The card
    // below says the same thing in full.
    if (ctx.entry && !ctx.entry.rebuy_cap_chips) {
      return { order: 'Go and play.',
               sub: 'Your points are all in play, so there is no re-buy tonight.' };
    }
    return { order: 'Go and play.',
             /* "The bank OPENS at" reads as a start time, and there is no
              * start time: take_rebuy has no time gate and the button is
              * live from 18:00. A member reading this at 18:10 concluded
              * the bank was shut, which is the opposite of the rule, and it
              * contradicted the re-buy card 600px below saying there is
              * nothing to miss. Says when it usually happens instead. */
             sub: 'Most people re-buy at the first break, ' + BREAK_TIME_TEXT + '.' };
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
    // Reporting is over and nothing is left in the queue. The chips went back
    // when the round ended, so "Hand your chips back." is a stale instruction,
    // and the only thing that can still change anything is an organiser.
    // sendRefused(), not reportingClosed(): with no deadline set it is
    // settling that ends reporting. A report still queued never reaches here,
    // because jobStuck() answers first for it.
    if (sendRefused()) {
      return { order: 'You have reported.',
               sub: 'Reporting has closed, so an organiser makes any change to your numbers now.' };
    }
    // The chips went back when that round ended, so "Hand your chips back."
    // is a stale instruction and the busted line below it is a stale reason.
    // Placed after the stuck, unknown and refused branches, which are correct
    // copy for any night.
    if (!isDefaultNight()) {
      return { order: 'That round is done.',
               sub: (job && job.status !== 'sent')
                 ? 'Your final stack is on its way. It keeps sending by itself.'
                 : 'Your final stack is in. The organisers settle that round from here.' };
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

  /* A link may name a night: /report?r=<night id>. The night ID, NEVER the
   * attendance code. nights.code is admin only behind get_night_code, and
   * putting it in a URL would hand the check-in gate to anybody who saw the
   * link; the id opens nothing on its own, check_in still wants the code and
   * report_entry still wants the session, and it is already exposed to anon
   * through v_upcoming_nights.
   *
   * It does NOT survive signing in, and no email may depend on it.
   * requireAuth sends a signed out member to login.html?next=report.html and
   * login.js redirects back to the bare whitelisted page name, so the query
   * string is dropped on the way through. That is why the bare /report link
   * in the reminder mail is what everything below is written to serve, and
   * this parameter is only ever a convenience for a member who is already
   * signed in. */
  var urlNightId = (function () {
    var raw = new URLSearchParams(window.location.search).get('r') || '';
    return /^[0-9a-fA-F-]{36}$/.test(raw) ? raw : '';
  })();

  /* The night boot landed on, and the entry it found there. Written once and
   * never reassigned: this is the way back to tonight from any older night,
   * so it must not drift while the member is away. */
  var defaultNight = null;
  var defaultEntry = null;

  /* Open nights this member has an unreported entry on, oldest first, and
   * their own entry rows keyed by night id. Filled AFTER the screen has
   * painted and never waited on by anything. */
  var outstanding = [];
  var outstandingEntries = {};

  /* What #other-night-btn will switch to, written only by
   * renderOutstanding(). */
  var offerNight = null;
  var offerEntry = null;

  /* Non-null rebuy_at means the BANK issued the re-buy, so there is a slip
   * to re-show and the server defends the number against this client. */
  function bankMode() {
    return !!(ctx.entry && ctx.entry.rebuy_at);
  }

  /* The re-buy on record, whoever put it there. This is the only re-buy
   * figure this screen ever reads, shows or sends. */
  function recordedRebuy() {
    return (ctx.entry && ctx.entry.rebuy_chips) || 0;
  }

  /* An organiser typed it into admin.html after handing chips across the
   * table: a real re-buy with no slip behind it. Worth stating, and worth
   * never overwriting. */
  function organiserRebuy() {
    return !bankMode() && recordedRebuy() > 0;
  }

  /* The night's own reporting deadline, or null when it has none. Null is the
   * normal case: reporting runs until the organisers settle, and settling is
   * what report_entry refuses on. An organiser can still set a deadline by
   * hand for a single night, so every reader goes through here and nothing
   * downstream parses the column a second way or reads a missing deadline as
   * a passed one. */
  function deadlineAtFor(n) {
    var t = (n && n.reports_close_at) ? new Date(n.reports_close_at) : null;
    return (t && !isNaN(t)) ? t : null;
  }

  function deadlineAt() {
    return deadlineAtFor(ctx.night);
  }

  /* A deadline was set by hand for this night and it has passed. False all
   * night when there is none, which is why nothing that needs to know whether
   * a send can still land may read this alone: sendRefused() is that
   * question. It is NOT the re-buy break, which is guidance and never a
   * gate. */
  function reportingClosedOn(n) {
    var t = deadlineAtFor(n);
    return !!(t && Date.now() >= t.getTime());
  }

  function reportingClosed() {
    return reportingClosedOn(ctx.night);
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

  /* "09:00 today", for copy that has to name a hand-set deadline inside a
   * sentence. Empty when there is none, so every caller must sit behind
   * reportingClosed() and never behind sendRefused() alone: a settled night
   * has no time to name and would print "Reporting closed at , so". That is
   * why each swap below carries a nightSettled() branch. renderDeadline
   * builds its own line with a mono span, so this one is plain text. */
  function closedAtWords(night) {
    /* The argument is for the other-night card, which has to name a hand-set
     * deadline on a night that is not the one on screen. Every existing
     * caller passes nothing and is unchanged. */
    var t = night ? deadlineAtFor(night) : deadlineAt();
    if (!t) { return ''; }
    return osloClock(t, false) + ' ' + osloDayWord(t);
  }

  /* ------------------------------------------------------------------
   * Oslo time. A hand-set deadline and the slips are read in one room, in
   * one timezone; the phone's own zone is irrelevant.
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

  /* The re-buy on record can change AFTER a report is queued. An organiser
   * hands chips across the table at 20:33 and types the number into
   * admin.html while this phone is still retrying on bad wifi, which is the
   * same bad wifi the outbox exists for, so the two go together more often
   * than not. The payload was frozen at Send with whatever was on record
   * then, and report_entry defends the BANK's number (rebuy_at set) but
   * overwrites an ORGANISER's (rebuy_at null) with whatever the parameter
   * says, so posting the frozen 0 would quietly write the organiser's 4,000
   * down to nothing, with the receipt still reading the record and showing
   * no sign of it. So the figure is re-read from the server on EVERY
   * attempt, immediately before the post. The read can never fail the send:
   * any error falls back to the queued figure, which is what would have gone
   * anyway. The member's own number, p_final_stack, is never touched here.
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

  /* A draft is the one number being typed, nothing else. Re-buys live at
   * the bank, so there is never a re-buy worth drafting. */
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
   * stale re-buy is dropped on the floor rather than resurrected. */
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
     * Those are two different facts and they disagree whenever an organiser
     * has set a deadline by hand: past reports_close_at the column still
     * reads 'open', because the
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
      ledgerRow(bankMode() ? 'Re-buy (bank)' : 'Re-buy',
                rebuy > 0 ? '−' + S.fmt(rebuy) : '0', { minus: rebuy > 0 }) +
      ledgerRow('Final stack', '+' + S.fmt(finalStack), { plus: finalStack > 0 }) +
      ledgerRow(isDefaultNight() ? 'Net for tonight' : 'Net for that round',
                S.fmtSigned(net),
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
   * and re-buy are chips leaving the bank, so the slip says GIVE. Closing is
   * chips coming back, so it says COLLECT FROM and counts in chips back. */
  var SLIP_KICKER    = { buyin: 'Buy-in', rebuy: 'Re-buy', closing: 'Closing' };
  var SLIP_DIRECTION = { buyin: 'GIVE',   rebuy: 'GIVE',   closing: 'COLLECT FROM' };
  var SLIP_UNIT      = { buyin: 'chips',  rebuy: 'chips',  closing: 'chips back' };

  /* Colour is faster than a word at four metres in bad light, and the words
   * carry the same information independently, so a colour-blind organiser
   * loses nothing: brass and felt also differ hard in lightness. Brass on
   * --on-brass is about 8.2:1, cream on --felt about 11:1. Both survive a
   * dimmed phone at 20:35. */
  var SLIP_BAND = {
    buyin:   { text: 'GIVE CHIPS OUT',  cls: 'slip__band--give' },
    rebuy:   { text: 'GIVE CHIPS OUT',  cls: 'slip__band--give' },
    closing: { text: 'TAKE CHIPS BACK', cls: 'slip__band--take' }
  };

  var SLIP_AGE_VERB = { buyin: 'Checked in', rebuy: 'Taken at the bank', closing: 'Reported' };

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

  /* opts: { kind: 'buyin' | 'rebuy' | 'closing', amount, note (string html-safe
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
    var back = slipReturnFocus;   // closeSlip clears it
    closeSlip();
    renderSync();
    /* <body> is what slipReturnFocus holds when the slip was opened by a
     * tap that never focused its button, which is most taps on a phone.
     * body.closest('.card') is null, so the fallback below scrolled <body>
     * into view, and that is the top of the page: the exact jump this
     * whole change exists to remove, reintroduced on the one path nobody
     * clicks with a keyboard. Body is not a place to return to, so the
     * reader is simply left where they already were. */
    if (back === document.body || back === document.documentElement) { back = null; }
    // Put the card that button belongs to under the nav. The receipt's own
    // headline used to sit behind the fixed nav at the exact moment it was
    // the whole point of the screen, and the next errand after a re-buy slip
    // was 19px below the fold.
    if (back && document.contains(back)) {
      // The escalated receipt inverts that rule. There the h1 reads "Show
      // this to an organiser." and the thing it points at is #organiser-card,
      // which sits ABOVE the receipt card and is not an ancestor of the
      // button that opened the slip, so closest('.card') found the receipt
      // card BELOW it and scrolled the payload and #retry-btn off the top,
      // the last 64px of it behind the fixed nav. This is the one screen
      // where a number is closest to being lost, so it gets the landing.
      // Focus goes with the scroll: #closing-slip-btn is about 1100px below
      // this card, and a focus ring parked off screen is no better than none.
      // The heading is what the standing order is pointing at, so it is what
      // gets announced.
      var esc = $('organiser-card');
      // The card lives inside #state-receipt and keeps its own hidden state
      // when the member walks off to another screen, so both are checked.
      // Both are read defensively: a missing element falls through to the
      // ordinary landing rather than throwing inside a dismissal.
      var rec = $('state-receipt');
      if (esc && !esc.hidden && rec && !rec.hidden) {
        goToStep(esc, $('organiser-title'));
      } else {
        goToStep((back.closest ? back.closest('.card') : null) || back, back);
      }
    }
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

  function openRebuySlip(reshow) {
    var e = ctx.entry;
    // The guard that stops an organiser-recorded re-buy from ever printing a
    // slip for chips the bank never issued.
    if (!e || !e.rebuy_at) { return; }
    var becomes = (e.rebuy_stack_before !== null && e.rebuy_stack_before !== undefined)
      ? e.rebuy_stack_before + (e.rebuy_chips || 0)
      : null;
    openSlip({
      kind: 'rebuy',
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
  $('rebuy-reshow-btn').addEventListener('click', function () { openRebuySlip(true); });
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
   * move, about a number the server may not hold. The server's own entries
   * row is the only thing that may say SENT without a job behind it. It is a
   * leaf, safe to call from the slip's per-second tick: it reads the queue and
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
    // The oldest pending night's job rides in here too, because the card
    // below reports it and nothing else on this page reads a job for a night
    // that is not the one on screen. Without it, "Round 1 is still sending"
    // would still be on the card a minute after Round 1 landed.
    var other = pendingNights()[0];
    var oj = (other && ctx.member) ? OB.get(other.id, ctx.member.id) : null;
    return [job ? job.status : '-',
            job ? job.attempts : '-',
            sendVerdict(),
            jobStuck() ? 'stuck' : '-',
            tabOnly() ? 'tab' : '-',
            navigator.onLine === false ? 'off' : 'on',
            other ? other.id : '-',
            oj ? oj.status : '-'].join('|');
  }

  /* What the HUB reads, which is deliberately less. job.attempts and the flip
   * from queued to sending and back appear nowhere on that screen, and they
   * change on every retry, so re-rendering the hub on them moved the screen
   * under a member who was sitting still while nothing they could see had
   * changed. Whether the server would still take a report is in here because
   * it rewrites the whole card with no queue event behind it. */
  function hubSignature() {
    var nums = shownNumbers();
    var d = loadDraft();
    return [sendVerdict(),
            myJob() ? 'job' : '-',
            nums ? nums.final : '-',
            recordedRebuy(),
            sendRefused() ? 'closed' : '-',
            (d && d.final) || '-'].join('|');
  }

  function watchQueue() {
    // At the bank. The slip is a takeover with its own tick and its own
    // verdict line, and re-rendering the hub underneath it would close it.
    if (!$('slip').hidden) { return; }
    var sig = queueSignature();
    if (sig !== syncSig) { syncSig = sig; renderSync(); renderOutstanding(); }
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
    // isDefaultNight(): the QR on the venue TV encodes TONIGHT's code, and a
    // ?r= link can name an older night. Nothing routes there today, because
    // an older night is only ever offered when an entry already exists and
    // this is the no-entry screen, but the prefill must not be the thing that
    // makes that a bug later.
    if (urlCode && isDefaultNight() && !$('code-input').value) {
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
        // Quiet: the slip below takes the screen a millisecond later, so
        // placing and announcing the hub here would be work nobody sees.
        enterReport(true);
        // The first thing the player does after checking in is collect
        // chips, so the buy-in slip opens itself. Focus lands on a control
        // that is actually on screen first, because openSlip remembers
        // document.activeElement and closeSlip hands focus back to it: this
        // line is what decides where the reader is put down afterwards, so it
        // is not dead code. preventScroll, because dismissSlip does the
        // placing once the slip is out of the way.
        $('buyin-slip-btn').focus({ preventScroll: true });
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
    // re-buy already taken, and the difference is what the member walks to
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
    } else if (!isDefaultNight()) {
      // An older night. Whatever the status column says, the bank packed up
      // when that round ended, and "not taken yet" would be an offer.
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

    // The buy-in slip says GIVE CHIPS OUT in 24px, and until this screen
    // could show an older night there was no way to reach one for a round
    // that had finished. Now there is, so the button goes with the closing
    // slip and the bank offer. The buy-in itself is not hidden: it is two
    // rows up, on the card, as "Buy-in booked". Only the instruction to an
    // organiser to count chips out goes.
    S.show($('buyin-slip-btn'), isDefaultNight());

    renderRebuy();
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
  function enterReport(quiet) {
    var e = ctx.entry;
    renderHub();

    // Prefill the one input: server row wins if already reported, else the
    // local draft, else whatever is already in the field (which is what lets
    // "Change my report" preload the last number). A re-buy, if any, is
    // stated by the bank card above and is never something this form fills in.
    var draft = loadDraft();
    if (e.reported) {
      $('final-input').value = e.final_stack === null ? '' : String(e.final_stack);
    } else if (draft) {
      $('final-input').value = draft.final;
      $('bust-btn').classList.toggle('btn--bust--on', draft.busted);
    }

    showState('state-report', quiet);
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
    // sendRefused(), not reportingClosed(): with no deadline set it is
    // settling that ends reporting, and it can land while this card is on
    // screen. The deadline alone left "Change my report" and "Close my round"
    // live on a settled night, both routes to a refused send.
    var refused = sendRefused();
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
        (isDefaultNight()
          ? '. Show the closing slip as you hand your chips back.'
          : '. That round is over, so there is nothing left to hand back.') +
        (refused
          ? (nightSettled()
              ? ' The night has been settled, so an organiser makes any ' +
                'change to it now.'
              : ' Reporting closed at ' + closedAtWords() +
                ', so an organiser makes any change to it now.')
          : '');
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
      // The slip is the artefact for a chip handover, and on an older night
      // there is no handover: it reads COLLECT FROM in 24px over a round
      // whose chips went back last Friday, and the sentence directly above it
      // has just said there is nothing left to hand back. One card, one
      // instruction. The number itself is on this card and on the receipt, so
      // nothing is lost with the button.
      S.show(slipBtn, isDefaultNight());
      btn.textContent = 'Change my report';
      btn.className = 'btn btn--secondary btn--block';
      // A refused send is refused whatever the network does (P0021 past a
      // hand-set deadline, P0003 once settled), so "Change my report" is a
      // route to a form that cannot send. The sentence above says who to talk
      // to instead.
      S.show(btn, !refused);
    } else if (refused) {
      // Nothing on this phone can reach the server any more, so the card
      // carries no control at all: it says why the two buttons are gone and
      // gives the one thing that still works. The standing order above it
      // already reads "Show your numbers to an organiser." nightSettled() is
      // asked first, because a settled night has no time to name and
      // closedAtWords() would hand back an empty string mid sentence.
      if (nightSettled()) {
        label.textContent = '3 · The night is settled';
        text.textContent = 'The night has been settled, so this phone can no ' +
          'longer send your final stack, and the bank has shut. Count your ' +
          'chips and read the total to an organiser: they can still enter ' +
          'it, and a settled night can be corrected and settled again.';
      } else {
        label.textContent = '3 · Reporting has closed';
        text.textContent = 'Reporting closed at ' + closedAtWords() +
          ', so this phone can no longer send your final stack, and the bank ' +
          'has shut. Count your chips and read the total to an organiser: ' +
          'they can still enter it for you.';
      }
      S.show(slipBtn, false);
      S.show(btn, false);
    } else if (!isDefaultNight()) {
      // An older night that is still open. Reporting is the only thing left
      // on it, so this card takes the screen's one brass fill by the same
      // rule that promotes it once a night leaves 'open'. None of the words
      // about tonight, the count in front of you or the chips going back are
      // true here.
      label.textContent = '3 · Send your final stack';
      text.textContent = 'That round is over, and reporting for it is open ' +
        'until the organisers settle it. Send the total you finished it ' +
        'with. If you are not sure to the chip, your best honest count is ' +
        'what we want, and an organiser can change it afterwards.';
      S.show(slipBtn, false);
      S.show(btn, true);
      btn.textContent = 'Send my final stack';
      btn.className = 'btn btn--primary btn--block btn--lg';
    } else {
      label.textContent = '3 · Close the round';
      // No deadline is invented here. With reports_close_at null there is no
      // time to name and reporting runs until the organisers settle; when one
      // has been set by hand, closedAtWords() names it AND the settle, because
      // settle_night can land before a deadline and refuses with P0003. The
      // organiser sentence is the rescue the first real night did not have.
      // This copy is duplicated as the pre-render default of #close-card-text
      // in report.html: change both or neither.
      text.textContent = 'When you are done for the night, count your chips ' +
        'and report the total. You get a closing slip to show an organiser ' +
        'while you hand the chips back. ' +
        (reportingClosed() || !deadlineAt()
          ? 'No rush: reporting stays open until the organisers settle the ' +
            'night. If you go home without reporting, an organiser can still ' +
            'enter your numbers by hand.'
          : 'Reporting is open until the organisers settle the night, and no ' +
            'later than ' + closedAtWords() + ', Oslo time. If you go home ' +
            'without reporting, an organiser can still enter your numbers by ' +
            'hand.');
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
    // keeps the number, and until now nothing said so. It is also the only
    // place a member who walked away mid count meets their own unsent number
    // on the way back, so it now says out loud that it is unsent: the guard
    // above means it can never appear once a report exists.
    var d = loadDraft();
    var note = $('hub-draft-note');
    if (!reported && d && d.final) {
      // "nothing has been sent yet" promises a send that is now impossible if
      // the card two centimetres above has just said this phone cannot send.
      // The number itself stays either way: it is the thing an organiser
      // needs, and hiding it would throw it away.
      note.textContent = refused
        ? 'You started closing the round. Your count of ' + d.final +
          ' is saved on this phone. It was never sent, so read it to an organiser.'
        : 'You started closing the round. Your count of ' + d.final +
          ' is saved on this phone and nothing has been sent yet.';
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
    if (nightSettled()) {
      // Asked first, and asked before the deadline: with reports_close_at
      // null, settling is the only thing that ends reporting. Settled used to
      // fall through to "The organisers are closing the night. Report your
      // final stack now." over a Send that report_entry answers with P0003.
      el.textContent = 'The night has been settled, so nothing sent from here will be accepted. Show your numbers to an organiser: a settled night can be corrected and settled again.';
    } else if (reportingClosed()) {
      // This branch used to be missing entirely, so the intro read "The round
      // is still running" directly above a deadline line that read, in clay,
      // that reporting had closed.
      el.textContent = 'Reporting has closed, so nothing sent from here will be accepted. Show your numbers to an organiser and they can enter them.';
    } else if (reportedNumbers()) {
      el.textContent = 'You already reported. Change the number and send again: the new report replaces the old one.';
    } else if (!isDefaultNight()) {
      // "The round is still running" is false about a night played a week
      // ago. Asked after the settled, closed and already-reported branches,
      // which are correct copy for any night.
      el.textContent = 'That round is over and reporting for it is still open. Type the total you finished it with.';
    } else if (ctx.night && ctx.night.status === 'open') {
      el.textContent = 'The round is still running. Only close if you are done playing for tonight.';
    } else {
      el.textContent = 'The organisers are closing the night. Report your final stack now.';
    }
  }

  /* The close screen's send route, withdrawn when the server will refuse it.
   * #close-intro and #deadline-line are statements of fact and #review-btn is
   * a route to a send, so all three follow the server rather than the moment
   * enterClose happened to run. A tab left open across the end of the night
   * had the intro still reading "the round is still running" over a live
   * brass Send. #final-input is never touched here: a member typing a chip
   * count must not have the field move under their thumb, and the count is
   * still worth having for the organiser. */
  function renderCloseRoute() {
    // sendRefused(), not reportingClosed(). With no deadline set, settling is
    // the act that ends reporting, and it lands while members are still on
    // this screen: refreshCtx returns early whenever #state-close is up, so
    // this function IS the settled path for them. The deadline alone left
    // Review and Send live for report_entry to answer with P0003.
    var refused = sendRefused();
    S.show($('review-btn'), !refused);
    S.show($('close-next-help'), !refused);
    S.show($('submit-btn'), !refused);
    // Goes with #submit-btn, so "Not done until the receipt is on screen" is
    // never left standing over a Send that has been withdrawn.
    S.show($('review-not-done'), !refused);
    // nightSettled() is asked first: a settled night has no deadline to name,
    // and closedAtWords() would hand back an empty string mid sentence.
    if (!refused) {
      $('close-no-send').textContent = '';
    } else if (nightSettled()) {
      $('close-no-send').textContent = 'The night has been settled, so ' +
        'nothing can be sent from this phone now. Count your chips and read ' +
        'the total to an organiser: they can still enter it, and a settled ' +
        'night can be corrected and settled again.';
    } else {
      $('close-no-send').textContent = 'Reporting closed at ' +
        closedAtWords() + ', so nothing can be sent from this phone now. ' +
        'Count your chips and read the total to an organiser: they can ' +
        'still enter it for you.';
    }
    S.show($('close-no-send'), refused);
    if (refused && !$('review-panel').hidden) {
      // The review sheet is a route to the same send, so a member who was
      // already looking at it when reporting ended goes back to the form and
      // its explanation rather than sitting in front of a Send button that
      // cannot work.
      S.show($('review-panel'), false);
      S.show($('report-form'), true);
      setOrder(closeOrder().order, closeOrder().sub);
      // The swap hides the element that held focus, which drops
      // document.activeElement to BODY and leaves the explanation silent.
      // Place the card and announce its heading instead. Reached from
      // enterClose, from the submit handler's guard and from
      // refreshCtx on a tab return, never from a timer.
      goToStep($('final-card'), $('final-card-title'));
    }
  }

  function enterRebuy() {
    S.show($('rebuy-flow'), true);   // renderRebuy hid it on the way home
    rebuyReset();
    showState('state-rebuy');
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
   * Deadline line: the hand-set nights.reports_close_at, in Oslo time.
   * Most nights have none and this line never appears at all. The server
   * enforces the ones that do exist (P0021); this line just keeps nobody
   * surprised by one.
   * ------------------------------------------------------------------ */
  function renderDeadline() {
    var el = $('deadline-line');
    var t = deadlineAt();
    // No deadline is the normal case, and there is nothing true to say about
    // one that does not exist. The line stays hidden rather than naming a
    // time; #close-intro carries the state of the night instead.
    if (!t) { S.show(el, false); return; }
    // A settle can land BEFORE a hand-set deadline, so the deadline on its
    // own is not enough to go on. Without this, the line read "You can report
    // until 09:00 tomorrow" two centimetres above #close-no-send saying the
    // night is settled and nothing can be sent. A window this phone does not
    // have is the one thing the screen must never offer, so the line stands
    // down and lets #close-intro and #close-no-send tell the one story.
    if (nightSettled()) { S.show(el, false); return; }
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
    // The button now sits BELOW the primary, so the 0 it just wrote is off
    // screen above. Scroll only, no focus: #final-msg is the one step level
    // announcement on this screen that already works, and moving focus would
    // talk over it.
    goToView($('final-card'));
  });

  $('final-input').addEventListener('input', function () {
    var v = S.parseChips($('final-input').value);
    $('bust-btn').classList.toggle('btn--bust--on', v === 0);
    msg($('final-msg'), '', '');
    saveDraft();
  });

  /* ------------------------------------------------------------------
   * Re-buy at the bank. count your chips → rebuy_quote → pick an amount
   * → take_rebuy → slip. Every branch ends in a message or a slip;
   * nothing is ever left spinning.
   * ------------------------------------------------------------------ */
  var rebuyQuote = null;   // last rebuy_quote result, while step 2 is up

  /* Set the moment this page load fires its first "Take it", and never
   * cleared. On a slow connection a second tap gets away before the first
   * answer lands; take_rebuy is row-locked, so the later taps come back
   * P0023 and route through rebuyAlreadyDone. That refusal is one tap
   * landing twice, not somebody looking at a slip for the second time, so
   * the slip it opens is this member's FIRST slip. Clay RE-SHOW is the one
   * alarm colour on the slip and it must never point at a member who did
   * nothing but tap a laggy button, while an organiser reads it across the
   * table. A genuine re-show comes from "Show the slip again" and calls
   * openRebuySlip(true) directly, so it still reads RE-SHOW. */
  var rebuyTakenHere = false;

  /* The faces, and #rebuy-flow is the one that now lives in #state-rebuy:
   * this list spans two state divs on purpose. */
  function rebuyFace(name) {
    ['rebuy-open', 'rebuy-flow', 'rebuy-done', 'rebuy-organiser',
     'rebuy-closed', 'rebuy-settled', 'rebuy-none', 'rebuy-over']
      .forEach(function (id) { S.show($(id), id === name); });
    S.show($('rebuy-card'), !!name);
  }

  /* #rebuy-over is the one face two branches share, and the two are not
   * saying the same thing. On tonight's round, once it stops being open,
   * there are chips in front of the reader and counting them is the next
   * thing to do. On a round played last Friday there are none, and "count
   * your chips" would be the stale instruction this screen keeps having to
   * take out. The tonight wording is also the markup's pre-render default in
   * report.html: change both or neither. */
  var REBUY_OVER_TONIGHT = 'The round is over, so the bank has stopped ' +
    'issuing re-buys. Reporting is still open: count your chips and close ' +
    'the round below.';
  var REBUY_OVER_OLDER = 'That round is over, so the bank packed up with it. ' +
    'Reporting for it is still open: send the total you finished it with.';

  function renderRebuy() {
    var e = ctx.entry;
    if (!e) { rebuyFace(null); return; }
    if (e.rebuy_at) {
      // The bank issued it: a quiet record, and the slip on demand.
      $('rebuy-done-amount').textContent = S.fmt(recordedRebuy());
      var t = new Date(e.rebuy_at);
      $('rebuy-done-time').textContent = isNaN(t) ? '…' : osloClock(t, false);
      rebuyFace('rebuy-done');
    } else if (organiserRebuy()) {
      // Recorded by hand. No slip to show, and no second helping: offering
      // the bank here would let take_rebuy overwrite the organiser's number.
      $('rebuy-organiser-amount').textContent = S.fmt(recordedRebuy());
      rebuyFace('rebuy-organiser');
    } else if (nightSettled()) {
      // A settled night used to fall through to #rebuy-over, whose copy says
      // "Reporting is still open", which is the one thing it is not. It does
      // NOT get #rebuy-closed either: take_rebuy shuts the bank at status
      // <> 'open', which is close_reporting, so on a settled night the bank
      // shut BEFORE reporting did and that card's first clause would be
      // backwards. Its own face, saying the true thing.
      rebuyFace('rebuy-settled');
    } else if (reportingClosed()) {
      // A hand-set deadline has passed. Asked BEFORE the open-night branch,
      // because the night status can still read 'open' past it and the offer
      // would come back with it. Withdrawing the offer here is a club choice,
      // not the server's: take_rebuy has no deadline guard, so the copy on
      // #rebuy-closed states the club's position and not the server's. The
      // card says why it is gone: a member who watched a button disappear
      // goes hunting for it, which is the ambiguity this screen exists to
      // remove.
      rebuyFace('rebuy-closed');
    } else if (!isDefaultNight()) {
      // An older night, in either status it can still be reached in.
      // take_rebuy tests the STATUS and nothing else, so on one still reading
      // 'open' the bank would really issue chips against a round that
      // finished days ago: a member on last week's hub taps Re-buy, walks to
      // the bank, and an organiser counts out chips for a round that is over.
      // Asked BEFORE the status branch for exactly the reason the
      // reportingClosed() branch above is. Withdrawing the offer is the
      // club's position, not the server's.
      $('rebuy-over-text').textContent = REBUY_OVER_OLDER;
      rebuyFace('rebuy-over');
    } else if (ctx.night && ctx.night.status === 'open') {
      // No allowance: the season points are all in play, so there is no offer
      // to make and never was tonight. The card used to vanish outright,
      // which left a 1-2-3 list reading 1, 3, with a two word status row four
      // lines up as the only trace. Same treatment as the closed bank: say
      // which reason it was.
      if (!e.rebuy_cap_chips) { rebuyFace('rebuy-none'); return; }
      rebuyFace('rebuy-open');
    } else {
      // TONIGHT's night, reconciling or beyond: the bank has packed up, while
      // reporting is still running. It gets its own face for the same reason.
      // The text is restated rather than left to the markup, because the
      // branch above shares this face and writes different words into it.
      $('rebuy-over-text').textContent = REBUY_OVER_TONIGHT;
      rebuyFace('rebuy-over');
    }
  }

  function rebuyReset() {
    rebuyQuote = null;
    S.show($('rebuy-step-count'), true);
    S.show($('rebuy-step-quote'), false);
    msg($('rebuy-msg'), '', '');
  }

  /* The bank flow refused with P0023: a re-buy is already on record (this
   * phone raced its own second tap, or an organiser entered it). The
   * recorded row is the truth: fetch it, re-render, and open its slip.
   * Marked RE-SHOW only when the re-buy on record was not this page
   * load's own doing. */
  function rebuyAlreadyDone() {
    return S.myEntry(ctx.night.id, ctx.member.id).then(function (row) {
      if (row) { ctx.entry = row; }
      enterReport();
      if (bankMode()) { openRebuySlip(!rebuyTakenHere); }
    }).catch(function () {
      msg($('rebuy-msg'),
          'A re-buy is already recorded for you tonight. Reload to see it, or ask an organiser.',
          'error');
    });
  }

  function rebuyError(err) {
    var code = err && err.code;
    if (code === 'P0023') { return rebuyAlreadyDone(); }
    var text;
    if (code === 'P0022') {
      text = 'You are not checked in to tonight\'s round. Check in first.';
    } else if (code === 'P0001') {
      // The flow stays on screen ON PURPOSE: #rebuy-msg lives inside
      // #rebuy-flow, and renderRebuy() here would hide the flow and the
      // explanation with it. The offer disappears on the next reload.
      text = 'The night is no longer open, so the bank is closed. An organiser can still help.';
    } else if (code === 'P0024') {
      text = 'No re-buy is available: nothing fits between your stack and tonight\'s ceiling.';
    } else if (code === 'P0025') {
      text = S.friendlyError(err) + ' Go back and check the chip count.';
    } else {
      text = S.friendlyError(err);
    }
    msg($('rebuy-msg'), text, 'error');
    return Promise.resolve();
  }

  $('rebuy-start-btn').addEventListener('click', function () { enterRebuy(); });

  $('rebuy-cancel-btn').addEventListener('click', function () {
    rebuyReset();
    enterReport();
  });

  $('rebuy-stack-input').addEventListener('input', function () {
    msg($('rebuy-msg'), '', '');
  });

  $('rebuy-quote-btn').addEventListener('click', function () {
    var stack = S.parseChips($('rebuy-stack-input').value);
    if (stack === null) {
      msg($('rebuy-msg'), 'Count the chips in front of you and type the total. 0 counts.', 'error');
      goToStep($('rebuy-step-count'), $('rebuy-stack-input'));
      return;
    }
    var btn = $('rebuy-quote-btn');
    btn.setAttribute('aria-busy', 'true');
    msg($('rebuy-msg'), '', '');
    S.client().rpc('rebuy_quote', { p_night_id: ctx.night.id, p_current_stack: stack })
      .then(function (r) {
        if (r.error) { throw r.error; }
        var q = r.data;
        if (!q || !q.eligible) {
          var reason = q && q.reason;
          if (reason === 'holding_full_stack') {
            msg($('rebuy-msg'),
                'You are holding tonight\'s full stack (' + S.fmt(q.stack_size) +
                '), so there is no re-buy to take.', 'error');
          } else if (reason === 'no_points_left') {
            msg($('rebuy-msg'),
                'Your season points are spent, so there is no re-buy left tonight. You still play what you hold.',
                'error');
          } else {
            msg($('rebuy-msg'), 'No re-buy is available right now.', 'error');
          }
          return;
        }
        rebuyQuote = q;
        $('rebuy-max-line').innerHTML = 'You can take up to <span class="mono">' +
          S.escapeHtml(S.fmt(q.max_topup)) + '</span>.';
        $('rebuy-amount-input').value = String(q.max_topup);
        rebuyBecomes();
        S.show($('rebuy-step-count'), false);
        S.show($('rebuy-step-quote'), true);
        // A step change inside one state, so the order line is set here and
        // not by showState.
        setOrder('Choose how much to take.',
                 'One re-buy per night, points for chips 1:1, up to tonight\'s stack.');
        // The quote step goes under the nav and the step is announced from
        // the field it is about: "Chips to take (edit to take less), edit
        // text, 4000". Until now this step change moved neither scroll nor
        // focus, so the h1 changed in silence while focus sat on the field
        // the step had just hidden.
        // Focus stays INSIDE the element we scrolled to, as it does at every
        // other step. Announcing the new h1 instead meant focusing
        // #standing-order, which is 375px above this step: a live 2px brass
        // focus ring was being painted off the top of the screen. The two
        // other ways into this step, a bad amount and the back button, land
        // on this same field, so the step now has one landing place.
        goToStep($('rebuy-step-quote'), $('rebuy-amount-input'));
      })
      .catch(rebuyError)
      .finally(function () { btn.removeAttribute('aria-busy'); });
  });

  function rebuyBecomes() {
    var el = $('rebuy-becomes');
    if (!rebuyQuote) { el.textContent = ''; return; }
    var amount = S.parseChips($('rebuy-amount-input').value);
    if (amount === null || amount <= 0) {
      el.textContent = 'Type how many chips to take.';
      return;
    }
    if (amount > rebuyQuote.max_topup) {
      el.textContent = 'That is over the ceiling: the most you can take is ' +
        S.fmt(rebuyQuote.max_topup) + '.';
      return;
    }
    el.innerHTML = 'Your stack becomes <span class="mono">' +
      S.escapeHtml(S.fmt(rebuyQuote.current_stack + amount)) + '</span>.';
  }

  $('rebuy-amount-input').addEventListener('input', function () {
    msg($('rebuy-msg'), '', '');
    rebuyBecomes();
  });

  $('rebuy-back-btn').addEventListener('click', function () {
    rebuyReset();
    setOrder(ORDER_DEFAULTS['state-rebuy'].order, ORDER_DEFAULTS['state-rebuy'].sub);
    goToStep($('rebuy-step-count'), $('rebuy-stack-input'));
  });

  $('rebuy-confirm-btn').addEventListener('click', function () {
    if (!rebuyQuote) { return; }
    var amount = S.parseChips($('rebuy-amount-input').value);
    if (amount === null || amount <= 0) {
      msg($('rebuy-msg'), 'Type how many chips to take, 1 or more.', 'error');
      goToStep($('rebuy-step-quote'), $('rebuy-amount-input'));
      return;
    }
    if (amount > rebuyQuote.max_topup) {
      msg($('rebuy-msg'), 'The most you can take is ' + S.fmt(rebuyQuote.max_topup) +
          '. Lower the amount.', 'error');
      goToStep($('rebuy-step-quote'), $('rebuy-amount-input'));
      return;
    }
    var btn = $('rebuy-confirm-btn');
    btn.setAttribute('aria-busy', 'true');
    msg($('rebuy-msg'), '', '');
    // From here on a P0023 belongs to this tap, not to a slip already seen.
    rebuyTakenHere = true;
    // take_rebuy is row-locked server-side: a double tap cannot issue two.
    // p_current_stack is the server's own echo from the quote, never the live
    // field, so editing the count after quoting cannot slip past the ceiling.
    S.client().rpc('take_rebuy', {
      p_night_id: ctx.night.id,
      p_current_stack: rebuyQuote.current_stack,
      p_amount: amount
    })
      .then(function (r) {
        if (r.error) { throw r.error; }
        ctx.entry = Array.isArray(r.data) ? r.data[0] : r.data;
        rebuyReset();
        S.show($('rebuy-flow'), false);
        // Quiet: the re-buy slip takes the screen on the next line.
        enterReport(true);  // re-reads the draft, restates the bank fact
        // This is where the reader is put down when the slip is dismissed,
        // so it is not a dead call. dismissSlip does the placing.
        $('rebuy-reshow-btn').focus({ preventScroll: true });
        openRebuySlip(false);
      })
      .catch(rebuyError)
      .finally(function () { btn.removeAttribute('aria-busy'); });
  });

  /* ---------------- review ---------------- */

  var reviewed = null; // { final, rebuy } as validated for sending

  $('report-form').addEventListener('submit', function (e) {
    e.preventDefault();

    // Reporting can end between the render that withdrew Review and the tap
    // that reaches it, and a hidden submit button is still a submit button to
    // a keyboard. sendRefused(), not reportingClosed(): with no deadline set,
    // a night settled under a member sitting on this screen is the only thing
    // that ends reporting, and it refuses the send just as hard. Re-render
    // instead of opening a review sheet whose Send has already been taken
    // away: #close-no-send says why and stays said.
    if (sendRefused()) {
      renderCloseIntro();
      renderDeadline();
      renderCloseRoute();
      return;
    }

    var finalStack = S.parseChips($('final-input').value);
    if (finalStack === null) {
      msg($('final-msg'), 'Type your final stack, or tap "I busted" if it is 0.', 'error');
      goToStep($('final-card'), $('final-input'));
      return;
    }

    // The re-buy on record, sent back unchanged. No member ever types this
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
      note.textContent = 'Season points after ' +
        (isDefaultNight() ? 'tonight' : 'that round') + ': about ' + S.fmt(after) +
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
    // The night's own name at the one moment of commitment. This is the
    // screen where somebody could otherwise type tonight's count into an
    // older round's form, and goToStep announces the review card immediately
    // below, so a screen reader hears the night before Send.
    setOrder('Check the maths, then send.',
             isDefaultNight() ? '' : ('This is ' + nightName(ctx.night) +
               ', played ' + osloDateWords(ctx.night.played_on) + '.'));
    // Hiding the form takes the focused element with it, which drops
    // document.activeElement to BODY: nothing was announced and the next Tab
    // restarted at the top of the document. Focus is restored inside this
    // same task, so activeElement is never observably BODY. This replaces an
    // unconditional window.scrollTo({ behavior: 'smooth' }) that ignored
    // prefers-reduced-motion and landed the reader at scrollY 0 with
    // #submit-btn 47px below the fold.
    goToStep($('review-card'), $('review-card-title'));
  });

  $('edit-btn').addEventListener('click', function () {
    S.show($('review-panel'), false);
    S.show($('report-form'), true);
    setOrder(closeOrder().order, closeOrder().sub);
    goToStep($('final-card'), $('final-input'));
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
    // On an older night nothing physical happens next: the chips went back
    // when that round ended, so there is no slip to open and no takeover to
    // be quiet for. The receipt is the whole of the answer, and it is placed
    // and announced the ordinary way, which is what a quiet showState would
    // have skipped.
    if (!isDefaultNight()) {
      showState('state-receipt');
      return;
    }
    // Quiet: the closing slip takes the screen two lines below. The
    // window.scrollTo that used to sit here was swallowed by .no-scroll
    // anyway, which is why the receipt rested at scrollY 276 instead of 0.
    showState('state-receipt', true);
    // Handing the chips back is the next physical act, so the slip that
    // proves it opens itself, with focus first on a control that is on
    // screen. This is where dismissSlip puts the reader down afterwards, so
    // it is not a dead call.
    $('closing-slip-btn').focus({ preventScroll: true });
    openClosingSlip(false);
  });

  /* ---------------- receipt + organiser card ---------------- */

  /* The final stack is this phone's number, so a queued job (not yet sent)
   * is the freshest version of it. The re-buy never is: it belongs to the
   * server, and a job can be older than the record, which is how a phone
   * that reported before its owner reached the bank ends up printing a
   * confident "Re-buy (bank) 0" on a receipt. The record always wins. */
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

    // The screen's one brass fill, and on an escalated screen it is NOT this
    // button. The single thing to do there is get the numbers in front of an
    // organiser, which is a card and not a control, so the escalated receipt
    // carries no brass fill at all, the way the hub does while the night is
    // quietly running. Rebuilt wholesale, so no layout class may be hung on
    // this button in markup.
    $('closing-slip-btn').className = (stuck || verdict === 'unknown')
      ? 'btn btn--secondary btn--block'
      : 'btn btn--primary btn--block btn--lg';
    // Same rule as the hub's copy of this button, and the same reason: the
    // slip exists for the moment chips cross the table, and on a round played
    // last week that moment is gone. The standing order above already reads
    // "That round is done." An escalated report is unaffected, because the
    // organiser card below carries the numbers in its own right.
    S.show($('closing-slip-btn'), isDefaultNight());

    if (stuck) {
      $('organiser-payload').innerHTML =
        '<div><span class="organiser-payload__label">Pseudonym</span>' +
          S.escapeHtml(ctx.member.pseudonym) + '</div>' +
        '<div><span class="organiser-payload__label">Night</span>' +
          S.escapeHtml((ctx.night.title || 'Night ' + ctx.night.night_no) +
            ' · ' + ctx.night.played_on) + '</div>' +
        '<div><span class="organiser-payload__label">Re-buy (chips)</span>' +
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
        // Not "for tonight". This screen reaches older nights now, and a
        // hand-set deadline can have passed on one of those just as easily.
        $('organiser-why').textContent = 'Reporting has closed, so the ' +
          'server will not take this from your phone any more. An organiser ' +
          'can still enter it.';
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
    // "Tonight is settled" is false about a night played a week ago, and this
    // screen is reachable for one: refreshCtx settles the night under a
    // member who switched to it. showState has just written the default
    // order, so this overwrites it, the way the re-buy quote step does.
    if (isDefaultNight()) {
      $('settled-title').textContent = 'Tonight is settled';
    } else {
      $('settled-title').textContent = 'That round is settled';
      setOrder('That round is settled.', '');
    }
  }

  /* ------------------------------------------------------------------
   * Boot. It never lands on state-rebuy or state-close: both are reachable
   * only by a deliberate tap, so a reload mid re-buy discards a quote that
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
        if (!$('state-close').hidden || !$('state-rebuy').hidden) {
          nightBanner();
          // #close-intro and #deadline-line are statements of fact, and
          // #review-btn is a route to a send, so all three follow the server.
          // A tab left open past the end of the night used to keep "the round
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
        //
        // The card is re-read only for the members who have something ON it,
        // which is pendingNights() and NOT outstanding. outstanding holds
        // every night this member owes a count on, and the one they are
        // sitting at is always one of them: an entry is unreported from
        // check-in until they close the round. So `outstanding.length` is
        // true for all 38 people at the table from the moment they check in,
        // and every one of them was paying two reads on every return to the
        // tab, forever, to re-read a list whose only member is the night
        // already on screen. pendingNights() drops that one, so this is now
        // what it says it is.
        //
        // Nobody can acquire a pending night mid session either: the only
        // night a member can check in to is the one they are already on, and
        // that one is never pending by definition.
        if (pendingNights().length) { loadOutstanding(); }
        renderSync();
      })
      .catch(function () { /* offline, or the night vanished: leave the screen alone */ });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { refreshCtx(); }
  });
  window.addEventListener('online', refreshCtx);

  /* ------------------------------------------------------------------
   * The other night.
   *
   * Reporting used to close at 09:00 the morning after, so activeNight()'s
   * "newest open night" was the only night a member could possibly have
   * meant. It now runs until an organiser settles, so somebody can be
   * carrying an unreported entry on a night that is no longer the newest one,
   * and boot would hand them a check-in screen for a round they have not
   * played, with no route at all to the one number they came to send.
   *
   * activeNight() is NOT changed. It is on the critical path of the screen 38
   * people open on a Friday evening, and the only thing it ever got wrong was
   * being the last word. Everything below makes that choice reversible
   * without touching it: two reads fired after the paint and never waited on,
   * one card of chrome, and a switch that re-enters the arrival tree boot
   * already has. The bank, the draft key, the outbox key, the ledger, the
   * deadline tests and report_entry's night id all read ctx.night already.
   * ------------------------------------------------------------------ */

  /* True when the screen is showing the night boot chose, AND true when there
   * was no choice to make. With no open night at all, boot lands on a freshly
   * settled night through latestSettled() and every sentence on that path is
   * already written for it, so defaultNight being null must read as "this is
   * the only night there is" and not as "this is an older one". Only a
   * DELIBERATE switch makes this false.
   *
   * It compares two ids the server gave us and reads no clock, so a phone
   * whose date is wrong cannot get it wrong. Every sentence on this screen
   * containing the word tonight, and every control that only makes sense on
   * the round being played, hangs off this one switch. */
  function isDefaultNight() {
    if (!defaultNight) { return true; }
    return !!(ctx.night && ctx.night.id === defaultNight.id);
  }

  function nightName(n) {
    return n ? (n.title || ('Night ' + n.night_no)) : '';
  }

  /* What a night scores if this member never reports: no final stack means
   * zero chips back. Deliberately the SAME arithmetic as
   * supabase/functions/notify-unreported, which puts this figure in the
   * reminder mail, so somebody arriving from that mail meets the number the
   * mail quoted rather than a second opinion about it. */
  function silentPoints(night, entry) {
    if (!night || !entry) { return null; }
    var taken = (entry.buyin_chips || 0) + (entry.rebuy_chips || 0);
    return 0 - taken + (night.attendance_bonus || 0);
  }

  /* Fired by boot and NOT waited on. A failure leaves the page exactly as it
   * is today, which is the worst case this whole change is allowed to have. */
  function loadOutstanding() {
    if (!ctx.member) { return Promise.resolve(); }
    return S.outstandingNights(ctx.member.id).then(function (res) {
      outstanding = res.nights;
      outstandingEntries = res.entries;
      renderOutstanding();
    });
  }

  /* The outstanding nights that are not the one on screen. The night a member
   * is actually on is unreported until they close it, so it is always in the
   * list and is never something to nag them about. */
  function pendingNights() {
    return outstanding.filter(function (n) {
      return !ctx.night || n.id !== ctx.night.id;
    });
  }

  /* Screens the card must never appear on. state-close and state-rebuy carry
   * exactly one instruction each and are the two screens refreshCtx already
   * refuses to disturb, because a thumb is mid count on them.
   *
   * HAND MAINTAINED, and it fails the same way the `states` array at the top
   * of this file fails: a state added later that must not carry this card
   * will carry it, and the symptom is two things stacked on a phone at 20:30
   * with nothing in the console. */
  var CARD_HIDE_ON = ['state-config', 'state-loading', 'state-nopseudonym',
                      'state-close', 'state-rebuy'];

  /* The sentence under the card's title. It leads with the points, because
   * that is what the reminder mail led with and it is the whole reason this
   * matters to the person reading it. */
  function owedText(n, entry, count) {
    var when = osloDateWords(n.played_on);
    var pts = silentPoints(n, entry);
    if (reportingClosedOn(n)) {
      // Night state B: a deadline was set by hand for that night and it has
      // passed, so this phone cannot send for it and must not offer to.
      return (count > 1 ? 'The oldest is ' + nightName(n) + ', from ' : 'No final stack from ') +
        when + ', and reporting for it closed at ' + closedAtWords(n) +
        '. Open it and an organiser can enter your total.';
    }
    if (count > 1) {
      return 'The oldest is ' + nightName(n) + ' from ' + when +
        (pts !== null && pts < 0
          ? ', with no final stack: that counts as 0 chips back, ' + S.fmtSigned(pts) + ' points.'
          : ', with no final stack on record.') +
        ' Send that one and this card brings up the next.';
    }
    if (pts !== null && pts < 0) {
      return 'No final stack from ' + when + ', so it counts as 0 chips back, ' +
        'which is ' + S.fmtSigned(pts) + ' points. One number fixes it.';
    }
    return 'No final stack from ' + when + ', and the round is still open. ' +
      'One number fixes it.';
  }

  /* The card. A leaf: it writes DOM, calls nothing that renders, and moves
   * neither focus nor scroll, because a member reading the way-out card must
   * not be thrown to the top of the page because a background read answered.
   *
   * Four faces in priority order: a report for another night still in this
   * phone's queue, a night missing a count, the way back once the screen is
   * on an older night, and hidden. Its button is never brass: the current
   * screen keeps the one brass action it has. */
  function renderOutstanding() {
    var card = $('other-night-card');
    var backBtn = $('other-night-back-btn');
    // The WRAPPER carries the hiding, not the button. An empty div with a
    // margin-top is still 8px of card, and on the check-in screen 8px is a
    // quarter of the room the brass Check in button has left below the fold.
    var backWrap = $('other-night-back-wrap');
    offerNight = null;
    offerEntry = null;
    if (!ctx.member || !defaultNight || !currentState ||
        CARD_HIDE_ON.indexOf(currentState) !== -1) {
      S.show(card, false);
      return;
    }

    var pend = pendingNights();
    var sending = null;
    var owed = [];
    var i, n, job;
    for (i = 0; i < pend.length; i += 1) {
      n = pend[i];
      // A job in the store at all, sent or not, means this member has done
      // their part and the outbox owns it from here. Only a night with no job
      // behind it is still something to ask them for, which is also what
      // keeps the card from nagging about a round they reported a moment ago
      // while the list itself is still a minute old.
      job = OB.get(n.id, ctx.member.id);
      if (job && job.status !== 'sent') {
        if (!sending) { sending = { night: n, job: job }; }
      } else if (!job && n.id !== defaultNight.id) {
        // The default night is never OWED, only ever gone back to.
        //
        // pendingNights() drops the night on screen for the reason that it is
        // unreported until the member closes it, and the moment they step off
        // tonight to send an older count, tonight becomes exactly that night:
        // checked in, still being played, still unreported. Without this
        // clause a member sitting on Round 1 reads "Round 2 needs your chip
        // count" with the full silent-points figure under it, about the round
        // they are in the middle of playing, at a table with chips in front
        // of them. Face 3 below is how tonight is offered instead, and it is
        // the same one tap.
        //
        // Nothing is lost by it: the way back always exists, and tonight's
        // own hub carries the whole instruction once they are on it. It can
        // never fire on the common path either, because pendingNights() has
        // already dropped tonight whenever tonight is the screen.
        owed.push(n);
      }
    }

    var label, title, text, btnText;
    if (sending) {
      n = sending.night;
      offerNight = n;
      offerEntry = outstandingEntries[n.id] || null;
      label = 'Still sending';
      title = nightName(n) + ' is still sending';
      // #sync-pill reads myJob(), which reads ctx.night, so a queued report
      // for another night goes invisible the moment the member comes back to
      // tonight. The pill is described in this file as the one piece of
      // chrome that outlives every state, and this is the line that stops the
      // switch making it lie by omission.
      text = 'Your ' + nightName(n) + ' count of ' +
        S.fmt(sending.job.payload.p_final_stack) +
        ' is saved on this phone and still going out. Open it to see where it stands.';
      btnText = 'Open ' + nightName(n);
    } else if (owed.length) {
      n = owed[0];
      offerNight = n;
      offerEntry = outstandingEntries[n.id] || null;
      label = 'Still open';
      title = owed.length > 1
        ? (owed.length + ' rounds are missing your chip count')
        : (nightName(n) + ' needs your chip count');
      text = owedText(n, offerEntry, owed.length);
      btnText = (reportingClosedOn(n) ? 'Open ' : 'Report ') + nightName(n);
    } else if (!isDefaultNight()) {
      offerNight = defaultNight;
      offerEntry = defaultEntry;
      label = 'The newest round';
      title = 'You are on ' + nightName(ctx.night);
      text = 'Everything on this screen belongs to ' + nightName(ctx.night) +
        ', played ' + osloDateWords(ctx.night.played_on) + '. ' +
        nightName(defaultNight) + ' is the newest round, and this page goes ' +
        'back to it whenever you want.';
      btnText = 'Go to ' + nightName(defaultNight);
    } else {
      S.show(card, false);
      return;
    }

    $('other-night-label').textContent = label;
    $('other-night-title').textContent = title;
    $('other-night-text').textContent = text;
    $('other-night-btn').textContent = btnText;
    // The check-in screen's fold, which is a measured number and not a
    // guess. report.html's rule is that the code field and the brass Check in
    // button both stay above it on a 390x844 phone, and the three facts were
    // moved below the button to buy that back. Measured on that phone, fonts
    // loaded, with this card above the check-in card, the button's bottom
    // edge sits at:
    //   697  no card at all
    //   964  the card whole
    //   877  paragraph hidden
    //   844  paragraph and title hidden, which is ON the fold, not above it
    //   828  and the gap under the card closed to --space-sm
    // Only the last of those clears 844, so that is what the check-in screen
    // gets. Read the middle rows before trying to put the title back: the
    // paragraph is worth 87px and the TITLE IS WORTH 33, twice the 16px of
    // headroom the shipped layout has left. Paragraph goes first, then the
    // title, and the button never goes: the night is named on the button
    // itself, so "Report Round 1" is a whole instruction with everything else
    // stripped off it.
    var compact = (currentState === 'state-checkin');
    S.show($('other-night-text'), !compact);
    S.show($('other-night-title'), !compact);
    // Inline, because it is a per-state measurement and not a style: the
    // markup's own var(--space-lg) is what every other screen keeps.
    card.style.marginBottom = compact ? 'var(--space-sm)' : 'var(--space-lg)';
    // The route home exists whenever the screen is on an older night, even
    // while the card is pointing at a third one.
    //
    // BY ID, never by object identity. defaultNight is the row activeNight()
    // handed boot; outstanding holds rows loadOutstanding() read separately,
    // so tonight appears in BOTH as two different objects with one id. The
    // first face reaches for tonight's row out of outstanding whenever a
    // report for tonight is still in this phone's queue, which is the
    // ordinary shape of the evening: report tonight, take the card's offer of
    // last week, and land on last week with tonight still sending. Compared
    // by identity that came out true, and the card grew a second button
    // reading "Go to Round 2" directly under one reading "Open Round 2".
    if (!isDefaultNight() && offerNight && offerNight.id !== defaultNight.id) {
      backBtn.textContent = 'Go to ' + nightName(defaultNight);
      S.show(backWrap, true);
    } else {
      S.show(backWrap, false);
    }
    S.show(card, true);
  }

  /* Everything on this page that is night shaped and NOT keyed by night.
   *
   * Drafts and outbox jobs need no clearing at all: draftKey() and OB.keyOf()
   * are both keyed by (night, member), so a queued Round 1 report and a
   * queued Round 2 report coexist without touching each other, and the pump
   * in outbox.js is night agnostic and keeps retrying both.
   *
   * lastReported is the one that bites, and it is why this function exists.
   * It is a memory of THIS page load's report with no night on it, and
   * shownNumbers() falls back to it whenever the queue and the entry row have
   * nothing, so a member who reported Round 1 and then went back to tonight
   * would find tonight's hub reading "You have reported." over Round 1's
   * count, with the way-out card printing the figure. */
  function resetNightState() {
    lastReported = null;
    reviewed = null;
    rebuyQuote = null;
    hubSig = null;
    syncSig = null;
    // The 30 second throttle belongs to the night being left.
    refreshedAt = 0;
    // enterReport only writes the field when the server row or a draft says
    // to, so a count typed for one night would otherwise follow the member
    // into the other night's close screen.
    $('final-input').value = '';
    $('bust-btn').classList.remove('btn--bust--on');
    $('code-input').value = '';
    msg($('final-msg'), '', '');
    msg($('checkin-msg'), '', '');
    msg($('rebuy-msg'), '', '');
    S.show($('review-panel'), false);
    S.show($('report-form'), true);
    // showState places and announces only on a REAL change, and a switch can
    // land on the same state name it left. The night underneath is different,
    // so it is a real change and has to be announced like one.
    currentState = null;
  }

  /* Boot's arrival tree, lifted out whole so it can be entered a second time.
   * Nothing in it is about WHICH night this is: the job, the entry and the
   * report are all read off ctx, which is why switching night needs no new
   * state div and no new copy. */
  function enterNight() {
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
  }

  /* Move the whole screen to another night, with NO network.
   *
   * Everything it needs was fetched by loadOutstanding, and that matters more
   * than it looks: this runs at 20:35 on campus wifi, and a design that
   * reloaded the page here would strand a member whose connection had just
   * gone, on the one screen that exists to survive exactly that. The refresh
   * at the tail corrects a stale entry row when the network is there and
   * costs nothing when it is not.
   *
   * Refused while a slip is up and on the two screens refreshCtx already
   * refuses to disturb, so nothing can move under a thumb mid count. */
  function switchNight(n, entry) {
    if (!n) { return; }
    if (!$('slip').hidden) { return; }
    if (!$('state-close').hidden || !$('state-rebuy').hidden) { return; }
    // Leaving tonight: keep the freshest entry we have for it, because that
    // is what the way back will be entered with.
    if (isDefaultNight() && ctx.night) { defaultEntry = ctx.entry; }
    resetNightState();
    ctx.night = n;
    ctx.entry = entry || null;
    // The balance belongs to the season it was read for. Two open nights can
    // straddle a semester boundary, and the wrong season's points on the
    // check-in card and the review sheet are worse than none: every reader
    // already handles null.
    if (!defaultNight || n.season_id !== defaultNight.season_id) { ctx.balance = null; }
    nightBanner();
    enterNight();
    // refreshedAt was zeroed above, so this really runs. It re-reads this
    // night and this entry by id and re-renders the right screen with all of
    // its own guards, which is the whole reason nothing new is written here.
    refreshCtx();
  }

  $('other-night-btn').addEventListener('click', function () {
    switchNight(offerNight, offerEntry);
  });

  $('other-night-back-btn').addEventListener('click', function () {
    switchNight(defaultNight, defaultEntry);
  });

  /* A /report?r=<night id> link, which only an already signed in member can
   * arrive on. Honoured ONLY when the night is one this member could actually
   * report on: open or reconciling, not removed, and carrying an unreported
   * entry of their own. Anything else falls back to the night boot chose,
   * silently, because a link that has gone stale must not cost somebody the
   * screen they came for. The two reads happen only when the parameter is
   * there, so the common case, which has no parameter at all, waits for
   * nothing. */
  function enterLinkedNight() {
    return Promise.all([
      S.nightById(urlNightId),
      S.myEntry(urlNightId, ctx.member.id)
    ]).then(function (res) {
      var n = res[0], e = res[1];
      var usable = n && !n.deleted_at &&
        (n.status === 'open' || n.status === 'reconciling') &&
        e && !e.reported && !e.voided_at;
      if (usable) {
        ctx.night = n;
        ctx.entry = e;
        if (n.season_id !== defaultNight.season_id) { ctx.balance = null; }
        nightBanner();
      }
      enterNight();
    }).catch(function () { enterNight(); });
  }

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

      // Remembered before anything can move it: this is the way back to
      // tonight from any older night, and it is what every "is this tonight"
      // test on the page compares against.
      defaultNight = night;
      ctx.night = night;
      nightBanner();

      return Promise.all([
        S.myEntry(night.id, ctx.member.id),
        S.myBalance(night.season_id, ctx.member.id)
      ]).then(function (res) {
        ctx.entry = res[0];
        ctx.balance = res[1];
        defaultEntry = res[0];

        // The two reads behind the other-night card, fired and deliberately
        // NOT waited on. The screen this member came for is painted by the
        // line below on the same round trips it takes today, and a card that
        // never arrives leaves them exactly the page they have now.
        loadOutstanding();

        if (urlNightId && urlNightId !== night.id) {
          return enterLinkedNight();
        }
        enterNight();
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
