// ==UserScript==
// @name         MPC Autofill → Card Conjurer Bridge
// @namespace    https://github.com/WilfordGrimley/mpc-cardconjurer-bridge
// @version      0.8.0
// @description  Adds a "+ conjure" button to MPC Autofill card grids that opens your own Card Conjurer instance in an in-page editor modal (like the card selector), auto-fills Card Conjurer's own card-import feature and a 1/8" bleed margin, and exports the finished card to a configured local folder (Chromium) or your browser's downloads (Firefox fallback).
// @author       wilfordgrimley
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

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

  // Google Drive export is opt-in and per-user: each installation brings
  // its own Google Cloud OAuth client (same "user supplies their own"
  // pattern as the CC origin above), since this tool stays independent of
  // any specific service — there's no shared cc-bridge Google app. See the
  // "Connect Google Drive" menu command below for the one-time setup this
  // requires (an Authorized JavaScript origin matching the CC origin, on
  // the user's own OAuth client).
  function getDriveClientId() {
    return GM_getValue('driveClientId', '');
  }

  function setDriveClientId(clientId) {
    GM_setValue('driveClientId', clientId);
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
    const current = getDriveClientId();
    const input = prompt(
      'Google OAuth Client ID for Drive export (from your own Google Cloud project — ' +
        'Data Access → add the drive.file scope, then create an OAuth Client ID and add "' +
        getCCOrigin() +
        '" as an Authorized JavaScript origin):',
      current
    );
    if (input === null) return;
    setDriveClientId(input.trim());
    alert('cc-bridge: Google Drive Client ID ' + (input.trim() ? 'saved.' : 'cleared.'));
  });

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

  // Same top-of-scope-before-the-early-return placement as currentCardData
  // above, for the same reason — these are only ever touched from the
  // receiver's own code paths, all of which live after that return.
  let driveAccessToken = null;
  let driveTokenClient = null;

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
      if (!data || typeof data.name !== 'string' || !data.name) return;
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

  function doFillCardConjurerImport(cardData) {
    const nameInput = document.querySelector('#import-name');
    if (!nameInput) return; // CC markup changed, or navigation above didn't land.

    const wantsSpecificPrint = !!(cardData.set_code && cardData.collector_number);
    const allPrintsCheckbox = document.querySelector('#importAllPrints');
    if (allPrintsCheckbox && wantsSpecificPrint) {
      allPrintsCheckbox.checked = true;
    }

    nameInput.value = cardData.name;
    nameInput.dispatchEvent(new Event('change', { bubbles: true }));

    const importIndex = document.querySelector('#import-index');
    if (!importIndex) {
      setTimeout(function () {
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
      setToolbarStatus('Building frame…');
      const scryfallCardData = getSelectedScryfallCard();
      loadBaseFrame(scryfallCardData, function () {
        // No separate refreshAutoFrame() call needed here — setAutoFrame()
        // inside loadBaseFrame already set #autoFrame and dispatched its
        // change event, which is what actually builds card.frames.
        applyBleedMargin(scryfallCardData);
      });
    });
    observer.observe(importIndex, { childList: true });
    // Safety net in case the Scryfall fetch never resolves (network error, etc).
    setTimeout(function () {
      observer.disconnect();
    }, 8000);
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
  function applyManualFrameSelectionRobust(targetName, callback, checksRemaining) {
    checksRemaining = checksRemaining === undefined ? 4 : checksRemaining;
    applyManualFrameSelection(targetName); // Idempotent — re-clicking an already-correct option is harmless.
    if (checksRemaining <= 0) {
      callback();
      return;
    }
    setTimeout(function () {
      applyManualFrameSelectionRobust(targetName, callback, checksRemaining - 1);
    }, 700);
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

  // ---- Google Drive export ------------------------------------------
  //
  // Opt-in only: nothing here runs, and no script from accounts.google.com
  // or googleapis.com is loaded, until the user clicks "Export to Drive"
  // themselves. See CLAUDE.md's network-calls boundary — this is the exact
  // exception carved out for it. Uses Google Identity Services' token
  // client (a popup-based flow returning an access token directly to this
  // page's JS), not a server-side redirect flow — there's no backend here
  // to receive a redirect, so this is the flow that actually fits a
  // userscript. The access token lives only in the `driveAccessToken`
  // variable above (memory only, cleared on page reload) — never written
  // to GM_setValue/localStorage, since it's a live credential, not
  // configuration.

  function ensureGisLoaded(callback) {
    if (pageWindow.google && pageWindow.google.accounts && pageWindow.google.accounts.oauth2) {
      callback();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = callback;
    script.onerror = function () {
      setToolbarStatus('Failed to load Google Sign-In — check your connection.');
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
    setToolbarStatus('Connecting to Google Drive…');
    ensureGisLoaded(function () {
      if (!driveTokenClient) {
        driveTokenClient = pageWindow.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.file',
          callback: function (response) {
            if (response && response.access_token) {
              driveAccessToken = response.access_token;
              setToolbarStatus('Connected to Google Drive.');
              if (onConnected) onConnected();
            } else {
              setToolbarStatus('Google Drive connection failed or was cancelled.');
            }
          },
        });
      }
      driveTokenClient.requestAccessToken();
    });
  }

  function uploadCardToGoogleDrive(cardData) {
    const canvas = pageWindow.cardCanvas;
    if (!canvas) {
      alert('cc-bridge: no card canvas found — is a card loaded?');
      return;
    }
    if (!driveAccessToken) {
      connectGoogleDrive(function () {
        uploadCardToGoogleDrive(cardData);
      });
      return;
    }

    setToolbarStatus('Uploading to Google Drive…');
    canvas.toBlob(function (blob) {
      const metadata = {
        name: buildExportFilename(cardData),
        // Drive's own structured tagging (queryable via the Drive API's
        // `properties has {...}` search, not just a filename convention) —
        // this is the "correctly tagged with set code and things from
        // import" part.
        properties: {
          cc_bridge_card_name: cardData.name || '',
          cc_bridge_set_code: cardData.set_code || '',
          cc_bridge_collector_number: cardData.collector_number || '',
        },
      };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', blob);

      fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + driveAccessToken },
        body: form,
      })
        .then(function (res) {
          if (res.status === 401) {
            // Token expired/revoked — clear it and let the next click
            // reconnect rather than repeatedly failing silently.
            driveAccessToken = null;
            throw new Error('Google Drive session expired — click "Export to Drive" again to reconnect.');
          }
          if (!res.ok) throw new Error('upload failed (HTTP ' + res.status + ')');
          return res.json();
        })
        .then(function () {
          setToolbarStatus('Uploaded to Google Drive.');
        })
        .catch(function (e) {
          setToolbarStatus('');
          alert('cc-bridge: Google Drive upload failed — ' + e.message);
        });
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
      '.cc-bridge-toolbar-status {' +
      '  font-size: 12px; padding: 6px 4px; color: #ebebeb; background: rgba(15,37,55,0.8);' +
      '  border-radius: 2px; align-self: center;' +
      '}' +
      '.cc-bridge-toolbar-status:empty { display: none; }';
    document.documentElement.appendChild(toolbarStyle);

    const toolbar = document.createElement('div');
    toolbar.className = 'cc-bridge-toolbar';

    const statusEl = document.createElement('span');
    statusEl.className = 'cc-bridge-toolbar-status';
    toolbar.appendChild(statusEl);

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
      uploadCardToGoogleDrive(currentCardData);
    });
    toolbar.appendChild(driveBtn);

    document.body.appendChild(toolbar);
  }

  function setToolbarStatus(text) {
    // The base-frame/bleed-margin pipeline can genuinely take tens of
    // seconds (Card Conjurer's own frame compositing runs on the single JS
    // main thread — confirmed against the live site). Surface that as
    // in-progress rather than letting it look stalled.
    const statusEl = document.querySelector('.cc-bridge-toolbar-status');
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
    '  z-index: 10;' +
    '  font-size: 11px;' +
    '  line-height: 1;' +
    '  padding: 4px 7px;' +
    '  border: 1px solid #4c9be8;' +
    '  border-radius: 2px;' +
    '  background: #4c9be8;' +
    '  color: #ebebeb;' +
    '  cursor: pointer;' +
    '}' +
    '.' + BUTTON_CLASS + ':hover { background: #3d8cd9; }' +
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
    '.cc-bridge-modal-close:hover { background: #3d8cd9; }';
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

  // mpc:card-selected is real now (earlier commits),
  // firing with a camelCase detail: {name, identifier, sourceKey, dpi,
  // cardType, setCode, collectorNumber}. Mapped explicitly below — not a
  // blind Object.assign — since the event's camelCase keys don't match the
  // payload's snake_case ones.
  let lastCardSelectedDetail = null;
  document.addEventListener('mpc:card-selected', function (event) {
    lastCardSelectedDetail = event && event.detail ? event.detail : null;
  });

  function mergeCardSelectedDetail(cardData, detail) {
    const merged = Object.assign({}, cardData);
    if (detail.name) merged.name = detail.name;
    if (detail.setCode) merged.set_code = detail.setCode;
    if (detail.collectorNumber) merged.collector_number = detail.collectorNumber;
    return merged;
  }

  // ---- button injection ----------------------------------------------

  function injectButtonIfNeeded(rootEl) {
    if (rootEl.hasAttribute(INJECTED_MARKER_ATTR)) return;
    if (!extractCardData(rootEl)) return;

    const computedPosition = getComputedStyle(rootEl).position;
    if (computedPosition === 'static') {
      rootEl.style.position = 'relative';
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.textContent = '+ conjure';
    rootEl.appendChild(btn);
    rootEl.setAttribute(INJECTED_MARKER_ATTR, '1');
  }

  function scanForCards() {
    const roots = document.querySelectorAll(CARD_ROOT_SELECTOR);
    for (let i = 0; i < roots.length; i++) {
      injectButtonIfNeeded(roots[i]);
    }
  }

  // ---- click handling / postMessage -----------------------------------

  document.body.addEventListener('click', function (event) {
    const btn = event.target.closest ? event.target.closest('.' + BUTTON_CLASS) : null;
    if (!btn) return;

    const rootEl = btn.closest(CARD_ROOT_SELECTOR);
    if (!rootEl) return;

    let cardData = extractCardData(rootEl);
    if (!cardData) return;

    if (lastCardSelectedDetail && lastCardSelectedDetail.name) {
      cardData = mergeCardSelectedDetail(cardData, lastCardSelectedDetail);
    }

    openEditorModal(cardData, rootEl.getBoundingClientRect());
  });

  // Only one editor modal at a time; tracks the previous instance's own
  // cleanup so a second "+ conjure" click replaces rather than stacks.
  let closeCurrentModal = null;

  function openEditorModal(cardData, originRect) {
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
