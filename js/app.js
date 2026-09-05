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
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // The club's standing hours, for a night the database knows about and the
  // file does not. See nightToEvent: nights has no time column.
  var HOUSE_START = '18:00';
  var HOUSE_END = '20:30';

  // How long the live read gets before the saved copy takes over. See
  // withTimeout for why a hang needs its own answer.
  var DB_TIMEOUT_MS = 2500;

  var TBD_TEXT = 'Venue still to be confirmed';

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
    return fetch('data/events.json', { cache: 'no-cache' })
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

  var WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'];

  function formatDateLong(ev) {
    var d = eventDate(ev);
    return WEEKDAYS_LONG[d.getDay()] + ' ' + d.getDate() + ' ' +
           MONTHS_LONG[d.getMonth()] + ' ' + d.getFullYear();
  }

  // "18:00 to 20:30" when an event declares an end, otherwise just the start.
  function timeRange(ev) {
    if (!ev.time) { return ''; }
    return ev.endTime ? ev.time + ' to ' + ev.endTime : ev.time;
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
          if (label) { label.textContent = 'Happening now'; }
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
      ? '<span class="badge badge--muted event-card__badge">Past</span>'
      : '<span class="badge badge--gold event-card__badge">Upcoming</span>';
    var venue = venueOf(ev);
    var href = venue ? mapHref(ev.locationUrl) : '';
    var links = '';
    if (href) {
      links += '<a class="event-link" href="' + escapeHtml(href) +
        '" target="_blank" rel="noopener">Find the room &#8599;</a>';
    }
    if (ev.registrationUrl) {
      links += '<a class="event-link" href="' + escapeHtml(ev.registrationUrl) +
        '" target="_blank" rel="noopener">Sign up &#8599;</a>';
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
    eventsStatus.innerHTML = '<div><strong>This is the last saved copy of the calendar.</strong> ' +
      'We could not reach the live schedule, so a room or a time may have ' +
      'changed since it was saved. The club ' +
      '<a class="link-gold" href="https://discord.gg/XjdnedqTC" target="_blank" rel="noopener">Discord</a> ' +
      'has the current answer.</div>';
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
          '<p class="empty-state__text">Nothing on the calendar right now. New nights are announced here and on Discord.</p></div>';
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
          '<p class="empty-state__text">No played nights are listed here yet. ' +
          'The <a class="link-gold" href="leaderboard.html">leaderboard</a> ' +
          'has the standings for every night that has been settled.</p></div>';
    }
  }

  function initEventsPage() {
    loadEvents().then(renderEvents).catch(function (err) {
      console.warn('Events unavailable:', err);
      var msg = '<div class="empty-state"><p class="empty-state__text">' +
        'Could not load the events list. Please refresh, or check the club Discord.</p></div>';
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
          if (!rows.length) { return; }
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

  function fetchLiveLeaderboard() {
    var client = anonClient();
    if (!client) {
      return Promise.reject(new Error('Supabase not configured'));
    }
    try {
      return client
        .from('v_leaderboard')
        .select('rank,pseudonym,points,nights_played,pending,provisional')
        .order('rank', { ascending: true })
        .then(function (res) {
          if (res.error) { throw res.error; }
          return res.data || [];
        });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function fetchFallbackLeaderboard() {
    fetch('data/leaderboard-fallback.json', { cache: 'no-cache' })
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

  function renderLeaderboard(rows, source, updated) {
    var fmt = function (n) {
      try { return Number(n).toLocaleString('en-GB'); } catch (e) { return String(n); }
    };

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
        '<td><span class="rank-number">' + escapeHtml(r.rank) + '</span></td>' +
        '<td><span class="player-cell"><span class="player-avatar">' + escapeHtml(initial) +
          '</span><span class="player-name">' + escapeHtml(r.pseudonym) + '</span>' + tag + '</span></td>' +
        '<td class="num">' + fmt(r.points) + '</td>' +
        '<td class="num">' + fmt(r.nights_played) + '</td>' +
      '</tr>';
    }).join('');

    var status = document.getElementById('leaderboard-status');
    if (status) {
      if (source === 'fallback') {
        status.textContent = 'Shown from the last saved standings' +
          (updated ? ' (' + updated + ')' : '') +
          '. The live database is unreachable right now.';
      } else {
        status.textContent = 'Live standings, updated after each night is settled.';
      }
    }
    var placeholder = document.getElementById('leaderboard-placeholder');
    if (placeholder) { placeholder.style.display = 'none'; }
  }
})();
