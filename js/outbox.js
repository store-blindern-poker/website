/* Store Blindern Poker: localStorage outbox.
 *
 * The report screen's safety net for a loud room on flaky campus wifi.
 * A submission is queued here FIRST, then sent; it survives reloads,
 * force-quits and airplane mode, and it retries by itself when the radio
 * comes back.
 *
 * Rules:
 *   - One job per (night_id, member_id). That pair is the idempotency key,
 *     it matches the server's UNIQUE (night_id, member_id) upsert, so a
 *     replayed send is a harmless no-op and a re-submit simply replaces the
 *     queued payload.
 *   - One send in flight at a time, exponential backoff with jitter.
 *   - Errors are classified by the sender: `permanent` errors (night
 *     settled, signed out, bad input) stop the retry loop and surface to the
 *     UI; anything network-shaped retries forever, quietly.
 *   - Retry triggers: timer, page load, `online`, `visibilitychange`.
 *
 * The module is storage-defensive: every localStorage touch is wrapped, so
 * a private-mode browser degrades to an in-memory queue (still correct for
 * the session, just not crash-proof).
 */
(function () {
  'use strict';

  var STORE_KEY = 'sbp.outbox.v1';
  var BASE_DELAY_MS = 2000;      // first retry after ~2s
  var MAX_DELAY_MS = 60000;      // never wait more than a minute
  var STUCK_AFTER_ATTEMPTS = 5;  // UI escalates to the organiser card here

  var memoryStore = null;        // fallback when localStorage is unavailable
  var inFlight = false;
  var timer = null;
  var sender = null;             // function(job) -> Promise
  var listeners = [];

  /* ---------------- storage ---------------- */

  function load() {
    if (memoryStore) { return memoryStore; }
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      memoryStore = memoryStore || {};
      return memoryStore;
    }
  }

  function save(store) {
    if (memoryStore) { memoryStore = store; return; }
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (e) {
      memoryStore = store;
    }
  }

  /* ---------------- events ---------------- */

  function emit() {
    var jobs = list();
    listeners.forEach(function (fn) {
      try { fn(jobs); } catch (e) { /* a UI bug must not stop the queue */ }
    });
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  /* ---------------- queue API ---------------- */

  function keyOf(nightId, memberId) {
    return String(nightId) + ':' + String(memberId);
  }

  /* Queue (or replace) a job. payload is what the sender will transmit.
   * Re-queuing the same key resets the retry clock, a member correcting
   * their numbers starts fresh. */
  function enqueue(nightId, memberId, payload) {
    var store = load();
    var key = keyOf(nightId, memberId);
    store[key] = {
      key: key,
      night_id: nightId,
      member_id: memberId,
      payload: payload,
      status: 'queued',          // queued | sending | sent | failed
      attempts: 0,
      queued_at: new Date().toISOString(),
      next_attempt_at: 0,        // epoch ms; 0 = now
      last_error: null,
      permanent: false
    };
    save(store);
    emit();
    kick();
    return store[key];
  }

  function get(nightId, memberId) {
    return load()[keyOf(nightId, memberId)] || null;
  }

  function remove(nightId, memberId) {
    var store = load();
    delete store[keyOf(nightId, memberId)];
    save(store);
    emit();
  }

  function list() {
    var store = load();
    return Object.keys(store).map(function (k) { return store[k]; });
  }

  /* Give a failed job another chance (the UI's "try again" button). */
  function retryNow(nightId, memberId) {
    var store = load();
    var job = store[keyOf(nightId, memberId)];
    if (!job) { return; }
    job.status = 'queued';
    job.permanent = false;
    job.next_attempt_at = 0;
    save(store);
    emit();
    kick();
  }

  /* ---------------- the pump ---------------- */

  function backoffDelay(attempts) {
    var exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempts));
    // Full jitter: 50 to 100% of the computed delay, so 38 phones that all
    // lost wifi together do not all retry together.
    return Math.floor(exp * (0.5 + Math.random() * 0.5));
  }

  function nextDue() {
    var due = null;
    list().forEach(function (job) {
      if (job.status !== 'queued') { return; }
      if (due === null || job.next_attempt_at < due.next_attempt_at) { due = job; }
    });
    return due;
  }

  function schedule(ms) {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(kick, Math.max(50, ms));
  }

  function kick() {
    if (inFlight || !sender) { return; }
    var job = nextDue();
    if (!job) { return; }

    var wait = job.next_attempt_at - Date.now();
    if (wait > 0) { schedule(wait); return; }

    var store = load();
    var live = store[job.key];
    if (!live) { return; }
    live.status = 'sending';
    save(store);
    emit();
    inFlight = true;

    sender(live).then(function () {
      var s = load();
      if (s[job.key]) {
        s[job.key].status = 'sent';
        s[job.key].sent_at = new Date().toISOString();
        s[job.key].last_error = null;
        save(s);
      }
      inFlight = false;
      emit();
      kick(); // anything else waiting?
    }).catch(function (err) {
      var s = load();
      var j = s[job.key];
      if (j) {
        j.attempts += 1;
        j.last_error = String((err && err.message) || err || 'send failed');
        if (err && err.permanent) {
          j.status = 'failed';
          j.permanent = true;
        } else {
          j.status = 'queued';
          j.next_attempt_at = Date.now() + backoffDelay(j.attempts);
        }
        save(s);
      }
      inFlight = false;
      emit();
      var due = nextDue();
      if (due) { schedule(Math.max(0, due.next_attempt_at - Date.now())); }
    });
  }

  /* Wire the retry triggers once a sender exists.
   *
   * First, rescue orphans. kick() marks a job 'sending' before the request
   * leaves, so a force quit, a killed tab or a dead battery mid submit strands
   * it in that state forever: nextDue() only ever returns 'queued'. On a poker
   * night that is a player's whole result, lost in silence while their screen
   * still says it is sending. Anything still 'sending' when we boot cannot be
   * in flight, because the page that owned it is gone, so put it back in the
   * queue and let the normal retry path have it. Sending twice is safe: the
   * server upsert is idempotent on (night_id, member_id). */
  function start(sendFn) {
    sender = sendFn;
    var store = load();
    var revived = 0;
    Object.keys(store).forEach(function (k) {
      if (store[k].status === 'sending') {
        store[k].status = 'queued';
        store[k].next_attempt_at = 0;
        revived += 1;
      }
    });
    if (revived) { save(store); }
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { kick(); }
    });
    kick();
  }

  window.SBPOutbox = {
    enqueue: enqueue,
    get: get,
    remove: remove,
    list: list,
    retryNow: retryNow,
    onChange: onChange,
    start: start,
    STUCK_AFTER_ATTEMPTS: STUCK_AFTER_ATTEMPTS
  };
})();
