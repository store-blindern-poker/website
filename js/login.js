/* Store Blindern Poker: login.html behaviour.
 *
 * States (exactly one visible at a time):
 *   state-config    config placeholders not patched → honest notice
 *   state-loading   session check in flight
 *   state-auth      signed out → sign in / create account tabs
 *   state-claim     signed in, no pseudonym → claim step
 *   state-signedin  signed in with pseudonym → links onwards
 *
 * Flow notes:
 *   - Email confirmation is OFF in Supabase, so signUp() returns a live
 *     session immediately. No email is ever sent at signup.
 *   - The claim step calls the claim_pseudonym() RPC. Live availability:
 *     v_unclaimed_pseudonyms lists legacy pseudonyms nobody has claimed,
 *     matching one of those reconnects a returning player. A brand-new
 *     pseudonym can only be fully checked server-side; the RPC's unique
 *     violation comes back as a clear "already taken".
 *   - ?next=<page> (whitelisted) forwards to report.html etc. after the
 *     member is fully set up.
 */
(function () {
  'use strict';

  var S = window.SBP;
  if (!S) { return; }

  var $ = function (id) { return document.getElementById(id); };

  var states = {
    config: $('state-config'),
    loading: $('state-loading'),
    auth: $('state-auth'),
    claim: $('state-claim'),
    signedin: $('state-signedin')
  };

  function showState(name) {
    Object.keys(states).forEach(function (k) {
      S.show(states[k], k === name);
    });
  }

  var params = new URLSearchParams(window.location.search);
  var nextPage = params.get('next') ? S.safeNextPage(params.get('next')) : null;

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

  /* ---------------- auth tabs ---------------- */
  var mode = 'signin'; // 'signin' | 'signup'
  var tabSignin = $('tab-signin');
  var tabSignup = $('tab-signup');
  var authSubmit = $('auth-submit');
  var authMsg = $('auth-msg');
  var passwordInput = $('auth-password');

  function setMode(m) {
    mode = m;
    tabSignin.setAttribute('aria-selected', m === 'signin' ? 'true' : 'false');
    tabSignup.setAttribute('aria-selected', m === 'signup' ? 'true' : 'false');
    authSubmit.textContent = m === 'signin' ? 'Sign in' : 'Create account';
    passwordInput.setAttribute('autocomplete', m === 'signin' ? 'current-password' : 'new-password');
    S.show($('signup-help'), m === 'signup');
    msg(authMsg, '', '');
  }

  tabSignin.addEventListener('click', function () { setMode('signin'); });
  tabSignup.addEventListener('click', function () { setMode('signup'); });

  function msg(el, text, kind) {
    if (!el) { return; }
    el.textContent = text;
    el.className = 'form-msg' + (kind ? ' form-msg--' + kind : '');
  }

  $('auth-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('auth-email').value.trim();
    var password = passwordInput.value;
    if (!email || !password) {
      msg(authMsg, 'Enter both email and password.', 'error');
      return;
    }
    authSubmit.disabled = true;
    msg(authMsg, mode === 'signin' ? 'Signing in…' : 'Creating your account…', 'busy');

    var c = S.client();
    var call = mode === 'signin'
      ? c.auth.signInWithPassword({ email: email, password: password })
      : c.auth.signUp({ email: email, password: password });

    call.then(function (r) {
      if (r.error) { throw r.error; }
      // With confirm-email OFF both calls return a session. If a signup
      // somehow returns no session (config drift), fall through to a
      // sign-in attempt message rather than a dead end.
      if (!r.data || !r.data.session) {
        return c.auth.signInWithPassword({ email: email, password: password })
          .then(function (r2) {
            if (r2.error) { throw r2.error; }
          });
      }
    }).then(function () {
      msg(authMsg, '', '');
      return route();
    }).catch(function (err) {
      msg(authMsg, S.friendlyError(err), 'error');
    }).finally(function () {
      authSubmit.disabled = false;
    });
  });

  /* ---------------- Google (flag-gated) ---------------- */
  if (S.config.GOOGLE_ENABLED) {
    S.show($('google-block'), true);
    $('google-btn').addEventListener('click', function () {
      var redirect = window.location.origin + window.location.pathname +
        (nextPage ? '?next=' + encodeURIComponent(nextPage) : '');
      S.client().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: redirect }
      }).then(function (r) {
        if (r.error) { msg(authMsg, S.friendlyError(r.error), 'error'); }
      });
    });
  }

  /* ---------------- claim step ---------------- */
  var unclaimed = null;        // [{pseudonym, key}], lazily loaded
  var claimInput = $('claim-input');
  var claimAvail = $('claim-avail');
  var claimMsg = $('claim-msg');
  var claimSubmit = $('claim-submit');

  function loadUnclaimed() {
    if (unclaimed) { return Promise.resolve(unclaimed); }
    return S.client().from('v_unclaimed_pseudonyms').select('pseudonym')
      .then(function (r) {
        if (r.error) { throw r.error; }
        unclaimed = (r.data || []).map(function (row) {
          return { pseudonym: row.pseudonym, key: S.normPseudonym(row.pseudonym) };
        });
        return unclaimed;
      })
      .catch(function () {
        unclaimed = []; // availability degrades gracefully; the RPC still decides
        return unclaimed;
      });
  }

  function updateAvailability() {
    var raw = claimInput.value;
    var key = S.normPseudonym(raw);
    var wrap = $('claim-suggestions-wrap');
    var box = $('claim-suggestions');

    if (raw.trim().length < 2) {
      claimAvail.textContent = '';
      claimAvail.className = 'avail';
      S.show(wrap, false);
      return;
    }

    loadUnclaimed().then(function (list) {
      // Ignore a stale response if the input changed meanwhile.
      if (S.normPseudonym(claimInput.value) !== key) { return; }

      var exact = list.some(function (u) { return u.key === key; });
      if (exact) {
        claimAvail.textContent = 'Unclaimed pseudonym from a past season. Claiming it reconnects you to that seat.';
        claimAvail.className = 'avail avail--legacy';
      } else if (list.length) {
        claimAvail.textContent = 'Looks new. Final check happens when you claim: if someone holds it, you’ll be told straight away.';
        claimAvail.className = 'avail avail--neutral';
      } else {
        claimAvail.textContent = 'Availability is checked when you claim.';
        claimAvail.className = 'avail avail--neutral';
      }

      var matches = list.filter(function (u) {
        return u.key.indexOf(key) !== -1 && u.key !== key;
      }).slice(0, 8);
      if (matches.length) {
        box.innerHTML = matches.map(function (u) {
          return '<button type="button" class="chip-suggestion">' +
            S.escapeHtml(u.pseudonym) + '</button>';
        }).join('');
        S.show(wrap, true);
      } else {
        S.show(wrap, false);
      }
    });
  }

  claimInput.addEventListener('input', updateAvailability);

  $('claim-suggestions').addEventListener('click', function (e) {
    var btn = e.target.closest('.chip-suggestion');
    if (!btn) { return; }
    claimInput.value = btn.textContent;
    updateAvailability();
    claimInput.focus();
  });

  $('claim-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var pseudonym = claimInput.value.trim();
    if (pseudonym.length < 2 || pseudonym.length > 32) {
      msg(claimMsg, 'A pseudonym is 2 to 32 characters.', 'error');
      return;
    }
    claimSubmit.disabled = true;
    msg(claimMsg, 'Claiming…', 'busy');
    S.client().rpc('claim_pseudonym', { p_pseudonym: pseudonym })
      .then(function (r) {
        if (r.error) { throw r.error; }
        msg(claimMsg, 'Claimed ✓', 'ok');
        if (nextPage) {
          window.location.replace(nextPage);
        } else {
          route();
        }
      })
      .catch(function (err) {
        msg(claimMsg, S.friendlyError(err), 'error');
        claimSubmit.disabled = false;
      });
  });

  $('claim-signout').addEventListener('click', function () {
    S.signOut().then(function () { showState('auth'); });
  });

  /* ---------------- signed-in card ---------------- */
  $('signedin-signout').addEventListener('click', function () {
    S.signOut().then(function () { showState('auth'); });
  });

  /* ---------------- routing ---------------- */
  function route() {
    return S.getSession().then(function (session) {
      if (!session) {
        showState('auth');
        return;
      }
      return S.getMyMember().then(function (member) {
        if (!member || !member.pseudonym) {
          showState('claim');
          loadUnclaimed(); // warm the list while they think
          return;
        }
        if (nextPage) {
          window.location.replace(nextPage);
          return;
        }
        $('signedin-name').textContent = member.pseudonym;
        showState('signedin');
        S.isAdmin().then(function (admin) {
          S.show($('signedin-admin'), admin);
        });
      }).catch(function () {
        // Could not read the member row (offline?). The claim screen would
        // mislead; show the signed-in card with the report link, which
        // handles its own states.
        $('signedin-name').textContent = 'member';
        showState('signedin');
      });
    });
  }

  route();
})();
