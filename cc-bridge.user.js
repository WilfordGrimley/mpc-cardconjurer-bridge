// ==UserScript==
// @name         MPC Autofill → Card Conjurer Bridge
// @namespace    https://github.com/WilfordGrimley/mpc-cardconjurer-bridge
// @version      0.19.0
// @description  Adds a "+ conjure" button to MPC Autofill card grids that opens your own Card Conjurer instance in an in-page editor modal (like the card selector), auto-fills Card Conjurer's own card-import feature and a 1/8" bleed margin, and exports the finished card to a configured local folder (Chromium) or your browser's downloads (Firefox fallback).
// @author       wilfordgrimley
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_getResourceURL
// @grant        unsafeWindow
// @resource     ultramixModel https://raw.githubusercontent.com/WilfordGrimley/mpc-cardconjurer-bridge/3846cf7c803d320144ebf948f36f459e924beda8/models/4x-UltraMix_Balanced.onnx
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

// The @resource above is Kim2091's Ultramix (Balanced) upscaler, converted
// to ONNX from https://huggingface.co/Kim2091/UltraSharp (Interpolations/
// 4x-UltraMix_Balanced.pth) — CC-BY-NC-SA-4.0, non-commercial. It's the
// bundled default for the Enlarger upscale pass (see getUpscaleModelUrl/
// isBundledUltramixEnabled below); this project's own code stays MIT, but
// this one bundled asset carries Kim2091's license terms. See
// THIRD_PARTY_NOTICES.md.

// NOTE on @match: this is intentionally broad. Tampermonkey/Violentmonkey only
// ever run a script on origins covered by @match, so the "enable this site"
// menu command below (which is the actual, user-controlled activation
// mechanism) would be a no-op on any origin not already matched. Real safety
// comes from the activation gate a few lines down: on any origin that isn't a
// default or user-enabled MPC Autofill instance, this script does nothing at
// all beyond registering its two menu commands.

