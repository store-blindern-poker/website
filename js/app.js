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
   * ------------------------------------------------------------------ */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

  function fetchEvents() {
    return fetch('data/events.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) { throw new Error('events.json: HTTP ' + r.status); }
        return r.json();
      });
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
   * ------------------------------------------------------------------ */
  var countdownSection = document.getElementById('countdown-section');
  if (countdownSection) {
    fetchEvents().then(function (events) {
      var upcoming = events.filter(isUpcoming).sort(function (a, b) {
        return eventDate(a) - eventDate(b);
      });
      if (!upcoming.length) { return; } // section stays hidden
      var ev = upcoming[0];

      document.getElementById('countdown-name').textContent = ev.title;
      document.getElementById('countdown-date').textContent =
        formatDateLong(ev) + ', ' + timeRange(ev) +
        (ev.timeNote ? ' (' + ev.timeNote + ')' : '');
      document.getElementById('countdown-location').textContent = ev.location || '';
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
      // No events file, no countdown, the page is complete without it.
      console.warn('Countdown unavailable:', err);
    });
  }

  /* ------------------------------------------------------------------
   * Events page rendering (events.html)
   * ------------------------------------------------------------------ */
  var upcomingList = document.getElementById('events-upcoming');
  var pastList = document.getElementById('events-past');

  function renderEventCard(ev, past) {
    var d = eventDate(ev);
    var badge = past
      ? '<span class="badge badge--muted event-card__badge">Past</span>'
      : '<span class="badge badge--gold event-card__badge">Upcoming</span>';
    var links = '';
    if (ev.locationUrl) {
      links += '<a class="event-link" href="' + escapeHtml(ev.locationUrl) +
        '" target="_blank" rel="noopener">Find the room &#8599;</a>';
    }
    if (ev.registrationUrl) {
      links += '<a class="event-link" href="' + escapeHtml(ev.registrationUrl) +
        '" target="_blank" rel="noopener">Sign up &#8599;</a>';
    }
    var timeStr = escapeHtml(timeRange(ev)) +
      (ev.timeNote ? ' <span class="badge badge--muted">' + escapeHtml(ev.timeNote) + '</span>' : '');
    return (
      '<article class="event-card">' +
        '<div class="event-card__date">' +
          '<div class="event-card__day">' + d.getDate() + '</div>' +
          '<div class="event-card__month">' + MONTHS[d.getMonth()] + '</div>' +
          '<div class="event-card__weekday">' + WEEKDAYS[d.getDay()] + '</div>' +
        '</div>' +
        '<div class="event-card__info">' +
          '<h3 class="event-card__title">' + escapeHtml(ev.title) + '</h3>' +
          '<div class="event-card__meta">' +
            '<span>' + timeStr + '</span>' +
            '<span>' + escapeHtml(ev.location || '') + '</span>' +
          '</div>' +
          (ev.description ? '<p class="event-card__desc">' + escapeHtml(ev.description) + '</p>' : '') +
          (links ? '<div class="event-card__links">' + links + '</div>' : '') +
        '</div>' +
        badge +
      '</article>'
    );
  }

  if (upcomingList || pastList) {
    fetchEvents().then(function (events) {
      var upcoming = events.filter(isUpcoming).sort(function (a, b) {
        return eventDate(a) - eventDate(b);
      });
      var past = events.filter(function (ev) { return !isUpcoming(ev); })
        .sort(function (a, b) { return eventDate(b) - eventDate(a); });

      if (upcomingList) {
        upcomingList.innerHTML = upcoming.length
          ? upcoming.map(function (ev) { return renderEventCard(ev, false); }).join('')
          : '<div class="empty-state"><div class="empty-state__icon">&#9824;</div>' +
            '<p class="empty-state__text">Nothing on the calendar right now. New nights are announced here and on Discord.</p></div>';
      }
      if (pastList) {
        pastList.innerHTML = past.length
          ? past.map(function (ev) { return renderEventCard(ev, true); }).join('')
          : '<div class="empty-state">' +
            '<p class="empty-state__text">The Fall 2026 season has not started yet. Played nights will appear here.</p></div>';
      }
    }).catch(function (err) {
      console.warn('Events unavailable:', err);
      var msg = '<div class="empty-state"><p class="empty-state__text">' +
        'Could not load the events list. Please refresh, or check the club Discord.</p></div>';
      if (upcomingList) { upcomingList.innerHTML = msg; }
      if (pastList) { pastList.innerHTML = ''; }
    });
  }

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

  function fetchLiveLeaderboard() {
    var cfg = window.SBP_CONFIG || {};
    var configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
      String(cfg.SUPABASE_URL).indexOf('__') !== 0 &&
      String(cfg.SUPABASE_ANON_KEY).indexOf('__') !== 0 &&
      window.supabase && window.supabase.createClient;
    if (!configured) {
      return Promise.reject(new Error('Supabase not configured'));
    }
    try {
      var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      return client
        .from('v_leaderboard')
        .select('rank,pseudonym,points,nights_played')
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
        return '<div class="podium__place podium__place--' + (i + 1) + '">' +
          '<div class="podium__medal">' + medals[i] + '</div>' +
          '<div class="podium__name">' + escapeHtml(r.pseudonym) + '</div>' +
          '<div class="podium__points">' + fmt(r.points) + ' pts</div>' +
        '</div>';
      }).join('');
      podium.style.display = '';
    }

    leaderboardBody.innerHTML = rows.map(function (r) {
      var initial = (r.pseudonym || '?').trim().charAt(0).toUpperCase();
      return '<tr>' +
        '<td><span class="rank-number">' + escapeHtml(r.rank) + '</span></td>' +
        '<td><span class="player-cell"><span class="player-avatar">' + escapeHtml(initial) +
          '</span><span class="player-name">' + escapeHtml(r.pseudonym) + '</span></span></td>' +
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
