/* Store Blindern Poker: public site behaviour.
 *
 * Vanilla JS, no build step. Every feature checks for its own DOM hooks and
 * does nothing if they are absent, so this one file is safe to include on
 * every public page. Every network call fails soft: the static markup is
 * always the fallback.
 */
(function () {
  'use strict';

  // Signal that JS is running. CSS gates .reveal behind this class so a JS
  // failure never leaves the page blank.
  document.documentElement.classList.add('js');

  /* ------------------------------------------------------------------
   * Mobile navigation
   * ------------------------------------------------------------------ */
  var navToggle = document.querySelector('.nav__toggle');
  var navLinks = document.querySelector('.nav__links');
  if (navToggle && navLinks) {
    navToggle.addEventListener('click', function () {
      var open = navLinks.classList.toggle('nav__links--open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Close the menu when a link is chosen.
    navLinks.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        navLinks.classList.remove('nav__links--open');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ------------------------------------------------------------------
   * Scroll reveal
   * ------------------------------------------------------------------ */
  var revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('reveal--visible');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12 });
      revealEls.forEach(function (el) { io.observe(el); });
    } else {
      revealEls.forEach(function (el) { el.classList.add('reveal--visible'); });
    }
  }

  /* ------------------------------------------------------------------
   * Events data
   *
   * ORDER OF TRUTH, the same three steps the leaderboard further down this
   * file already runs (live view, then the committed file, then the static
   * markup):
   *
   *   1. v_upcoming_nights, read anonymously. THIS is the calendar. A night
   *      created in admin.html is on this page at the next reload, with no
   *      file to edit and no deploy.
   *   2. data/events.json, when the view will not answer, or will not answer
   *      in time. It is the last known good copy, exactly what
   *      data/leaderboard-fallback.json is to the standings, and the page
   *      says so above the list when that is what you are reading.
   *   3. The empty state, or the noscript block with JavaScript off.
   *
   * WHY THIS CHANGED. The file used to be the source, so a round that
   * existed only in the database was a round this page denied. An organiser
   * created Round 2 in the console, pressed the button that mails everybody
   * who has played this season, and forty people followed "save your seat"
   * to a page that said nothing was on. The data was already in every one of
   * those browsers: js/rsvp.js had fetched this same view and used it only
   * to correct rooms on cards the file had built. The fix is to let the
   * database decide what exists, and to demote the file to what it is good
   * at, being readable when nothing else answers.
   * ------------------------------------------------------------------ */
  /* Language, or English if js/i18n.js did not load. t() is the identity
   * function on an English page, so every string below reads as it always
   * did and the English pages do not depend on that file at all. */
  var I18N = window.SBP_I18N ||
    { lang: 'en', locale: 'en-GB', t: function (k, en) { return en; },
      months: function () { return null; }, weekdays: function () { return null; } };

  // The English arrays stay as the fallback, so a browser without a locale
  // database still gets a date badge rather than "undefined".
  var MONTHS = I18N.months(false) || ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = I18N.weekdays(false) || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // The club's standing hours, for a night the database knows about and the
  // file does not. See nightToEvent: nights has no time column.
  var HOUSE_START = '18:00';
  var HOUSE_END = '20:30';

  // How long the live read gets before the saved copy takes over. See
  // withTimeout for why a hang needs its own answer.
  var DB_TIMEOUT_MS = 2500;

  var TBD_TEXT = I18N.t('events.venue.tbd', 'Venue still to be confirmed');

  function eventDate(ev) {
    // Events happen in Oslo; the audience reads the site in Oslo. Local time
    // parsing is deliberate and good enough.
    return new Date(ev.date + 'T' + (ev.time || '18:00') + ':00');
  }

  function isUpcoming(ev) {
    // Trust the status flag, but auto-demote events whose night has passed
    // (a night "ends" six hours after its start time).
    var ends = eventDate(ev).getTime() + 6 * 60 * 60 * 1000;
    return ev.status === 'upcoming' && Date.now() < ends;
  }

  /* played_on and the dates in data/events.json are plain calendar dates,
   * never timestamps, so they compare as strings and no Date object or
   * timezone is involved. Same rule js/rsvp.js states for the same reason. */
  function isoOf(v) { return String(v == null ? '' : v).slice(0, 10); }
  function isIso(v) { return /^\d{4}-\d{2}-\d{2}$/.test(isoOf(v)); }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // Today where the reader is, which for this audience is Oslo. The view
  // filters on the database's UTC date instead, so for an hour or two after
  // midnight the two disagree. mergeSources says why that is harmless.
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* Run once every deferred script on the page has executed.
   *
   * This file is loaded BEFORE js/sb.js, which owns the single Supabase
   * client the member pages share, so window.SBP does not exist yet at the
   * moment this script runs. Deferred scripts all execute before
   * DOMContentLoaded fires, so waiting for that event is what lets us borrow
   * that client instead of standing up a second one, and it costs one tick.
   * The timer is a backstop for the day somebody loads this file some other
   * way; whichever fires first wins and the other is dropped. */
  function afterScripts(fn) {
    var ran = false;
    function go() {
      if (ran) { return; }
      ran = true;
      fn();
    }
    if (document.readyState === 'complete') { go(); return; }
    document.addEventListener('DOMContentLoaded', go);
    setTimeout(go, 0);
  }

  /* ------------------------------------------------------------------
   * The anonymous client, made once for this file.
   *
   * js/sb.js owns THE client wherever it is loaded, and we borrow it: two
   * supabase-js clients in one tab share the auth storage key and can race
   * each other refreshing a token, and the symptom of that is a member being
   * signed out at random, which would be blamed on the login page and not on
   * here. leaderboard.html loads this file without js/sb.js, so there has to
   * be a fallback, and it is built with the session machinery switched off so
   * that it can never touch that store.
   * ------------------------------------------------------------------ */
  var sbClient = null;
  var sbClientTried = false;

  function anonClient() {
    if (sbClientTried) { return sbClient; }
    sbClientTried = true;
    var cfg = window.SBP_CONFIG || {};
    var configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
      String(cfg.SUPABASE_URL).indexOf('__') !== 0 &&
      String(cfg.SUPABASE_ANON_KEY).indexOf('__') !== 0 &&
      window.supabase && window.supabase.createClient;
    if (!configured) { return null; }
    try {
      if (window.SBP && typeof window.SBP.client === 'function') {
        sbClient = window.SBP.client();
      }
      if (!sbClient) {
        sbClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
          }
        });
      }
    } catch (err) {
      console.warn('Supabase client unavailable:', err);
      sbClient = null;
    }
    return sbClient;
  }

  /* ------------------------------------------------------------------
   * The live calendar
   *
   * Named columns, never select('*'): the same rule js/sb.js documents for
   * the nights table applies to any view that might grow a column later. The
   * view is anon readable and carries counts, never names.
   *
   * THERE IS NO STATUS FILTER HERE, and that is a decision rather than an
   * omission. v_upcoming_nights already refuses settled and void and
   * anything before today, so what reaches us is draft, open or reconciling,
   * and all three belong on a public calendar.
   *
   * DRAFT IS THE NORMAL STATE OF A FUTURE NIGHT, and the schema says so
   * out loud. Migration 0004, widening the nights_read policy: "Upcoming
   * nights must be visible to members before they are opened, or there is
   * nothing to RSVP to: nights are created as drafts and only opened on the
   * night itself." The policy in force, from 0014, still carries the
   * "played_on >= current_date" arm that makes a future draft readable. So
   * hiding drafts would empty this page from Saturday morning to Friday
   * evening every single week, which is today's bug with a tidier cause.
   * The rest of the system already treats a draft as public: announceable()
   * in js/admin.js is draft or open, so the mail that sent forty people here
   * was sent about a draft on purpose, and set_rsvp() accepts an answer on
   * one, so the Going button on a draft card is not a promise the server
   * will break.
   *
   * OPEN and RECONCILING are tonight, before and after the cards are away.
   * The six hour clock in isUpcoming() moves the card to Past, which is the
   * honest line for both and the one the file already used.
   *
   * The cost is real and worth stating: a mistyped date is public at once
   * rather than at the next deploy. It is also fixable from the console in
   * ten seconds, and visible to four hundred people who will say so. A
   * missing night was visible to nobody, which is why it survived until
   * after the mail went out.
   * ------------------------------------------------------------------ */
  var NIGHT_COLS = 'played_on,title,location,location_url';

  function fetchNightsList() {
    var client = anonClient();
    if (!client) { return Promise.reject(new Error('Supabase not configured')); }
    try {
      return client.from('v_upcoming_nights').select(NIGHT_COLS)
        .order('played_on', { ascending: true })
        .then(function (res) {
          if (res.error) { throw res.error; }
          return res.data || [];
        });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function fetchEventsJson() {
    return fetch('/data/events.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error('events.json: HTTP ' + r.status); }
        return r.json();
      });
  }

  /* A database that hangs is not the same as one that fails, and only the
   * failure has a catch. A captive portal on campus wifi answers every
   * request with a login page that never resolves, and a paused project can
   * sit behind a slow edge. Without a bound the list would stay empty for as
   * long as that lasted: the same blank page we are fixing, from a different
   * cause, which would be an embarrassing way to ship this. */
  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) { return; }
        settled = true;
        reject(new Error('timed out after ' + ms + 'ms'));
      }, ms);
      p.then(function (v) {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /* The room, and whether we have one.
   *
   * DUPLICATED ON PURPOSE. js/rsvp.js owns this rule (venueText and
   * applyVenue there) and re-applies it to every card it matches, so it
   * remains the authority. This copy exists so that a card is never painted
   * with the literal word "TBD" and corrected a beat later, which is a
   * visible flicker on the one line people navigate by. If the two ever
   * disagree, js/rsvp.js wins and this one is the bug. */
  function venueOf(ev) {
    var v = String((ev && ev.location) || '').trim();
    return (!v || v.toLowerCase() === 'tbd') ? '' : v;
  }

  // Only a real web link becomes a link. Same rule, same file, same reason.
  function mapHref(url) {
    var u = String(url == null ? '' : url).trim();
    return /^https?:\/\//i.test(u) ? u : '';
  }

  /* One night row, in the shape renderEventCard already takes.
   *
   * Two fields the view does not carry, and it matters which is which.
   *
   * TIME. nights has no start or end column, so a night that does not run
   * the usual 18:00 to 20:30 cannot be advertised correctly from the console
   * at all. Where data/events.json still has a row for the same date we take
   * its time, its end and its "doors at 17:30" note, because a human wrote
   * those on purpose. Otherwise the house hours, which the page header states
   * anyway. This is the one thing on the card the console cannot correct, and
   * the honest fix is columns on nights plus fields in admin.html.
   *
   * DESCRIPTION and SIGN-UP LINK. Same source, same reason. The paragraph
   * that welcomes a first timer is copy, not data, and a committed file is
   * good at copy. A night with no row simply has no paragraph, and the
   * "First time?" notice under the list carries the welcome either way.
   *
   * EVERY field the file can add is read the same way: what the row says
   * wins, and what it leaves out falls through to the house default. An
   * absent field is an absence of information, never an instruction. Reading
   * a missing endTime as "this night has no end" was how a row written before
   * endTime existed lost its closing time, while a night the file has never
   * heard of kept one, which is backwards. */
  function nightToEvent(row, byDate) {
    var iso = isoOf(row.played_on);
    var copy = byDate[iso] || null;
    var venue = venueOf(row);
    return {
      date: iso,
      // title is nullable in the database, and this view carries no night_no
      // to build "Round 3" out of, so a nameless night still needs a name.
      title: String(row.title || '').trim() || 'Poker night',
      time: (copy && copy.time) || HOUSE_START,
      endTime: (copy && copy.endTime) || HOUSE_END,
      timeNote: (copy && copy.timeNote) || '',
      location: venue,
      // The room and its map move TOGETHER: a "Find the room" button on a
      // card that says the room is not settled sends people somewhere with
      // full confidence. js/rsvp.js documents this at length.
      locationUrl: venue ? mapHref(row.location_url) : '',
      description: (copy && copy.description) || '',
      registrationUrl: (copy && copy.registrationUrl) || '',
      // The existing clock decides upcoming or past. See isUpcoming.
      status: 'upcoming'
    };
  }

  /* One list out of two sources. Both rules are about what SILENCE means.
   *
   * The database wins on any date both name. nights has UNIQUE (season_id,
   * played_on), so one date is one night, and the console is where the room
   * and the title actually change. This is also what stops the Round 2 line
   * somebody added to the file by hand from rendering twice, which matters
   * because nobody is going to remember to delete it.
   *
   * A successful read that does not name a FUTURE date means that night is
   * gone: voided, removed, or never real. So future rows in the file are
   * dropped. Without that the file is a resurrection vector, and a cancelled
   * night comes back with a gold Upcoming badge that nobody would notice,
   * because deleting the line is precisely the chore this change abolishes.
   *
   * TODAY is the exception. A night settled at 21:00 leaves the view at once
   * but is still today's night, and until midnight the file is the only place
   * its card can come from. So silence about today means "already played",
   * not "never happened", and the file keeps that row. This is also what
   * covers the hour or two after midnight in Oslo when the view still returns
   * last night on the database's UTC date: one date, one card, and the clock
   * files it under Past. */
  function mergeSources(rows, events) {
    var byDate = {};
    var out = [];
    var seen = {};
    var today = todayIso();
    var i, iso;

    for (i = 0; i < events.length; i++) {
      iso = isoOf(events[i].date);
      if (isIso(iso)) { byDate[iso] = events[i]; }
    }

    for (i = 0; i < rows.length; i++) {
      iso = isoOf(rows[i].played_on);
      if (!isIso(iso) || seen[iso]) { continue; }
      seen[iso] = true;
      out.push(nightToEvent(rows[i], byDate));
    }

    for (i = 0; i < events.length; i++) {
      iso = isoOf(events[i].date);
      // ISO dates sort and compare as plain strings, which is the whole
      // reason this site stores them that way.
      if (!isIso(iso) || seen[iso] || iso > today) { continue; }
      seen[iso] = true;
      out.push(events[i]);
    }

    return out;
  }

  /* The loader every consumer on the page shares, resolved once.
   *
   * Resolves with { list: [...], source: 'live' | 'fallback' }. The source
   * is not decoration: a room read from a file that was last committed in
   * August is probably right and possibly a locked door, and the difference
   * between the two is a sentence above the list. It rejects only when both
   * sources are gone, which is the state the existing error message covers. */
  var eventsPromise = null;

  function loadEvents() {
    if (eventsPromise) { return eventsPromise; }
    eventsPromise = fetchEventsJson().catch(function (err) {
      console.warn('Saved events file unavailable:', err);
      return [];
    }).then(function (json) {
      var events = [];
      var i;
      // Defensive: a half-written file should cost us the fallback, not the
      // live list.
      if (Object.prototype.toString.call(json) === '[object Array]') {
        for (i = 0; i < json.length; i++) {
          if (json[i] && isIso(json[i].date)) { events.push(json[i]); }
        }
      }
      return withTimeout(fetchNightsList(), DB_TIMEOUT_MS).then(function (rows) {
        return { list: mergeSources(rows, events), source: 'live' };
      }).catch(function (err) {
        console.warn('Live calendar unavailable, using the saved copy:', err);
        if (!events.length) { throw err; }
        return { list: events.slice(), source: 'fallback' };
      });
    });
    return eventsPromise;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var WEEKDAYS_LONG = I18N.weekdays(true) ||
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS_LONG = I18N.months(true) ||
    ['January', 'February', 'March', 'April', 'May', 'June', 'July',
     'August', 'September', 'October', 'November', 'December'];

  /* "Friday 18 September 2026", and in Norwegian "fredag 18. september
   * 2026".
   *
   * Intl does the whole string rather than us gluing four pieces together,
   * because the differences are not just the words. Norwegian keeps the
   * weekday and month lowercase and puts a point after the day number, and
   * a version of this that concatenated capitalised names with spaces got
   * all three wrong at once. The manual build stays as the fallback for a
   * browser with no locale data. */
  function formatDateLong(ev) {
    var d = eventDate(ev);

    /* English keeps the hand-built string it always had. Intl's en-GB
     * would render "Friday, 18 September 2026" with a comma the club has
     * never written, and the English pages are the ones almost everybody
     * lands on, so they should not quietly change punctuation because the
     * site gained a second language. */
    if (I18N.lang === 'en') {
      return WEEKDAYS_LONG[d.getDay()] + ' ' + d.getDate() + ' ' +
             MONTHS_LONG[d.getMonth()] + ' ' + d.getFullYear();
    }

    try {
      return new Intl.DateTimeFormat(I18N.locale, {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      }).format(d);
    } catch (e) {
      return WEEKDAYS_LONG[d.getDay()] + ' ' + d.getDate() + ' ' +
             MONTHS_LONG[d.getMonth()] + ' ' + d.getFullYear();
    }
  }

  // "18:00 to 20:30" when an event declares an end, otherwise just the start.
  function timeRange(ev) {
    if (!ev.time) { return ''; }
    return ev.endTime ? ev.time + ' ' + I18N.t('time.to', 'to') + ' ' + ev.endTime : ev.time;
  }

  /* ------------------------------------------------------------------
   * Countdown (index.html)
   *
   * Reads the same loader as the events page, so a night that exists only in
   * the database lights the countdown too. Fixing one page and not the other
   * would just move the incident to next Friday: the mail pointed at /events
   * this time, and the landing page is where most people arrive.
   * ------------------------------------------------------------------ */
  var countdownSection = document.getElementById('countdown-section');

  function initCountdown() {
    loadEvents().then(function (res) {
      var events = res.list;
      var upcoming = events.filter(isUpcoming).sort(function (a, b) {
        return eventDate(a) - eventDate(b);
      });
      if (!upcoming.length) { return; } // section stays hidden
      var ev = upcoming[0];

      // The ISO date, written down BEFORE the name, so that by the time
      // js/rsvp.js sees the name appear the stamp is already there to read.
      // js/rsvp.js used to recover this date by matching the name back
      // against data/events.json, which finds nothing for a night that only
      // the database knows about, and the landing page would then lose its
      // headcount and its room. See initIndex there.
      if (isIso(ev.date)) {
        countdownSection.setAttribute('data-night-date', isoOf(ev.date));
      }
      document.getElementById('countdown-name').textContent = ev.title;
      document.getElementById('countdown-date').textContent =
        formatDateLong(ev) + ', ' + timeRange(ev) +
        (ev.timeNote ? ' (' + ev.timeNote + ')' : '');
      // Same venue rule as the cards, applied here so the line never shows a
      // bare "TBD" and never sits empty waiting for js/rsvp.js to correct it.
      var locEl = document.getElementById('countdown-location');
      var venue = venueOf(ev);
      locEl.textContent = venue || TBD_TEXT;
      if (venue) { locEl.classList.remove('venue--tbd'); }
      else { locEl.classList.add('venue--tbd'); }
      countdownSection.style.display = '';

      var target = eventDate(ev).getTime();
      var link = document.getElementById('countdown-link');
      var els = {
        d: document.getElementById('cd-days'),
        h: document.getElementById('cd-hours'),
        m: document.getElementById('cd-mins'),
        s: document.getElementById('cd-secs')
      };

      function pad(n) { return n < 10 ? '0' + n : '' + n; }

      function tick() {
        var diff = target - Date.now();
        if (diff <= 0) {
          if (link) { link.classList.add('countdown--live'); }
          var label = countdownSection.querySelector('.countdown__label');
          if (label) { label.textContent = I18N.t('board.now', 'Happening now'); }
          els.d.textContent = els.h.textContent = els.m.textContent = els.s.textContent = '00';
          clearInterval(timer);
          return;
        }
        els.d.textContent = pad(Math.floor(diff / 864e5));
        els.h.textContent = pad(Math.floor(diff / 36e5) % 24);
        els.m.textContent = pad(Math.floor(diff / 6e4) % 60);
        els.s.textContent = pad(Math.floor(diff / 1e3) % 60);
      }

      var timer = setInterval(tick, 1000);
      tick();
    }).catch(function (err) {
      // No calendar at all, no countdown, the page is complete without it.
      console.warn('Countdown unavailable:', err);
    });
  }

  if (countdownSection) { afterScripts(initCountdown); }

  /* ------------------------------------------------------------------
   * Events page rendering (events.html)
   *
   * ONE render, database first. The tempting alternative, painting the file
   * immediately and upgrading when the view answers, breaks js/rsvp.js:
   * whenPresent there watches for the first .event-card, would pair its RSVP
   * blocks against that first pass, and this second write would then destroy
   * the blocks it had just hung. Hence the short timeout above instead.
   * ------------------------------------------------------------------ */
  var upcomingList = document.getElementById('events-upcoming');
  var pastList = document.getElementById('events-past');
  var eventsStatus = document.getElementById('events-status');

  function renderEventCard(ev, past) {
    var d = eventDate(ev);
    var badge = past
      ? '<span class="badge badge--muted event-card__badge">' +
        I18N.t('events.badge.past', 'Past') + '</span>'
      : '<span class="badge badge--gold event-card__badge">' +
        I18N.t('events.badge.upcoming', 'Upcoming') + '</span>';
    var venue = venueOf(ev);
    var href = venue ? mapHref(ev.locationUrl) : '';
    var links = '';
    if (href) {
      links += '<a class="event-link" href="' + escapeHtml(href) +
        '" target="_blank" rel="noopener">' +
        I18N.t('events.link.room', 'Find the room') + ' &#8599;</a>';
    }
    if (ev.registrationUrl) {
      links += '<a class="event-link" href="' + escapeHtml(ev.registrationUrl) +
        '" target="_blank" rel="noopener">' +
        I18N.t('events.link.signup', 'Sign up') + ' &#8599;</a>';
    }
    var timeStr = escapeHtml(timeRange(ev)) +
      (ev.timeNote ? ' <span class="badge badge--muted">' + escapeHtml(ev.timeNote) + '</span>' : '');
    var venueCell = venue
      ? '<span>' + escapeHtml(venue) + '</span>'
      : '<span class="venue--tbd">' + TBD_TEXT + '</span>';
    // The date, written on the card. js/rsvp.js reads it back to find the
    // night this card is, instead of matching the title against
    // data/events.json, which cannot name a night that is only in the
    // database. Without this stamp a database-only night would render with
    // no RSVP control at all. See matchCards there.
    var stamp = isIso(ev.date) ? ' data-night-date="' + escapeHtml(isoOf(ev.date)) + '"' : '';
    return (
      '<article class="event-card"' + stamp + '>' +
        '<div class="event-card__date">' +
          '<div class="event-card__day">' + d.getDate() + '</div>' +
          '<div class="event-card__month">' + MONTHS[d.getMonth()] + '</div>' +
          '<div class="event-card__weekday">' + WEEKDAYS[d.getDay()] + '</div>' +
        '</div>' +
        '<div class="event-card__info">' +
          '<h3 class="event-card__title">' + escapeHtml(ev.title) + '</h3>' +
          '<div class="event-card__meta">' +
            '<span>' + timeStr + '</span>' +
            venueCell +
          '</div>' +
          (ev.description ? '<p class="event-card__desc">' + escapeHtml(ev.description) + '</p>' : '') +
          (links ? '<div class="event-card__links">' + links + '</div>' : '') +
        '</div>' +
        badge +
      '</article>'
    );
  }

  /* The line above the list, and it appears only when the list is not live.
   *
   * The room is the thing worth being careful about. At 17:55 on a Friday a
   * probably right room beats no room, so we do not suppress it, and an
   * unlabelled probably right room is how somebody ends up outside a locked
   * Abelstua, so we label it. This is the fetchFallbackLeaderboard rule
   * applied to the calendar. */
  function showFallbackNotice() {
    if (!eventsStatus) { return; }
    eventsStatus.innerHTML = '<div>' + I18N.t('events.fallback.notice',
      '<strong>This is the last saved copy of the calendar.</strong> ' +
      'We could not reach the live schedule, so a room or a time may have ' +
      'changed since it was saved. The club ' +
      '<a class="link-gold" href="https://discord.gg/XjdnedqTC" target="_blank" rel="noopener">Discord</a> ' +
      'has the current answer.') + '</div>';
    eventsStatus.hidden = false;
  }

  /* PAST NIGHTS still come from data/events.json only, and that is a
   * deferral rather than a design.
   *
   * v_upcoming_nights cannot serve them by construction: it filters
   * "status not in ('settled','void') and played_on >= current_date", and a
   * played night is settled almost by definition. No filtering here can
   * recover rows the view never returns. The honest end state is a second
   * anon readable view, v_past_nights, over played_on, title, kind, location
   * and nothing else. No code column, no RSVP counts, bounded to the current
   * season.
   *
   * It is not in this change for one reason: a missing past night misleads
   * nobody into walking anywhere, while a wrong upcoming night sends
   * thirty-eight people to the wrong room, and adding an anon readable view
   * over nights is a privacy decision that should not be made in the same
   * hour as an incident fix. It is real work and it is due within the
   * season: from Round 3 on, a night created in the console, played and
   * settled appears nowhere at all, because it leaves the view on settle and
   * was never in the file. An absence is invisible, so nobody will report
   * it. */
  /* Event structured data for the upcoming nights, built from the cards
   * that were actually rendered.
   *
   * It is here, and not baked into events.html, for the same reason the
   * list itself is not: the calendar is read live from the database, so
   * anything written into the page by hand is a room and a date that
   * somebody has to remember to change. A stale <h2> is a small problem.
   * A stale Event block is a wrong room in the format search engines and
   * assistants trust most, and it outlives the page that carried it,
   * because a rich result can sit in an index for weeks. So this reads
   * whichever source answered, file or database, and says only that.
   *
   * Upcoming nights only. Past nights come from data/events.json alone
   * and that section already knows it is incomplete (see the comment
   * above renderEvents); publishing an incomplete history as structured
   * data would be asserting the gaps are real.
   *
   * No offers block, deliberately. The club rule is no currency
   * language anywhere, and isAccessibleForFree says the true thing
   * without inventing a price in kroner for a night that has none.
   */
  /* The canonical URL of the page we are on, for the Event url below.
   *
   * Read from the canonical tag rather than hardcoded, because there are
   * now two events pages, /events and /no/events, and an Event that told
   * search engines the Norwegian page was the English one would be
   * pointing half its readers at a language they did not ask for. The
   * canonical is already per page and already correct; this just uses it. */
  function pageUrl() {
    var link = document.querySelector('link[rel="canonical"]');
    var href = link && link.getAttribute('href');
    return href || location.href.split('#')[0].split('?')[0];
  }

  function emitEventSchema(upcoming) {
    var old = document.getElementById('events-schema');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    if (!upcoming || !upcoming.length) { return; }

    var items = [];
    for (var i = 0; i < upcoming.length; i++) {
      var ev = upcoming[i];
      var day = isoOf(ev.date);
      if (!isIso(day)) { continue; }

      // Local time, no offset. The nights are in Oslo and the reader may
      // not be, and guessing an offset from the visitor's clock is how a
      // night ends up an hour out in somebody's calendar.
      var start = /^\d{2}:\d{2}$/.test(String(ev.time || '')) ? day + 'T' + ev.time : day;
      var end = /^\d{2}:\d{2}$/.test(String(ev.endTime || '')) ? day + 'T' + ev.endTime : '';

      // An unconfirmed room is still a confirmed campus, so the Place
      // falls back to the campus rather than to nothing.
      var venue = venueOf(ev);
      var item = {
        '@type': 'Event',
        name: String(ev.title || 'Poker night'),
        startDate: start,
        eventStatus: 'https://schema.org/EventScheduled',
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        isAccessibleForFree: true,
        url: pageUrl(),
        image: 'https://storeblindernpoker.org/assets/img/og-events.jpg',
        organizer: { '@id': 'https://storeblindernpoker.org/#organization' },
        location: {
          '@type': 'Place',
          name: venue || 'Blindern campus, University of Oslo',
          address: {
            '@type': 'PostalAddress',
            addressLocality: 'Oslo',
            addressCountry: 'NO'
          }
        }
      };
      if (end) { item.endDate = end; }
      if (ev.description) { item.description = String(ev.description); }
      items.push(item);
    }
    if (!items.length) { return; }

    var el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = 'events-schema';
    el.textContent = JSON.stringify({ '@context': 'https://schema.org', '@graph': items });
    document.head.appendChild(el);
  }

  function renderEvents(res) {
    var events = res.list;
    var upcoming = events.filter(isUpcoming).sort(function (a, b) {
      return eventDate(a) - eventDate(b);
    });
    var past = events.filter(function (ev) { return !isUpcoming(ev); })
      .sort(function (a, b) { return eventDate(b) - eventDate(a); });

    if (res.source === 'fallback') { showFallbackNotice(); }

    if (upcomingList) {
      upcomingList.innerHTML = upcoming.length
        ? upcoming.map(function (ev) { return renderEventCard(ev, false); }).join('')
        : '<div class="empty-state"><div class="empty-state__icon">&#9824;</div>' +
          '<p class="empty-state__text">' + I18N.t('events.empty.upcoming',
            'Nothing on the calendar right now. New nights are announced here and on Discord.') +
          '</p></div>';
    }
    if (pastList) {
      // "They appear here once a night has been played" was a promise this
      // section cannot keep while it reads the file and nothing else: a night
      // created in the console, played and settled never reaches the file at
      // all. So the empty state says what is true, and points at the board,
      // which is live and counts every settled night.
      pastList.innerHTML = past.length
        ? past.map(function (ev) { return renderEventCard(ev, true); }).join('')
        : '<div class="empty-state">' +
          '<p class="empty-state__text">' + I18N.t('events.empty.past',
            'No played nights are listed here yet. ' +
            'The <a class="link-gold" href="leaderboard.html">leaderboard</a> ' +
            'has the standings for every night that has been settled.') +
          '</p></div>';
    }

    // Last, and only on the events page: the structured data describes the
    // list a reader can see, so it is written after the list exists.
    if (upcomingList) { emitEventSchema(upcoming); }
  }

  function initEventsPage() {
    loadEvents().then(renderEvents).catch(function (err) {
      console.warn('Events unavailable:', err);
      var msg = '<div class="empty-state"><p class="empty-state__text">' +
        I18N.t('events.error',
          'Could not load the events list. Please refresh, or check the club Discord.') +
        '</p></div>';
      if (upcomingList) { upcomingList.innerHTML = msg; }
      if (pastList) { pastList.innerHTML = ''; }
    });
  }

  if (upcomingList || pastList) { afterScripts(initEventsPage); }

  /* ------------------------------------------------------------------
   * Leaderboard (leaderboard.html), live view with a baked fallback.
   *
   * Order of truth:
   *   1. The v_leaderboard view, read anonymously through the vendored
   *      supabase-js bundle (once js/config.js carries real values).
   *   2. On ANY failure, placeholders unpatched, network down, project
   *      paused, view error, data/leaderboard-fallback.json, the
   *      last-known-good copy an admin exports and commits.
   *   3. If the fallback is empty or missing too, the static "season
   *      starts 4 September" markup stays exactly as it is.
   * ------------------------------------------------------------------ */
  var leaderboardBody = document.getElementById('leaderboard-body');
  if (leaderboardBody) {
    // Its own read, deliberately not chained to the board's. If the banner
    // fails the standings still render, and a board with no caveat is worse
    // than a board with one but better than no board at all.
    fetchPendingBanner();
    fetchHistory();
    fetchLiveLeaderboard()
      .then(function (rows) {
        if (rows && rows.length) {
          renderLeaderboard(rows, 'live', null);
        } else {
          // Live but empty (season not settled yet): the placeholder
          // already says exactly that. Keep it.
        }
      })
      .catch(function (err) {
        console.warn('Live leaderboard unavailable, trying fallback:', err);
        fetchFallbackLeaderboard();
      });
    // Starts whatever the first read did. A page that fell back to the baked
    // copy because the project was waking up should pick up the live board on
    // its own a minute later, without anybody pressing reload.
    startLbPolling();
  }

  /* The caveat above the board.
   *
   * Points move as members report, rather than only when an organiser
   * settles a night, so the standings are usually a little ahead of the
   * record. This says by how much, in the two numbers anybody actually
   * wants: which night is still open, and how many people it is waiting on.
   *
   * It hides itself when there is nothing outstanding, so a settled season
   * reads exactly as it did before any of this existed. */
  function fetchPendingBanner() {
    var box = document.getElementById('leaderboard-provisional');
    if (!box) { return; }
    var client = anonClient();
    if (!client) { return; }
    try {
      client.from('v_leaderboard_pending')
        .select('title,night_no,entries,unreported')
        .order('played_on', { ascending: true })
        .then(function (res) {
          if (res.error) { throw res.error; }
          var rows = (res.data || []).filter(function (r) { return r.unreported > 0; });
          // Hidden again when the last night settles. Before the board
          // refreshed on a timer this could only ever appear, because the page
          // was thrown away before the answer changed. It can now go from
          // something to nothing while somebody is looking at it, and a
          // caveat left above a settled board is a lie.
          if (!rows.length) { box.hidden = true; return; }
          var parts = rows.map(function (r) {
            var name = r.title || ('Round ' + r.night_no);
            return escapeHtml(name) + ' is waiting on ' + r.unreported +
              ' of ' + r.entries + ' players';
          });
          box.innerHTML = '<div><strong>These standings can still change.</strong> ' +
            parts.join(', and ') + '. Anybody marked ' +
'<span class="badge badge--muted">not reported</span> is shown at the ' +
            'points they had before that night, because we do not know their ' +
            'result yet.</div>';
          box.hidden = false;
        })
        .catch(function (err) {
          console.warn('Provisional banner unavailable:', err);
        });
    } catch (err) {
      console.warn('Provisional banner unavailable:', err);
    }
  }

  /* The two column lists exist because a deploy and a migration are separate
   * acts here, and they land in whichever order somebody does them. Asking
   * for a column the view does not have yet is a 400 on the whole request,
   * which would drop the board to its baked fallback and make a missing
   * arrow look like a database outage. So the read asks for the movement
   * columns (migration 0024), and on any failure asks again without them.
   * A board with no arrows is a small loss. A board that will not load is
   * the page. */
  var LB_COLS = 'season_id,rank,pseudonym,points,nights_played,pending,provisional';
  var LB_COLS_MOVE = LB_COLS + ',delta_live,points_delta,places_moved';

  function fetchLiveLeaderboard() {
    var client = anonClient();
    if (!client) {
      return Promise.reject(new Error('Supabase not configured'));
    }
    function read(cols) {
      return client
        .from('v_leaderboard')
        .select(cols)
        .order('rank', { ascending: true })
        .then(function (res) {
          if (res.error) { throw res.error; }
          return res.data || [];
        });
    }
    try {
      return read(LB_COLS_MOVE).catch(function (err) {
        console.warn('Leaderboard movement columns unavailable, ' +
                     'reading without them:', err);
        return read(LB_COLS);
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /* ---------------- keeping it live ----------------
   *
   * Points move as people report, so a board left open on a phone at the
   * table goes stale within minutes. It re-reads on a timer rather than over
   * a realtime socket: a socket would mean opening replication on
   * season_scores and holding a connection per visitor, which is a lot of
   * machinery for a number that changes a few times an hour.
   *
   * A hidden tab polls nothing. Somebody's laptop left open on this page for
   * a week should cost the club's free tier nothing at all, and the read on
   * becoming visible again means they still see current numbers the moment
   * they look. Every failure is swallowed and the last good board stays up.
   */
  var lbTimer = null;

  function lbCadence() {
    var el = boardEl();
    // On the wall at closing time, worth the extra reads. Anywhere else, not.
    return (el && !el.hidden) ? 20000 : 60000;
  }

  function refreshLeaderboard() {
    if (document.hidden) { return; }
    fetchLiveLeaderboard().then(function (rows) {
      if (rows && rows.length) { renderLeaderboard(rows, 'live', null); }
    }).catch(function () { /* keep whatever is on screen */ });
    fetchPendingBanner();
    fetchHistory();
  }

  function startLbPolling() {
    if (lbTimer) { window.clearInterval(lbTimer); }
    lbTimer = window.setInterval(refreshLeaderboard, lbCadence());
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && leaderboardBody) { refreshLeaderboard(); }
  });

  function fetchFallbackLeaderboard() {
    fetch('/data/leaderboard-fallback.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error('leaderboard-fallback.json: HTTP ' + r.status); }
        return r.json();
      })
      .then(function (fb) {
        var rows = (fb && fb.rows) || [];
        if (rows.length) {
          renderLeaderboard(rows, 'fallback', fb.updated || null);
        }
        // Empty fallback (pre-season): keep the static placeholder.
      })
      .catch(function (err) {
        console.warn('Fallback leaderboard unavailable, keeping static content:', err);
      });
  }

  function fmt(n) {
    try { return Number(n).toLocaleString(I18N.locale); } catch (e) { return String(n); }
  }

  /* ---------------- what the round did to you ----------------
   *
   * Both numbers come from the view already decided (0024): while a night is
   * open they describe that night so far, and once it is settled they
   * describe it in full, until the next night opens and resets them to zero.
   * Nothing here chooses a baseline, it only draws what it is handed.
   *
   * Zero and null are drawn differently on purpose. Zero is a result, they
   * held their place, and gets the muted dot. Null means there is no earlier
   * standing to measure against, which is true of a member on their first
   * settled round, and gets nothing at all. Drawing "0" for both would claim
   * we know something we do not. */
  function moveChip(r) {
    if (!r || r.places_moved === null || r.places_moved === undefined) { return ''; }
    var n = Number(r.places_moved);
    if (!n) {
      return ' <span class="move move--level" aria-hidden="true">·</span>' +
             '<span class="visually-hidden">' +
             I18N.t('board.held', 'held their place') + '</span>';
    }
    var up = n > 0;
    var word = up ? I18N.t('board.up', 'up') : I18N.t('board.down', 'down');
    return ' <span class="move move--' + (up ? 'up' : 'down') + '">' +
             '<span aria-hidden="true">' + (up ? '▲' : '▼') + ' ' + Math.abs(n) + '</span>' +
             '<span class="visually-hidden">' + word + ' ' + Math.abs(n) + ' ' +
             I18N.t('board.places', 'places') + '</span>' +
           '</span>';
  }

  function deltaChip(r) {
    if (!r || r.points_delta === null || r.points_delta === undefined) { return ''; }
    var n = Number(r.points_delta);
    if (!n) {
      return '<span class="delta delta--level" aria-hidden="true">·</span>';
    }
    var up = n > 0;
    return '<span class="delta delta--' + (up ? 'up' : 'down') + '">' +
             (up ? '+' : '') + fmt(n) +
           '</span>';
  }

  /* ---------------- the trend line ----------------
   *
   * A ticker line for one member: their balance after each settled night,
   * normalised to its own range so the SHAPE is what you read. Absolute
   * height would make every line below the leader a flat smear, and the
   * question this answers is "steady or one enormous Friday", not "how many
   * points", which is in the next column in full.
   *
   * Four marks, in the order they are drawn:
   *   area    the fill under the line, which is what makes it read as a
   *           ticker rather than a scribble
   *   open    a dashed rule at the season's starting points, so above and
   *           below the line you began on is visible without arithmetic
   *   line    the balance itself
   *   dot     the latest value, the ticker's "now"
   *
   * Colour is set by the whole season, last against first, not by the last
   * night. A player who is up 30,000 on the term and lost a little on Friday
   * is having a good season, and 0024's arrows already say what Friday did.
   *
   * non-scaling-stroke is not a detail. The box is stretched by CSS to
   * whatever the column is wide, and without it the stroke stretches with the
   * geometry, so the same line is hairline on the page and fat on the wall.
   */
  function sparkline(series) {
    if (!series || series.length < 2) { return ''; }
    var vals = series.map(Number).filter(function (n) { return isFinite(n); });
    if (vals.length < 2) { return ''; }

    var W = 100, H = 28, PAD = 3;
    var min = Math.min.apply(null, vals);
    var max = Math.max.apply(null, vals);
    var span = (max - min) || 1;           // a flat season is a flat line, not a divide by zero
    var xAt = function (i) { return PAD + (i * (W - 2 * PAD)) / (vals.length - 1); };
    var yAt = function (v) { return H - PAD - ((v - min) / span) * (H - 2 * PAD); };

    var pts = vals.map(function (v, i) { return xAt(i).toFixed(2) + ',' + yAt(v).toFixed(2); });
    var net = vals[vals.length - 1] - vals[0];
    var kind = net > 0 ? 'up' : net < 0 ? 'down' : 'level';
    var openY = yAt(vals[0]).toFixed(2);
    var lastX = xAt(vals.length - 1).toFixed(2);
    var lastY = yAt(vals[vals.length - 1]).toFixed(2);

    var label = I18N.t('board.trend', 'Season trend') + ': ' +
      (net > 0 ? '+' : '') + fmt(net) + ' ' +
      I18N.t('board.over', 'over') + ' ' + (vals.length - 1) + ' ' +
      I18N.t('board.nights', 'nights');

    return '<svg class="spark spark--' + kind + '" viewBox="0 0 ' + W + ' ' + H + '" ' +
             'preserveAspectRatio="none" role="img" aria-label="' + escapeHtml(label) + '">' +
             '<path class="spark__area" d="M' + xAt(0).toFixed(2) + ',' + (H - PAD) +
               ' L' + pts.join(' L') + ' L' + lastX + ',' + (H - PAD) + ' Z"/>' +
             '<line class="spark__open" x1="' + PAD + '" y1="' + openY +
               '" x2="' + (W - PAD) + '" y2="' + openY + '" vector-effect="non-scaling-stroke"/>' +
             '<polyline class="spark__line" points="' + pts.join(' ') +
               '" vector-effect="non-scaling-stroke"/>' +
             '<circle class="spark__dot" cx="' + lastX + '" cy="' + lastY + '" r="2.1"/>' +
           '</svg>';
  }

  /* Keyed on season AND pseudonym. A pseudonym is unique inside a season and
   * emphatically not across them, and both views carry the season, so there
   * is no reason to key on the half of that which can collide. */
  var lbHistory = null;

  function histKey(r) { return String(r.season_id) + '|' + String(r.pseudonym); }

  function sparkFor(r) {
    if (!lbHistory) { return ''; }
    return sparkline(lbHistory[histKey(r)] || null);
  }

  /* Its own read, like the pending banner, and just as disposable. The board
   * must render whether or not this answers, including on a database that has
   * not had 0025 applied yet, so every failure here is a warning and a board
   * without trend lines. */
  function fetchHistory() {
    var client = anonClient();
    if (!client) { return; }
    try {
      client.from('v_leaderboard_history')
        .select('season_id,pseudonym,series')
        .then(function (res) {
          if (res.error) { throw res.error; }
          var map = {};
          (res.data || []).forEach(function (r) { map[histKey(r)] = r.series; });
          lbHistory = map;
          // Arrives after the board in the ordinary case, so the rows already
          // on screen are redrawn once with their lines in.
          if (lbRows.length) { renderLeaderboard(lbRows, 'live', null); }
        })
        .catch(function (err) {
          console.warn('Trend lines unavailable:', err);
        });
    } catch (err) {
      console.warn('Trend lines unavailable:', err);
    }
  }

  /* The round's two extremes.
   *
   * Computed here rather than in the view because it is not a scoring rule,
   * it is a max and a min over a column the page has already been handed.
   * Adding a second read, or a second view to keep in step with 0024's
   * baseline, would buy nothing.
   *
   * NEITHER IS SHOWN UNLESS IT REALLY HAPPENED. If nobody lost points over
   * the round there is no biggest loss, and the row is absent rather than
   * handed to whoever gained least. Printing "biggest loss" over a player who
   * had a perfectly good night, on a screen in front of the room, would be a
   * straightforward lie about them. Same in reverse on a brutal night where
   * nobody finished up.
   *
   * Ties go to the better-ranked player, because rows arrive in rank order
   * and the comparison is strict. Deterministic, which matters when this is
   * on a wall and somebody is arguing about it. */
  function roundMovers(rows) {
    var up = null, down = null;
    rows.forEach(function (r) {
      if (r.points_delta === null || r.points_delta === undefined) { return; }
      var d = Number(r.points_delta);
      if (d > 0 && (!up || d > Number(up.points_delta))) { up = r; }
      if (d < 0 && (!down || d < Number(down.points_delta))) { down = r; }
    });
    return (up || down) ? { up: up, down: down } : null;
  }

  function moverRowHtml(r, kind) {
    var label = kind === 'win'
      ? I18N.t('board.biggestWin', 'Biggest win')
      : I18N.t('board.biggestLoss', 'Biggest loss');
    var d = Number(r.points_delta);
    return '<div class="podium__place podium__place--' + kind + '">' +
      '<div class="podium__medal">' + label + '</div>' +
      '<div class="podium__name">' + escapeHtml(r.pseudonym) + '</div>' +
      '<div class="podium__points">' + (d > 0 ? '+' : '') + fmt(d) + '</div>' +
    '</div>';
  }

  function renderLeaderboard(rows, source, updated) {

    // Podium cards for the top three.
    var podium = document.getElementById('leaderboard-podium');
    if (podium) {
      var medals = ['Champion', 'Second', 'Third'];
      podium.innerHTML = rows.slice(0, 3).map(function (r, i) {
        // A leader whose own night is unreported is standing on last week's
        // number, not this week's. Saying so is the difference between a
        // provisional board and a wrong one.
        var waiting = r.pending
          ? '<div class="podium__medal">Not reported yet</div>'
          : '';
        return '<div class="podium__place podium__place--' + (i + 1) + '">' +
          '<div class="podium__medal">' + medals[i] + '</div>' +
          '<div class="podium__name">' + escapeHtml(r.pseudonym) + '</div>' +
          '<div class="podium__points">' + fmt(r.points) + ' pts</div>' +
          waiting +
        '</div>';
      }).join('');

      // Appended to the same list rather than given their own card grid: the
      // top three and the round's movers are the same kind of statement about
      // the same board, and two competing layouts above one table is noise.
      var mv = roundMovers(rows);
      if (mv) {
        podium.innerHTML += (mv.up ? moverRowHtml(mv.up, 'win') : '') +
                            (mv.down ? moverRowHtml(mv.down, 'loss') : '');
      }
      podium.style.display = '';
    }

    leaderboardBody.innerHTML = rows.map(function (r) {
      var initial = (r.pseudonym || '?').trim().charAt(0).toUpperCase();
      // WHY THE TAG EXISTS. Points only move when somebody reports, so a
      // player who has not reported sits at the number they had before the
      // night. Without a word on the row that reads as a result, and it
      // quietly flatters silence: report a loss and you drop, say nothing
      // and you hold your place. The tag makes the reason visible, which is
      // how this club handles everything else it cannot verify.
      var tag = r.pending
        ? ' <span class="badge badge--muted" title="This player has not sent'
          + ' their chip count yet, so their points do not include that night.">'
          + 'not reported</span>'
        : '';
      return '<tr>' +
        '<td><span class="rank-number">' + escapeHtml(r.rank) + '</span>' + moveChip(r) + '</td>' +
        '<td><span class="player-cell"><span class="player-avatar">' + escapeHtml(initial) +
          '</span><span class="player-name">' + escapeHtml(r.pseudonym) + '</span>' + tag + '</span></td>' +
        '<td class="num">' + fmt(r.points) + deltaChip(r) + '</td>' +
        '<td class="trend">' + sparkFor(r) + '</td>' +
        '<td class="num">' + fmt(r.nights_played) + '</td>' +
      '</tr>';
    }).join('');

    var status = document.getElementById('leaderboard-status');
    if (status) {
      if (source === 'fallback') {
        status.textContent = I18N.t('board.saved', 'Shown from the last saved standings') +
          (updated ? ' (' + updated + ')' : '') +
          '. The live database is unreachable right now.';
      } else {
        // Says which round the arrows are about, because the same mark means
        // two different things either side of a settle and a reader cannot
        // tell from the arrow alone. Only added when there are arrows to
        // explain: a view without the movement columns says what it always did.
        var basis = '';
        if (rows.length && rows[0].points_delta !== undefined) {
          basis = ' ' + (rows[0].delta_live
            ? I18N.t('board.moveLive',
                'Movement and point changes are tonight so far, and reset when the next round opens.')
            : I18N.t('board.moveSettled',
                'Movement and point changes are from the last settled round.'));
        }
        status.textContent =
          I18N.t('board.live', 'Live standings, updated after each night is settled.') + basis;
      }
    }
    var placeholder = document.getElementById('leaderboard-placeholder');
    if (placeholder) { placeholder.style.display = 'none'; }

    lbRows = rows;
    var openBtn = document.getElementById('board-display-open');
    if (openBtn) { openBtn.hidden = false; }
    if (!boardEl().hidden) { layoutBoard(); }
  }

  /* ------------------------------------------------------------------
   * Display mode: the board on the screen in the room, at closing time.
   *
   * WHY IT PAGES RATHER THAN SCROLLS. The obvious build is a slow credits
   * roll, and it is the wrong one. At 20:20 every person in the room is
   * looking for exactly one name, their own. A list that is moving cannot be
   * pointed at, cannot be photographed, and if you glance away you wait for
   * the loop to come round again. A page that holds still for twelve seconds
   * can be read, argued with, and photographed by the six people who want it
   * for the group chat.
   *
   * WHY COLUMNS. Fifty names down one column is three screens of waiting. The
   * same fifty in four columns is one screen and no waiting, at type still
   * large enough to read from the back. So the layout takes the FEWEST
   * columns that fit everybody, which keeps a twelve-player night from being
   * spread thin across a wall, and only pages when even the widest layout
   * runs out of room.
   *
   * WHY IT REFRESHES. This screen is up precisely when the numbers are still
   * moving, so it re-reads every half minute. Somebody reporting from the
   * corridor sees themselves appear, which is the whole argument for putting
   * it on the wall in the first place.
   *
   * WHY THE NOT-REPORTED COUNT IS THE LOUDEST THING ON IT. At closing time
   * the board's most useful job is not flattering the winner, it is getting
   * the last eight people to send their stack before they walk to the tram.
   * The standings are what people want; the count is what the club needs.
   * ------------------------------------------------------------------ */
  var lbRows = [];
  var boardPage = 0;
  var boardPages = 1;
  var boardPageTimer = null;

  function boardEl() { return document.getElementById('board-takeover'); }

  function boardMeasure() {
    var vh = window.innerHeight;
    var vw = window.innerWidth;
    // Tied to viewport height so the same page fills a laptop and a projector.
    // The floor keeps a phone honest; the ceiling stops four rows filling a TV.
    var rowH = Math.max(32, Math.min(76, Math.round(vh * 0.052)));

    /* The space left for rows is MEASURED, not estimated. The header and
     * footer are sized in vmin and wrap differently at every aspect ratio, so
     * any fraction-of-the-viewport guess is wrong on some screen: too small
     * and a row is cut in half at the bottom, too large and a projector shows
     * fourteen names with a hand's width of empty felt under them. The grid
     * is flex:1 with align-content:start, so it already holds exactly the
     * space available whether or not anything is in it. Ask it. */
    var grid = document.getElementById('board-grid');
    var avail = (grid && grid.clientHeight) || Math.round(vh * 0.74);

    var rowsPerCol = Math.max(5, Math.floor(avail / rowH));
    var maxCols = vw >= 1800 ? 4 : vw >= 1200 ? 3 : vw >= 760 ? 2 : 1;

    /* The fewest columns that still turn the fewest pages.
     *
     * Not simply the most columns that fit. Eighty-five players on a 1080p
     * screen take two pages at four columns and two pages at three, and three
     * columns give every name half as much room again before it has to be cut
     * to "Den hvite q...". Widening a column is free when it costs no extra
     * page, and the name is the thing people are actually scanning for.
     *
     * A twelve-player night therefore lands on one wide column rather than
     * four thin ones with three names each, by the same rule. */
    var total = Math.max(1, lbRows.length);
    var best = Math.ceil(total / (rowsPerCol * maxCols));   // pages at the widest layout
    var cols = maxCols;
    for (var c = 1; c <= maxCols; c++) {
      if (Math.ceil(total / (rowsPerCol * c)) <= best) { cols = c; break; }
    }
    return { rowH: rowH, rowsPerCol: rowsPerCol, cols: cols };
  }

  function boardMoverHtml(r, kind) {
    var label = kind === 'win'
      ? I18N.t('board.biggestWin', 'Biggest win')
      : I18N.t('board.biggestLoss', 'Biggest loss');
    var d = Number(r.points_delta);
    return '<span class="board__mover">' +
      '<span class="board__mover-label">' + label + '</span>' +
      '<span class="board__mover-name">' + escapeHtml(r.pseudonym) + '</span>' +
      '<span class="delta delta--' + (d > 0 ? 'up' : 'down') + '">' +
        (d > 0 ? '+' : '') + fmt(d) +
      '</span>' +
    '</span>';
  }

  function boardRowHtml(r) {
    var top = Number(r.rank) <= 3 ? ' board-row--top' : '';
    var tag = r.pending
      ? ' <span class="board-row__pending">' +
        I18N.t('board.notReported', 'not reported') + '</span>'
      : '';
    return '<li class="board-row' + top + '">' +
      '<span class="board-row__rank">' + escapeHtml(r.rank) + '</span>' +
      '<span class="board-row__name">' +
        '<span class="board-row__who">' + escapeHtml(r.pseudonym) + '</span>' + tag +
      '</span>' +
      '<span class="board-row__points">' + fmt(r.points) + '</span>' +
      '<span class="board-row__spark">' + sparkFor(r) + '</span>' +
      '<span class="board-row__move">' + deltaChip(r) + moveChip(r) + '</span>' +
    '</li>';
  }

  function layoutBoard() {
    var el = boardEl();
    if (!el || el.hidden) { return; }
    var grid = document.getElementById('board-grid');
    var m = boardMeasure();
    var perPage = m.rowsPerCol * m.cols;
    boardPages = Math.max(1, Math.ceil(lbRows.length / perPage));
    if (boardPage >= boardPages) { boardPage = 0; }

    el.style.setProperty('--board-row-h', m.rowH + 'px');
    grid.style.gridTemplateColumns = 'repeat(' + m.cols + ', 1fr)';

    var start = boardPage * perPage;
    var slice = lbRows.slice(start, start + perPage);
    // Column-major: a ranked list has to read downwards, not across.
    var cols = [];
    for (var c = 0; c < m.cols; c++) {
      cols.push(slice.slice(c * m.rowsPerCol, (c + 1) * m.rowsPerCol));
    }
    grid.innerHTML = cols.map(function (col) {
      return '<ol class="board-col">' + col.map(boardRowHtml).join('') + '</ol>';
    }).join('');

    var pager = document.getElementById('board-pager');
    if (pager) {
      pager.textContent = boardPages > 1
        ? I18N.t('board.page', 'Page') + ' ' + (boardPage + 1) + ' / ' + boardPages
        : '';
    }

    var waiting = lbRows.filter(function (r) { return r.pending; }).length;
    var nudge = document.getElementById('board-waiting');
    if (nudge) {
      nudge.textContent = waiting
        ? waiting + ' ' + I18N.t('board.stillToReport', 'still to report')
        : I18N.t('board.allReported', 'Everybody has reported');
      nudge.className = 'board__waiting' + (waiting ? ' board__waiting--open' : '');
    }

    var sub = document.getElementById('board-sub');
    if (sub && lbRows.length && lbRows[0].points_delta !== undefined) {
      sub.textContent = lbRows[0].delta_live
        ? I18N.t('board.tonight', 'Tonight so far')
        : I18N.t('board.lastRound', 'Last settled round');
    }

    // In the header rather than the footer: it is the one thing on this screen
    // somebody reads out loud, and the footer already carries the count that
    // has to stay visible until the last person has reported.
    var moversEl = document.getElementById('board-movers');
    if (moversEl) {
      var mv = roundMovers(lbRows);
      moversEl.innerHTML = !mv ? '' :
        (mv.up ? boardMoverHtml(mv.up, 'win') : '') +
        (mv.down ? boardMoverHtml(mv.down, 'loss') : '');
    }

    // Only run a timer when there is a second page to turn to.
    if (boardPageTimer) { window.clearInterval(boardPageTimer); boardPageTimer = null; }
    if (boardPages > 1) {
      boardPageTimer = window.setInterval(function () {
        boardPage = (boardPage + 1) % boardPages;
        layoutBoard();
      }, 12000);
    }
  }

  function openBoard() {
    var el = boardEl();
    if (!el) { return; }
    boardPage = 0;
    // Plain .hidden, not SBP.show: leaderboard.html is one of the pages that
    // loads app.js WITHOUT js/sb.js, so there is no window.SBP here to borrow.
    el.hidden = false;
    document.body.classList.add('no-scroll');
    try {
      if (el.requestFullscreen) { el.requestFullscreen().catch(function () {}); }
    } catch (e) { /* the fixed overlay is already a takeover */ }
    layoutBoard();
    startLbPolling();   // faster cadence while it is on the wall
    refreshLeaderboard();
  }

  function closeBoard() {
    var el = boardEl();
    if (!el) { return; }
    el.hidden = true;
    document.body.classList.remove('no-scroll');
    if (boardPageTimer) { window.clearInterval(boardPageTimer); boardPageTimer = null; }
    startLbPolling();   // back to the quiet cadence
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(function () {});
      }
    } catch (e) { /* fine */ }
  }

  if (boardEl()) {
    var boardOpenBtn = document.getElementById('board-display-open');
    if (boardOpenBtn) { boardOpenBtn.addEventListener('click', openBoard); }
    var boardCloseBtn = document.getElementById('board-close');
    if (boardCloseBtn) { boardCloseBtn.addEventListener('click', closeBoard); }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !boardEl().hidden) { closeBoard(); }
      if (!boardEl().hidden && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        boardPage = (boardPage + (e.key === 'ArrowRight' ? 1 : boardPages - 1)) % boardPages;
        layoutBoard();
      }
    });
    var boardResize;
    window.addEventListener('resize', function () {
      window.clearTimeout(boardResize);
      boardResize = window.setTimeout(layoutBoard, 150);
    });
    // ?display goes straight to the wall, so an organiser can bookmark it on
    // the machine wired to the screen and not hunt for a button at 20:15.
    if (/(^|[?&])display(=|&|$)/.test(window.location.search)) {
      afterScripts(function () {
        if (lbRows.length) { openBoard(); }
        else { window.setTimeout(function () { if (lbRows.length) { openBoard(); } }, 1200); }
      });
    }
  }
})();