(function () {
  'use strict';

  // Firefox's userscript sandbox (Xray wrappers) hides variables/functions a
  // page's own script defines from a plain `window` reference inside a
  // userscript — Chrome is more permissive, which is why this only shows up
  // on Firefox. `card`, `importChanged`, `cardCanvas`, and
  // `loadMarginVersion` below are all Card Conjurer's own globals (defined
  // by creator-23.js/groupMargin.js), not this script's — unsafeWindow is
  // required to actually see them. Native browser APIs (showDirectoryPicker,
  // indexedDB) aren't affected by this and are read via plain `window`.
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const DEFAULT_CC_ORIGIN = 'http://localhost:4242';
  // Shared default so Drive export works out of the box for installers who
  // don't want to set up their own Google Cloud OAuth client — but it's a
  // shared quota/billing pool and a single point of failure across every
  // installer using it (see getDriveClientId/isUsingDefaultDriveClientId
  // below for the encouragement path away from it). Empty string disables
  // the default entirely (falls back to requiring the user's own Client
  // ID, same as before this existed) — intentionally left blank here until
  // the repo owner supplies a real one.
  const DEFAULT_DRIVE_CLIENT_ID = '794263898427-md1q1cc8qo15kq2fejr3fooi3tvqipau.apps.googleusercontent.com';
  const DEFAULT_ENABLED_ORIGINS = [
    'https://mpcfill.com',
    'https://mpcfill.com',
    'http://localhost',
    'https://localhost',
    'http://127.0.0.1',
    'https://127.0.0.1',
  ];
  const CARD_ROOT_SELECTOR = '[data-card-name], .mpccard';
  const BUTTON_CLASS = 'cc-bridge-btn';
  const BUTTON_ANCHOR_CLASS = 'cc-bridge-btn-anchor';
  // Set alongside BUTTON_ANCHOR_CLASS specifically for the
  // nested-inside-another-button case (see createConjureTrigger) — that's
  // the site's printing-tag candidates today, whose own hover-zoom
  // (the hover-zoom wrapper) is a deliberate exception to how every other card
  // on the site behaves (border/label static, only the art scales) —
  // the button should scale along with it there instead of staying put.
  const BUTTON_ANCHOR_ZOOM_CLASS = 'cc-bridge-btn-anchor-zoom';
  // Wraps the trigger in the zoom case (see createConjureTrigger) — sized
  // to exactly match the art image's own box, as a *sibling* of it (never
  // the img itself, which can't have children, and never anchorEl, which
  // already contains the img and has its own separate scale rule — see
  // the comment in createConjureTrigger for why that'd double-scale it).
  // Scaling this congruent, independent wrapper in lockstep with the art
  // makes the trigger track the art's actual moving corner, not just grow
  // in place near it.
  const BUTTON_TETHER_CLASS = 'cc-bridge-btn-tether';
  const INJECTED_MARKER_ATTR = 'data-cc-bridge-injected';
  const RETRY_INTERVAL_MS = 250;
  const MAX_RETRIES = 20; // 250ms * 20 = 5s
  // Used by the CC-receiver's local-export code, which lives (along with
  // everything else receiver-only) after an early `return` for the
  // non-receiver path — declared up here, at true top-of-scope, so they're
  // never in a temporal dead zone in either execution path. (Two other
  // `const`/`let`s hit exactly this bug during testing before being moved
  // here — see the comment by `currentCardData` below.)
  const EXPORT_DB_NAME = 'cc-bridge-fs';
  const EXPORT_DB_STORE = 'handles';
  const EXPORT_DB_KEY = 'exportDir';
  const HAS_FS_ACCESS = typeof window.showDirectoryPicker === 'function';
  // Bleed-margin border-extension name lookup — same TDZ reasoning as above.
  const BORDER_EXTENSION_NAME_BY_COLOR = {
    white: 'White Border Extension',
    silver: 'Silver Border Extension',
    gold: 'Gold Border Extension',
    borderless: 'Borderless Extension',
  };

  // ---- config helpers -------------------------------------------------

  function getCCOrigin() {
    return GM_getValue('ccOrigin', DEFAULT_CC_ORIGIN);
  }

  function setCCOrigin(origin) {
    GM_setValue('ccOrigin', origin);
  }

  // Google Drive export is opt-in. The OAuth connect + upload runs on the
  // sender/mpchost page (mpcfill.com etc.), not inside the Card
  // Conjurer iframe — see the "Google Drive export" section far below for
  // why. That means the Client ID's "Authorized JavaScript origins" needs
  // the *host site's* origin (e.g. https://mpcfill.com), not the CC
  // origin.
  //
  // A custom Client ID (set via the menu command below) always wins over
  // DEFAULT_DRIVE_CLIENT_ID — the shared default exists so this works with
  // zero setup, not to discourage anyone from running their own.
  function getDriveClientId() {
    return GM_getValue('driveClientId', '') || DEFAULT_DRIVE_CLIENT_ID;
  }

  function setDriveClientId(clientId) {
    GM_setValue('driveClientId', clientId);
  }

  function isUsingDefaultDriveClientId() {
    return !GM_getValue('driveClientId', '') && !!DEFAULT_DRIVE_CLIENT_ID;
  }

  // Optional: a URL to the user's own ONNX super-resolution model weights,
  // passed through to the Enlarger tool at handoff time so it can run real
  // neural upscaling instead of its built-in classical (Lanczos) resampling
  // fallback. Overrides the bundled Ultramix model entirely when set. Empty
  // means fall through to the bundled default (see resolveUpscaleModelUrl).
  function getUpscaleModelUrl() {
    return GM_getValue('upscaleModelUrl', '');
  }

  function setUpscaleModelUrl(url) {
    GM_setValue('upscaleModelUrl', url);
  }

  // Whether to use the bundled Ultramix (Balanced) model — see the
  // @resource block/comment at the top of this file — as the default
  // upscaler when the user hasn't configured their own model URL. Kim2091's
  // model, CC-BY-NC-SA-4.0/non-commercial; on by default since it's what
  // ships with the script, but a user who doesn't want any non-commercial
  // asset engaged at all can turn it off and fall back to classical resize.
  function isBundledUltramixEnabled() {
    return GM_getValue('useBundledUltramix', true);
  }

  function setBundledUltramixEnabled(enabled) {
    GM_setValue('useBundledUltramix', enabled);
  }

  // The user's own configured model always wins; otherwise the bundled
  // Ultramix resource if enabled and actually available (GM_getResourceURL
  // throws if the @resource failed to fetch/isn't declared); otherwise
  // empty, which means Enlarger's classical-resize fallback runs.
  function resolveUpscaleModelUrl() {
    const custom = getUpscaleModelUrl();
    if (custom) return custom;
    if (!isBundledUltramixEnabled()) return '';
    try {
      return GM_getResourceURL('ultramixModel') || '';
    } catch (e) {
      return '';
    }
  }

  function getEnabledOrigins() {
    return GM_getValue('enabledOrigins', []);
  }

  function isOriginEnabled(origin) {
    if (DEFAULT_ENABLED_ORIGINS.indexOf(origin) !== -1) return true;
    return getEnabledOrigins().indexOf(origin) !== -1;
  }

  function toggleCurrentOrigin() {
    const origin = location.origin;
    if (DEFAULT_ENABLED_ORIGINS.indexOf(origin) !== -1) {
      alert('cc-bridge: "' + origin + '" is enabled by default and cannot be toggled off here.');
      return;
    }
    const enabled = getEnabledOrigins();
    const idx = enabled.indexOf(origin);
    if (idx === -1) {
      enabled.push(origin);
      GM_setValue('enabledOrigins', enabled);
      alert('cc-bridge: enabled on ' + origin + '. Reload the page to activate.');
    } else {
      enabled.splice(idx, 1);
      GM_setValue('enabledOrigins', enabled);
      alert('cc-bridge: disabled on ' + origin + '. Reload the page to deactivate.');
    }
  }

  // ---- menu commands (always registered, regardless of activation) ---

  GM_registerMenuCommand('Configure Card Conjurer origin', function () {
    const current = getCCOrigin();
    const input = prompt('Card Conjurer origin (e.g. http://localhost:4242):', current);
    if (input === null) return;
    let parsed;
    try {
      parsed = new URL(input);
    } catch (e) {
      alert('cc-bridge: "' + input + '" is not a valid URL. Origin not changed.');
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      alert('cc-bridge: origin must be http:// or https://. Origin not changed.');
      return;
    }
    setCCOrigin(parsed.origin);
    alert('cc-bridge: Card Conjurer origin set to ' + parsed.origin);
  });

  GM_registerMenuCommand(
    (isOriginEnabled(location.origin) ? 'Disable' : 'Enable') + ' conjuring on this site',
    toggleCurrentOrigin
  );

  GM_registerMenuCommand('Configure Google Drive Client ID (for Drive export)', function () {
    // The raw custom value, not getDriveClientId()'s fallback-merged
    // result — pre-filling the prompt with the shared default would make
    // it look like "your" saved value when it isn't one.
    const current = GM_getValue('driveClientId', '');
    const usingDefaultNote = DEFAULT_DRIVE_CLIENT_ID
      ? '\n\nLeave blank to use the built-in shared default — works with zero setup, but shares a Google ' +
        'Cloud quota/billing pool across everyone using it, and stops working for you if that project ever ' +
        'changes. Set your own here for an independent, private connection instead.'
      : '';
    const input = prompt(
      'Google OAuth Client ID for Drive export — Data Access → add the drive.file scope, ' +
        'then create an OAuth Client ID and add the origin of the site you conjure cards from ' +
        '(e.g. https://mpcfill.com — NOT the Card Conjurer origin) as an Authorized ' +
        'JavaScript origin:' +
        usingDefaultNote,
      current
    );
    if (input === null) return;
    setDriveClientId(input.trim());
    if (input.trim()) {
      alert('cc-bridge: Google Drive Client ID saved — this install now uses its own, not the shared default.');
    } else if (DEFAULT_DRIVE_CLIENT_ID) {
      alert('cc-bridge: cleared — back to the built-in shared default for Drive export.');
    } else {
      alert('cc-bridge: cleared. No shared default is configured, so Drive export is now unavailable until you set a Client ID.');
    }
  });

  GM_registerMenuCommand('Configure upscale model weights (for Enlarger)', function () {
    const current = getUpscaleModelUrl();
    const input = prompt(
      'URL to your own ONNX super-resolution model for the Enlarger tool to use instead of the bundled ' +
        'default. The bundled default (used when this is blank) is Ultramix (Balanced) by Kim2091 — ' +
        'ESRGAN/RRDBNet, CC-BY-NC-SA-4.0/non-commercial, native 4x scale, RGB, 0-1 normalized — see ' +
        'THIRD_PARTY_NOTICES.md. A custom URL here fully replaces it and must be reachable with CORS ' +
        'enabled from wherever you host Enlarger. Leave blank to use the bundled Ultramix model (or ' +
        'classical resize, if you\'ve disabled that via the other upscale menu command):',
      current
    );
    if (input === null) return;
    setUpscaleModelUrl(input.trim());
    alert('cc-bridge: upscale model URL ' + (input.trim() ? 'saved.' : 'cleared — back to the bundled Ultramix default.'));
  });

  GM_registerMenuCommand(
    (isBundledUltramixEnabled() ? 'Disable' : 'Enable') + ' bundled Ultramix upscaling (non-commercial)',
    function () {
      const next = !isBundledUltramixEnabled();
      setBundledUltramixEnabled(next);
      alert(
        next
          ? 'cc-bridge: bundled Ultramix upscaling enabled — used automatically unless you\'ve set a custom model URL.'
          : 'cc-bridge: bundled Ultramix upscaling disabled — Enlarger falls back to classical resize unless you\'ve set a custom model URL.'
      );
    }
  );

  // ---- Card Conjurer receiver -------------------------------------------
  //
  // Card Conjurer's own deployed code has no listener for the message this
  // script sends (verified against the live cardconjurer.app bundle — no
  // addEventListener('message'), no onmessage, no URL-param import path).
  // It does, however, already have a working "import a real card by name"
  // feature (#import-name -> importChanged() -> Scryfall fetch) that isn't
  // wired to anything external. Rather than requiring a change to Card
  // Conjurer's source, this script drives that existing feature itself when
  // it detects it's running on the user's configured CC origin — as an
  // iframe embedded in an in-page modal on the MPC Autofill site (see
  // openEditorModal below), the same way MPC Autofill's own grid-selector
  // modal works, rather than a separate browser tab. Tampermonkey/
  // Violentmonkey run matching scripts inside iframes by default, so this
  // same script executes a second time, in the iframe's own context, once
  // its `src` navigates to the configured CC origin. Coupling to Card
  // Conjurer's specific DOM here is intentional and expected — unlike the
  // source side (which stays generic across MPC Autofill sites), Card
  // Conjurer is this project's single, explicit target. If CC's markup ever
  // changes, this degrades to a no-op (editor opens, nothing auto-fills)
  // rather than throwing. cardconjurer.app itself sends no X-Frame-Options
  // or CSP frame-ancestors headers, so embedding it this way is possible
  // without any cooperation from Card Conjurer's side either.

  // Tracked separately from toolbar creation so a second "+ conjure" click
  // that reuses the same iframe document (no fresh navigation) still exports
  // the most recently imported card, not whichever one built the toolbar.
  // Declared here, before the early `return` below, so it's actually
  // initialized in the receiver's execution path — a `let` further down
  // this file (after that `return`) would sit in the temporal dead zone
  // forever in that path, throwing on every reference. (Caught exactly this
  // way against the live site during testing.)
  let currentCardData = null;

  // The origin of the page that framed us — captured from the import
  // message's own event.origin (below), not from window.parent.location
  // (cross-origin, unreadable). Needed to hand the finished export back to
  // that page for Google Drive upload (see "Google Drive export" further
  // down) — the OAuth Client ID's "Authorized JavaScript origins" only
  // needs to list stable mpchost origins this way, not every possible
  // self-hosted CC origin. Same top-of-scope-before-the-early-return
  // placement as currentCardData above, for the same TDZ reason.
  let senderOrigin = null;

  // The upscaled (or raw user-uploaded) art blob from the current import
  // payload, if any — same TDZ-safe placement as the two above, since
  // doFillCardConjurerImport (which consumes this) lives after the early
  // return too.
  let pendingCustomArtBlob = null;

  // Tracks the currently-open "Reimport art…" popover inside Card
  // Conjurer's own toolbar — same TDZ-safe placement as the three above,
  // since showReimportPopover/closeReimportPopover (which read/write this)
  // live after the early return too.
  let reimportPopoverEl = null;

  // The Scryfall card JSON the sender already fetched (see
  // fetchScryfallCard), if any — handed straight to Card Conjurer's own
  // importCard() instead of Card Conjurer redundantly re-fetching it.
  // Same TDZ-safe placement as the above, since doFillCardConjurerImport
  // (which consumes this) lives after the early return too.
  let pendingScryfallCard = null;
  let pendingIsFullArtFlow = false;

  if (location.origin === getCCOrigin()) {
    // Only reskin when actually embedded via our own modal — a user who
    // separately has this script installed and visits Card Conjurer
    // directly on its own tab should see Card Conjurer's own real theme,
    // not have it silently overridden.
    if (window.parent !== window) applyMpcfillTheme();
    setupCCReceiver();
    return;
  }

  // Card Conjurer's entire visual theme runs through ~9 CSS custom
  // properties on :root (confirmed by reading style-9.css directly —
  // --color-primary/--color-selected/--color-highlight/--font-color/
  // --font-color-2/--input-background/--input-background-selected feed
  // every themed selector in the file) plus a couple of hard-coded values
  // on html/.background that aren't var()-driven. Overriding just these
  // gives a complete, coherent reskin without fighting individual
  // selectors — and never touches the card canvas/rendering itself, only
  // the surrounding application chrome. Colors are the site's real
  // computed theme (--bs-primary/--bs-body-bg/etc.), not guessed.
  function applyMpcfillTheme() {
    const style = document.createElement('style');
    style.textContent =
      ':root {' +
      '  --color-primary: #4c9be8;' +
      '  --color-selected: #7ab8ec;' +
      '  --color-highlight: #4c9be8;' +
      '  --font-color: #ebebeb;' +
      '  --font-color-2: #abb6c2;' +
      '  --input-background: #20374c;' +
      '  --input-background-selected: #2d4a63;' +
      '}' +
      'html { background: #0f2537 !important; }' +
      '.background { background: #0f2537 !important; }';
    document.documentElement.appendChild(style);
  }

  function setupCCReceiver() {
    // The sender has no way to know a message landed (no ack protocol — see
    // openEditorModal below), so it blindly retries the same postMessage
    // every RETRY_INTERVAL_MS for up to MAX_RETRIES. Track the last payload
    // we've already started handling so those retries don't re-trigger a
    // fresh navigate/import/fetch cycle each time one arrives.
    let lastHandledPayload = null;
    window.addEventListener('message', function (event) {
      // We're always embedded as an iframe in the modal below; only accept
      // messages from the page that framed us. (If somehow not framed —
      // e.g. the user navigated here directly — there's no parent to check
      // against, so fall through to the payload-shape check alone.)
      if (window.parent !== window && event.source !== window.parent) return;
      const data = event.data;

      // Reply to our own Google Drive export request (see
      // sendCardToDriveViaParent below) — the sender page did the actual
      // upload and is reporting how it went.
      if (data && data.type === 'cc-bridge-drive-export-result') {
        if (data.ok) {
          setDriveToolbarStatus('Uploaded to Google Drive.');
        } else {
          setDriveToolbarStatus('');
          alert('cc-bridge: Google Drive upload failed — ' + (data.message || 'unknown error'));
        }
        return;
      }

      // Reply to our own reimport request (see sendReimportRequest) — the
      // sender page ran the actual upscale and is handing back the
      // result to apply over the current art.
      if (data && data.type === 'cc-bridge-reimport-result') {
        if (data.blob && typeof pageWindow.uploadArt === 'function') {
          applyCustomArtRobust(URL.createObjectURL(data.blob), 4);
          setToolbarStatus('Reimported.');
        } else {
          setToolbarStatus('Reimport failed — no image came back.');
        }
        return;
      }

      if (!data || typeof data.name !== 'string' || !data.name) return;
      senderOrigin = event.origin; // Real origin from the message itself, not a cross-origin read.
      if (data.customArtBlob) pendingCustomArtBlob = data.customArtBlob;
      if (data.scryfallCard) pendingScryfallCard = data.scryfallCard;
      pendingIsFullArtFlow = !!data.isFullArtFlow;
      const key = JSON.stringify(data);
      if (key === lastHandledPayload) return;
      lastHandledPayload = key;
      fillCardConjurerImport(data);
    });
  }

  function fillCardConjurerImport(cardData) {
    if (document.querySelector('#import-name')) {
      ensureExportToolbar(cardData);
      waitForImportReady(function () {
        doFillCardConjurerImport(cardData);
      });
      return;
    }
    navigateToCardCreator(function () {
      ensureExportToolbar(cardData);
      waitForImportReady(function () {
        doFillCardConjurerImport(cardData);
      });
    });
  }

  function isImportReady() {
    // `#import-name` and even `importChanged` itself can exist before Card
    // Conjurer's default frame has finished loading — changeCardIndex()
    // reads `card.text.title` unconditionally partway through, and `card`
    // starts as `{version: '', ...}` with no `.text` at all until a frame
    // has actually loaded one in. This is the real precondition, confirmed
    // against the live site: importChanged existing was not sufficient.
    return (
      typeof pageWindow.importChanged === 'function' &&
      pageWindow.card &&
      pageWindow.card.text &&
      pageWindow.card.text.title
    );
  }

  function waitForImportReady(callback) {
    if (isImportReady()) {
      callback();
      return;
    }
    let attempts = 0;
    const intervalId = setInterval(function () {
      attempts++;
      if (isImportReady()) {
        clearInterval(intervalId);
        callback();
      } else if (attempts > 50) {
        // ~5s at 100ms; give up quietly rather than throw into CC's page.
        clearInterval(intervalId);
      }
    }, 100);
  }

  function navigateToCardCreator(callback) {
    // The homepage doesn't load the Card Creator tool until its htmx-driven
    // nav link swaps `#content`. That link listens for `doCreate` on
    // <body> as well as a click (its own markup: hx-trigger="click,
    // doCreate from:body") — an existing hook, not something added here —
    // so this triggers the same navigation a real click would, without
    // needing the hamburger menu open.
    const content = document.querySelector('#content');
    if (!content) {
      callback(); // Unknown page shape; let the caller's own null-check handle it.
      return;
    }
    const observer = new MutationObserver(function () {
      if (document.querySelector('#import-name')) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(content, { childList: true, subtree: true });
    document.body.dispatchEvent(new CustomEvent('doCreate'));
    setTimeout(function () {
      observer.disconnect();
    }, 8000);
  }

  // Card Conjurer's own changeCardIndex() (run as part of every import,
  // regardless of how it's triggered) always fires its own "art cycling"
  // fetch — fetchScryfallData(cardToImport.name, artFromScryfall, 'art'),
  // a name-wide search across every printing with different art, purely
  // to populate the #art-index "browse alternate arts" dropdown. Its
  // callback chain (artFromScryfall -> changeArtIndex) unconditionally
  // calls uploadArt(...) and artistEdited(...) with whatever the search's
  // first result happens to be — confirmed the hard way: a full-art
  // EOS/37 import (artist "Andrew Theophilopoulos") ended up with artist
  // "Bastien Grivet" and a plain remote art_crop URL instead of our
  // upscaled blob, because this fetch resolves *after* our own art/info
  // application and silently overwrites it. cc-bridge never uses the art-
  // cycling feature at all, so there's no legitimate call here to
  // preserve — neutered for the duration of our own import (a fixed
  // window rather than a precise signal, since the underlying fetch has
  // no exposed completion hook of its own) and restored afterward so any
  // later *manual* use of Card Conjurer's own dropdown still works.
  function suppressArtCycling() {
    if (typeof pageWindow.changeArtIndex !== 'function' || pageWindow.changeArtIndex.__ccBridgeSuppressed) return;
    const original = pageWindow.changeArtIndex;
    const suppressed = function () {};
    suppressed.__ccBridgeSuppressed = true;
    pageWindow.changeArtIndex = suppressed;
    setTimeout(function () {
      if (pageWindow.changeArtIndex === suppressed) {
        pageWindow.changeArtIndex = original;
      }
    }, 10000);
  }

  function doFillCardConjurerImport(cardData) {
    const nameInput = document.querySelector('#import-name');
    if (!nameInput) return; // CC markup changed, or navigation above didn't land.

    suppressArtCycling();
    nameInput.value = cardData.name; // Keeps CC's own UI state consistent for later manual edits either way.

    // The sender already fetched this exact card (see fetchScryfallCard) —
    // hand it straight to Card Conjurer's own importCard() instead of
    // dispatching the name-change event that would make Card Conjurer
    // redundantly re-fetch the identical data itself. This also sidesteps
    // selectMatchingPrint entirely: there's only ever one candidate here,
    // so there's no async "resolve which of several search results is the
    // right one" step for Card Conjurer's change-event handling to race
    // our own art application against.
    if (pendingScryfallCard && typeof pageWindow.importCard === 'function') {
      pageWindow.importCard([pendingScryfallCard]);
      onImportPopulated(cardData);
      return;
    }

    // Fallback: no pre-fetched card (fetchScryfallCard failed, or this
    // import didn't go through the Scryfall-art path at all) — let Card
    // Conjurer do its own normal name-driven fetch, same as always.
    const wantsSpecificPrint = !!(cardData.set_code && cardData.collector_number);
    const allPrintsCheckbox = document.querySelector('#importAllPrints');
    if (allPrintsCheckbox && wantsSpecificPrint) {
      allPrintsCheckbox.checked = true;
    }

    nameInput.dispatchEvent(new Event('change', { bubbles: true }));

    const importIndex = document.querySelector('#import-index');
    if (!importIndex) {
      setTimeout(function () {
        applyPendingCustomArt();
        refreshAutoFrame();
        setToolbarStatus('Applying bleed margin…');
        applyBleedMargin();
      }, 1200);
      return;
    }

    const observer = new MutationObserver(function () {
      observer.disconnect();
      if (wantsSpecificPrint) {
        selectMatchingPrint(importIndex, cardData);
      }
      onImportPopulated(cardData);
    });
    observer.observe(importIndex, { childList: true });
    // Safety net in case the Scryfall fetch never resolves (network error, etc).
    setTimeout(function () {
      observer.disconnect();
    }, 8000);
  }

  // Continuation shared by both the direct-importCard() path and the
  // fallback (Card Conjurer's own fetch) path, once #import-index/scryfallCard
  // is populated either way.
  function onImportPopulated(cardData) {
    setToolbarStatus('Building frame…');
    const scryfallCardData = getSelectedScryfallCard();
    loadBaseFrame(scryfallCardData, function () {
      // Applied here — after frame/autoFrame selection, not before —
      // since card.artBounds is frame-dependent (confirmed directly: the
      // default frame's artBounds is roughly a quarter of the card, while
      // FullArtNew/Borderless's is nearly the whole card) and 'autoFit'
      // reads whatever artBounds is current at the moment the art image
      // actually loads. Applying earlier would fit against the wrong
      // (default, smaller) bounds for the full-art/borderless case.
      // applyCustomArtRobust's own repeated reapply still covers any
      // residual race with Card Conjurer's own art auto-fetch in the
      // fallback path (changeCardIndex() applies its own art_crop
      // synchronously as part of importCard()/the name-change handler, so
      // by the time this callback runs, that's already settled either
      // way — the robust reapply is cheap insurance, not load-bearing).
      applyPendingCustomArt();
      if (pendingIsFullArtFlow) {
        applyFullArtInfoFlow(scryfallCardData, function () {
          applyBleedMargin(scryfallCardData);
        });
      } else {
        applyBleedMargin(scryfallCardData);
      }
    });
  }

  // Applies pendingCustomArtBlob (the upscaled-or-raw art the user chose
  // via the art-source popover) over whatever art Card Conjurer's own
  // import just auto-fetched from Scryfall. Same mechanism Card
  // Conjurer's own paste-art feature uses — confirmed by reading
  // creator-23.js's pasteArt(): URL.createObjectURL(blob) followed by
  // uploadArt(url, 'autoFit') — a blob: URL works as an <img> src exactly
  // like a remote one, and 'autoFit' sizes/positions it the same way a
  // real Scryfall art_crop would be.
  function applyPendingCustomArt() {
    if (!pendingCustomArtBlob || typeof pageWindow.uploadArt !== 'function') return;
    const url = URL.createObjectURL(pendingCustomArtBlob);
    pendingCustomArtBlob = null; // Consumed — don't reapply on a later re-import in the same session.
    applyCustomArtRobust(url, 4);
  }

  // selectMatchingPrint (below) selects a *specific* printing and
  // dispatches a change event on #import-index, which triggers Card
  // Conjurer's own async art re-fetch for that exact printing — this can
  // complete after our override above and silently win the race, undoing
  // it back to Scryfall's own art. Confirmed happening in testing (the
  // override visibly applied, then got clobbered moments later). Same
  // verify-and-reapply pattern already used for the frame-option-
  // selection race earlier in this file — re-asserting a few times over
  // the next couple of seconds reliably wins regardless of exactly when
  // Card Conjurer's own fetch finishes.
  function applyCustomArtRobust(url, checksRemaining) {
    pageWindow.uploadArt(url, 'autoFit');
    if (checksRemaining <= 0) return;
    setTimeout(function () {
      applyCustomArtRobust(url, checksRemaining - 1);
    }, 700);
  }

  function selectMatchingPrint(importIndex, cardData) {
    const setCode = cardData.set_code.toUpperCase();
    const collectorNumber = '#' + cardData.collector_number;
    for (let i = 0; i < importIndex.options.length; i++) {
      const label = importIndex.options[i].textContent.toUpperCase();
      if (label.indexOf(setCode) !== -1 && label.indexOf(collectorNumber) !== -1) {
        importIndex.value = importIndex.options[i].value;
        importIndex.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
  }

  function refreshAutoFrame() {
    // Degraded-markup fallback only (see the #import-index null-check
    // above) — without access to the imported Scryfall data there, this
    // can't make an informed frame choice, so it only re-runs CC's own
    // auto-frame builder if the user already had one configured, rather
    // than picking a frame on its own. The normal path (loadBaseFrame's
    // setAutoFrame) does pick one, using real card data.
    const autoFrameSelect = document.querySelector('#autoFrame');
    if (!autoFrameSelect || autoFrameSelect.value === 'false') return;
    autoFrameSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---- base frame selection ---------------------------------------------
  //
  // The bleed margin (below) layers a border *onto* whatever frame is
  // already loaded — without a base frame first, there's nothing under it
  // to render. Picks a default group+pack from the same Scryfall data Card
  // Conjurer's own import already fetched (layout/type_line) — not Scryfall
  // Tagger, a separate unofficial API with sparse, community-curated tag
  // coverage that nothing here calls. Only the structurally-necessary
  // distinctions are handled: a Saga literally needs Saga frame elements to
  // render at all, unlike a purely cosmetic choice (showcase, extended art),
  // where the regular frame still renders a complete, correct-looking card.
  //
  // Clicking #loadFrameVersion (via loadFramePack below) only sets up
  // metadata — art bounds, text fields, card.version — confirmed by reading
  // several pack scripts directly; none of them touch card.frames. The
  // actual frame *images* (and legendary crowns/PT boxes) only get added by
  // autoFrame() (autoFrame.js), which reads #autoFrame's value. That
  // dropdown only has entries for the "Regular"-style frame family
  // (M15Regular-1, UB, Borderless, etc.) — Saga/Planeswalker/Modal/
  // Transform/Token have no corresponding #autoFrame option, so for those,
  // this still falls back to M15Regular-1 for the frame graphics (better
  // than a completely blank card) even though the group/pack chosen above
  // sets up the structurally-correct art bounds/text fields for the real
  // layout. A real per-layout autoFrame equivalent for those, if one
  // exists, wasn't found in the time available here.

  // Two families of frame choice exist in Card Conjurer, and this returns a
  // selector for whichever applies:
  //
  //  - `autoFrame`: a value for #autoFrame — Card Conjurer's own
  //    buildAutoFrames() (autoFrame.js) picks the color/legendary-crown/etc.
  //    automatically. Only a handful of frame families have an #autoFrame
  //    entry at all (confirmed against creator.html's real <option> list):
  //    the plain "Regular" family (M15Regular-1/Borderless/FullArtNew/8th/
  //    Seventh/...).
  //  - `manualFrameName`: everything else. These packs (confirmed by
  //    reading their scripts directly) populate availableFrames with
  //    entries literally named 'White Frame'/'Blue Frame'/.../'Land Frame'/
  //    'Artifact Frame'/'Multicolored Frame' — the exact same 8-way color
  //    convention across every one of them (Margin, Showcase-5's
  //    GenericShowcase, Misc-2's ABU, and Standard-3's Room/Battle/Case/
  //    Class/Adventure/Split/Aftermath/Leveler/Flip) — so one derivation
  //    (deriveColorFrameName) covers all of them. applyManualFrameSelection
  //    below is what actually turns a name into a rendered frame image.
  //
  // Only structurally-necessary distinctions and cheaply-correct cosmetic
  // upgrades are handled — not Scryfall Tagger (a separate, sparse,
  // community-curated API nothing here calls) and not the ~150-entry list
  // of set-specific showcase treatments Card Conjurer ships (Neon Ink,
  // Draconic, Paranormal, etc.) since which *specific* one applies isn't
  // reliably derivable from Scryfall's card-level fields, and the generic
  // showcase frame below is still much closer than the plain frame.
  function determineFrameSelection(scryfallCardData) {
    if (!scryfallCardData) return null;
    const layout = scryfallCardData.layout || '';
    const typeLine = scryfallCardData.type_line || '';
    const frameEra = scryfallCardData.frame || ''; // Scryfall's own border-era field: '1993'/'1997'/'2003'/'2015'/'future'.
    const frameEffects = scryfallCardData.frame_effects || [];
    const keywords = scryfallCardData.keywords || [];
    const colorName = deriveColorFrameName(scryfallCardData);

    // --- layouts that need their own frame *elements* (extra art/text
    // slots, different text positions) — a plain M15 frame renders wrong
    // or incomplete for these, not just cosmetically different ---
    if (layout === 'saga') return { group: 'Saga-1', pack: 'SagaRegular' };
    if (typeLine.indexOf('Planeswalker') !== -1) {
      return { group: 'Planeswalker', pack: 'PlaneswalkerRegular' };
    }
    if (layout === 'modal_dfc') return { group: 'Modal-1', pack: 'ModalRegular' };
    if (typeLine.indexOf('Battle') !== -1) {
      // Battles report layout:'transform' in Scryfall's data (same as
      // ordinary DFCs) — checked via type_line, before the transform case
      // below, so Battles don't fall into the wrong bucket.
      return { group: 'Standard-3', pack: 'Battle', manualFrameName: colorName };
    }
    // Front face only — a transform card's back face isn't part of this
    // import (MPC Autofill sources front/back as separate card slots).
    if (layout === 'transform') return { group: 'DFC', pack: 'M15TransformFront' };
    if (layout === 'token' || typeLine.indexOf('Token') !== -1) {
      return { group: 'Token-2', pack: 'TokenRegular-1' };
    }
    if (layout === 'class') return { group: 'Standard-3', pack: 'Class', manualFrameName: colorName };
    if (layout === 'case') return { group: 'Standard-3', pack: 'Case', manualFrameName: colorName };
    if (layout === 'leveler') return { group: 'Standard-3', pack: 'Leveler', manualFrameName: colorName };
    if (layout === 'adventure') return { group: 'Standard-3', pack: 'Adventure', manualFrameName: colorName };
    if (layout === 'flip') return { group: 'Standard-3', pack: 'Flip', manualFrameName: colorName };
    if (layout === 'prototype') return { group: 'Standard-3', pack: 'Prototype' };
    if (typeLine.indexOf('Attraction') !== -1) return { group: 'Standard-3', pack: 'Attraction' };
    if (layout === 'split') {
      // Room and Aftermath both report layout:'split' too, so they have to
      // be distinguished before falling through to a plain Split frame.
      if (typeLine.indexOf('Room') !== -1) {
        return { group: 'Standard-3', pack: 'Room', manualFrameName: colorName };
      }
      if (keywords.indexOf('Aftermath') !== -1) {
        return { group: 'Standard-3', pack: 'Aftermath', manualFrameName: colorName };
      }
      return { group: 'Standard-3', pack: 'Split', manualFrameName: colorName };
    }

    // --- cosmetic-only treatments on an otherwise-plain card: the regular
    // frame below would still render a complete, correct card, so these
    // are opportunistic upgrades. Checked most-visually-distinct first. ---
    if (frameEffects.indexOf('showcase') !== -1) {
      return { group: 'Showcase-5', pack: 'GenericShowcase', manualFrameName: colorName };
    }
    // Legendary crowns etc. aren't handled here at all: autoFrame()'s own
    // buildAutoFrames() already detects "legendary"/"snow"/nyx-enchantment
    // straight from the type line and adds them automatically, for any of
    // these #autoFrame choices (confirmed: Borderless and FullArtNew both
    // have supportsCrown: true in autoFrame.js) — no extra logic needed.
    if (scryfallCardData.full_art) {
      return { group: 'Standard-3', pack: 'M15Regular-1', autoFrame: 'FullArtNew' };
    }
    if (scryfallCardData.border_color === 'borderless') {
      return { group: 'Standard-3', pack: 'M15Regular-1', autoFrame: 'Borderless' };
    }
    // Historical border eras. '2015' is the modern border (the plain
    // default below); 'future' (Future Sight full-art frame) isn't handled
    // — its pack keys frame choice by card *type* rather than color, a
    // different selection axis, and future-shifted reprints are rare
    // enough that the modern frame is an acceptable fallback.
    if (frameEra === '1993') {
      return { group: 'Misc-2', pack: 'ABU', manualFrameName: colorName };
    }
    if (frameEra === '2003') {
      return { group: 'Standard-3', pack: 'M15Regular-1', autoFrame: '8th' };
    }
    if (frameEra === '1997') {
      return { group: 'Standard-3', pack: 'M15Regular-1', autoFrame: 'Seventh' };
    }

    return { group: 'Standard-3', pack: 'M15Regular-1', autoFrame: 'M15Regular-1' };
  }

  // Card Conjurer's own color-frame naming convention (see determineFrameSelection's
  // comment above) — mirrors Magic's standard frame-color rule (land > multicolor >
  // single color > colorless/artifact). Only needed for manualFrameName packs;
  // #autoFrame-driven packs already do the equivalent detection internally.
  function deriveColorFrameName(scryfallCardData) {
    const typeLine = scryfallCardData.type_line || '';
    const colors = scryfallCardData.colors || [];
    if (typeLine.indexOf('Land') !== -1) return 'Land Frame';
    if (colors.length >= 2) return 'Multicolored Frame';
    if (colors.length === 1) {
      const names = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
      return (names[colors[0]] || 'Artifact') + ' Frame';
    }
    return 'Artifact Frame'; // Colorless nonland — artifacts, Eldrazi, etc.
  }

  function getSelectedScryfallCard() {
    const importIndex = document.querySelector('#import-index');
    const scryfallCard = pageWindow.scryfallCard;
    if (!importIndex || !Array.isArray(scryfallCard)) return null;
    return scryfallCard[importIndex.value] || null;
  }

  function loadBaseFrame(scryfallCardData, callback) {
    const selection = determineFrameSelection(scryfallCardData);
    if (!selection) {
      callback(); // No Scryfall data to key off; let the caller carry on frameless.
      return;
    }
    resolveFramePack(selection.group, selection.pack, function () {
      const loadBtn = document.querySelector('#loadFrameVersion');
      if (loadBtn) loadBtn.click(); // Sets up bounds/text/card.version — never touches card.frames itself.
      if (selection.autoFrame) {
        setAutoFrame(selection.autoFrame);
        waitForFramesBuilt(callback);
      } else if (selection.manualFrameName) {
        applyManualFrameSelectionRobust(selection.manualFrameName, function () {
          waitForFramesBuilt(callback);
        });
      } else {
        // Structural-only pack with no color concept (Saga, Planeswalker,
        // Modal DFC, Transform, Token, Prototype, Attraction) and no
        // #autoFrame equivalent of its own — fall back to the plain
        // Regular frame graphic layered onto this pack's bounds, better
        // than a blank card.
        setAutoFrame('M15Regular-1');
        waitForFramesBuilt(callback);
      }
    });
  }

  function waitForFramesBuilt(callback) {
    // setAutoFrame's dispatched change event runs autoFrame(), which builds
    // card.frames asynchronously. card.frames.length > 0 only means the
    // array got populated with frame *references* — the real frame image
    // fetch/decode/canvas-composite work for each one is still in flight
    // at that point and can measurably take several more seconds (confirmed
    // against the live site via network timing: a single frame image's
    // response alone took ~2s, and since JS is single-threaded, that work
    // blocks anything queued after it, including the *next* step's own
    // loadScript() onload from firing — proceeding to applyBleedMargin
    // immediately after frames.length > 0 measured a ~10s stall there
    // purely from queueing behind this). Poll until frames.length is
    // non-zero *and* stops changing across a few consecutive checks, as a
    // proxy for "settled", with a generous bound since this can genuinely
    // take a while.
    let attempts = 0;
    let stableTicks = 0;
    let lastLength = -1;
    const intervalId = setInterval(function () {
      attempts++;
      const frames = pageWindow.card && pageWindow.card.frames;
      const length = Array.isArray(frames) ? frames.length : 0;
      if (length > 0 && length === lastLength) {
        stableTicks++;
      } else {
        stableTicks = 0;
      }
      lastLength = length;
      if (stableTicks >= 3 || attempts > 150) {
        // 3 stable ticks (~600ms unchanged) or ~30s given up either way.
        clearInterval(intervalId);
        callback();
      }
    }, 200);
  }

  function setAutoFrame(value) {
    const autoFrameSelect = document.querySelector('#autoFrame');
    if (!autoFrameSelect) return;
    const hasOption = Array.prototype.some.call(autoFrameSelect.options, function (o) {
      return o.value === value;
    });
    if (!hasOption) return; // Degrade silently rather than pick an arbitrary option.
    autoFrameSelect.value = value;
    autoFrameSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---- manual frame-option selection (shared) ---------------------------
  //
  // Card Conjurer's UI normally requires either a genuine double-click on a
  // .frame-option (a same-index click within 500ms of the previous one —
  // see doubleClick()/frameOptionClicked() in creator-23.js) or a manual
  // click of "Add Frame to Card" (#addToFull) to actually call addFrame()
  // and render anything. A single synthetic .click() on a .frame-option
  // only updates selectedFrameIndex and the preview UI — confirmed the hard
  // way: an earlier version of this script picked the right .frame-option
  // but nothing ever rendered differently, because addFrame() was never
  // actually being called. #addToFull's own onclick is literally
  // `addFrame()` (confirmed in creator.html), so this calls it directly
  // instead of trying to simulate a double-click gesture's timing.
  function applyManualFrameSelection(targetName) {
    if (!targetName) return;
    const frames = pageWindow.availableFrames;
    if (!Array.isArray(frames)) return;
    const index = frames.findIndex(function (f) { return f.name === targetName; });
    if (index < 0) return; // Not in this pack (e.g. pack failed to load) — degrade silently.
    const options = document.querySelectorAll('#frame-picker .frame-option');
    if (!options[index]) return;
    options[index].click(); // Sets selectedFrameIndex + mask-picker UI only.
    const addBtn = document.querySelector('#addToFull');
    if (addBtn) addBtn.click(); // Actually calls addFrame() with that selection.
  }

  // resolveFramePack's "skip the redundant reload when our target is
  // already the group's own default pack" optimization (below) still
  // leaves that *original*, auto-triggered internal pack load running
  // asynchronously and completely outside our control — and confirmed
  // against the live site, it can finish well after our own selection
  // already succeeded (main-thread contention, same as elsewhere in this
  // file), silently reverting #frame-picker back to its own default choice
  // with nothing to notice or fix it. Re-checking a few times over the
  // next couple of seconds and re-clicking if something clobbered it
  // catches this reliably in practice.
  //
  // addFrame() itself has no dedup at all — it unconditionally unshifts a
  // new frame onto card.frames every time "Add Frame to Card" is clicked
  // (confirmed by reading creator-23.js directly), so re-clicking it isn't
  // actually idempotent the way the old comment here claimed. Left
  // unguarded, this produced exactly the visible bug: up to 5 duplicate
  // border-extension layers stacked on top of each other from this
  // function's own retries, plus one more from Card Conjurer's own
  // auto-triggered default-pack load landing independently — 6 black
  // borders on one card, confirmed against a real export. Fixed by only
  // clicking when card.frames[0] (unshift means index 0 is the most
  // recently added) isn't already the right frame — genuinely idempotent
  // now, not just re-clicking and hoping — with a same-name dedup pass
  // once settled to clean up anything that slipped through from the race
  // this function exists to defeat in the first place.
  function applyManualFrameSelectionRobust(targetName, callback, checksRemaining) {
    checksRemaining = checksRemaining === undefined ? 4 : checksRemaining;
    const frames = pageWindow.card && pageWindow.card.frames;
    const currentTop = Array.isArray(frames) && frames.length ? frames[0] : null;
    if (!currentTop || currentTop.name !== targetName) {
      applyManualFrameSelection(targetName);
    }
    if (checksRemaining <= 0) {
      dedupeFramesByName(targetName);
      callback();
      return;
    }
    setTimeout(function () {
      applyManualFrameSelectionRobust(targetName, callback, checksRemaining - 1);
    }, 700);
  }

  // Removes all but the first (most recently added, per addFrame's own
  // unshift ordering) frame matching targetName — cleans up any duplicates
  // that landed before this function's own idempotency check could catch
  // them (e.g. Card Conjurer's own default-pack auto-load racing our first
  // call). Goes through the same #frame-list "X" button / removeFrame()
  // Card Conjurer's own frame-element editor uses, rather than splicing
  // card.frames directly, so the array and its DOM list stay in sync for
  // any later manual edit. Collects every close button to remove in one
  // read-only pass *before* clicking any of them — removeFrame's own index
  // lookup is computed live from the DOM at click time, so clicking
  // stale/shifted indices while still walking the (shrinking) live array
  // would skip entries; clicking real element references afterward avoids
  // that regardless of how each click reshuffles what's left.
  function dedupeFramesByName(targetName) {
    const frames = pageWindow.card && pageWindow.card.frames;
    const frameList = document.querySelector('#frame-list');
    if (!Array.isArray(frames) || !frameList) return;
    const children = frameList.children;
    const toRemove = [];
    let seenOne = false;
    for (let i = 0; i < frames.length && i < children.length; i++) {
      if (frames[i].name !== targetName) continue;
      if (!seenOne) {
        seenOne = true;
        continue;
      }
      const closeBtn = children[i].querySelector('.frame-element-close');
      if (closeBtn) toRemove.push(closeBtn);
    }
    toRemove.forEach(function (closeBtn) {
      closeBtn.click();
    });
  }

  // Selecting a frame group loads /js/frames/group<X>.js, which (per every
  // group script's own source) synchronously calls Card Conjurer's own
  // loadFramePacks() — populating #selectFramePack *and* auto-loading
  // whichever pack is listed first for that group, via its own internal
  // loadScript() call, before our group loadScript() promise even
  // resolves. When our target pack is that same default (e.g. Margin-1 is
  // the Margin group's own first pack), deliberately skipping our own
  // redundant reload avoids a real, confirmed race: two concurrent loads
  // of the identical pack script each independently re-populate
  // availableFrames/#frame-picker, and whichever finishes last wins —
  // unpredictably clobbering whichever one we intended.
  function resolveFramePack(group, pack, callback) {
    const groupSelect = document.querySelector('#selectFrameGroup');
    const packSelect = document.querySelector('#selectFramePack');
    if (!groupSelect || !packSelect || typeof pageWindow.loadScript !== 'function') {
      callback(); // Degrade silently, as elsewhere.
      return;
    }
    groupSelect.value = group;
    pageWindow
      .loadScript('/js/frames/group' + group + '.js')
      .then(function () {
        if (packSelect.value === pack) {
          return waitForFramePickerPopulated(callback);
        }
        packSelect.value = pack;
        return pageWindow.loadScript('/js/frames/pack' + pack + '.js').then(function () {
          packSelect.value = pack; // Re-assert against the group's own (different) default-pack load.
          waitForFramePickerPopulated(callback);
        });
      })
      .catch(function () {
        callback(); // Let the caller continue even if frame loading failed.
      });
  }

  function waitForFramePickerPopulated(callback) {
    let attempts = 0;
    const intervalId = setInterval(function () {
      attempts++;
      const ready = document.querySelectorAll('#frame-picker .frame-option').length > 0;
      if (ready || attempts > 50) {
        // ~5s cap.
        clearInterval(intervalId);
        callback();
      }
    }, 100);
  }

  // ---- full-art / borderless: collector info over the source image's own
  // baked-in copyright line --------------------------------------------
  //
  // FullArtNew/Borderless (already selected by determineFrameSelection)
  // ship their own opaque black bar across the bottom of the frame —
  // confirmed directly against the live site, visible even before any art
  // is applied. That bar sits on top of the art layer in the compositing
  // order, so it already blanks out whatever the source image's own
  // bottom edge has printed on it (including a real card's baked-in "™ &
  // © Wizards of the Coast" line) — nothing to draw ourselves there.
  //
  // What's missing is the actual collector info text: Card Conjurer's own
  // "bottom info" system (#info-number/#info-rarity/#info-set/#info-artist,
  // gated by #enableCollectorInfo, drawn by bottomInfoEdited()) already
  // deliberately skips drawing its own "Wizards of the Coast"/"NOT FOR
  // SALE"/"CardConjurer.com" placeholder lines (see bottomInfoEdited's own
  // skip-list) — so populating these fields and triggering a draw gives
  // exactly "collector info only, no WotC copyright" with no extra
  // filtering needed on this end. Field mapping mirrors Card Conjurer's
  // own import-time population code exactly (creator-23.js, the
  // enableImportCollectorInfo branch) for consistent formatting.
  //
  // bottomInfoEdited() is genuinely async (awaits internally) — confirmed
  // directly: sampling the composited canvas right after a fire-and-forget
  // call showed nothing drawn, awaiting the same call showed the real
  // text. Skipping the further /sets/{code} lookup Card Conjurer's own
  // import does purely for zero-padding the collector number against the
  // set's printed size — cosmetic only, not needed for the actual ask.
  function applyFullArtInfoFlow(scryfallCardData, callback) {
    if (!scryfallCardData) {
      callback();
      return;
    }
    const numberEl = document.querySelector('#info-number');
    const rarityEl = document.querySelector('#info-rarity');
    const setEl = document.querySelector('#info-set');
    const langEl = document.querySelector('#info-language');
    const enableEl = document.querySelector('#enableCollectorInfo');
    if (numberEl) numberEl.value = scryfallCardData.collector_number || '';
    if (rarityEl) {
      rarityEl.value = scryfallCardData.rarity ? scryfallCardData.rarity[0].toUpperCase() : '';
    }
    if (setEl) setEl.value = (scryfallCardData.set || '').toUpperCase();
    if (langEl) langEl.value = (scryfallCardData.lang || '').toUpperCase();
    if (enableEl) enableEl.checked = true;
    // Also sets #art-artist and triggers its own bottomInfoEdited() call —
    // harmless (bottomInfoEdited is idempotent/cheap), the awaited call
    // below is the one that's actually waited on before continuing.
    if (scryfallCardData.artist && typeof pageWindow.artistEdited === 'function') {
      pageWindow.artistEdited(scryfallCardData.artist);
    }
    if (typeof pageWindow.bottomInfoEdited === 'function') {
      Promise.resolve(pageWindow.bottomInfoEdited()).then(callback, callback);
    } else {
      callback();
    }
  }

  // ---- bleed margin ----------------------------------------------------
  //
  // Verified against the live site: "1/8th Inch Margin" is a real frame
  // group (#selectFrameGroup value 'Margin'), not a checkbox. Selecting it
  // loads /js/frames/groupMargin.js, which populates #selectFramePack with
  // several themed packs plus a generic one ({name:'Generic Margins',
  // value:'Margin-1'}). That pack's own script (packMargin-1.js) defines
  // multiple named border-extension images in its availableFrames array —
  // 'Black Extension', 'White Border Extension', 'Silver Border Extension',
  // 'Gold Border Extension', 'Borderless Extension', etc. — matching Card
  // Conjurer's own frame's real border color, not a color we compute
  // ourselves.

  function applyBleedMargin(scryfallCardData, attempt) {
    attempt = attempt || 1;
    if (pageWindow.card && pageWindow.card.margins) {
      setToolbarStatus('');
      return; // Already applied.
    }
    if (attempt > 6) {
      // Give up after a generous number of tries. Verified against the live
      // site that this genuinely does complete given enough wall-clock time
      // (Card Conjurer's own frame compositing runs on the single JS main
      // thread and can take tens of seconds under contention) — this cap
      // exists only to avoid polling forever if something is actually wrong.
      setToolbarStatus('Bleed margin failed to apply — try "Export card" anyway or reload.');
      return;
    }
    setToolbarStatus('Applying bleed margin…');

    const borderColor = scryfallCardData && scryfallCardData.border_color;
    const extensionName = BORDER_EXTENSION_NAME_BY_COLOR[borderColor] || 'Black Extension';

    resolveFramePack('Margin', 'Margin-1', function () {
      const loadBtn = document.querySelector('#loadFrameVersion');
      if (loadBtn) loadBtn.click(); // Sets card.margins = true + adjusts artBounds — doesn't touch card.frames.

      // applyManualFrameSelectionRobust (not the plain, one-shot version)
      // because resolveFramePack's "skip the redundant reload" fast path
      // (used here, since Margin-1 is the Margin group's own default pack)
      // still leaves that original, auto-triggered internal pack load
      // running asynchronously and outside our control — confirmed against
      // the live site, it can finish well after our own selection already
      // succeeded and silently revert it back to 'Black Extension' with
      // nothing to notice or fix it otherwise.
      applyManualFrameSelectionRobust(extensionName, function () {
        // Retry-until-confirmed rather than trying to predict exactly when
        // the main thread frees up: the base frame's own image
        // fetch/decode/composite work can still be running here (confirmed
        // against the live site — it measurably delays anything queued
        // after it), so a first attempt can silently lose a race even
        // after waitForFramesBuilt's settle check in loadBaseFrame. A
        // fresh attempt once things actually quiet down reliably sticks
        // (confirmed end-to-end against live production data).
        let attempts = 0;
        const intervalId = setInterval(function () {
          attempts++;
          const applied = !!(pageWindow.card && pageWindow.card.margins);
          if (applied || attempts > 60) {
            // ~12s per attempt.
            clearInterval(intervalId);
            if (applied) {
              // card.margins flips true as soon as loadMarginVersion runs,
              // well before the border-extension image addFrame() just
              // queued has actually finished fetching/decoding/compositing
              // (confirmed against the live site: a silver/borderless
              // extension's true color only appeared on canvas a couple of
              // seconds after margins went true, while black/white — likely
              // smaller/already-cached images — looked done immediately).
              // Reuse the same settle check as the base frame rather than
              // just trusting the flag.
              waitForFramesBuilt(function () {
                setToolbarStatus('');
              });
            } else {
              applyBleedMargin(scryfallCardData, attempt + 1);
            }
          }
        }, 200);
      });
    });
  }

  // ---- local export ------------------------------------------------------
  //
  // Card Conjurer's own downloadCard() reads cardCanvas.toDataURL(...)
  // directly and triggers a browser download — cardCanvas is a real global
  // (dynamically created, confirmed via window[name + 'Canvas'] patterns
  // elsewhere in CC's code), so this script can read it the same way
  // without needing to intercept CC's own download button.
  //
  // Chromium: uses the File System Access API for a silent write after a
  // one-time folder permission grant — the same API CC's own bulk-download
  // feature (bulkDownloadZip, showSaveFilePicker) already depends on.
  // Firefox has no File System Access API support, so it falls back to the
  // same <a download> flow downloadCard() itself uses; the browser's own
  // download settings decide where that lands.

  function openHandleDB() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(EXPORT_DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(EXPORT_DB_STORE);
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }

  function getStoredDirHandle() {
    return openHandleDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(EXPORT_DB_STORE, 'readonly');
        const req = tx.objectStore(EXPORT_DB_STORE).get(EXPORT_DB_KEY);
        req.onsuccess = function () {
          resolve(req.result || null);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    });
  }

  function setStoredDirHandle(handle) {
    return openHandleDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(EXPORT_DB_STORE, 'readwrite');
        tx.objectStore(EXPORT_DB_STORE).put(handle, EXPORT_DB_KEY);
        tx.oncomplete = function () {
          resolve();
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '').trim();
  }

  function buildExportFilename(cardData) {
    let base = sanitizeFilename(cardData.name || 'card');
    if (cardData.set_code && cardData.collector_number) {
      base += ' (' + cardData.set_code.toUpperCase() + '-' + cardData.collector_number + ')';
    }
    return base + '.png';
  }

  async function pickExportDirectory() {
    try {
      const handle = await window.showDirectoryPicker();
      await setStoredDirHandle(handle);
      alert('cc-bridge: export folder set to "' + handle.name + '".');
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        alert('cc-bridge: could not set export folder (' + e.message + ').');
      }
    }
  }

  async function ensureWritePermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  async function findAvailableFilename(dirHandle, filename) {
    const dot = filename.lastIndexOf('.');
    const stem = dot === -1 ? filename : filename.slice(0, dot);
    const ext = dot === -1 ? '' : filename.slice(dot);
    let candidate = filename;
    let n = 2;
    while (true) {
      try {
        await dirHandle.getFileHandle(candidate);
        candidate = stem + ' (' + n + ')' + ext; // Exists; try the next one.
        n++;
      } catch (e) {
        return candidate; // Not found — free to use.
      }
    }
  }

  async function exportViaFileSystemAccess(blob, filename) {
    const handle = await getStoredDirHandle();
    if (!handle) {
      alert('cc-bridge: no export folder configured yet — use "Set export folder" first.');
      return false;
    }
    if (!(await ensureWritePermission(handle))) {
      alert('cc-bridge: write permission for the export folder was denied.');
      return false;
    }
    const finalName = await findAvailableFilename(handle, filename);
    const fileHandle = await handle.getFileHandle(finalName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  }

  function exportViaDownload(dataUrl, filename) {
    const a = document.createElement('a');
    a.download = filename;
    a.href = dataUrl;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function exportCard(cardData) {
    const canvas = pageWindow.cardCanvas;
    if (!canvas) {
      alert('cc-bridge: no card canvas found — is a card loaded?');
      return;
    }
    const filename = buildExportFilename(cardData);

    if (HAS_FS_ACCESS) {
      const blob = await new Promise(function (resolve) {
        canvas.toBlob(resolve, 'image/png');
      });
      const wrote = await exportViaFileSystemAccess(blob, filename).catch(function (e) {
        alert('cc-bridge: export failed (' + e.message + ').');
        return false;
      });
      if (!wrote) return;
    } else {
      exportViaDownload(canvas.toDataURL('image/png'), filename);
    }
  }

  // ---- Google Drive export (hand-off half) -------------------------------
  //
  // The actual OAuth + upload happens on the sender/mpchost page (e.g.
  // mpcfill.com) — see its "Google Drive export" section further down —
  // not here. A Client ID's "Authorized JavaScript origins" list requires
  // exact domain matches, and the mpchost's own origin is a small, stable,
  // known set under this project's control; the CC origin is
  // user-configurable and could be any self-hosted domain, which doesn't
  // work as an OAuth origin for installs meant to work for other users
  // without each of them registering their own Client ID. This just
  // renders the export and hands the blob to the sender via postMessage —
  // still entirely triggered by this one user click, which is what
  // CLAUDE.md's network-calls exception actually requires; the network
  // call itself just happens one hop over.
  function sendCardToDriveViaParent(cardData) {
    const canvas = pageWindow.cardCanvas;
    if (!canvas) {
      alert('cc-bridge: no card canvas found — is a card loaded?');
      return;
    }
    if (!senderOrigin) {
      alert('cc-bridge: no host page on record to hand this off to — reopen this from the "+ conjure" button.');
      return;
    }
    setDriveToolbarStatus('Sending to host page for Drive upload…');
    canvas.toBlob(function (blob) {
      window.parent.postMessage({ type: 'cc-bridge-drive-export', cardData: cardData, blob: blob }, senderOrigin);
    }, 'image/png');
  }

  // ---- export toolbar (injected into the Card Conjurer page itself) -----

  function ensureExportToolbar(cardData) {
    currentCardData = cardData;
    if (document.querySelector('.cc-bridge-toolbar')) return;

    const toolbarStyle = document.createElement('style');
    toolbarStyle.textContent =
      '.cc-bridge-toolbar {' +
      '  position: fixed; top: 8px; left: 8px; z-index: 999999;' +
      '  display: flex; gap: 6px;' +
      '}' +
      '.cc-bridge-toolbar-btn {' +
      '  font-size: 12px; padding: 6px 10px; border-radius: 2px;' +
      '  border: 1px solid #4c9be8; background: #4c9be8;' +
      '  color: #ebebeb; cursor: pointer;' +
      '}' +
      '.cc-bridge-toolbar-btn:hover { background: #3d8cd9; }' +
      '.cc-bridge-toolbar-status, .cc-bridge-toolbar-drive-status {' +
      '  font-size: 12px; padding: 6px 4px; color: #ebebeb; background: rgba(15,37,55,0.8);' +
      '  border-radius: 2px; align-self: center;' +
      '}' +
      '.cc-bridge-toolbar-status:empty, .cc-bridge-toolbar-drive-status:empty { display: none; }';
    document.documentElement.appendChild(toolbarStyle);

    const toolbar = document.createElement('div');
    toolbar.className = 'cc-bridge-toolbar';

    const statusEl = document.createElement('span');
    statusEl.className = 'cc-bridge-toolbar-status';
    toolbar.appendChild(statusEl);

    // Separate from the frame-build/bleed-margin status above — that
    // pipeline can still be updating its own status well after a Drive
    // upload (a much faster round trip) has already finished, and the two
    // sharing one text field meant whichever happened to fire last won,
    // sometimes clobbering "Uploaded to Google Drive." with a stale
    // "Applying bleed margin…" (confirmed happening in testing — a real
    // race, not hypothetical).
    const driveStatusEl = document.createElement('span');
    driveStatusEl.className = 'cc-bridge-toolbar-drive-status';
    toolbar.appendChild(driveStatusEl);

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'cc-bridge-toolbar-btn';
    exportBtn.textContent = 'Export card';
    exportBtn.addEventListener('click', function () {
      exportCard(currentCardData);
    });
    toolbar.appendChild(exportBtn);

    if (HAS_FS_ACCESS) {
      const folderBtn = document.createElement('button');
      folderBtn.type = 'button';
      folderBtn.className = 'cc-bridge-toolbar-btn';
      folderBtn.textContent = 'Set export folder';
      folderBtn.addEventListener('click', pickExportDirectory);
      toolbar.appendChild(folderBtn);
    }

    // Always offered, regardless of browser — the Drive upload only needs
    // fetch()/FormData, not the Chromium-only File System Access API.
    // Nothing here runs until this button is actually clicked (see the
    // Google Drive export section above).
    const driveBtn = document.createElement('button');
    driveBtn.type = 'button';
    driveBtn.className = 'cc-bridge-toolbar-btn';
    driveBtn.textContent = 'Export to Drive';
    driveBtn.addEventListener('click', function () {
      sendCardToDriveViaParent(currentCardData);
    });
    toolbar.appendChild(driveBtn);

    // Minimal — redoing the art-source choice mid-session (without losing
    // whatever frame/text edits are already in progress by closing and
    // reopening the whole modal from scratch), not a full copy of
    // Enlarger's former control surface.
    const reimportBtn = document.createElement('button');
    reimportBtn.type = 'button';
    reimportBtn.className = 'cc-bridge-toolbar-btn';
    reimportBtn.textContent = 'Reimport art…';
    reimportBtn.addEventListener('click', function () {
      showReimportPopover(reimportBtn);
    });
    toolbar.appendChild(reimportBtn);

    document.body.appendChild(toolbar);
  }

  // ---- reimport art mid-session (relays through the sender page) --------
  //
  // The actual upscale (upscaleViaEnlarger, ENLARGER_HTML) only exists in
  // the sender/host page's own code path — this receiver code path
  // returned early long before that's ever defined, they're the same
  // script file but never the same running context. So this asks the
  // parent to do it and waits for the result, rather than duplicating the
  // upscale machinery here.

  function closeReimportPopover() {
    if (reimportPopoverEl && reimportPopoverEl.parentNode) reimportPopoverEl.parentNode.removeChild(reimportPopoverEl);
    reimportPopoverEl = null;
    document.removeEventListener('click', onReimportPopoverOutsideClick, true);
  }

  function onReimportPopoverOutsideClick(event) {
    if (reimportPopoverEl && !reimportPopoverEl.contains(event.target) && event.target !== event.currentTarget) {
      closeReimportPopover();
    }
  }

  function showReimportPopover(anchorBtn) {
    closeReimportPopover();
    const rect = anchorBtn.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'cc-bridge-art-popover';
    pop.style.top = rect.bottom + 4 + 'px';
    pop.style.left = Math.max(4, rect.left) + 'px';

    const scryfallOpt = document.createElement('button');
    scryfallOpt.type = 'button';
    scryfallOpt.className = 'cc-bridge-art-popover-opt';
    scryfallOpt.textContent = 'Use Scryfall art';
    scryfallOpt.addEventListener('click', function () {
      closeReimportPopover();
      const scryfallCardData = getSelectedScryfallCard();
      const artUrl = scryfallCardData && scryfallCardData.image_uris && scryfallCardData.image_uris.art_crop;
      if (!artUrl || !senderOrigin) {
        setToolbarStatus('No Scryfall art available to reimport.');
        return;
      }
      sendReimportRequest({ artUrl: artUrl });
    });

    const uploadOpt = document.createElement('button');
    uploadOpt.type = 'button';
    uploadOpt.className = 'cc-bridge-art-popover-opt';
    uploadOpt.textContent = 'Upload my own image…';
    uploadOpt.addEventListener('click', function () {
      closeReimportPopover();
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
      fileInput.addEventListener('change', function () {
        const file = fileInput.files[0];
        fileInput.remove();
        if (!file || !senderOrigin) return;
        sendReimportRequest({ file: file });
      });
      fileInput.click();
    });

    pop.appendChild(scryfallOpt);
    pop.appendChild(uploadOpt);
    document.body.appendChild(pop);
    reimportPopoverEl = pop;

    setTimeout(function () {
      document.addEventListener('click', onReimportPopoverOutsideClick, true);
    }, 0);
  }

  function sendReimportRequest(source) {
    setToolbarStatus('Upscaling…');
    const payload = { type: 'cc-bridge-reimport-request' };
    if (source.artUrl) payload.artUrl = source.artUrl;
    if (source.file) payload.file = source.file;
    window.parent.postMessage(payload, senderOrigin);
  }

  function setToolbarStatus(text) {
    // The base-frame/bleed-margin pipeline can genuinely take tens of
    // seconds (Card Conjurer's own frame compositing runs on the single JS
    // main thread — confirmed against the live site). Surface that as
    // in-progress rather than letting it look stalled.
    const statusEl = document.querySelector('.cc-bridge-toolbar-status');
    if (statusEl) statusEl.textContent = text;
  }

  function setDriveToolbarStatus(text) {
    const statusEl = document.querySelector('.cc-bridge-toolbar-drive-status');
    if (statusEl) statusEl.textContent = text;
  }

  // ---- activation gate --------------------------------------------------

  if (!isOriginEnabled(location.origin)) {
    return;
  }

  // ---- styles -------------------------------------------------------

  // Colors below are the site's own real computed theme (read directly
  // off the live site: --bs-primary/--bs-body-bg/--bs-dark/etc.), not a
  // guess — the injected button and modal chrome are meant to look like
  // they belong to that page, not to Card Conjurer or to this script.
  const style = document.createElement('style');
  style.textContent =
    '.' + BUTTON_CLASS + ' {' +
    '  position: absolute;' +
    '  top: 4px;' +
    '  right: 4px;' +
    // The anchor is Bootstrap's `.ratio` box (see BUTTON_ANCHOR_CLASS),
    // which carries `.ratio > * { position: absolute; top: 0; left: 0;
    // width: 100%; height: 100% }` — a rule that targets *any* direct
    // child, including this button, and was still winning over a plain
    // (non-!important) override here, ballooning the button to the full
    // size of the card. !important forces its natural, content-sized
    // dimensions (padding + font-size below) to actually stick, same as
    // it always sized when it lived on the card header/tile — no
    // Bootstrap rule competed for width/height there.
    '  left: auto !important;' +
    '  width: auto !important;' +
    '  height: auto !important;' +
    '  max-width: none !important;' +
    '  z-index: 10;' +
    '  font-size: 11px;' +
    '  line-height: 1;' +
    '  padding: 4px 7px;' +
    '  border: 1px solid #4c9be8;' +
    '  border-radius: 2px;' +
    '  background: #4c9be8;' +
    '  color: #ebebeb;' +
    '  cursor: pointer;' +
    '  opacity: 0;' +
    '  pointer-events: auto;' + // carves an exception out of BUTTON_TETHER_CLASS's pointer-events: none, below
    '  transition: opacity 0.12s ease;' +
    '}' +
    '.' + BUTTON_CLASS + ':hover { background: #3d8cd9; }' +
    // Shown only while hovering the card art itself (the button's
    // positioned parent, see BUTTON_ANCHOR_CLASS in injectButtonIfNeeded).
    // Descendant (not direct-child) combinator since the button may live
    // one level deeper, inside BUTTON_TETHER_CLASS's wrapper — see there.
    '.' + BUTTON_ANCHOR_CLASS + ':hover .' + BUTTON_CLASS + ' { opacity: 1; }' +
    // Sized/positioned to exactly match the art's own box (see
    // BUTTON_TETHER_CLASS's declaration for why this has to be a separate
    // element rather than scaling the button or anchorEl directly).
    '.' + BUTTON_TETHER_CLASS + ' {' +
    '  position: absolute; inset: 0; pointer-events: none;' +
    // the site's the art element sets the art <img> itself to explicit
    // z-index: 1 — a sibling at the default z-index: auto (no z-index
    // set) always paints *behind* an explicit-z-index sibling regardless
    // of DOM order, so without this the wrapper (and the trigger inside
    // it) silently rendered behind the art: invisible and unclickable
    // even though genuinely present in the DOM. Matches .cc-bridge-btn's
    // own z-index for consistency.
    '  z-index: 10;' +
    // Timing matches the hover-zoom wrapper's own img transition exactly, so
    // the two move in lockstep during the hover-zoom.
    '  transition: transform 0.15s ease-out;' +
    '}' +
    // Everywhere else on the site, a card's border/label stay static
    // while only its art zooms on hover — but the site's printing-tag
    // candidates (the hover-zoom wrapper, `:hover img { transform: scale(1.6) }`)
    // are a deliberate exception, so the trigger matches that exception
    // here rather than the site-wide norm.
    '.' + BUTTON_ANCHOR_ZOOM_CLASS + ':hover > .' + BUTTON_TETHER_CLASS + ' { transform: scale(1.6); }' +
    '.cc-bridge-modal-backdrop {' +
    '  position: fixed; inset: 0; background: rgba(15,37,55,0.75);' +
    '  z-index: 999999;' +
    '}' +
    // position/left/top/width/height are set as inline styles (see
    // openEditorModal) and transitioned between the clicked card's own
    // rect and the panel's full working size — position: fixed throughout
    // both states, not just relative-then-fixed, so the transition is a
    // smooth resize/reposition rather than a mode-switch snap.
    '.cc-bridge-modal-panel {' +
    '  position: fixed;' +
    '  background: #0f2537; border-radius: 2px; overflow: hidden;' +
    '  box-shadow: 0 10px 40px rgba(0,0,0,0.5);' +
    '  border: 1px solid #20374c;' +
    '  transition: left 0.32s cubic-bezier(0.2, 0.7, 0.3, 1), top 0.32s cubic-bezier(0.2, 0.7, 0.3, 1),' +
    '    width 0.32s cubic-bezier(0.2, 0.7, 0.3, 1), height 0.32s cubic-bezier(0.2, 0.7, 0.3, 1);' +
    '}' +
    '.cc-bridge-modal-iframe { width: 100%; height: 100%; border: 0; display: block; }' +
    '.cc-bridge-modal-close {' +
    '  position: absolute; top: 8px; right: 8px; z-index: 1;' +
    '  width: 32px; height: 32px; border-radius: 50%; border: none;' +
    '  background: #4c9be8; color: #ebebeb; font-size: 18px; line-height: 1;' +
    '  cursor: pointer;' +
    '}' +
    '.cc-bridge-modal-close:hover { background: #3d8cd9; }' +
    '.cc-bridge-art-popover {' +
    '  position: fixed; z-index: 1000000; width: 190px;' +
    '  background: #0f2537; border: 1px solid #20374c; border-radius: 2px;' +
    '  box-shadow: 0 6px 20px rgba(0,0,0,0.4); overflow: hidden;' +
    '  display: flex; flex-direction: column;' +
    '}' +
    '.cc-bridge-art-popover-opt {' +
    '  display: block; width: 100%; text-align: left;' +
    '  background: transparent; border: none; border-bottom: 1px solid #20374c;' +
    '  color: #ebebeb; font-size: 12px; padding: 9px 12px; cursor: pointer;' +
    '}' +
    '.cc-bridge-art-popover-opt:last-child { border-bottom: none; }' +
    '.cc-bridge-art-popover-opt:hover { background: #4c9be8; color: #1c0d07; }' +
    '.cc-bridge-queue-panel {' +
    '  position: fixed; z-index: 1000000; width: 260px; max-height: 320px; overflow-y: auto;' +
    '  background: #0f2537; border: 1px solid #20374c; border-radius: 2px;' +
    '  box-shadow: 0 6px 20px rgba(0,0,0,0.4);' +
    '}' +
    '.cc-bridge-queue-empty {' +
    '  padding: 14px 12px; font-size: 12px; color: #abb6c2; line-height: 1.5;' +
    '}' +
    '.cc-bridge-queue-row {' +
    '  display: flex; align-items: center; gap: 6px; padding: 9px 10px;' +
    '  border-bottom: 1px solid #20374c; font-size: 12px; color: #ebebeb;' +
    '}' +
    '.cc-bridge-queue-row:last-child { border-bottom: none; }' +
    '.cc-bridge-queue-row-clickable { cursor: pointer; }' +
    '.cc-bridge-queue-row-clickable:hover { background: #1c3348; }' +
    '.cc-bridge-queue-row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +
    '.cc-bridge-queue-row-status {' +
    '  font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;' +
    '  padding: 2px 6px; border-radius: 2px; flex: none;' +
    '}' +
    '.cc-bridge-queue-status-queued { color: #abb6c2; background: #20374c; }' +
    '.cc-bridge-queue-status-processing { color: #1c0d07; background: #4c9be8; }' +
    '.cc-bridge-queue-status-ready { color: #0f2537; background: #8fd6c0; }' +
    '.cc-bridge-queue-status-failed { color: #ebebeb; background: #b3432f; }' +
    '.cc-bridge-queue-row-remove {' +
    '  background: transparent; border: none; color: #6f6259; font-size: 14px;' +
    '  line-height: 1; padding: 0 2px; cursor: pointer; flex: none;' +
    '}' +
    '.cc-bridge-queue-row-remove:hover { color: #ebebeb; }';
  document.documentElement.appendChild(style);

  // ---- card data extraction ------------------------------------------

  function extractCardData(rootEl) {
    const name =
      rootEl.getAttribute('data-card-name') ||
      textOf(rootEl.querySelector('.mpccard-name')) ||
      attrOf(rootEl.querySelector('img.card-img'), 'alt');

    if (!name) return null;

    const data = { name: name };

    // data-card-set-code / data-card-collector-number: added in the site
    // commit , sourced from the card data model.its resolved card data — omitted
    // (not emitted empty) when a card's resolved printing isn't known.
    const setCode = rootEl.getAttribute('data-card-set-code');
    if (setCode) data.set_code = setCode;

    const collectorNumber = rootEl.getAttribute('data-card-collector-number');
    if (collectorNumber) data.collector_number = collectorNumber;

    // No frame_hint here: data-card-type turned out to mean "card" /
    // "cardback" / "token" (the MPC element category) once the real DOM API
    // shipped, not a Magic frame/layout hint — sending it through as
    // frame_hint would be actively misleading, and nothing downstream reads
    // frame_hint yet regardless.

    return data;
  }

  function textOf(el) {
    return el && el.textContent ? el.textContent.trim() : '';
  }

  function attrOf(el, attr) {
    return el ? el.getAttribute(attr) || '' : '';
  }

  // The card's own rendered image URL — read straight off the DOM (same
  // img.card-img element extractCardData already knows about). This is a
  // *full card* image (mpchost sites here are Google-Drive-sourced print
  // fronts, not raw Scryfall art), never the art alone — only correct as
  // an art-layer source for the full-art/borderless flow below, which
  // wants exactly that: the whole finished card image, upscaled and
  // placed to fill the larger full-art/borderless art window.
  function extractCardArtUrl(rootEl) {
    const img = rootEl.querySelector('img.card-img');
    return img && img.src ? img.src : null;
  }

  // ---- Scryfall lookup (see CLAUDE.md's narrow exception for this) ------
  //
  // The mpchost page has no Scryfall data at all (name/set/collector only
  // — confirmed by reading the site's own the card data model/its serialization code code,
  // which has no art_crop/full_art/border_color fields to give us). Card
  // Conjurer normally fetches this itself once it opens, from this exact
  // same public, unauthenticated, CORS-open endpoint — so this isn't a
  // new kind of access, just doing it a beat earlier and hand it to CC
  // directly (see pageWindow.importCard usage in the receiver) instead of
  // CC redundantly re-fetching the same data a moment later.
  function fetchScryfallCard(cardData, callback) {
    let url;
    if (cardData.set_code && cardData.collector_number) {
      url =
        'https://api.scryfall.com/cards/' +
        encodeURIComponent(cardData.set_code.toLowerCase()) +
        '/' +
        encodeURIComponent(cardData.collector_number);
    } else {
      url = 'https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(cardData.name);
    }
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('Scryfall lookup failed: ' + res.status);
        return res.json();
      })
      .then(function (json) {
        callback(json);
      })
      .catch(function () {
        callback(null);
      });
  }

  // A card's art_crop, handling both normal cards (image_uris directly on
  // the card) and modal/transform/split cards (image_uris nested under
  // the front face) — Scryfall omits the top-level image_uris entirely
  // for those layouts.
  function getArtCropUrl(scryfallCard) {
    if (!scryfallCard) return null;
    if (scryfallCard.image_uris && scryfallCard.image_uris.art_crop) {
      return scryfallCard.image_uris.art_crop;
    }
    const face = scryfallCard.card_faces && scryfallCard.card_faces[0];
    return (face && face.image_uris && face.image_uris.art_crop) || null;
  }

  function isFullArtOrBorderless(scryfallCard) {
    return !!(scryfallCard && (scryfallCard.full_art || scryfallCard.border_color === 'borderless'));
  }

  // The full Enlarger tool, embedded directly — no separate hosting at
  // all. Runs entirely headless: no visible UI, so no fonts/CSS either
  // (nothing to ever render on screen). Turned into a blob: URL at
  // hand-off time (see upscaleViaEnlarger) rather than a data: URL —
  // confirmed directly against a real page: a blob: iframe's own
  // location.origin, and the origin the parent sees on messages back
  // from it, both correctly report the *creating* page's real origin,
  // not "null"/opaque the way a data: URL's would — so the existing
  // exact-origin postMessage validation this project uses everywhere
  // else still applies cleanly here, with no separate origin to
  // configure at all.
  const ENLARGER_HTML = `<title>Enlarger (background)</title>
<script>
(function () {
  'use strict';

  // onnxruntime-web's own internal WASM-backend init tries several CDN
  // fallback paths and can leave a stray rejected promise behind even
  // when the failure it caused was already caught and handled correctly
  // (confirmed in the interactive build this was stripped down from) —
  // only about not letting a third-party library's internals surface as
  // a raw uncaught error in this tab.
  window.addEventListener('unhandledrejection', function (event) {
    console.warn('Enlarger: suppressed an unhandled promise rejection (likely onnxruntime-web internals):', event.reason);
    event.preventDefault();
  });

  // No visible UI at all — this only ever runs embedded as a hidden
  // iframe cc-bridge creates from an inline blob: URL (see
  // upscaleViaEnlarger in cc-bridge.user.js), so window.parent is always
  // the real receiver and location.origin always matches it (blob: URLs
  // inherit the creating document's origin for both, confirmed directly:
  // a blob: iframe's location.origin and the postMessage event.origin the
  // parent sees both report the parent's own real origin, not "null" or
  // anything blob-specific).
  window.addEventListener('message', function (event) {
    const data = event.data;
    if (!data || data.type !== 'enlarger-load') return;
    const cardData = data.cardData || null;
    const scaleFactor = typeof data.scale === 'number' && data.scale > 0 ? data.scale : 2;
    const source = data.url || data.dataUrl;
    if (!source) return;

    loadImage(source, !!data.url)
      .then(function (img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);

        if (data.modelUrl) {
          return runCustomModel(canvas, data, scaleFactor).catch(function (err) {
            // Any failure in the custom-model path (bad shape, CORS,
            // network, wrong tensor layout, a blob: model URL the iframe
            // couldn't fetch) falls back to the built-in resampler rather
            // than producing nothing -- but do it loudly, since this is
            // now the default path for every install and a silent
            // degrade-to-Lanczos looks identical to a successful upscale
            // from the output alone.
            console.warn('Enlarger: model-based upscale failed, falling back to classical resize:', err);
            return runBuiltin(canvas, scaleFactor);
          });
        }
        return runBuiltin(canvas, scaleFactor);
      })
      .then(function (resultCanvas) {
        resultCanvas.toBlob(function (blob) {
          window.parent.postMessage({ type: 'enlarger-result', blob: blob, cardData: cardData }, location.origin);
        }, 'image/png');
      })
      .catch(function (err) {
        window.parent.postMessage(
          { type: 'enlarger-result', blob: null, cardData: cardData, error: err.message },
          location.origin
        );
      });
  });

  function loadImage(src, useCors) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      // Scryfall's image CDN serves permissive CORS; crossOrigin lets us
      // actually read pixels back out of the canvas afterward instead of
      // hitting a tainted-canvas security error. Not set for data: URLs
      // (the "upload your own image" path), which don't need it.
      if (useCors) img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('failed to load source image')); };
      img.src = src;
    });
  }

  function runBuiltin(canvas, scaleFactor) {
    const targetW = Math.round(canvas.width * scaleFactor);
    const targetH = Math.round(canvas.height * scaleFactor);
    // Fixed, sensible sharpen amount — no UI to expose a slider for it in
    // background/headless use.
    return Promise.resolve(upscaleImage(canvas, targetW, targetH, 18));
  }

  function runCustomModel(canvas, data, scaleFactor) {
    const tileSize = data.tileSize || 128;
    const overlap = data.tileOverlap || 8;
    const channelOrder = data.channelOrder || 'rgb';
    const nativeScale = data.modelScale || 4;
    let onnxSession = null;

    return ensureOrtLoaded()
      .then(function () { return window.ort.InferenceSession.create(data.modelUrl); })
      .then(function (session) {
        onnxSession = session;
        return runTiledInference(canvas, onnxSession, tileSize, overlap, channelOrder, nativeScale);
      })
      .then(function (result) {
        if (nativeScale !== scaleFactor) {
          const targetW = Math.round(canvas.width * scaleFactor);
          const targetH = Math.round(canvas.height * scaleFactor);
          return upscaleImage(result, targetW, targetH, 0);
        }
        return result;
      });
  }

  // ---------------------------------------------------------------------
  // Classical fallback: separable Lanczos-3 resample + light unsharp mask.
  // Deterministic signal processing, not a trained super-resolution model
  // — it sharpens what's already in the source, it doesn't invent detail
  // the way the bundled Ultramix model (via runCustomModel below) can.
  // Runs when there's no resolved model URL at all — the user disabled
  // the bundled default and hasn't set a custom one, or the model
  // resource/URL failed to load. See runCustomModel for the model path.
  // ---------------------------------------------------------------------
  function lanczosKernel(x, a) {
    if (x === 0) return 1;
    if (x <= -a || x >= a) return 0;
    const px = Math.PI * x;
    return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
  }

  function resampleAxis(srcData, srcW, srcH, dstW, dstH, horizontal, a) {
    const scale = horizontal ? dstW / srcW : dstH / srcH;
    const filterScale = Math.max(1, 1 / scale);
    const support = a * filterScale;
    const dstLen = horizontal ? dstW : dstH;
    const out = new Float32Array((horizontal ? dstW * srcH : srcW * dstH) * 4);
    const outW = horizontal ? dstW : srcW;

    for (let d = 0; d < dstLen; d++) {
      const center = (d + 0.5) / scale;
      const left = Math.floor(center - support);
      const right = Math.ceil(center + support);
      const weights = [];
      let wsum = 0;
      for (let s = left; s <= right; s++) {
        const w = lanczosKernel((s + 0.5 - center) / filterScale, a);
        weights.push(w);
        wsum += w;
      }
      if (wsum === 0) wsum = 1;

      const otherLen = horizontal ? srcH : srcW;
      for (let o = 0; o < otherLen; o++) {
        let r = 0, g = 0, b = 0, al = 0;
        for (let i = 0; i < weights.length; i++) {
          let s = left + i;
          s = Math.max(0, Math.min((horizontal ? srcW : srcH) - 1, s));
          const idx = horizontal ? (o * srcW + s) * 4 : (s * srcW + o) * 4;
          const w = weights[i] / wsum;
          r += srcData[idx] * w; g += srcData[idx + 1] * w; b += srcData[idx + 2] * w; al += srcData[idx + 3] * w;
        }
        const outIdx = horizontal ? (o * outW + d) * 4 : (d * outW + o) * 4;
        out[outIdx] = r; out[outIdx + 1] = g; out[outIdx + 2] = b; out[outIdx + 3] = al;
      }
    }
    return out;
  }

  function unsharpMask(data, w, h, amountPct) {
    if (amountPct <= 0) return data;
    const amount = amountPct / 100;
    const out = new Float32Array(data.length);
    const kernel = [0.077847, 0.123317, 0.077847, 0.123317, 0.195346, 0.123317, 0.077847, 0.123317, 0.077847];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = Math.max(0, Math.min(w - 1, x + dx));
            const sy = Math.max(0, Math.min(h - 1, y + dy));
            const idx = (sy * w + sx) * 4;
            const wgt = kernel[k++];
            r += data[idx] * wgt; g += data[idx + 1] * wgt; b += data[idx + 2] * wgt;
          }
        }
        const idx = (y * w + x) * 4;
        out[idx] = data[idx] + (data[idx] - r) * amount;
        out[idx + 1] = data[idx + 1] + (data[idx + 1] - g) * amount;
        out[idx + 2] = data[idx + 2] + (data[idx + 2] - b) * amount;
        out[idx + 3] = data[idx + 3];
      }
    }
    return out;
  }

  function upscaleImage(canvas, targetW, targetH, sharpenPct) {
    const ctx = canvas.getContext('2d');
    const srcData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const a = 3;
    const pass1 = resampleAxis(srcData, canvas.width, canvas.height, targetW, canvas.height, true, a);
    const pass2 = resampleAxis(pass1, targetW, canvas.height, targetW, targetH, false, a);
    const sharpened = unsharpMask(pass2, targetW, targetH, sharpenPct);

    const out = document.createElement('canvas');
    out.width = targetW; out.height = targetH;
    const outCtx = out.getContext('2d');
    const imgData = outCtx.createImageData(targetW, targetH);
    for (let i = 0; i < sharpened.length; i++) {
      imgData.data[i] = Math.max(0, Math.min(255, sharpened[i]));
    }
    outCtx.putImageData(imgData, 0, 0);
    return out;
  }

  // ---------------------------------------------------------------------
  // ONNX model path — bundled Ultramix by default, or the user's own
  // configured model (see resolveUpscaleModelUrl in cc-bridge.user.js).
  // Loaded lazily, only when the handoff message actually includes a
  // modelUrl. onnxruntime-web is fetched from a CDN, which needs real
  // network access from wherever this ends up running (fine once embedded
  // in a real userscript on a real page; the one thing that never worked
  // was Claude's own sandboxed Artifact preview, which blocks all external
  // requests by design).
  //
  // Tensor-shape assumptions below match Ultramix (Kim2091's
  // ESRGAN/RRDBNet-family upscaler, CC-BY-NC-SA-4.0/non-commercial) as
  // exported to ONNX: NCHW, float32, 0..1 normalized, RGB channel order,
  // native 4x scale — the same layout standard ESRGAN-family exports use
  // generally. Overridable via the handoff message's tileSize/
  // tileOverlap/channelOrder/modelScale fields since not every export
  // matches exactly.
  // ---------------------------------------------------------------------
  const ORT_CDN_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js';

  function ensureOrtLoaded() {
    if (window.ort) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = ORT_CDN_URL;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('could not load onnxruntime-web')); };
      document.head.appendChild(script);
    });
  }

  // Splits the source into overlapping tiles, runs each through the ONNX
  // session, and stitches the (nativeScale×-larger) results back into one
  // canvas — feeding a whole multi-megapixel card image into a model in
  // one shot is both slow and often exceeds what the model's graph
  // actually supports.
  async function runTiledInference(canvas, onnxSession, tileSize, overlap, channelOrder, nativeScale) {
    const srcCtx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const outCanvas = document.createElement('canvas');
    outCanvas.width = W * nativeScale;
    outCanvas.height = H * nativeScale;
    const outCtx = outCanvas.getContext('2d');

    const stepX = tileSize - overlap * 2;
    const stepY = tileSize - overlap * 2;
    const tilesX = Math.max(1, Math.ceil(W / stepX));
    const tilesY = Math.max(1, Math.ceil(H / stepY));

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const sx = Math.max(0, Math.min(W - tileSize, tx * stepX - overlap));
        const sy = Math.max(0, Math.min(H - tileSize, ty * stepY - overlap));
        const tw = Math.min(tileSize, W - sx);
        const th = Math.min(tileSize, H - sy);

        const tileData = srcCtx.getImageData(sx, sy, tw, th);
        const inputTensor = imageDataToTensor(tileData, channelOrder);
        const feeds = {};
        feeds[onnxSession.inputNames[0]] = inputTensor;
        const results = await onnxSession.run(feeds);
        const outputTensor = results[onnxSession.outputNames[0]];
        const outTile = tensorToImageData(outputTensor, channelOrder);

        const destX = sx * nativeScale;
        const destY = sy * nativeScale;
        const tmp = document.createElement('canvas');
        tmp.width = outTile.width; tmp.height = outTile.height;
        tmp.getContext('2d').putImageData(outTile, 0, 0);
        outCtx.drawImage(tmp, destX, destY);

        await new Promise(function (r) { setTimeout(r, 0); }); // yield between tiles
      }
    }
    return outCanvas;
  }

  function imageDataToTensor(imageData, channelOrder) {
    const data = imageData.data, width = imageData.width, height = imageData.height;
    const chw = new Float32Array(3 * width * height);
    const plane = width * height;
    for (let i = 0; i < plane; i++) {
      const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
      if (channelOrder === 'bgr') {
        chw[i] = b; chw[plane + i] = g; chw[plane * 2 + i] = r;
      } else {
        chw[i] = r; chw[plane + i] = g; chw[plane * 2 + i] = b;
      }
    }
    return new window.ort.Tensor('float32', chw, [1, 3, height, width]);
  }

  function tensorToImageData(tensor, channelOrder) {
    const dims = tensor.dims;
    const h = dims[2], w = dims[3];
    const plane = w * h;
    const src = tensor.data;
    const out = new ImageData(w, h);
    for (let i = 0; i < plane; i++) {
      let r = src[i], g = src[plane + i], b = src[plane * 2 + i];
      if (channelOrder === 'bgr') { const t = r; r = b; b = t; }
      out.data[i * 4] = Math.max(0, Math.min(255, r * 255));
      out.data[i * 4 + 1] = Math.max(0, Math.min(255, g * 255));
      out.data[i * 4 + 2] = Math.max(0, Math.min(255, b * 255));
      out.data[i * 4 + 3] = 255;
    }
    return out;
  }
})();
</script>
`;

  // ---- Enlarger hand-off (upscale pass before Card Conjurer even opens) -
  //
  // Both art-source choices ("use Scryfall art" / "upload my own image")
  // route through here first — the upscaled result becomes the
  // customArtBlob in openEditorModal's initial payload, applied inside
  // Card Conjurer after its own Scryfall auto-art-fetch settles (see
  // doFillCardConjurerImport). If no Enlarger URL is configured, or
  // anything about the hand-off fails, this calls back with null and the
  // caller proceeds without an upscale pass — never a hard blocker to
  // getting the card into Card Conjurer at all.
  function upscaleViaEnlarger(source, callback) {
    // location.origin — not a configured URL's origin — since a blob:
    // iframe's own location.origin, and the origin the parent sees on its
    // postMessage replies, both inherit this page's real origin (verified
    // directly, see the ENLARGER_HTML comment above).
    const enlargerOrigin = location.origin;

    function sendHandoff(dataUrlOrUrl, isDataUrl) {
      const blobUrl = URL.createObjectURL(new Blob([ENLARGER_HTML], { type: 'text/html' }));
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      let done = false;
      let timeoutId = null;

      function cleanup() {
        window.removeEventListener('message', onMessage);
        if (timeoutId) clearTimeout(timeoutId);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        URL.revokeObjectURL(blobUrl);
      }

      function onMessage(event) {
        if (event.origin !== enlargerOrigin || event.source !== iframe.contentWindow) return;
        const data = event.data;
        if (!data || data.type !== 'enlarger-result') return;
        done = true;
        cleanup();
        callback(data.blob || null);
      }
      window.addEventListener('message', onMessage);

      iframe.addEventListener('load', function () {
        const payload = { type: 'enlarger-load', scale: 2 };
        if (isDataUrl) payload.dataUrl = dataUrlOrUrl;
        else payload.url = dataUrlOrUrl;
        // Bundled Ultramix by default, the user's own configured model if
        // they've set one, or omitted entirely (classical-resize fallback)
        // — see resolveUpscaleModelUrl. This was previously never wired
        // through at all, so runCustomModel's ONNX path was unreachable
        // regardless of configuration.
        const modelUrl = resolveUpscaleModelUrl();
        if (modelUrl) payload.modelUrl = modelUrl;
        iframe.contentWindow.postMessage(payload, enlargerOrigin);
      });

      // Never let a slow/broken upscale pass block getting the card into
      // Card Conjurer at all — fall through to no-upscale instead.
      timeoutId = setTimeout(function () {
        if (done) return;
        cleanup();
        callback(null);
      }, 20000);

      iframe.src = blobUrl;
      document.body.appendChild(iframe);
    }

    if (source.file) {
      const reader = new FileReader();
      reader.onload = function () { sendHandoff(reader.result, true); };
      reader.onerror = function () { callback(null); };
      reader.readAsDataURL(source.file);
    } else if (source.url) {
      sendHandoff(source.url, false);
    } else {
      callback(null);
    }
  }

  // mpc:card-selected is real now (earlier commits),
  // firing with a camelCase detail: {name, identifier, sourceKey, dpi,
  // cardType, setCode, collectorNumber}. Mapped explicitly below — not a
  // blind Object.assign — since the event's camelCase keys don't match the
  // payload's snake_case ones.
  //
  // Dispatched only from the project-editor grid's card component (the project-editor grid) — never
  // from the main card component, the card-details view, or the site's printing-tag
  // candidates. lastCardSelectedTarget (the event's own .target, which
  // custom events keep stable through bubbling regardless of listener
  // location) is tracked alongside the detail so handleConjureTrigger can
  // confirm it actually came from the card being conjured, not just "was
  // the most recent selection somewhere on the page" — without that check,
  // clicking conjure on a printing-tag candidate would silently overwrite
  // its correct, freshly-read data-card-set-code/data-card-collector-number
  // with whatever card was last selected in the project editor, since that
  // feature never fires this event at all and the stale detail would
  // otherwise look just as valid as a real one.
  let lastCardSelectedDetail = null;
  let lastCardSelectedTarget = null;
  document.addEventListener('mpc:card-selected', function (event) {
    lastCardSelectedDetail = event && event.detail ? event.detail : null;
    lastCardSelectedTarget = event ? event.target : null;
  });

  function mergeCardSelectedDetail(cardData, detail) {
    const merged = Object.assign({}, cardData);
    if (detail.name) merged.name = detail.name;
    if (detail.setCode) merged.set_code = detail.setCode;
    if (detail.collectorNumber) merged.collector_number = detail.collectorNumber;
    return merged;
  }

  // ---- button injection ----------------------------------------------

  // Moves an already-injected button from its current anchor onto the
  // art's own box (img.card-img's parent), if it isn't there already.
  // Needed because injectButtonIfNeeded can run before the art has
  // rendered (MPC Autofill's card images are `loading="lazy"`), in which
  // case it falls back to rootEl — this is what upgrades that button once
  // the art actually shows up on a later rescan, instead of leaving it
  // stuck on rootEl forever (rootEl only ever gets scanned once, gated by
  // INJECTED_MARKER_ATTR).
  function upgradeButtonAnchor(rootEl) {
    const artImg = rootEl.querySelector('img.card-img');
    if (!artImg || !artImg.parentElement) return;
    const anchorEl = artImg.parentElement;
    if (anchorEl.classList.contains(BUTTON_ANCHOR_CLASS)) return; // already there

    // The button is a direct child of whichever element it's currently
    // anchored to (rootEl, in the not-yet-upgraded case) — find it there.
    const btn = rootEl.querySelector(':scope > .' + BUTTON_CLASS);
    if (!btn) return;

    if (getComputedStyle(anchorEl).position === 'static') {
      anchorEl.style.position = 'relative';
    }
    anchorEl.classList.add(BUTTON_ANCHOR_CLASS);
    anchorEl.appendChild(btn);
  }

  // A literal <button> can't validly nest inside another <button> or an
  // <a> — some card contexts (e.g. the site's printing-tag candidates,
  // where data-card-* attributes are spread directly onto a react-bootstrap
  // <Button>) match CARD_ROOT_SELECTOR on exactly such an element. Nesting
  // a real <button> there is invalid HTML; browsers silently reparent it
  // elsewhere in the DOM to fix that, completely decoupling its position
  // from the card (it stops moving/scaling with it — e.g. on hover-zoom).
  // A <span role="button"> is not "interactive content" per the HTML spec,
  // so it nests validly — same class (all existing CSS/positioning still
  // applies) and still caught by the delegated click handler below, which
  // matches by class, not tag; only needs keyboard activation added by
  // hand, since a real <button> gets that for free.
  // Returns the element to append to anchorEl: either the trigger itself,
  // or (when it needs the tether-wrapper treatment) a wrapper containing
  // it. artImg is the actual art <img> anchorEl was built around, if any
  // (see injectButtonIfNeeded) — undefined when anchorEl fell back to
  // rootEl because no art was found.
  function createConjureTrigger(anchorEl, artImg) {
    const mustAvoidNesting = !!anchorEl.closest('button, a');
    const btn = document.createElement(mustAvoidNesting ? 'span' : 'button');
    if (mustAvoidNesting) {
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      btn.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          btn.click();
        }
      });
      // A click here would otherwise bubble into the real <button>/<a>
      // we're nested inside — e.g. the site's printing-tag candidate
      // buttons, whose own onClick submits a vote — and fire that too.
      // Handled directly (not via the document-level delegated listener
      // further down, which only sees this after it's already bubbled
      // past that ancestor) so stopPropagation actually lands in time.
      // handleConjureTrigger is a function declaration defined later in
      // this same scope — hoisted, so it's already callable here.
      btn.addEventListener('click', function (event) {
        event.stopPropagation();
        event.preventDefault();
        handleConjureTrigger(btn);
      });
    } else {
      btn.type = 'button';
    }
    btn.className = BUTTON_CLASS;
    btn.textContent = '+ conjure';

    if (!mustAvoidNesting || !artImg) return btn;

    anchorEl.classList.add(BUTTON_ANCHOR_ZOOM_CLASS);
    const wrapper = document.createElement('span');
    wrapper.className = BUTTON_TETHER_CLASS;
    wrapper.appendChild(btn);
    return wrapper;
  }

  function injectButtonIfNeeded(rootEl) {
    if (rootEl.hasAttribute(INJECTED_MARKER_ATTR)) {
      upgradeButtonAnchor(rootEl);
      return;
    }
    if (!extractCardData(rootEl)) return;

    // Anchor to the art's own box (the art <img>'s parent), not rootEl —
    // rootEl is whatever CARD_ROOT_SELECTOR matched, which on a grid tile
    // is the *whole* tile (header + art + name footer), on MPC Autofill's
    // card-details modal is the entire viewport-covering modal, and on
    // the site's printing-tag candidates is the candidate's own vote
    // <button>. The art's box (`.ratio-7x5` in the upstream/fork source,
    // or the hover-zoom wrapper for printing-tag candidates) is sized to the
    // art's own real proportions, so it — not the raw <img>, which e.g. on
    // the normal grid/details view is deliberately scaled ~9% past it to
    // preview bleed and then clipped — is exactly the art's visible
    // boundary. `img.card-img` covers the grid/details case; the plain
    // `img` fallback covers cases with no class hook, like the printing-tag
    // candidates. Falls back to rootEl if no art is found at all (e.g. it
    // hasn't rendered yet, `loading="lazy"`, or there genuinely isn't one —
    // the site's "No match" candidate button); see upgradeButtonAnchor
    // above for how the lazy-load case gets corrected once art appears.
    const artImg = rootEl.querySelector('img.card-img') || rootEl.querySelector('img');
    const anchorEl = (artImg && artImg.parentElement) || rootEl;

    const computedPosition = getComputedStyle(anchorEl).position;
    if (computedPosition === 'static') {
      anchorEl.style.position = 'relative';
    }
    anchorEl.classList.add(BUTTON_ANCHOR_CLASS);

    const trigger = createConjureTrigger(anchorEl, artImg);
    anchorEl.appendChild(trigger);
    rootEl.setAttribute(INJECTED_MARKER_ATTR, '1');
  }

  function scanForCards() {
    const roots = document.querySelectorAll(CARD_ROOT_SELECTOR);
    for (let i = 0; i < roots.length; i++) {
      injectButtonIfNeeded(roots[i]);
    }
    // Cheap no-op once already present (guarded at the top of the
    // function) — piggybacks on the same rescan trigger as card scanning
    // so it retries opportunistically until the nav actually exists,
    // without a separate observer.
    injectQueueNavTab();
  }

  // ---- Google Drive export (upload half, runs on this host page) --------
  //
  // The Card Conjurer iframe hands us a finished export via postMessage
  // (sendCardToDriveViaParent, in the receiver section above) instead of
  // uploading itself — see that section's comment for why. Opt-in only:
  // nothing here runs, and no script from accounts.google.com or
  // googleapis.com is loaded, until the export message actually arrives
  // (which itself only happens because the user clicked "Export to Drive"
  // inside the CC panel). See CLAUDE.md's network-calls boundary — this is
  // the exact exception carved out for it. Uses Google Identity Services'
  // token client (a popup-based flow returning an access token directly to
  // this page's JS), not a server-side redirect flow — there's no backend
  // here to receive one. The access token lives only in `driveAccessToken`
  // below (memory only, cleared on page reload) — never written to
  // GM_setValue/localStorage, since it's a live credential, not
  // configuration.

  let driveAccessToken = null;
  let driveTokenClient = null;

  function ensureGisLoaded(callback) {
    if (pageWindow.google && pageWindow.google.accounts && pageWindow.google.accounts.oauth2) {
      callback();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = callback;
    script.onerror = function () {
      showDriveToast('Failed to load Google Sign-In — check your connection.', true);
    };
    document.head.appendChild(script);
  }

  function connectGoogleDrive(onConnected) {
    const clientId = getDriveClientId();
    if (!clientId) {
      alert(
        'cc-bridge: set a Google Drive Client ID first — Tampermonkey menu → ' +
          '"Configure Google Drive Client ID (for Drive export)".'
      );
      return;
    }
    // One-time nudge toward running your own Client ID instead of relying
    // on the shared default — not shown again once seen, so it informs
    // without nagging every connect.
    if (isUsingDefaultDriveClientId() && !GM_getValue('seenDriveDefaultNotice', false)) {
      GM_setValue('seenDriveDefaultNotice', true);
      alert(
        'cc-bridge: this is using the built-in shared Google Drive connection — works with zero setup, ' +
          'but shares a Google Cloud quota/billing pool across everyone using it, and could stop working ' +
          'if that shared project ever changes. For your own independent, private connection instead, ' +
          'set one up via the Tampermonkey menu → "Configure Google Drive Client ID (for Drive export)" ' +
          '— a few minutes in Google Cloud Console. This notice won\'t show again.'
      );
    }
    showDriveToast(
      'Connecting to Google Drive' + (isUsingDefaultDriveClientId() ? ' (shared default)' : '') + '…'
    );
    ensureGisLoaded(function () {
      if (!driveTokenClient) {
        driveTokenClient = pageWindow.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.file',
          callback: function (response) {
            if (response && response.access_token) {
              driveAccessToken = response.access_token;
              showDriveToast('Connected to Google Drive.');
              if (onConnected) onConnected();
            } else {
              showDriveToast('Google Drive connection failed or was cancelled.', true);
            }
          },
          error_callback: function (error) {
            const message = error && error.message ? error.message : String(error);
            showDriveToast('Google Drive connection failed — ' + message, true);
          },
        });
      }
      driveTokenClient.requestAccessToken();
    });
  }

  function uploadBlobToGoogleDrive(cardData, blob, onDone) {
    showDriveToast('Uploading to Google Drive…');
    const metadata = {
      name: buildExportFilename(cardData || {}),
      // Drive's own structured tagging (queryable via the Drive API's
      // `properties has {...}` search, not just a filename convention) —
      // the "correctly tagged with set code and things from import" part.
      properties: {
        cc_bridge_card_name: (cardData && cardData.name) || '',
        cc_bridge_set_code: (cardData && cardData.set_code) || '',
        cc_bridge_collector_number: (cardData && cardData.collector_number) || '',
      },
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    // &fields=id trims Google's response to just the file id instead of
    // the full file resource — small, free saving, matching the same call
    // in the site's uploadFile (its own Drive upload code).
    fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + driveAccessToken },
      body: form,
    })
      .then(function (res) {
        if (res.status === 401) {
          // Token expired/revoked — clear it so the next attempt
          // reconnects rather than repeatedly failing silently.
          driveAccessToken = null;
          throw new Error('Google Drive session expired — try exporting again.');
        }
        if (!res.ok) throw new Error('upload failed (HTTP ' + res.status + ')');
        return res.json();
      })
      .then(function () {
        showDriveToast('Uploaded to Google Drive.');
        onDone(true);
      })
      .catch(function (e) {
        showDriveToast('Google Drive upload failed — ' + e.message, true);
        onDone(false, e.message);
      });
  }

  function handleDriveExportMessage(event) {
    // Only ever accept this from the Card Conjurer origin we ourselves
    // configured and framed — not "*", matching the same validation
    // discipline as every other postMessage boundary in this file.
    if (event.origin !== getCCOrigin()) return;
    const data = event.data;
    if (!data || data.type !== 'cc-bridge-drive-export' || !data.blob) return;

    function reply(ok, message) {
      if (event.source) {
        event.source.postMessage({ type: 'cc-bridge-drive-export-result', ok: ok, message: message }, event.origin);
      }
    }

    function doUpload() {
      uploadBlobToGoogleDrive(data.cardData, data.blob, reply);
    }

    if (!driveAccessToken) {
      connectGoogleDrive(doUpload);
    } else {
      doUpload();
    }
  }

  window.addEventListener('message', handleDriveExportMessage);

  // Reimport-mid-session requests from inside an already-open Card
  // Conjurer panel (see sendReimportRequest/showReimportPopover in the
  // receiver section) — runs the same upscale pass as the initial
  // art-source choice, just triggered later instead of before Card
  // Conjurer opens.
  function handleReimportRequestMessage(event) {
    if (event.origin !== getCCOrigin()) return;
    const data = event.data;
    if (!data || data.type !== 'cc-bridge-reimport-request') return;
    if (!data.artUrl && !data.file) return;

    function reply(blob) {
      if (event.source) {
        event.source.postMessage({ type: 'cc-bridge-reimport-result', blob: blob || null }, event.origin);
      }
    }

    upscaleViaEnlarger(data.artUrl ? { url: data.artUrl } : { file: data.file }, function (blob) {
      // Same fall-back-to-raw-upload discipline as the initial art-source
      // choice — the user's explicit reimport request shouldn't be
      // dropped just because the upscale pass itself failed.
      reply(blob || data.file || null);
    });
  }
  window.addEventListener('message', handleReimportRequestMessage);

  function showDriveToast(message, isError) {
    let toast = document.querySelector('.cc-bridge-drive-toast');
    if (!toast) {
      const style = document.createElement('style');
      style.textContent =
        '.cc-bridge-drive-toast {' +
        '  position: fixed; bottom: 16px; right: 16px; z-index: 999999;' +
        '  font-size: 13px; padding: 10px 14px; border-radius: 2px; color: #ebebeb;' +
        '  max-width: 320px; box-shadow: 0 4px 16px rgba(0,0,0,0.4);' +
        '}';
      document.documentElement.appendChild(style);
      toast = document.createElement('div');
      toast.className = 'cc-bridge-drive-toast';
      document.body.appendChild(toast);
    }
    toast.style.background = isError ? '#b3432f' : '#4c9be8';
    toast.style.display = 'block';
    toast.textContent = message;
    clearTimeout(toast._hideTimer);
    if (!isError) {
      toast._hideTimer = setTimeout(function () {
        toast.style.display = 'none';
      }, 4000);
    }
  }

  // ---- click handling / postMessage -----------------------------------

  // Shared by the delegated document-level listener below (the normal
  // path) and by createConjureTrigger's own direct listener (the
  // nested-inside-another-button path, which needs to intercept the click
  // before it bubbles into that button's own handler — see there).
  function handleConjureTrigger(btn) {
    const rootEl = btn.closest(CARD_ROOT_SELECTOR);
    if (!rootEl) return;

    let cardData = extractCardData(rootEl);
    if (!cardData) return;

    // Only trust lastCardSelectedDetail if it was actually dispatched from
    // *this* card (see the declaration above) — otherwise it's some other
    // card's stale selection and would silently override rootEl's own
    // correct data-card-set-code/data-card-collector-number.
    if (
      lastCardSelectedDetail &&
      lastCardSelectedDetail.name &&
      lastCardSelectedTarget &&
      rootEl.contains(lastCardSelectedTarget)
    ) {
      cardData = mergeCardSelectedDetail(cardData, lastCardSelectedDetail);
    }

    showArtSourcePopover(btn, cardData, rootEl, rootEl.getBoundingClientRect());
  }

  document.body.addEventListener('click', function (event) {
    const btn = event.target.closest ? event.target.closest('.' + BUTTON_CLASS) : null;
    if (!btn) return;
    handleConjureTrigger(btn);
  });

  // ---- background upscale queue ------------------------------------------
  //
  // In-memory, not GM_setValue — GM storage is JSON-only and can't hold a
  // Blob (the actual upscaled result), and the scope this is built for
  // (host page stays open while working through a batch of cards) doesn't
  // need survival across a full reload/tab close, only across multiple
  // "+ conjure" clicks within the same page session, which a plain array
  // handles fine.
  let upscaleQueue = [];
  let queueListeners = [];

  function addQueueJob(cardData, originRect) {
    const job = {
      id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      cardName: cardData.name,
      status: 'queued', // 'queued' | 'processing' | 'ready' | 'failed'
      cardData: cardData,
      originRect: originRect,
      resultBlob: null,
      createdAt: Date.now(),
    };
    upscaleQueue.push(job);
    notifyQueueChanged();
    return job;
  }

  function updateQueueJob(id, patch) {
    const job = upscaleQueue.find(function (j) { return j.id === id; });
    if (!job) return null;
    Object.assign(job, patch);
    notifyQueueChanged();
    return job;
  }

  function removeQueueJob(id) {
    const idx = upscaleQueue.findIndex(function (j) { return j.id === id; });
    if (idx !== -1) upscaleQueue.splice(idx, 1);
    notifyQueueChanged();
  }

  function notifyQueueChanged() {
    queueListeners.forEach(function (fn) {
      fn(upscaleQueue);
    });
  }

  // Marks a job ready (resultBlobOrFile may be null — the upscale pass
  // didn't come through, or there was nothing to upscale — Card Conjurer
  // still opens fine either way, just without a custom art override) and
  // raises the toast notification. The job itself stays in the queue list
  // regardless of whether the toast gets dismissed or times out, so
  // "summon it themselves" from the queue tab always works even if they
  // miss the toast.
  function finishQueueJob(job, resultBlobOrFile) {
    updateQueueJob(job.id, { status: 'ready', resultBlob: resultBlobOrFile || null });
    showQueueReadyToast(job);
  }

  function showQueueReadyToast(job) {
    let container = document.querySelector('.cc-bridge-toast-stack');
    if (!container) {
      const style = document.createElement('style');
      style.textContent =
        '.cc-bridge-toast-stack {' +
        '  position: fixed; bottom: 16px; right: 16px; z-index: 999999;' +
        '  display: flex; flex-direction: column-reverse; gap: 8px; align-items: flex-end;' +
        '}' +
        '.cc-bridge-ready-toast {' +
        '  font-size: 13px; padding: 10px 14px; border-radius: 2px; cursor: pointer;' +
        '  color: #ebebeb; background: #4c9be8; max-width: 280px;' +
        '  box-shadow: 0 4px 16px rgba(0,0,0,0.4); border: none; text-align: left;' +
        '  font-family: inherit;' +
        '}' +
        '.cc-bridge-ready-toast:hover { background: #3d8cd9; }' +
        '.cc-bridge-ready-toast .cc-bridge-toast-sub { display: block; font-size: 11px; opacity: 0.85; margin-top: 2px; }';
      document.documentElement.appendChild(style);
      container = document.createElement('div');
      container.className = 'cc-bridge-toast-stack';
      document.body.appendChild(container);
    }

    const toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'cc-bridge-ready-toast';

    const strong = document.createElement('strong');
    strong.textContent = job.cardName;
    toast.appendChild(strong);
    toast.appendChild(document.createTextNode(' is ready for Card Conjurer.'));

    const sub = document.createElement('span');
    sub.className = 'cc-bridge-toast-sub';
    sub.textContent = 'Click to open';
    toast.appendChild(sub);

    toast.addEventListener('click', function () {
      toast.remove();
      openEditorModal(job.cardData, job.originRect, job.resultBlob);
    });
    container.appendChild(toast);

    // Auto-dismiss the toast itself after a while so they don't pile up —
    // the job stays in the queue tab (#2) regardless, so nothing is lost
    // by missing it, just the quick-click shortcut.
    setTimeout(function () {
      if (toast.parentNode) toast.remove();
    }, 12000);
  }

  // ---- art source choice (Scryfall vs. the user's own upload) -----------
  //
  // Card Conjurer's own import already fetches Scryfall's art
  // automatically as part of loading the card by name — this doesn't skip
  // that (it still drives frame selection, text fields, mana cost, etc.
  // off the real Scryfall record), it just re-uploads over the art layer
  // afterward when the user asked for their own image. Same mechanism
  // Card Conjurer's own paste-art feature uses (confirmed by reading
  // creator-23.js's pasteArt(): URL.createObjectURL(blob) -> uploadArt(url,
  // 'autoFit')) — a blob: URL works as an <img> src exactly like a remote
  // one.
  let openArtSourcePopover = null; // Tracks the currently-open one so a second click replaces rather than stacks.

  function closeArtSourcePopover() {
    if (openArtSourcePopover && openArtSourcePopover.parentNode) {
      openArtSourcePopover.parentNode.removeChild(openArtSourcePopover);
    }
    openArtSourcePopover = null;
    document.removeEventListener('click', onOutsideClick, true);
    document.removeEventListener('keydown', onPopoverKeydown);
  }

  function onOutsideClick(event) {
    if (openArtSourcePopover && !openArtSourcePopover.contains(event.target)) closeArtSourcePopover();
  }

  function onPopoverKeydown(event) {
    if (event.key === 'Escape') closeArtSourcePopover();
  }

  function showArtSourcePopover(anchorBtn, cardData, rootEl, originRect) {
    closeArtSourcePopover();

    const rect = anchorBtn.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'cc-bridge-art-popover';
    pop.style.top = rect.bottom + 4 + 'px';
    pop.style.left = Math.max(4, rect.right - 190) + 'px';

    const scryfallOpt = document.createElement('button');
    scryfallOpt.type = 'button';
    scryfallOpt.className = 'cc-bridge-art-popover-opt';
    scryfallOpt.textContent = 'Use Scryfall art';
    scryfallOpt.addEventListener('click', function () {
      closeArtSourcePopover();
      const job = addQueueJob(cardData, originRect);
      updateQueueJob(job.id, { status: 'processing' });
      fetchScryfallCard(cardData, function (scryfallCard) {
        if (!scryfallCard) {
          // No pre-fetch available (network hiccup, unknown card) — let
          // Card Conjurer's own import + art fetch run untouched rather
          // than falling back to the full card image (which is what
          // caused the wrong-image bug this replaces).
          finishQueueJob(job, null);
          return;
        }
        // Stashed on cardData (same object reference the job already
        // holds) so it rides along through openEditorModal's payload
        // without adding another parameter to thread through.
        cardData.scryfallCard = scryfallCard;
        const isFullArt = isFullArtOrBorderless(scryfallCard);
        cardData.isFullArtFlow = isFullArt;
        const artUrl = isFullArt ? extractCardArtUrl(rootEl) : getArtCropUrl(scryfallCard);
        if (!artUrl) {
          finishQueueJob(job, null);
          return;
        }
        upscaleViaEnlarger({ url: artUrl }, function (blob) {
          finishQueueJob(job, blob);
        });
      });
    });

    const uploadOpt = document.createElement('button');
    uploadOpt.type = 'button';
    uploadOpt.className = 'cc-bridge-art-popover-opt';
    uploadOpt.textContent = 'Upload my own image…';
    uploadOpt.addEventListener('click', function () {
      closeArtSourcePopover();
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
      fileInput.addEventListener('change', function () {
        const file = fileInput.files[0];
        fileInput.remove();
        if (!file) return;
        const job = addQueueJob(cardData, originRect);
        updateQueueJob(job.id, { status: 'processing' });
        upscaleViaEnlarger({ file: file }, function (blob) {
          // Fall back to the raw upload if the upscale pass didn't come
          // through — the user's own explicit choice should never just
          // get silently dropped.
          finishQueueJob(job, blob || file);
        });
      });
      fileInput.click();
    });

    pop.appendChild(scryfallOpt);
    pop.appendChild(uploadOpt);
    document.body.appendChild(pop);
    openArtSourcePopover = pop;

    // setTimeout so this click itself (already bubbling to document.body's
    // own listener above) doesn't immediately trigger onOutsideClick.
    setTimeout(function () {
      document.addEventListener('click', onOutsideClick, true);
      document.addEventListener('keydown', onPopoverKeydown);
    }, 0);
  }

  // Only one editor modal at a time; tracks the previous instance's own
  // cleanup so a second "+ conjure" click replaces rather than stacks.
  let closeCurrentModal = null;

  function openEditorModal(cardData, originRect, customArtBlob) {
    if (closeCurrentModal) closeCurrentModal();

    const ccOrigin = getCCOrigin();

    const backdrop = document.createElement('div');
    backdrop.className = 'cc-bridge-modal-backdrop';

    const panel = document.createElement('div');
    panel.className = 'cc-bridge-modal-panel';

    // The panel is position: fixed for its entire life (see the .panel
    // class above) — both the starting and final rects below are plain
    // pixel values in that same coordinate space, so the CSS transition
    // between them is a smooth resize/move rather than a layout-mode
    // snap. Anchoring the opening rect to the card that was actually
    // clicked reads as the editor growing out of that card, rather than
    // an unrelated dialog appearing over the page.
    const finalWidth = Math.min(window.innerWidth * 0.92, 1400);
    const finalHeight = window.innerHeight * 0.92;
    const finalLeft = (window.innerWidth - finalWidth) / 2;
    const finalTop = (window.innerHeight - finalHeight) / 2;

    function setPanelRect(rect) {
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.width = rect.width + 'px';
      panel.style.height = rect.height + 'px';
    }

    setPanelRect(
      originRect || { left: finalLeft, top: finalTop, width: finalWidth, height: finalHeight }
    );

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cc-bridge-modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';

    const iframe = document.createElement('iframe');
    iframe.className = 'cc-bridge-modal-iframe';
    iframe.src = ccOrigin;

    panel.appendChild(closeBtn);
    panel.appendChild(iframe);
    backdrop.appendChild(panel);

    if (originRect) {
      // Force layout with the starting rect applied before switching to
      // the final size, so the browser has something to transition from.
      // eslint-disable-next-line no-unused-expressions
      panel.getBoundingClientRect();
      requestAnimationFrame(function () {
        setPanelRect({ left: finalLeft, top: finalTop, width: finalWidth, height: finalHeight });
      });
    }

    let intervalId = null;

    function close() {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('keydown', onKeydown);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (closeCurrentModal === close) closeCurrentModal = null;
    }
    closeCurrentModal = close;

    function onKeydown(event) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) close();
    });

    const payload = { name: cardData.name };
    if (cardData.set_code) payload.set_code = cardData.set_code;
    if (cardData.collector_number) payload.collector_number = cardData.collector_number;
    if (cardData.frame_hint) payload.frame_hint = cardData.frame_hint;
    // A Blob is structured-clone-transferable via postMessage same as the
    // Drive export blob hand-off elsewhere in this file — no base64
    // round-trip needed. Applied inside Card Conjurer after its own
    // Scryfall auto-art-fetch settles (doFillCardConjurerImport), so this
    // overrides it rather than racing it.
    if (customArtBlob) payload.customArtBlob = customArtBlob;
    // The card JSON already fetched via fetchScryfallCard (see
    // showArtSourcePopover) — plain data, structured-clone-safe same as
    // everything else here. Lets the receiver hand it straight to Card
    // Conjurer's own importCard() instead of Card Conjurer redundantly
    // re-fetching the same card itself.
    if (cardData.scryfallCard) payload.scryfallCard = cardData.scryfallCard;
    if (cardData.isFullArtFlow) payload.isFullArtFlow = true;

    iframe.addEventListener('load', function () {
      let attempts = 0;
      intervalId = setInterval(function () {
        attempts++;
        if (!backdrop.parentNode || attempts > MAX_RETRIES) {
          clearInterval(intervalId);
          return;
        }
        try {
          iframe.contentWindow.postMessage(payload, ccOrigin);
        } catch (e) {
          // iframe may be mid-navigation; next tick will retry or stop.
        }
      }, RETRY_INTERVAL_MS);
    });

    document.body.appendChild(backdrop);
  }

  // ---- queue nav tab (site-specific literal injection) -------------------
  //
  // Injects a real tab into the site's own nav, matching its real
  // markup/classes so it's indistinguishable from a native one — confirmed
  // directly against the live site that this survives real interactions
  // (typing, form submission, tab switching, a full route navigation to a
  // different page), since its nav links aren't state-driven and React
  // never touches this container's children once mounted. This selector
  // strategy is the site's own real markup, not a generic pattern — a
  // different MPC host site would need its own matching injection added
  // here, not a change to this one.
  function injectQueueNavTab() {
    if (document.querySelector('.cc-bridge-queue-tab')) return;
    const links = Array.prototype.filter.call(document.querySelectorAll('nav a'), function (a) {
      return a.textContent.trim();
    });
    const referenceLink =
      links.find(function (a) { return a.textContent.trim() === 'Editor'; }) ||
      links.find(function (a) { return a.textContent.trim() === 'Explore'; });
    if (!referenceLink) return; // Not a recognized nav structure — degrade silently, no tab.
    const container = referenceLink.parentElement;

    // A real href here (even "#") lets the host site's own client-side
    // router grab the click — routers commonly delegate on a[href] at the
    // document level, in the capture phase, ahead of our own listener on
    // the tab — and navigate the page out from under the user (observed:
    // the address bar gets overwritten with the site's own printing-queue
    // route). No href at all means the router has nothing to match.
    const tab = document.createElement('a');
    tab.className = referenceLink.className + ' cc-bridge-queue-tab';
    tab.setAttribute('role', 'button');
    tab.tabIndex = 0;
    updateQueueTabLabel(tab);
    tab.addEventListener('click', function (event) {
      event.preventDefault();
      toggleQueuePanel(tab);
    });
    tab.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleQueuePanel(tab);
      }
    });
    container.appendChild(tab);

    queueListeners.push(function () {
      updateQueueTabLabel(tab);
      renderQueuePanelIfOpen();
    });
  }

  function updateQueueTabLabel(tab) {
    const activeOrReady = upscaleQueue.filter(function (j) {
      return j.status !== 'failed';
    }).length;
    tab.textContent = 'Queue' + (activeOrReady ? ' (' + activeOrReady + ')' : '');
  }

  let queuePanelEl = null;

  function toggleQueuePanel(anchorTab) {
    if (queuePanelEl) {
      closeQueuePanel();
      return;
    }
    openQueuePanel(anchorTab);
  }

  function openQueuePanel(anchorTab) {
    const rect = anchorTab.getBoundingClientRect();
    const panel = document.createElement('div');
    panel.className = 'cc-bridge-queue-panel';
    panel.style.top = rect.bottom + 6 + 'px';
    panel.style.left = Math.max(4, rect.left) + 'px';
    document.body.appendChild(panel);
    queuePanelEl = panel;
    renderQueuePanel();

    setTimeout(function () {
      document.addEventListener('click', onQueuePanelOutsideClick, true);
      document.addEventListener('keydown', onQueuePanelKeydown);
    }, 0);
  }

  function closeQueuePanel() {
    if (queuePanelEl && queuePanelEl.parentNode) queuePanelEl.parentNode.removeChild(queuePanelEl);
    queuePanelEl = null;
    document.removeEventListener('click', onQueuePanelOutsideClick, true);
    document.removeEventListener('keydown', onQueuePanelKeydown);
  }

  function onQueuePanelOutsideClick(event) {
    if (queuePanelEl && !queuePanelEl.contains(event.target) && !event.target.closest('.cc-bridge-queue-tab')) {
      closeQueuePanel();
    }
  }

  function onQueuePanelKeydown(event) {
    if (event.key === 'Escape') closeQueuePanel();
  }

  function renderQueuePanelIfOpen() {
    if (queuePanelEl) renderQueuePanel();
  }

  const QUEUE_STATUS_LABELS = { queued: 'Queued', processing: 'Upscaling…', ready: 'Ready', failed: 'Failed' };

  function renderQueuePanel() {
    if (!queuePanelEl) return;
    queuePanelEl.innerHTML = '';
    if (upscaleQueue.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cc-bridge-queue-empty';
      empty.textContent = 'No cards queued yet — pick a card and choose an art source to start one.';
      queuePanelEl.appendChild(empty);
      return;
    }
    upscaleQueue
      .slice()
      .reverse()
      .forEach(function (job) {
        const row = document.createElement('div');
        row.className = 'cc-bridge-queue-row';

        const name = document.createElement('span');
        name.className = 'cc-bridge-queue-row-name';
        name.textContent = job.cardName;
        row.appendChild(name);

        const status = document.createElement('span');
        status.className = 'cc-bridge-queue-row-status cc-bridge-queue-status-' + job.status;
        status.textContent = QUEUE_STATUS_LABELS[job.status] || job.status;
        row.appendChild(status);

        if (job.status === 'ready') {
          row.classList.add('cc-bridge-queue-row-clickable');
          row.title = 'Open in Card Conjurer';
          row.addEventListener('click', function () {
            closeQueuePanel();
            openEditorModal(job.cardData, job.originRect, job.resultBlob);
          });
        }

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'cc-bridge-queue-row-remove';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', 'Remove from queue');
        removeBtn.addEventListener('click', function (event) {
          event.stopPropagation();
          removeQueueJob(job.id);
        });
        row.appendChild(removeBtn);

        queuePanelEl.appendChild(row);
      });
  }

  // ---- observe for new/re-rendered cards -------------------------------

  let rescanScheduled = false;
  function scheduleRescan() {
    if (rescanScheduled) return;
    rescanScheduled = true;
    setTimeout(function () {
      rescanScheduled = false;
      scanForCards();
    }, 100);
  }

  // attributes: true is required, not just childList — the site omits
  // data-card-name entirely while a card is still resolving (per its own
  // its documented DOM API), adding it later via an attribute change on the *same* DOM
  // node rather than inserting a new one. childList alone would only ever
  // see that node once, while it's still attribute-less, and never rescan
  // it once the real data lands. attributeFilter keeps this from also
  // firing on our own injected marker/style attributes.
  const observer = new MutationObserver(scheduleRescan);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-card-name', 'alt'],
  });

  scanForCards();
})();
