/* Store Blindern Poker: RSVP for upcoming nights, and the venue.
 *
 * Loaded (after js/config.js, js/vendor/supabase.js, js/sb.js and js/app.js)
 * by index.html and events.html. Self-contained: it adds behaviour to markup
 * js/app.js has already rendered and never edits or depends on that script.
 *
 * Progressive enhancement, in this order:
 *   1. The page renders from data/events.json with no database at all. That
 *      is the baseline and it must never regress.
 *   2. If Supabase answers, an RSVP block is appended to each upcoming event
 *      card, the going count is added to the home page countdown, and the
 *      venue on a matched card is replaced by the one in the database, which
 *      is where the room lives since migration 0012.
 *   3. If any of that fails, times out, or the visitor is offline, we log a
 *      warning and leave the page exactly as js/app.js left it. Every entry
 *      point is wrapped, every promise has a catch, nothing here can blank a
 *      list or stop the countdown.
 *
 * The privacy split is deliberate and lives in the queries, not in the CSS:
 *   - v_upcoming_nights is anon-readable and carries the night itself: the
 *     venue, the map link, and RSVP COUNTS. No names. Signed-out visitors get
 *     a room and a number, never who is coming.
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
    'reports_close_at,location,location_url,going_count,not_going_count,capacity';

  /* Memoised for the life of the page load. index.html has three readers of
   * this view now (the headcount, the venue, and the live-night route) and
   * they must cost ONE request between them, not three. Every caller has its
   * own catch, so a rejection shared this way still cannot take a page down. */
  var nightsPromise = null;

  function fetchNights() {
    if (nightsPromise) { return nightsPromise; }
    nightsPromise = S.client().from('v_upcoming_nights').select(UPCOMING_COLS)
      .order('played_on', { ascending: true })
      .then(function (r) {
        if (r.error) { throw r.error; }
        return r.data || [];
      });
    return nightsPromise;
  }

  /* Ask the server again. Only the live-night route does this, and only when
   * a tonight face is already on screen: a stale "the round is open" is a
   * worse artefact than a nine minute old headcount. */
  function refetchNights() {
    nightsPromise = null;
    return fetchNights();
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
   * The venue: where the JSON and the database disagree, the database wins
   *
   * data/events.json still renders the card, and that stays the baseline:
   * with no database, or no match, the page is exactly what js/app.js drew.
   * But a room is now a field an organiser can change from admin.html in ten
   * seconds, and the file needs a commit and a deploy, so once a night row
   * matches this card the database is the newer answer and it replaces the
   * room and the map link together.
   *
   * A night whose location is empty or literally "TBD" is not a missing
   * answer, it is the answer: the room is not confirmed. Saying so is the
   * honest render. Falling back to the JSON there would send people to last
   * term's room with full confidence, which is the exact failure this whole
   * change exists to stop.
   * ------------------------------------------------------------------ */

  var TBD_TEXT = 'Venue still to be confirmed';

  function venueText(night) {
    var v = String((night && night.location) || '').trim();
    return (!v || v.toLowerCase() === 'tbd') ? '' : v;
  }

  /* Only a real web link becomes a link. */
  function mapHref(url) {
    var u = String(url == null ? '' : url).trim();
    return /^https?:\/\//i.test(u) ? u : '';
  }

  function roomLinkIn(box) {
    if (!box) { return null; }
    var all = box.querySelectorAll('a.event-link');
    for (var i = 0; i < all.length; i++) {
      if (/find the room/i.test(all[i].textContent || '')) { return all[i]; }
    }
    return null;
  }

  function applyVenue(card, night) {
    var venue = venueText(night);
    // The room and its map move TOGETHER. An unconfirmed room with a live
    // "Find the room" button is the worst of both: the card says nothing is
    // settled while the button sends people somewhere with full confidence.
    // It is a real state, too, not a hypothetical: clearing a room in the
    // console and forgetting the map link leaves exactly this row.
    var href = venue ? mapHref(night.location_url) : '';

    // The second cell of the meta row is the location, in js/app.js and in
    // the noscript fallback alike. DIRECT children only: the time cell can
    // carry a nested badge span (a "doors at 17:30" note), and a flat
    // querySelectorAll would hand back that badge as cell number two.
    // Text only: no markup goes in here.
    var meta = card.querySelector('.event-card__meta');
    if (meta) {
      var kids = meta.children;
      var spans = [];
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].tagName === 'SPAN') { spans.push(kids[i]); }
      }
      var cell = spans.length > 1 ? spans[1] : null;
      if (!cell) {
        cell = document.createElement('span');
        meta.appendChild(cell);
      }
      cell.textContent = venue || TBD_TEXT;
      if (venue) { cell.classList.remove('venue--tbd'); }
      else { cell.classList.add('venue--tbd'); }
    }

    // The map link belongs to whichever room the database names. If the
    // database has no link, the one from the JSON goes: a "Find the room"
    // button pointing at the wrong room is worse than no button at all.
    var links = card.querySelector('.event-card__links');
    var roomLink = roomLinkIn(links);

    if (href) {
      if (!roomLink) {
        if (!links) {
          links = document.createElement('div');
          links.className = 'event-card__links';
          (card.querySelector('.event-card__info') || card).appendChild(links);
        }
        roomLink = document.createElement('a');
        roomLink.className = 'event-link';
        roomLink.setAttribute('target', '_blank');
        roomLink.setAttribute('rel', 'noopener');
        roomLink.textContent = 'Find the room ↗';
        links.appendChild(roomLink);
      }
      roomLink.setAttribute('href', href);
    } else if (roomLink) {
      roomLink.parentNode.removeChild(roomLink);
      if (links && !links.querySelector('a')) { links.parentNode.removeChild(links); }
    }
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

  /* "9 of 38 going", or plain "9 going" when the night has no cap. */
  function setCountLine(el, n, cap, numClass) {
    el.textContent = '';
    var num = document.createElement('span');
    num.className = numClass;
    num.textContent = cap ? (String(n) + ' of ' + String(cap)) : String(n);
    el.appendChild(num);
    el.appendChild(document.createTextNode(' going'));
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
      // Seats. null means the night is uncapped, and the count renders
      // bare rather than as "9 of nothing".
      capacity: (night.capacity === null || night.capacity === undefined)
                  ? null : Number(night.capacity),
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

    /* A full night still takes walk-ins: the cap is how many chairs we
     * put out, not a door policy. So this disables the Going button and
     * says why, and says nothing about whether you may turn up. */
    var full = b.capacity !== null && b.goingCount >= b.capacity;

    /* Headcount. Always shown, to everybody. */
    if (b.goingCount > 0) {
      setCountLine(b.count, b.goingCount, b.capacity, 'rsvp__count-num');
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
        // Somebody who already holds a seat can always change their mind,
        // so a full night never locks the person who filled it.
        if (isChecking || b.locked ||
            (val === 'going' && full && b.mine !== 'going')) {
          btn.setAttribute('aria-disabled', 'true');
        } else { btn.removeAttribute('aria-disabled'); }
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
      if (full && b.mine !== 'going') {
        hint = 'All ' + b.capacity + ' seats are taken. Check back in case '
             + 'somebody drops out, or ask an organiser.';
      } else {
        hint = b.mine
          ? 'Tap the same answer again to clear it.'
          : 'One tap. You can change it later.';
      }
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
        // The room, before the RSVP block goes in, and wrapped: a venue that
        // will not render must never cost the card its RSVP control.
        try { applyVenue(pair.card, night); } catch (err) { warn('venue not applied', err); }
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
          var cap = (nights[i].capacity === null || nights[i].capacity === undefined)
                      ? null : Number(nights[i].capacity);
          if (n > 0) {
            setCountLine(out, n, cap, 'countdown__going-num');
          } else {
            out.textContent = 'Nobody has answered yet.';
          }
          // Same rule as the event cards: the database is the newer answer
          // about the room, including when the answer is "not confirmed".
          var locEl = document.getElementById('countdown-location');
          if (locEl) {
            var venue = venueText(nights[i]);
            locEl.textContent = venue || TBD_TEXT;
            if (venue) { locEl.classList.remove('venue--tbd'); }
            else { locEl.classList.add('venue--tbd'); }
          }
          return;
        }
      }
    }).catch(function (err) {
      warn('countdown headcount unavailable', err);
    });
  }

  /* ------------------------------------------------------------------
   * index.html: the route to reporting on a live night.
   *
   * Until this, nothing on the public site linked to report.html at all. The
   * shortest route on a Friday at 20:25 was three taps, the word "report"
   * appeared on the third screen, and the one element that knew it was a live
   * night, the countdown, pointed at a calendar.
   *
   * The nav's "Tonight" is the PERMANENT route and it cannot fail. This is
   * the loud one, and it is the opposite of the rest of this file: everything
   * else here fails soft toward a page that is complete without it, which is
   * right for a headcount. An element that fails soft toward nothing is wrong
   * for the only loud route to reporting, so every path below ends either in
   * a visible route or in exactly today's page, never in a half state.
   *
   * The source is v_upcoming_nights, which index.html already reads once for
   * the headcount and the venue, and which already carries status. It is
   * anon-readable, so a first timer at the door gets it too. Cost: zero extra
   * requests. It deliberately does NOT reuse initIndex's countdown-title
   * matching: the only route to reporting must not inherit a dependency on
   * somebody having committed the Friday to data/events.json with a title
   * that still matches.
   * ------------------------------------------------------------------ */

  var TONIGHT_KEY = 'sbp.tonight';
  var SIGN_IN_NOTE = ' You sign in first if you are not already.';

  function osloHm(date) {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(date);
    } catch (err) {
      // Ancient browser with no timeZone support: local time, honestly.
      return date.toTimeString().slice(0, 5);
    }
  }

  function osloDayKey(date) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(date);
    } catch (err) {
      return date.toISOString().slice(0, 10);
    }
  }

  /* "until 09:00 tomorrow", or no number at all rather than a guessed one.
   * lead is the sentence up to the time. */
  function closesSentence(lead, closesAt) {
    var t = closesAt ? new Date(closesAt) : null;
    if (!t || isNaN(t)) { return lead + ' the morning.'; }
    var word = (osloDayKey(t) === osloDayKey(new Date())) ? '' : ' tomorrow';
    return lead + ' ' + osloHm(t) + word + '.';
  }

  function readTonightNote() {
    try {
      var raw = window.localStorage.getItem(TONIGHT_KEY);
      if (!raw) { return null; }
      var v = JSON.parse(raw);
      if (!v || !v.closes_at) { return null; }
      var t = new Date(v.closes_at);
      if (isNaN(t)) { return null; }
      return { closes_at: v.closes_at, ms: t.getTime() };
    } catch (err) { return null; }
  }

  function writeTonightNote(night) {
    try {
      if (!night.reports_close_at) { return; }
      window.localStorage.setItem(TONIGHT_KEY, JSON.stringify({
        night_id: night.night_id,
        closes_at: night.reports_close_at
      }));
    } catch (err) { /* private mode: the note is a bonus, never the route */ }
  }

  function clearTonightNote() {
    try { window.localStorage.removeItem(TONIGHT_KEY); } catch (err) { /* as above */ }
  }

  /* Back to exactly today's page: the block down, the hero primary brass
   * again, the countdown pointing at the calendar. Called when the read
   * fails, when no night qualifies, and when a night is settled under a tab
   * that has been open since 19:00. */
  function hideTonight() {
    var root = document.getElementById('hero-tonight');
    var events = document.getElementById('hero-events-btn');
    var cd = document.getElementById('countdown-link');
    if (root) { root.style.display = 'none'; }
    if (events) { events.className = 'btn btn--primary'; }
    if (cd) { cd.setAttribute('href', 'events.html'); }
  }

  function showTonight(face) {
    var root = document.getElementById('hero-tonight');
    if (!root) { return; }
    document.getElementById('hero-tonight-label').textContent = face.label;
    document.getElementById('hero-tonight-btn').textContent = face.button;
    document.getElementById('hero-tonight-note').textContent = face.note;
    root.style.display = '';
    // The screen's one brass fill moves to the route that matters tonight.
    var events = document.getElementById('hero-events-btn');
    if (events) { events.className = 'btn btn--secondary'; }
    // The countdown already says "Happening now" off a clock in js/app.js. We
    // do not touch that label, because that clock knows nothing about whether
    // the organisers opened the night and would race us for the text. Only
    // the destination changes, and only when the database says it is open.
    var cd = document.getElementById('countdown-link');
    if (cd) { cd.setAttribute('href', 'report.html'); }
  }

  function tonightFace(night) {
    if (night.status === 'reconciling') {
      // The bank has packed up but reporting is still running, so the copy
      // does not offer a check-in that would be refused.
      return {
        label: 'Tonight',
        button: 'Report my stack',
        note: 'The round is over. ' +
          closesSentence('Reporting stays open until', night.reports_close_at) +
          SIGN_IN_NOTE
      };
    }
    return {
      label: 'Tonight',
      button: 'Check in and report',
      note: closesSentence('Reporting stays open until', night.reports_close_at) +
        SIGN_IN_NOTE
    };
  }

  var tonightShown = false;
  var tonightReadAt = 0;

  function initTonight(refetch) {
    if (!document.getElementById('hero-tonight')) { return; }
    tonightReadAt = Date.now();
    var p = refetch ? refetchNights() : fetchNights();
    p.then(function (nights) {
      var live = null;
      var i;
      // The view applies deleted_at is null and played_on >= current_date and
      // excludes settled and void, so it holds FUTURE nights too, not just
      // tonight's. Status alone said yes to a night open three days out and
      // lit the whole live face on the landing page. played_on comes back in
      // the same row, so compare it against today in Europe/Oslo: it is a
      // plain calendar date, the phone can be anywhere, and the club's day is
      // Oslo's. After midnight this stops matching, which is right: the row
      // is last night's, and the localStorage note below is what covers the
      // hours to 09:00 with the correct "Last night" wording.
      var today = osloDayKey(new Date());
      for (i = 0; i < nights.length; i++) {
        if (isoOf(nights[i].played_on) !== today) { continue; }
        if (nights[i].status === 'open' || nights[i].status === 'reconciling') {
          live = nights[i];
          break;
        }
      }
      if (live) {
        showTonight(tonightFace(live));
        tonightShown = true;
        writeTonightNote(live);
        return;
      }
      // No qualifying row. Either there is no night, or it is past midnight
      // Oslo and the view has dropped a night whose reporting runs to 09:00.
      // The phone that was in the room can tell the difference, because it
      // wrote down when reporting closes while the night was still open. A
      // phone that was not in the room gets the nav item and an honest
      // report.html, which is the stated limit of this route.
      var note = readTonightNote();
      if (note && Date.now() < note.ms) {
        showTonight({
          label: 'Last night',
          button: 'Report my stack',
          note: closesSentence('Reporting is still open until', note.closes_at) +
            ' If you went home without sending your final stack, send it now.'
        });
        tonightShown = true;
        return;
      }
      if (note) { clearTonightNote(); }
      hideTonight();
      tonightShown = false;
    }).catch(function (err) {
      // Offline, or the database will not answer. The page goes back to being
      // exactly what it is on a quiet Tuesday, and the nav still says Tonight.
      warn('tonight route unavailable', err);
      hideTonight();
      tonightShown = false;
    });
  }

  /* A phone left on this page since 19:00 keeps rendering whatever the first
   * read said, and "the round is open" is a worse stale artefact than a nine
   * minute old headcount. Re-read on the way back into the tab, but ONLY when
   * a tonight face is up and at most once a minute, so a quiet Tuesday still
   * makes exactly the one request it makes today. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { return; }
    if (!tonightShown) { return; }
    if (Date.now() - tonightReadAt < 60000) { return; }
    try { initTonight(true); } catch (err) { warn('tonight refresh failed', err); }
  });

  /* Three independent entry points. None can take the others down, and none
   * can take the page down. */
  try { initEvents(); } catch (err) { warn('events init failed', err); }
  try { initIndex(); } catch (err) { warn('index init failed', err); }
  try { initTonight(false); } catch (err) { warn('tonight route init failed', err); }
})();
