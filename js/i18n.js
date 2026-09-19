/* Language plumbing for the public pages.
 *
 * One function:
 *
 *   I18N.t('events.empty', 'Nothing on the calendar right now.')
 *
 * The English text lives at the call site, always, and is what you get on
 * an English page, on a page where this file failed to load, and on a
 * Norwegian page where nobody has written that string yet. The dictionary
 * below only ever adds Norwegian. It cannot take English away.
 *
 * That shape was chosen over the usual two-dictionary setup for one
 * reason: the English pages are the ones almost everybody lands on, and
 * they should not be able to break because of a typo in a translation
 * file. Here they cannot. t() on an English page returns its second
 * argument without looking at anything.
 *
 * Keys are short and semantic rather than the English sentence itself,
 * because four of these strings are paragraphs of HTML and a dictionary
 * keyed on a paragraph of HTML is a dictionary nobody will keep correct.
 *
 * Every consumer takes a local copy with a working fallback:
 *
 *   var I18N = window.SBP_I18N ||
 *     { lang: 'en', locale: 'en-GB', t: function (k, en) { return en; },
 *       months: function () { return null; },
 *       weekdays: function () { return null; } };
 *
 * so a page that fails to load this file is an English page, not a broken
 * one. Same rule as the rest of the site: the layer underneath has to be
 * complete on its own.
 *
 * SCOPE is the six public pages. The member flow (login, report, reset,
 * unsubscribe) and the organiser console are English only, deliberately:
 * they are noindex so there is no search argument for translating them,
 * and js/report.js alone carries more strings than all six public pages
 * together. If that changes, this file is where it changes.
 */
