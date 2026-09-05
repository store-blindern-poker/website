/* Store Blindern Poker: unsubscribe.html behaviour.
 *
 * WHY THIS PAGE EXISTS AT ALL, and it is not decoration.
 *
 * Corporate mail scanners, spam filters and link preview bots fetch every URL
 * they find in an email, before any human has looked at it. A one-click
 * unsubscribe that acts on load would therefore unsubscribe people who never
 * clicked anything, and the ones it would hit first are members on a
 * university or employer mailbox, which is most of them. So the link in the
 * mail lands here, on a page that changes nothing, and one deliberate press
 * sends the POST. A scanner that fetches this address gets HTML and leaves
 * the member on the list.
 *
 * The endpoint (supabase/functions/unsubscribe) is the other half of that:
 * POST only, and a GET is answered with a sentence telling the reader to use
 * the button. It is public on purpose, verify_jwt is off. Somebody who wants
 * out of a mailing list must not have to remember a password for a poker
 * website first, and the member who most wants out is exactly the one who
 * never made one.
 *
 * The token is a bearer capability, random per member, never the member id.
 * It can unsubscribe that one person and do nothing else. The endpoint
 * answers {"ok":true} for a real token, an unknown one and a malformed one
 * alike, so it cannot be used to test whether a token belongs to anybody, and
 * there is consequently nothing in the reply worth reading beyond the status.
 *
 * No Supabase client here: js/sb.js and the vendored bundle are not loaded by
 * unsubscribe.html. One fetch to one public URL is the whole network surface.
 */
(function () {
  'use strict';

  var cfg = window.SBP_CONFIG || {};

  var $ = function (id) { return document.getElementById(id); };

  var STATES = ['state-loading', 'state-config', 'state-confirm',
                'state-done', 'state-badlink'];

  // Local, because window.SBP is not on this page. Same contract as
  // SBP.show: a missing element is a no-op rather than a throw.
  function show(el, on) {
    if (!el) { return; }
    el.hidden = !on;
  }

  /* Takes the short name ('confirm'), not the id. */
  function showState(name) {
    var target = 'state-' + name;
    for (var i = 0; i < STATES.length; i++) {
      show($(STATES[i]), STATES[i] === target);
    }
  }

  function msg(el, text, kind) {
    if (!el) { return; }
    el.textContent = text;
    el.className = 'form-msg' + (kind ? ' form-msg--' + kind : '');
  }

  /* The URL half of SBP.configured(). The anon key and the vendored bundle
   * are not part of the test because nothing here uses either: an
   * unauthenticated POST needs the project URL and nothing more. */
  function configured() {
    return !!(cfg.SUPABASE_URL && String(cfg.SUPABASE_URL).indexOf('__') !== 0);
  }

  /* The same shape test the edge function runs before it touches the
   * database. Kept in step with it deliberately: a value that would be
   * rejected there is one we can name honestly here instead of sending it,
   * getting {"ok":true} back and telling somebody they are unsubscribed when
   * nothing was found to unsubscribe. */
  var TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var params = new URLSearchParams(String(window.location.search || '').replace(/^\?/, ''));
  var token = String(params.get('t') || '').trim();

  if (!configured()) {
    showState('config');
    return;
  }
  if (!TOKEN_RE.test(token)) {
    showState('badlink');
    return;
  }

  showState('confirm');

  /* The token stays in the address bar on purpose. reset.html scrubs its
   * token because that one can change a password; this one can only take one
   * member off one mailing list, and scrubbing it would turn an ordinary
   * reload, or a back button, into the "this link is not complete" screen for
   * somebody who did nothing wrong. */
  var STOP_URL = String(cfg.SUPABASE_URL).replace(/\/+$/, '') +
    '/functions/v1/unsubscribe?t=' + encodeURIComponent(token);

  $('stop-btn').addEventListener('click', function () {
    var btn = $('stop-btn');
    var box = $('stop-msg');

    btn.disabled = true;
    msg(box, 'Sending...', 'busy');

    /* No headers, no body, and that is not laziness. The token rides in the
     * query string, which is the shape the endpoint reads first, so the
     * request stays a simple cross-origin POST with no preflight. The
     * function's CORS allows exactly one request header, content-type, so an
     * apikey or Authorization header would fail the preflight it triggered.
     * It needs neither: verify_jwt is off. */
    fetch(STOP_URL, { method: 'POST', mode: 'cors', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) { throw new Error('HTTP ' + r.status); }
        // Nothing to read out of the body: see the note at the top about the
        // endpoint answering the same way for every token.
        msg(box, '', '');
        showState('done');
      })
      .catch(function () {
        /* One sentence for every failure, because every failure here has the
         * same remedy. A dropped connection, a function that is down and a
         * database that refused the write are different faults and identical
         * advice, and the member cannot act on the difference. */
        msg(box, 'That did not go through. Check your connection and press ' +
          'again, or write to it@storeblindernpoker.org and an organiser ' +
          'will take you off the list by hand.', 'error');
        btn.disabled = false;
      });
  });
})();
