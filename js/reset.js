/* Store Blindern Poker: reset.html behaviour.
 *
 * Two jobs on one page, told apart by the URL:
 *   1. No link in the URL: ask for an email and have Supabase send one.
 *   2. Arrived from that email: set a new password.
 *
 * Why one page rather than two: the address in the mail has to be a real
 * page, and sending people to /reset only to bounce them to /reset-confirm
 * is a redirect that in-app browsers routinely lose. Everything the link
 * needs is already here when it lands.
 *
 * THE ONE THING THAT WILL BREAK THIS is mail, not code. Supabase's built-in
 * sender allows a couple of messages an hour and is not meant for
 * production, so a busy Friday can use the allowance up before the person
 * who actually needs it asks. That refusal is caught by name below and
 * answered with the honest fallback, which is to find an organiser. Point
 * the project at a real SMTP sender and this stops happening.
 *
 * Supabase auth used: resetPasswordForEmail (send), updateUser (set).
 * No RPC, no table, no schema change: a password is not club data.
 */
(function () {
  'use strict';

  var S = window.SBP;
  if (!S) { return; }

  var $ = function (id) { return document.getElementById(id); };

  var states = ['state-config', 'state-loading', 'state-request',
                'state-sent', 'state-set', 'state-done', 'state-expired'];

  /* Takes the short name ('request'), not the id. The array holds full ids
   * because that is what S.show needs, and forgetting the prefix here hid
   * all seven at once: S.show no-ops rather than throwing, so the page came
   * up blank with an empty console and nothing to grep for. */
  function showState(name) {
    var target = 'state-' + name;
    states.forEach(function (id) { S.show($(id), id === target); });
  }

  function msg(el, text, kind) {
    if (!el) { return; }
    el.textContent = text;
    el.className = 'form-msg' + (kind ? ' form-msg--' + kind : '');
  }

  /* ------------------------------------------------------------------
   * Read the URL FIRST.
   *
   * Creating the Supabase client consumes the recovery fragment and wipes
   * it from the address bar, so anything not captured on this line is gone
   * by the time we would think to look. Everything below reads these two
   * snapshots, never window.location.
   * ------------------------------------------------------------------ */
  var hashParams = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
  var queryParams = new URLSearchParams(String(window.location.search || '').replace(/^\?/, ''));

  function param(name) {
    return hashParams.get(name) || queryParams.get(name);
  }

  var urlError = param('error') || param('error_code');
  var urlErrorText = param('error_description') || '';

  /* Both link shapes count. The implicit flow lands with type=recovery and
   * the tokens in the fragment; the PKCE flow lands with ?code= and nothing
   * else. An error lands with neither, so it is checked on its own. */
  var cameFromLink = !!(param('type') === 'recovery' || param('code') ||
                        param('access_token') || urlError);

  /* A token in the address bar survives a screenshot, and somebody WILL
   * screenshot this page to ask an organiser what to do with it. Cleared as
   * soon as the client has had its chance to read it. */
  function scrubUrl() {
    if (!window.history || !window.history.replaceState) { return; }
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch (e) { /* older browser: the fragment stays, nothing else breaks */ }
  }

  /* ---------------- webview escape card ---------------- */
  if (S.isInAppWebview()) {
    S.show($('webview-card'), true);
    var copyBtn = $('webview-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var url = window.location.origin + window.location.pathname;
        var done = function () { S.show($('webview-copied'), true); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(function () {
            window.prompt('Copy this link:', url); done();
          });
        } else {
          window.prompt('Copy this link:', url); done();
        }
      });
    }
  }

  /* ---------------- config gate ---------------- */
  if (!S.configured()) {
    showState('config');
    return;
  }

  var c = S.client();

  /* ------------------------------------------------------------------
   * Errors, in the club's words where we have better ones.
   * ------------------------------------------------------------------ */
  function sendError(err) {
    var text = String((err && err.message) || '');
    if (/rate limit|too many requests|over_email_send_rate/i.test(text) ||
        String((err && err.status) || '') === '429') {
      return 'The club\'s mail allowance is used up for the moment. Wait an ' +
        'hour and try again, or find an organiser at a night: we can set it ' +
        'for you in a few seconds.';
    }
    if (/invalid.*email|email.*invalid/i.test(text)) {
      return 'That does not look like an email address. Check it and try again.';
    }
    return S.friendlyError(err);
  }

  function setError(err) {
    var text = String((err && err.message) || '');
    if (/different from the old password|should be different/i.test(text)) {
      return 'That is the password you already had. Pick a different one.';
    }
    if (/at least|too short|minimum/i.test(text)) {
      return 'Use at least 8 characters.';
    }
    if (/expired|invalid|session/i.test(text)) {
      return 'This link has expired. Ask for a fresh one and it will work.';
    }
    return S.friendlyError(err);
  }

  function showExpired(why) {
    scrubUrl();
    var el = $('expired-why');
    if (el && why) {
      // The server writes these for the person reading them, so the sentence
      // passes through with a capital letter and the fix appended.
      var said = String(why).replace(/\+/g, ' ');
      said = said.charAt(0).toUpperCase() + said.slice(1);
      if (!/[.!?]$/.test(said)) { said += '.'; }
      el.textContent = said + ' Ask for a fresh link and it will work.';
    }
    showState('expired');
  }

  /* ------------------------------------------------------------------
   * Did we arrive from a link, and did it work?
   * ------------------------------------------------------------------ */
  function waitForRecovery() {
    var settled = false;

    function win() {
      if (settled) { return; }
      settled = true;
      scrubUrl();
      showState('set');
      try { $('set-password').focus(); } catch (e) { /* not focusable yet */ }
    }

    function lose() {
      if (settled) { return; }
      settled = true;
      showExpired('');
    }

    // PASSWORD_RECOVERY is the event this page exists for. SIGNED_IN counts
    // too: the PKCE exchange reports itself that way.
    try {
      c.auth.onAuthStateChange(function (event) {
        if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') { win(); }
      });
    } catch (e) { /* the poll below is the real guarantee */ }

    /* A hard stop that does NOT depend on getSession() ever answering.
     *
     * A mangled or already-used token leaves the client's own initialisation
     * promise pending, and everything below is chained off it, so the poll
     * simply never takes its second step. Measured: eleven seconds on the
     * skeleton with no error, no console line and no way out. That is the
     * same shape as an outbox that never finishes starting, and on this page
     * it is reachable by the ordinary act of opening a reset link twice. */
    window.setTimeout(lose, 9000);

    // The event can fire before that listener is attached, so the poll is
    // not a fallback, it is the primary check. Roughly eight seconds, which
    // is long enough for a cold phone on campus wifi and short enough that
    // nobody sits looking at a skeleton wondering.
    var tries = 0;
    (function poll() {
      if (settled) { return; }
      S.getSession().then(function (session) {
        if (settled) { return; }
        if (session) { win(); return; }
        tries += 1;
        if (tries > 20) { lose(); return; }
        window.setTimeout(poll, 400);
      }).catch(function () {
        if (settled) { return; }
        tries += 1;
        if (tries > 20) { lose(); return; }
        window.setTimeout(poll, 400);
      });
    })();
  }

  if (urlError) {
    showExpired(urlErrorText);
  } else if (cameFromLink) {
    showState('loading');
    waitForRecovery();
  } else {
    showState('request');
  }

  /* ------------------------------------------------------------------
   * 1. Ask for the link
   * ------------------------------------------------------------------ */
  $('request-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('request-email').value.trim();
    var box = $('request-msg');
    var btn = $('request-submit');

    if (!email) {
      msg(box, 'Type the email you signed up with.', 'error');
      $('request-email').focus();
      return;
    }

    btn.disabled = true;
    msg(box, 'Sending…', 'busy');

    // redirectTo must be on the allow list in the Supabase dashboard
    // (Authentication, URL Configuration) or the mail arrives pointing at
    // the site root and this page never sees the token.
    c.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    }).then(function (r) {
      if (r && r.error) { throw r.error; }
      // Deliberately the same answer whether or not that address has an
      // account. Supabase answers the same way for both, and a page that
      // said "no such member" would turn this form into a way of asking
      // whether somebody is in the club.
      $('sent-email').textContent = email;
      msg(box, '', '');
      showState('sent');
    }).catch(function (err) {
      msg(box, sendError(err), 'error');
    }).finally(function () {
      btn.disabled = false;
    });
  });

  /* ------------------------------------------------------------------
   * 2. Set the new password
   * ------------------------------------------------------------------ */
  $('set-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = $('set-password').value;
    var again = $('set-confirm').value;
    var box = $('set-msg');
    var btn = $('set-submit');

    if (pw.length < 8) {
      msg(box, 'Use at least 8 characters.', 'error');
      $('set-password').focus();
      return;
    }
    if (pw !== again) {
      msg(box, 'The two passwords do not match.', 'error');
      $('set-confirm').focus();
      return;
    }

    btn.disabled = true;
    msg(box, 'Saving…', 'busy');

    c.auth.updateUser({ password: pw }).then(function (r) {
      if (r && r.error) { throw r.error; }
      msg(box, '', '');
      // Cleared rather than left in the DOM: this page can be left open on a
      // shared phone at a table of thirty-eight people.
      $('set-password').value = '';
      $('set-confirm').value = '';
      showState('done');
    }).catch(function (err) {
      msg(box, setError(err), 'error');
    }).finally(function () {
      btn.disabled = false;
    });
  });

  /* ---------------- back to the start ---------------- */
  function backToRequest() {
    showState('request');
    msg($('request-msg'), '', '');
    try { $('request-email').focus(); } catch (e) { /* fine */ }
  }

  $('sent-again-btn').addEventListener('click', backToRequest);
  $('expired-again-btn').addEventListener('click', backToRequest);
})();