(function () {
  'use strict';

  var html = document.documentElement;
  var lang = String(html.getAttribute('lang') || 'en').slice(0, 2).toLowerCase();

  // nb, not no: Bokmål specifically, which is what the club writes and what
  // the founder's letter is in. nb-NO is the tag Intl wants.
  var LOCALES = { en: 'en-GB', nb: 'nb-NO' };

  /* Norwegian for the strings the public scripts write into the page.
   * Grouped by the file that uses them.
   *
   * House style is the site's: no em dashes, plain words, and the club is
   * always "Store Blindern Poker". Points are "poeng", chips "sjetonger",
   * a night is "en kveld", the buy-in is "innkjøpet".
   *
   * The links inside these strings are relative on purpose. A relative
   * href on /no/events.html resolves inside /no/, so the Norwegian pages
   * link to Norwegian pages without this file knowing anything about the
   * directory it is being read from.
   */
  var NB = {
    /* js/app.js, the events list */
    'events.venue.tbd': 'Rommet er ikke bekreftet ennå',
    'events.link.room': 'Finn rommet',
    'events.link.signup': 'Meld deg på',
    'events.badge.upcoming': 'Kommende',
    'events.badge.past': 'Spilt',

    /* "18:00 til 20:30". js/app.js glues this between two clock times. */
    'time.to': 'til',

    'events.empty.upcoming':
      'Ingenting på kalenderen akkurat nå. Nye kvelder blir annonsert her og på Discord.',

    'events.empty.past':
      'Ingen spilte kvelder er listet opp her ennå. ' +
      '<a class="link-gold" href="leaderboard.html">Ledertavlen</a> ' +
      'har stillingen for hver kveld som er gjort opp.',

    'events.error':
      'Fikk ikke lastet inn kalenderen. Prøv å laste siden på nytt, eller sjekk klubbens Discord.',

    'events.fallback.notice':
      '<strong>Dette er den sist lagrede kopien av kalenderen.</strong> ' +
      'Vi fikk ikke kontakt med den levende timeplanen, så et rom eller et ' +
      'tidspunkt kan ha endret seg siden den ble lagret. Klubbens ' +
      '<a class="link-gold" href="https://discord.gg/XjdnedqTC" target="_blank" rel="noopener">Discord</a> ' +
      'har det gjeldende svaret.',

    /* js/app.js, the leaderboard */
    'board.live': 'Levende stilling, oppdatert etter at hver kveld er gjort opp.',
    'board.saved': 'Vist fra den sist lagrede stillingen',
    'board.now': 'Skjer nå',

    /* The movement marks. "opp"/"ned" and "plasser" are read out by screen
     * readers and never seen, so they stay lower case: they are glued after
     * a number into "opp 3 plasser". */
    'board.up': 'opp',
    'board.down': 'ned',
    'board.places': 'plasser',
    'board.held': 'holdt plassen',
    'board.moveLive': 'Bevegelse og poengendring er så langt i kveld, og ' +
      'nullstilles når neste runde åpner.',
    'board.moveSettled': 'Bevegelse og poengendring er fra forrige ' +
      'oppgjorte runde.',

    /* Display mode, the big screen in the room */
    'board.notReported': 'ikke rapportert',
    'board.tonight': 'Så langt i kveld',
    'board.lastRound': 'Forrige oppgjorte runde',
    'board.stillToReport': 'har ikke rapportert ennå',
    'board.allReported': 'Alle har rapportert',
    'board.page': 'Side',

    /* js/rsvp.js, the answer block on each upcoming night.
     *
     * "kommer" carries the headcount line: "7 kommer", "7 av 24 kommer".
     * It is one word in both languages and it is glued after the number in
     * both, which is why splitting it this way is safe here and would not
     * be in a language that puts the verb somewhere else. */
    'rsvp.going': 'kommer',
    'rsvp.of': 'av',
    'rsvp.none': 'Ingen har svart ennå.',
    'rsvp.you': 'deg',
    'rsvp.signin': 'Logg inn for å svare',

    /* A path, not a sentence. login.html is at the site root, so a page in
     * /no/ climbs out to reach it, and ?next= names the Norwegian events
     * page so signing in comes back here. Both spellings are allowlisted in
     * safeNextPage. */
    'rsvp.login.href': '../login.html?next=no/events.html',

    'rsvp.claim': 'Velg et pseudonym for å svare',
    'rsvp.checking': 'Sjekker kontoen din.',
    'rsvp.hint.tap': 'Ett trykk. Du kan endre det senere.',
    'rsvp.hint.clear': 'Trykk på det samme svaret igjen for å fjerne det.',

    /* Split around the seat count: "Alle 24 plassene er tatt. ..." */
    'rsvp.full.a': 'Alle',
    'rsvp.full.b': 'plassene er tatt. Sjekk igjen i tilfelle noen melder seg av, eller spør en arrangør.',

    'rsvp.closed': 'Den kvelden er stengt for svar nå. Si fra til en arrangør i stedet.',
    'rsvp.notsaved': 'Ikke lagret:',
    'rsvp.err.account': 'Fikk ikke sjekket kontoen din. Last sida på nytt for å svare.',
    'rsvp.err.list': 'Fikk ikke lastet inn hvem som kommer. Ditt eget svar blir lagret uansett.',
    'rsvp.signin.note': 'Du logger inn først, om du ikke allerede er innlogget.',
    'rsvp.open': 'Rapporteringen står åpen til arrangørene gjør opp kvelden.',

    /* Glued in front of a date by osloDayPhrase. */
    'when.tomorrow': 'i morgen',
    'when.on': 'på'
  };

  window.SBP_I18N = {
    lang: lang,
    locale: LOCALES[lang] || LOCALES.en,

    t: function (key, en) {
      if (lang !== 'nb') { return en; }
      return Object.prototype.hasOwnProperty.call(NB, key) ? NB[key] : en;
    },

    /* Month and weekday names for the active locale, short or long.
     *
     * Built from Intl rather than from a second pair of hardcoded arrays,
     * because the only thing worse than one list of month names is two.
     * Returns null if the locale database will not answer, and every caller
     * keeps its English array for exactly that case: this feeds a date badge
     * on a poker calendar, and a missing locale should cost us Norwegian
     * month names, not the calendar.
     */
    months: function (long) { return buildNames(long ? 'long' : 'short', 'month'); },
    weekdays: function (long) { return buildNames(long ? 'long' : 'short', 'weekday'); }
  };

  function buildNames(width, kind) {
    var out = [];
    var i;
    try {
      var opts = {};
      opts[kind] = width;
      var fmt = new Intl.DateTimeFormat(window.SBP_I18N.locale, opts);
      if (kind === 'month') {
        // The 15th, so no timezone shift can walk a date into a
        // neighbouring month.
        for (i = 0; i < 12; i++) { out.push(cap(fmt.format(new Date(2021, i, 15)))); }
      } else {
        // 2021-08-01 was a Sunday, which is index 0 in Date#getDay.
        for (i = 0; i < 7; i++) { out.push(cap(fmt.format(new Date(2021, 7, 1 + i)))); }
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  // Norwegian writes months and weekdays lowercase. Every caller of these
  // two is a date badge or a heading, where capitalised is what the design
  // wants, so they are capitalised here rather than at four call sites.
  // formatDateLong does NOT use them: it asks Intl for a whole date string
  // and gets Norwegian's lowercase and its point after the day number right.
  function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
}());
