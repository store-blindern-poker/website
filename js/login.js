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
 *   - Full name (membership records, organiser-only): collected on the
 *     Create account tab, or on the claim step when signup was skipped
 *     (Google). set_my_name() needs a member row, so the save runs AFTER
 *     claim_pseudonym() succeeds. The typed name is stashed in
 *     localStorage first (keyed to the auth user id) so an OAuth redirect,
 *     reload or failed RPC cannot lose it; a failed save never blocks the
 *     signup, it retries on later visits and shows a quiet note instead.
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

  /* ---------------- full name stash ----------------
   * The typed full name, waiting for set_my_name(). Keyed to the auth user
   * id so a shared browser can never attach one person's name to another's
   * account. Storage-defensive: private mode degrades to "ask again". */
  var NAME_KEY = 'sbp.pending_name.v1';

  function stashName(userId, name) {
    try {
      window.localStorage.setItem(NAME_KEY, JSON.stringify({
        user_id: userId, name: name, queued_at: new Date().toISOString()
      }));
    } catch (e) { /* private mode: the claim step will just ask */ }
  }

  function clearStash() {
    try { window.localStorage.removeItem(NAME_KEY); } catch (e) { /* ok */ }
  }

  /* The stash for THIS user, or null. A stash for a different user is
   * cleared on sight: stale data from a shared machine. */
  function readStash(userId) {
    var raw = null;
    try { raw = window.localStorage.getItem(NAME_KEY); } catch (e) { return null; }
    if (!raw) { return null; }
    var st = null;
    try { st = JSON.parse(raw); } catch (e) { clearStash(); return null; }
    if (!st || !st.name || st.user_id !== userId) { clearStash(); return null; }
    return st;
  }

  function saveNameNow(name) {
    return S.client().rpc('set_my_name', { p_real_name: name })
      .then(function (r) {
        if (r.error) { throw r.error; }
        return r.data;
      });
  }

  /* Try to send a stashed name. Resolves true when nothing is pending or
   * the save worked, false when a name is still stuck (quiet note time).
   * Never rejects: signing in matters more than this record. */
  function flushPendingName(userId) {
    var st = readStash(userId);
    if (!st) { return Promise.resolve(true); }
    return saveNameNow(st.name).then(function () {
      clearStash();
      return true;
    }).catch(function (err) {
      // A server-side "no" (e.g. name too long, which the maxlength should
      // prevent) will never succeed by retrying; drop it so the queue can
      // not wedge. Network-shaped errors keep the stash for next visit.
      if (S.isPermanentError(err)) { clearStash(); }
      return false;
    });
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

  /* ---------------- auth tabs ---------------- */
  var mode = 'signin'; // 'signin' | 'signup'
  var tabSignin = $('tab-signin');
  var tabSignup = $('tab-signup');
  var authSubmit = $('auth-submit');
  var authMsg = $('auth-msg');
  var passwordInput = $('auth-password');
  var fullnameInput = $('auth-fullname');

  function setMode(m) {
    mode = m;
    tabSignin.setAttribute('aria-selected', m === 'signin' ? 'true' : 'false');
    tabSignup.setAttribute('aria-selected', m === 'signup' ? 'true' : 'false');
    authSubmit.textContent = m === 'signin' ? 'Sign in' : 'Create account';
    passwordInput.setAttribute('autocomplete', m === 'signin' ? 'current-password' : 'new-password');
    S.show($('signup-help'), m === 'signup');
    S.show($('fullname-field'), m === 'signup');
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
    var fullName = '';
    if (mode === 'signup') {
      fullName = (fullnameInput ? fullnameInput.value : '').trim();
      if (!fullName) {
        msg(authMsg, 'Add your full name too: organisers keep it for membership records.', 'error');
        return;
      }
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
      // Stash the full name against the fresh account. set_my_name() can
      // only run once the member row exists, i.e. after the claim step;
      // the claim handler picks the stash up from here.
      if (mode === 'signup' && fullName) {
        return S.getSession().then(function (s) {
          if (s && s.user) { stashName(s.user.id, fullName); }
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
  var claimNameField = $('claim-fullname-field');
  var claimNameInput = $('claim-fullname');
  var currentUserId = null;    // set by route(); keys the name stash

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

    // The full name: from the visible field (signup was skipped, e.g.
    // Google), else from the stash the signup form left. Either way it is
    // stashed before the claim so nothing typed can be lost mid-flight.
    var fullName = null;
    if (claimNameField && !claimNameField.hidden) {
      fullName = (claimNameInput ? claimNameInput.value : '').trim();
      if (!fullName) {
        msg(claimMsg, 'Add your full name too: organisers keep it for membership records.', 'error');
        return;
      }
      if (currentUserId) { stashName(currentUserId, fullName); }
    } else {
      var st = readStash(currentUserId);
      if (st) { fullName = st.name; }
    }

    claimSubmit.disabled = true;
    msg(claimMsg, 'Claiming…', 'busy');
    S.client().rpc('claim_pseudonym', { p_pseudonym: pseudonym })
      .then(function (r) {
        if (r.error) { throw r.error; }
        // The member row exists now, so the name can finally be stored.
        // A failure here must never undo the signup: the stash stays for a
        // later retry (route() shows the quiet note) and we carry on.
        if (!fullName) { return; }
        return saveNameNow(fullName).then(function () {
          clearStash();
        }).catch(function () { /* stash kept; route() retries and notes it */ });
      })
      .then(function () {
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
        currentUserId = null;
        showState('auth');
        return;
      }
      currentUserId = (session.user && session.user.id) || null;
      return S.getMyMember().then(function (member) {
        if (!member || !member.pseudonym) {
          // Ask for the full name here only when signup did not already
          // collect it (Google sign-in, or a reload lost the stash).
          S.show(claimNameField, !readStash(currentUserId));
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
        // A name that could not be saved earlier: retry quietly, and only
        // mention it if it is still stuck.
        flushPendingName(currentUserId).then(function (ok) {
          S.show($('name-note'), !ok);
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
