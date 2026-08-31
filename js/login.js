/* Store Blindern Poker: login.html behaviour.
 *
 * States (exactly one visible at a time):
 *   state-config    config placeholders not patched → honest notice
 *   state-loading   session check in flight
 *   state-auth      signed out → sign in / create account tabs
 *   state-claim     signed in, no pseudonym → claim step
 *   state-name      pseudonym claimed, real name not recorded yet
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
 *     member is fully set up, which now means after the name step too.
 *   - The real name (membership records, organiser-only) is asked for on a
 *     step of ITS OWN, after the pseudonym is claimed, as two fields. It used
 *     to sit next to the pseudonym box at signup and somebody typed their
 *     pseudonym into it, which is a form problem, not a member problem.
 *     set_my_name() also needs a member row, so after the claim is the only
 *     place it can run anyway.
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
    name: $('state-name'),
    signedin: $('state-signedin')
  };

  function showState(name) {
    Object.keys(states).forEach(function (k) {
      S.show(states[k], k === name);
    });
  }

  var params = new URLSearchParams(window.location.search);
  var nextPage = params.get('next') ? S.safeNextPage(params.get('next')) : null;

  /* ---------------- "still owes us a name" marker ----------------
   * There is no member-readable way to ask "is my name already on file?".
   * The name lives in member_private, whose only SELECT policy is is_admin(),
   * and v_member_directory returns zero rows to anyone else. Adding an RPC
   * for it is out of scope, so the flow REMEMBERS instead: claiming a
   * pseudonym sets this marker, saving the name clears it. That keeps the
   * name step from becoming a dead end when somebody claims and then closes
   * the tab: the next visit puts them straight back on it.
   *
   * The marker holds auth user ids and nothing else, no name, no PII. Every
   * lookup is keyed to the signed-in id, so a shared browser can never send
   * one person to a step meant for another. Storage-defensive: with
   * localStorage blocked it degrades to this page load only, which still
   * covers the normal path of claiming and naming in one sitting.
   *
   * It holds a LIST, not one id. Two people signing up on one phone at a
   * night is normal here, and a single slot meant the second signup erased
   * the first: that member was never asked for a name again, on any device,
   * which is the exact hole this step exists to close. The list is capped, so
   * it cannot grow without bound; the oldest entry falls off first.
   *
   * Members who claimed BEFORE this step existed are not routed here (there
   * is nothing to read that would tell us). Organisers see them on
   * admin.html: their row shows the "check this name" flag. */
  var NAME_STEP_KEY = 'sbp.name_step.v1';
  var NAME_STEP_MAX = 8;
  var nameStepUsers = null;  // in-memory mirror, and the fallback with no storage

  /* Whose name step is being skipped for THIS page load, after a save that
   * would not go through. The marker itself is left alone, so the next visit
   * asks again; this only stops route() sending them straight back to a step
   * that just refused them. Keyed to the user id like everything else here,
   * so a second account signing in on the same page load is unaffected. */
  var nameStepDeferredUser = null;

  function readNameNeeded() {
    if (nameStepUsers) { return nameStepUsers; }
    var raw = null;
    try { raw = window.localStorage.getItem(NAME_STEP_KEY); } catch (e) { raw = null; }
    var list = [];
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        list = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        list = [raw];  // the first version of this key stored one bare user id
      }
    }
    nameStepUsers = list.filter(function (id) {
      return typeof id === 'string' && id;
    }).slice(-NAME_STEP_MAX);
    return nameStepUsers;
  }

  function writeNameNeeded(list) {
    nameStepUsers = list;
    try {
      if (list.length) {
        window.localStorage.setItem(NAME_STEP_KEY, JSON.stringify(list));
      } else {
        window.localStorage.removeItem(NAME_STEP_KEY);
      }
    } catch (e) { /* memory only */ }
  }

  function markNameNeeded(userId) {
    if (!userId) { return; }
    var list = readNameNeeded().filter(function (id) { return id !== userId; });
    list.push(userId);
    writeNameNeeded(list.slice(-NAME_STEP_MAX));
  }

  function clearNameNeeded(userId) {
    if (!userId) { return; }
    writeNameNeeded(readNameNeeded().filter(function (id) { return id !== userId; }));
  }

  function needsNameStep(userId) {
    if (!userId) { return false; }
    if (nameStepDeferredUser === userId) { return false; }
    return readNameNeeded().indexOf(userId) !== -1;
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
  var currentUserId = null;    // set by route(); keys the name-step marker

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
    claimSubmit.setAttribute('aria-busy', 'true');
    msg(claimMsg, 'Claiming…', 'busy');
    S.client().rpc('claim_pseudonym', { p_pseudonym: pseudonym })
      .then(function (r) {
        if (r.error) { throw r.error; }
        // The member row exists now, so set_my_name() finally has something
        // to write to. Straight on to the name step, ?next= included: a
        // member is not set up until the records have a real name.
        msg(claimMsg, 'Claimed ✓', 'ok');
        markNameNeeded(currentUserId);
        showNameStep(pseudonym);
      })
      .catch(function (err) {
        msg(claimMsg, S.friendlyError(err), 'error');
        claimSubmit.disabled = false;
        claimSubmit.removeAttribute('aria-busy');
      });
  });

  $('claim-signout').addEventListener('click', function () {
    S.signOut().then(function () { showState('auth'); });
  });

  /* ---------------- name step ----------------
   * Two fields, both required, on a screen where the pseudonym is already
   * settled and shown above them. set_my_name() checks the same thing again
   * server-side: P0041 for a blank field, P0040 for "that is your pseudonym".
   */
  var nameFirst = $('name-first');
  var nameLast = $('name-last');
  var nameMsg = $('name-msg');
  var nameSubmit = $('name-submit');

  function showNameStep(pseudonym) {
    $('name-pseudonym').textContent = pseudonym || '…';
    // Coming back from a claim leaves that button spinning; it is off screen
    // now, but a sign-out returns to it and it must work.
    claimSubmit.disabled = false;
    claimSubmit.removeAttribute('aria-busy');
    S.show($('name-later-wrap'), false);   // earned by a failed save, not given
    clearNameFlags();
    showState('name');
    // The claim screen was scrolled down when this replaced it. Put the page
    // back to the top: the heading and the "only organisers read it" line are
    // what stop somebody typing their pseudonym in again, so they have to be
    // on screen, not scrolled off above the fields.
    window.scrollTo(0, 0);
    // Focus the first box only where there is already a keyboard. On a phone
    // an autofocus opens the on-screen one over that same explanation.
    var finePointer = window.matchMedia &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (finePointer && nameFirst) { nameFirst.focus(); }
  }

  /* Which box is wrong. On a two-field form "that is your pseudonym" is only
   * half an answer, so mark the field it came from, using the same
   * normalisation the database used to decide. If neither half matches on its
   * own then the two together were the pseudonym, so both are wrong. */
  function clearNameFlags() {
    [nameFirst, nameLast].forEach(function (el) {
      if (!el) { return; }
      el.removeAttribute('aria-invalid');
      el.classList.remove('input--error');
    });
  }

  function flagField(el) {
    if (!el) { return; }
    el.setAttribute('aria-invalid', 'true');
    el.classList.add('input--error');
  }

  function flagPseudonymFields(first, last) {
    var key = S.normPseudonym($('name-pseudonym').textContent || '');
    if (!key) { return; }
    var bad = [];
    if (S.normPseudonym(first) === key) { bad.push(nameFirst); }
    if (S.normPseudonym(last) === key) { bad.push(nameLast); }
    if (!bad.length) { bad = [nameFirst, nameLast]; }
    bad.forEach(flagField);
    bad[0].focus();
  }

  // Typing in a flagged box clears its mark. The message stays until the
  // save is tried again, which is the thing that decides.
  [nameFirst, nameLast].forEach(function (el) {
    if (!el) { return; }
    el.addEventListener('input', function () {
      el.removeAttribute('aria-invalid');
      el.classList.remove('input--error');
    });
  });

  $('name-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var first = nameFirst.value.trim();
    var last = nameLast.value.trim();
    clearNameFlags();
    if (!first || !last) {
      msg(nameMsg, 'We need both a first and a last name.', 'error');
      var blank = first ? nameLast : nameFirst;
      flagField(blank);
      blank.focus();
      return;
    }

    nameSubmit.disabled = true;
    nameSubmit.setAttribute('aria-busy', 'true');
    msg(nameMsg, 'Saving…', 'busy');
    S.client().rpc('set_my_name', { p_first_name: first, p_last_name: last })
      .then(function (r) {
        if (r.error) { throw r.error; }
        clearNameNeeded(currentUserId);
        msg(nameMsg, 'Saved ✓', 'ok');
        if (nextPage) {
          window.location.replace(nextPage);
          return;
        }
        nameSubmit.disabled = false;
        nameSubmit.removeAttribute('aria-busy');
        return route();
      })
      .catch(function (err) {
        msg(nameMsg, S.friendlyError(err), 'error');
        if (err && err.code === 'P0040') { flagPseudonymFields(first, last); }
        nameSubmit.disabled = false;
        nameSubmit.removeAttribute('aria-busy');
        // A save that will not go through must not become a locked door.
        // Two real cases: no signal in the venue basement, and a member whose
        // actual name is what they made their pseudonym out of, which
        // set_my_name() reads as the mistake it exists to catch (P0040).
        // Either way they still have a night to check in to.
        S.show($('name-later-wrap'), true);
      });
  });

  $('name-later').addEventListener('click', function () {
    // The marker stays put: the next visit asks again, and until then the
    // row reads "no name yet" on admin.html, where an organiser can fix it.
    nameStepDeferredUser = currentUserId;
    msg(nameMsg, '', '');
    if (nextPage) {
      window.location.replace(nextPage);
      return;
    }
    route();
  });

  $('name-signout').addEventListener('click', function () {
    // The marker stays: it is keyed to the user id, so signing back in
    // returns to this step rather than quietly skipping it.
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
          showState('claim');
          loadUnclaimed(); // warm the list while they think
          return;
        }
        // Claimed a pseudonym but never finished the name step (closed the
        // tab, lost the connection, signed out and back in). Finish it now.
        if (needsNameStep(currentUserId)) {
          showNameStep(member.pseudonym);
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
