/* Store Blindern Poker: RSVP for upcoming nights.
 *
 * Loaded (after js/config.js, js/vendor/supabase.js, js/sb.js and js/app.js)
 * by index.html and events.html. Self-contained: it adds behaviour to markup
 * js/app.js has already rendered and never edits or depends on that script.
 *
 * Progressive enhancement, in this order:
 *   1. The page renders from data/events.json with no database at all. That
 *      is the baseline and it must never regress.
 *   2. If Supabase answers, an RSVP block is appended to each upcoming event
 *      card, and the going count is added to the home page countdown.
 *   3. If any of that fails, times out, or the visitor is offline, we log a
 *      warning and leave the page exactly as js/app.js left it. Every entry
 *      point is wrapped, every promise has a catch, nothing here can blank a
 *      list or stop the countdown.
 *
 * The privacy split is deliberate and lives in the queries, not in the CSS:
 *   - v_upcoming_nights is anon-readable and carries COUNTS only. Signed-out
 *     visitors get a number and nothing else.
 *   - v_night_rsvps is authenticated-only and carries pseudonyms. It is
 *     queried only when there is a session.
 *   - Only 'going' pseudonyms are ever rendered. A public list of who
 *     declined helps nobody.
 *
 * Writes go through the set_rsvp() RPC, which always acts on the caller.
 * There is no way, here or in the database, to answer for somebody else.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * Guards. If anything this module needs is missing, do nothing at all.
   * ------------------------------------------------------------------ */
  var S = window.SBP;

  function warn(what, err) {
    if (window.console && console.warn) { console.warn('RSVP: ' + what, err || ''); }
  }

  if (!S || typeof S.configured !== 'function' || !S.configured()) {
    // No client: the pages are complete without us.
    return;
  }

  var LOGIN_HREF = 'login.html?next=events.html';
  var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WAIT_MS = 20000;

  /* ------------------------------------------------------------------
   * Small helpers
   * ------------------------------------------------------------------ */

  /* played_on and events.json dates are plain calendar dates, never
   * timestamps, so they compare as strings. No Date object, no timezone. */
  function isoOf(v) { return String(v == null ? '' : v).slice(0, 10); }

  function isoParts(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoOf(v));
    return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null;
  }

  function normText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /* Resolve once `test()` passes. js/app.js fills these containers from an
   * async fetch, so we watch instead of racing it. Rejects on timeout, and
   * every caller catches. */
  function whenPresent(root, test, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (test()) { resolve(); return; }
      if (!window.MutationObserver) { reject(new Error('no MutationObserver')); return; }
      var settled = false;
      var obs = new MutationObserver(function () {
        if (!settled && test()) { finish(resolve, null); }
      });
      var timer = setTimeout(function () {
        finish(reject, new Error('timed out waiting for content'));
      }, timeoutMs || WAIT_MS);
      function finish(cb, arg) {
        settled = true;
        clearTimeout(timer);
        obs.disconnect();
        cb(arg);
      }
      obs.observe(root, { childList: true, subtree: true, characterData: true });
    });
  }

  /* ------------------------------------------------------------------
   * Reads
   * ------------------------------------------------------------------ */

  /* Named columns, never select('*'): the same rule js/sb.js documents for
   * the nights table applies to anything that might grow a column later. */
  var UPCOMING_COLS = 'night_id,season_id,played_on,title,status,' +
    'going_count,not_going_count';

  function fetchNights() {
    return S.client().from('v_upcoming_nights').select(UPCOMING_COLS)
      .order('played_on', { ascending: true })
      .then(function (r) {
        if (r.error) { throw r.error; }
        return r.data || [];
      });
  }

  /* Authenticated only. Never called without a session. */
  function fetchRsvps(nightIds) {
    if (!nightIds.length) { return Promise.resolve([]); }
    return S.client().from('v_night_rsvps').select('night_id,pseudonym,response')
      .in('night_id', nightIds)
      .then(function (r) {
        if (r.error) { throw r.error; }
        return r.data || [];
      });
  }

  function fetchEventsJson() {
    return fetch('data/events.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) { throw new Error('events.json: HTTP ' + r.status); }
      return r.json();
    });
  }

  /* Who am I, in the four states the UI actually has to draw:
   *   anon    no session
   *   noname  signed in, no pseudonym claimed yet
   *   member  signed in and able to RSVP
   *   unknown signed in but the lookup failed, so claim nothing */
  function identify() {
    return S.getSession().then(function (session) {
      if (!session) { return { identity: 'anon', member: null }; }
      return S.getMyMember().then(function (m) {
        if (m && m.pseudonym) { return { identity: 'member', member: m }; }
        return { identity: 'noname', member: null };
      }).catch(function (err) {
        warn('member lookup failed', err);
        return { identity: 'unknown', member: null };
      });
    }).catch(function (err) {
      warn('session read failed', err);
      return { identity: 'unknown', member: null };
    });
  }

  /* ------------------------------------------------------------------
   * Matching a rendered card back to a database night
   *
   * js/app.js builds the event cards and is not ours to edit, so a card
   * carries no ISO date. Both the card and data/events.json come from the
   * same file in the same page load, and the title is copied verbatim, so
   * an exact title match is reliable. The day + month cell is the backstop
   * when two events share a title.
   *
   * From the ISO date to the night is exact: nights has UNIQUE
   * (season_id, played_on), and v_upcoming_nights only holds future nights,
   * so one date means one night.
   * ------------------------------------------------------------------ */
  function matchCards(cards, events) {
    var taken = {};
    var pairs = [];
    var i, j;

    for (i = 0; i < cards.length; i++) {
      var card = cards[i];
      var titleEl = card.querySelector('.event-card__title');
      var dayEl = card.querySelector('.event-card__day');
      var monEl = card.querySelector('.event-card__month');
      var want = normText(titleEl && titleEl.textContent);
      var hit = -1;

      if (want) {
        for (j = 0; j < events.length; j++) {
          if (taken[j]) { continue; }
          if (normText(events[j].title) === want) { hit = j; break; }
        }
      }

      if (hit === -1 && dayEl && monEl) {
        var day = parseInt(dayEl.textContent, 10);
        var mon = normText(monEl.textContent).slice(0, 3);
        for (j = 0; j < events.length; j++) {
          if (taken[j]) { continue; }
          var p = isoParts(events[j].date);
          if (p && p.d === day && MONTH_ABBR[p.mo - 1].toLowerCase() === mon) {
            hit = j;
            break;
          }
        }
      }

      if (hit === -1) { continue; }
      var iso = isoOf(events[hit].date);
      if (!isoParts(iso)) { continue; }
      taken[hit] = true;
      // Left on the card so the match is inspectable in devtools.
      card.setAttribute('data-rsvp-date', iso);
      pairs.push({ card: card, iso: iso });
    }
    return pairs;
  }

  /* ------------------------------------------------------------------
   * One RSVP block
   * ------------------------------------------------------------------ */

  function setNumLine(el, n, tail, numClass) {
    el.textContent = '';
    var num = document.createElement('span');
    num.className = numClass;
    num.textContent = String(n);
    el.appendChild(num);
    el.appendChild(document.createTextNode(' ' + tail));
  }

  function newBlock(night, tmpl, identity) {
    var el = tmpl.content.firstElementChild.cloneNode(true);
    var b = {
      night: night,
      el: el,
      count: el.querySelector('[data-rsvp="count"]'),
      aside: el.querySelector('[data-rsvp="aside"]'),
      control: el.querySelector('[data-rsvp="control"]'),
      signin: el.querySelector('[data-rsvp="signin"]'),
      hint: el.querySelector('[data-rsvp="hint"]'),
      msg: el.querySelector('[data-rsvp="msg"]'),
      list: el.querySelector('[data-rsvp="list"]'),
      choices: el.querySelectorAll('.rsvp__choice'),

      identity: identity,          // anon | checking | noname | member | unknown
      me: null,                    // my pseudonym, once known
      mine: null,                  // 'going' | 'not_going' | null
      going: null,                 // pseudonyms, or null when not loaded
      goingCount: Number(night.going_count) || 0,
      notGoingCount: Number(night.not_going_count) || 0,
      busy: false,
      busyOn: null,
      locked: false,               // the night stopped accepting RSVPs
      msgText: '',
      msgKind: ''
    };

    b.signin.setAttribute('href', LOGIN_HREF);

    // One listener on the group, so the two buttons stay interchangeable.
    b.control.addEventListener('click', function (ev) {
      try {
        var btn = ev.target && ev.target.closest ? ev.target.closest('.rsvp__choice') : null;
        if (!btn || btn.getAttribute('aria-disabled') === 'true') { return; }
        tap(b, btn.getAttribute('data-response'));
      } catch (err) {
        warn('tap failed', err);
      }
    });

    return b;
  }

  function render(b) {
    var isMember = b.identity === 'member';
    var isChecking = b.identity === 'checking';

    /* Headcount. Always shown, to everybody. */
    if (b.goingCount > 0) {
      setNumLine(b.count, b.goingCount, 'going', 'rsvp__count-num');
    } else {
      b.count.textContent = isMember
        ? 'Nobody has answered yet. Be the first.'
        : 'Nobody has answered yet.';
    }
    b.count.classList.toggle('rsvp__count--empty', b.goingCount === 0);

    if (b.notGoingCount > 0) {
      setNumLine(b.aside, b.notGoingCount, 'can\'t make it', 'rsvp__aside-num');
      b.aside.hidden = false;
    } else {
      b.aside.textContent = '';
      b.aside.hidden = true;
    }

    /* The control. Visible while checking, so it does not pop in late. */
    b.control.hidden = !(isMember || isChecking);
    for (var i = 0; i < b.choices.length; i++) {
      var btn = b.choices[i];
      var val = btn.getAttribute('data-response');
      btn.setAttribute('aria-pressed', (isMember && b.mine === val) ? 'true' : 'false');
      if (b.busy) {
        btn.setAttribute('aria-disabled', 'true');
        if (b.busyOn === val) { btn.setAttribute('aria-busy', 'true'); }
        else { btn.removeAttribute('aria-busy'); }
      } else {
        btn.removeAttribute('aria-busy');
        if (isChecking || b.locked) { btn.setAttribute('aria-disabled', 'true'); }
        else { btn.removeAttribute('aria-disabled'); }
      }
    }

    /* The way in, for people who are not signed in or have no pseudonym. */
    if (b.identity === 'anon') {
      b.signin.textContent = 'Sign in to RSVP';
      b.signin.hidden = false;
    } else if (b.identity === 'noname') {
      b.signin.textContent = 'Claim a pseudonym to RSVP';
      b.signin.hidden = false;
    } else {
      b.signin.hidden = true;
    }

    var hint = '';
    if (isChecking) {
      hint = 'Checking your account.';
    } else if (isMember && !b.locked) {
      hint = b.mine
        ? 'Tap the same answer again to clear it.'
        : 'One tap. You can change it later.';
    }
    b.hint.textContent = hint;
    b.hint.hidden = !hint;

    b.msg.textContent = b.msgText;
    b.msg.hidden = !b.msgText;
    b.msg.classList.toggle('rsvp__msg--error', b.msgKind === 'error');

    /* Pseudonyms: signed-in members only, and only the ones going. */
    b.list.textContent = '';
    if (isMember && b.going && b.going.length) {
      var names = b.going.slice().sort(function (a, c) {
        return String(a).localeCompare(String(c));
      });
      var mine = b.me ? S.normPseudonym(b.me) : null;
      for (var k = 0; k < names.length; k++) {
        var li = document.createElement('li');
        li.className = 'rsvp__who';
        li.textContent = names[k];
        if (mine && S.normPseudonym(names[k]) === mine) {
          li.className = 'rsvp__who rsvp__who--me';
          var you = document.createElement('span');
          you.className = 'rsvp__you';
          you.textContent = 'you';
          li.appendChild(you);
        }
        b.list.appendChild(li);
      }
      b.list.hidden = false;
    } else {
      b.list.hidden = true;
    }
  }

  /* Apply an answer locally, counts and list together, so the optimistic
   * state is always internally consistent and a rollback restores all of it. */
  function applyLocal(b, next) {
    if (b.mine === 'going') { b.goingCount = Math.max(0, b.goingCount - 1); }
    if (b.mine === 'not_going') { b.notGoingCount = Math.max(0, b.notGoingCount - 1); }
    if (next === 'going') { b.goingCount += 1; }
    if (next === 'not_going') { b.notGoingCount += 1; }
    if (b.going && b.me) {
      var key = S.normPseudonym(b.me);
      b.going = b.going.filter(function (p) { return S.normPseudonym(p) !== key; });
      if (next === 'going') { b.going.push(b.me); }
    }
    b.mine = next;
  }

  function tap(b, response) {
    if (b.busy || b.locked || b.identity !== 'member') { return; }
    if (response !== 'going' && response !== 'not_going') { return; }

    // Tapping the answer you already gave clears it.
    var next = (b.mine === response) ? null : response;
    var snap = {
      mine: b.mine,
      going: b.going ? b.going.slice() : null,
      goingCount: b.goingCount,
      notGoingCount: b.notGoingCount
    };

    applyLocal(b, next);
    b.busy = true;
    b.busyOn = response;
    b.msgText = '';
    b.msgKind = '';
    render(b);

    S.client().rpc('set_rsvp', {
      p_night_id: b.night.night_id,
      p_response: next
    }).then(function (r) {
      if (r.error) { throw r.error; }
      b.busy = false;
      b.busyOn = null;
      render(b);
    }).catch(function (err) {
      // Roll the whole snapshot back, visibly, and say why.
      b.busy = false;
      b.busyOn = null;
      b.mine = snap.mine;
      b.going = snap.going;
      b.goingCount = snap.goingCount;
      b.notGoingCount = snap.notGoingCount;
      if (String(err && err.code) === 'P0020') {
        b.locked = true;
        b.msgText = 'That night is closed for RSVPs now. Tell an organiser instead.';
      } else {
        b.msgText = 'Not saved: ' + S.friendlyError(err);
      }
      b.msgKind = 'error';
      render(b);
      warn('set_rsvp failed', err);
    });
  }

  /* ------------------------------------------------------------------
   * events.html
   * ------------------------------------------------------------------ */
  function initEvents() {
    var list = document.getElementById('events-upcoming');
    var tmpl = document.getElementById('rsvp-template');
    if (!list || !tmpl || !tmpl.content || !tmpl.content.firstElementChild) { return; }

    var sessionP = S.getSession().catch(function () { return null; });
    var nightsP = fetchNights();
    var jsonP = fetchEventsJson();
    var cardsP = whenPresent(list, function () {
      return !!list.querySelector('.event-card');
    }, WAIT_MS);

    Promise.all([nightsP, jsonP, cardsP, sessionP]).then(function (res) {
      var nights = res[0];
      var events = Array.isArray(res[1]) ? res[1] : [];
      var session = res[3];

      var byDate = {};
      nights.forEach(function (n) { byDate[isoOf(n.played_on)] = n; });

      var pairs = matchCards(list.querySelectorAll('.event-card'), events);
      var blocks = [];

      pairs.forEach(function (pair) {
        var night = byDate[pair.iso];
        if (!night) { return; }   // no night row: the card stays as it was
        var b = newBlock(night, tmpl, session ? 'checking' : 'anon');
        render(b);
        var host = pair.card.querySelector('.event-card__info') || pair.card;
        host.appendChild(b.el);
        blocks.push(b);
      });

      if (!blocks.length || !session) { return null; }
      return upgrade(blocks);
    }).catch(function (err) {
      warn('events RSVP unavailable', err);
    });
  }

  /* Second pass: who am I, what did I answer, who else is going. */
  function upgrade(blocks) {
    var ids = blocks.map(function (b) { return b.night.night_id; });

    return identify().then(function (who) {
      if (who.identity !== 'member') {
        blocks.forEach(function (b) {
          b.identity = who.identity;
          if (who.identity === 'unknown') {
            // Signed in, but we could not confirm the account. Say so rather
            // than leaving a control that would fail on the first tap.
            b.msgText = 'Could not check your account. Reload the page to RSVP.';
            b.msgKind = 'error';
          }
          render(b);
        });
        return null;
      }
      return fetchRsvps(ids).then(function (rows) {
        var mineKey = S.normPseudonym(who.member.pseudonym);
        var byNight = {};
        rows.forEach(function (r) {
          var slot = byNight[r.night_id];
          if (!slot) { slot = byNight[r.night_id] = { going: [], not: 0, mine: null }; }
          if (r.response === 'going') { slot.going.push(r.pseudonym); }
          else { slot.not += 1; }
          if (S.normPseudonym(r.pseudonym) === mineKey) { slot.mine = r.response; }
        });
        blocks.forEach(function (b) {
          var slot = byNight[b.night.night_id] || { going: [], not: 0, mine: null };
          b.identity = 'member';
          b.me = who.member.pseudonym;
          b.going = slot.going;
          b.goingCount = slot.going.length;
          b.notGoingCount = slot.not;
          b.mine = slot.mine;
          render(b);
        });
        return null;
      }).catch(function (err) {
        // The list failed, the control still works. Say so and keep going.
        warn('attendee list unavailable', err);
        blocks.forEach(function (b) {
          b.identity = 'member';
          b.me = who.member.pseudonym;
          b.going = null;
          b.msgText = 'Could not load who is going. Your own answer still saves.';
          b.msgKind = '';
          render(b);
        });
        return null;
      });
    }).catch(function (err) {
      warn('identity unavailable', err);
      return null;
    });
  }

  /* ------------------------------------------------------------------
   * index.html: the going count next to the countdown.
   *
   * The countdown decides which event is next, in js/app.js. We read its
   * title back out of the DOM rather than repeating that rule here, so the
   * two can never disagree. If the countdown never fills, neither do we.
   * ------------------------------------------------------------------ */
  function initIndex() {
    var out = document.getElementById('countdown-going');
    var nameEl = document.getElementById('countdown-name');
    if (!out || !nameEl) { return; }

    var nightsP = fetchNights();
    var jsonP = fetchEventsJson();
    var readyP = whenPresent(nameEl, function () {
      return normText(nameEl.textContent) !== '';
    }, WAIT_MS);

    Promise.all([nightsP, jsonP, readyP]).then(function (res) {
      var nights = res[0];
      var events = Array.isArray(res[1]) ? res[1] : [];
      var want = normText(nameEl.textContent);
      var iso = null;
      var i;

      for (i = 0; i < events.length; i++) {
        if (normText(events[i].title) === want) { iso = isoOf(events[i].date); break; }
      }
      if (!iso) { return; }

      for (i = 0; i < nights.length; i++) {
        if (isoOf(nights[i].played_on) === iso) {
          var n = Number(nights[i].going_count) || 0;
          if (n > 0) {
            setNumLine(out, n, 'going', 'countdown__going-num');
          } else {
            out.textContent = 'Nobody has answered yet.';
          }
          return;
        }
      }
    }).catch(function (err) {
      warn('countdown headcount unavailable', err);
    });
  }

  /* Two independent entry points. Neither can take the other down, and
   * neither can take the page down. */
  try { initEvents(); } catch (err) { warn('events init failed', err); }
  try { initIndex(); } catch (err) { warn('index init failed', err); }
})();
