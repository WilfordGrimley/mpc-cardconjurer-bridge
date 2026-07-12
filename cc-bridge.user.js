// ==UserScript==
// @name         MPC Autofill → Card Conjurer Bridge
// @namespace    https://github.com/WilfordGrimley/mpc-cardconjurer-bridge
// @version      0.5.0
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

  // ---- config helpers -------------------------------------------------

  function getCCOrigin() {
    return GM_getValue('ccOrigin', DEFAULT_CC_ORIGIN);
  }

  function setCCOrigin(origin) {
    GM_setValue('ccOrigin', origin);
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

  if (location.origin === getCCOrigin()) {
    setupCCReceiver();
    return;
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
      loadBaseFrame(getSelectedScryfallCard(), function () {
        // No separate refreshAutoFrame() call needed here — setAutoFrame()
        // inside loadBaseFrame already set #autoFrame and dispatched its
        // change event, which is what actually builds card.frames.
        applyBleedMargin();
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

  function determineFrameSelection(scryfallCardData) {
    if (!scryfallCardData) return null;
    const layout = scryfallCardData.layout || '';
    const typeLine = scryfallCardData.type_line || '';

    if (layout === 'saga') return { group: 'Saga-1', pack: 'SagaRegular', autoFrame: null };
    if (typeLine.indexOf('Planeswalker') !== -1) {
      return { group: 'Planeswalker', pack: 'PlaneswalkerRegular', autoFrame: null };
    }
    if (layout === 'modal_dfc') return { group: 'Modal-1', pack: 'ModalRegular', autoFrame: null };
    // Front face only — a transform card's back face isn't part of this
    // import (MPC Autofill sources front/back as separate card slots).
    if (layout === 'transform') return { group: 'DFC', pack: 'M15TransformFront', autoFrame: null };
    if (layout === 'token' || typeLine.indexOf('Token') !== -1) {
      return { group: 'Token-2', pack: 'TokenRegular-1', autoFrame: null };
    }

    // Structurally still a normal card either way — full_art/border_color
    // only change which #autoFrame frame graphics get built, not the text
    // field layout, so group/pack stay the same as the plain default below.
    // Legendary crowns etc. aren't handled here at all: autoFrame()'s own
    // buildAutoFrames() already detects "legendary"/"snow"/nyx-enchantment
    // straight from the type line and adds them automatically, for any of
    // these frame choices (confirmed: Borderless and FullArtNew both have
    // supportsCrown: true in autoFrame.js) — no extra logic needed here.
    if (scryfallCardData.full_art) {
      return { group: 'Standard-3', pack: 'M15Regular-1', autoFrame: 'FullArtNew' };
    }
    if (scryfallCardData.border_color === 'borderless') {
      return { group: 'Standard-3', pack: 'M15Regular-1', autoFrame: 'Borderless' };
    }

    return { group: 'Standard-3', pack: 'M15Regular-1', autoFrame: 'M15Regular-1' };
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
    loadFramePack(selection.group, selection.pack, function () {
      setAutoFrame(selection.autoFrame || 'M15Regular-1');
      waitForFramesBuilt(callback);
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

  // ---- bleed margin ----------------------------------------------------
  //
  // Verified against the live site: "1/8th Inch Margin" is a real frame
  // group (#selectFrameGroup value 'Margin'), not a checkbox. Selecting it
  // loads /js/frames/groupMargin.js, which populates #selectFramePack with
  // several themed packs plus a generic one ({name:'Generic Margins',
  // value:'Margin-1'}).

  function applyBleedMargin(attempt) {
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

    loadFramePack('Margin', 'Margin-1', function () {
      // Retry-until-confirmed rather than trying to predict exactly when
      // the main thread frees up: the base frame's own image
      // fetch/decode/composite work can still be running here (confirmed
      // against the live site — it measurably delays anything queued after
      // it, including this click's own async handler), so a first attempt
      // can silently lose a race even after waitForFramesBuilt's settle
      // check above. A fresh attempt once things actually quiet down
      // reliably sticks (confirmed end-to-end against live production data).
      let attempts = 0;
      const intervalId = setInterval(function () {
        attempts++;
        const applied = !!(pageWindow.card && pageWindow.card.margins);
        if (applied || attempts > 60) {
          // ~12s per attempt.
          clearInterval(intervalId);
          if (applied) {
            setToolbarStatus('');
          } else {
            applyBleedMargin(attempt + 1);
          }
        }
      }, 200);
    });
  }

  // Shared by base-frame and bleed-margin loading: selecting a frame group
  // loads /js/frames/group<X>.js (populates #selectFramePack), selecting a
  // pack loads /js/frames/pack<X>.js (wires up #loadFrameVersion's onclick
  // for that specific pack — confirmed by reading several pack scripts;
  // every one of them ends with exactly this assignment), and the frame is
  // actually applied by clicking #loadFrameVersion. Rather than poll for
  // some pack-specific side effect (which isn't a generalizable signal —
  // different packs define different globals, if any), this calls Card
  // Conjurer's own loadScript() directly and awaits its real promise
  // (resolves on the underlying <script> tag's onload), the same function
  // the page's own onchange handlers use internally.
  function loadFramePack(group, pack, callback) {
    const groupSelect = document.querySelector('#selectFrameGroup');
    const packSelect = document.querySelector('#selectFramePack');
    const loadBtn = document.querySelector('#loadFrameVersion');
    if (!groupSelect || !packSelect || !loadBtn || typeof pageWindow.loadScript !== 'function') {
      callback(); // Degrade silently, as elsewhere.
      return;
    }
    groupSelect.value = group;
    pageWindow
      .loadScript('/js/frames/group' + group + '.js')
      .then(function () {
        packSelect.value = pack;
        return pageWindow.loadScript('/js/frames/pack' + pack + '.js');
      })
      .then(function () {
        packSelect.value = pack; // Re-assert: belt-and-suspenders against the group script's own default-pack auto-load racing this.
        loadBtn.click();
        callback();
      })
      .catch(function () {
        callback(); // Let the caller continue even if frame loading failed.
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
      '  font-size: 12px; padding: 6px 10px; border-radius: 4px;' +
      '  border: 1px solid rgba(0,0,0,0.3); background: rgba(255,255,255,0.95);' +
      '  color: #222; cursor: pointer;' +
      '}' +
      '.cc-bridge-toolbar-btn:hover { background: #fff; }' +
      '.cc-bridge-toolbar-status {' +
      '  font-size: 12px; padding: 6px 4px; color: #fff; background: rgba(0,0,0,0.6);' +
      '  border-radius: 4px; align-self: center;' +
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

  const style = document.createElement('style');
  style.textContent =
    '.' + BUTTON_CLASS + ' {' +
    '  position: absolute;' +
    '  top: 4px;' +
    '  right: 4px;' +
    '  z-index: 10;' +
    '  font-size: 11px;' +
    '  line-height: 1;' +
    '  padding: 3px 6px;' +
    '  border: 1px solid rgba(0,0,0,0.3);' +
    '  border-radius: 4px;' +
    '  background: rgba(255,255,255,0.9);' +
    '  color: #222;' +
    '  cursor: pointer;' +
    '}' +
    '.' + BUTTON_CLASS + ':hover { background: #fff; }' +
    '.cc-bridge-modal-backdrop {' +
    '  position: fixed; inset: 0; background: rgba(0,0,0,0.6);' +
    '  z-index: 999999; display: flex; align-items: center; justify-content: center;' +
    '}' +
    '.cc-bridge-modal-panel {' +
    '  position: relative; width: 92vw; height: 92vh; max-width: 1400px;' +
    '  background: #fff; border-radius: 8px; overflow: hidden;' +
    '  box-shadow: 0 10px 40px rgba(0,0,0,0.5);' +
    '}' +
    '.cc-bridge-modal-iframe { width: 100%; height: 100%; border: 0; display: block; }' +
    '.cc-bridge-modal-close {' +
    '  position: absolute; top: 8px; right: 8px; z-index: 1;' +
    '  width: 32px; height: 32px; border-radius: 50%; border: none;' +
    '  background: rgba(0,0,0,0.6); color: #fff; font-size: 18px; line-height: 1;' +
    '  cursor: pointer;' +
    '}' +
    '.cc-bridge-modal-close:hover { background: rgba(0,0,0,0.8); }';
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

    openEditorModal(cardData);
  });

  // Only one editor modal at a time; tracks the previous instance's own
  // cleanup so a second "+ conjure" click replaces rather than stacks.
  let closeCurrentModal = null;

  function openEditorModal(cardData) {
    if (closeCurrentModal) closeCurrentModal();

    const ccOrigin = getCCOrigin();

    const backdrop = document.createElement('div');
    backdrop.className = 'cc-bridge-modal-backdrop';

    const panel = document.createElement('div');
    panel.className = 'cc-bridge-modal-panel';

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
