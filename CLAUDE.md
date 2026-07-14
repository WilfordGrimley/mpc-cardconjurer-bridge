# mpc-cardconjurer-bridge — context for Claude Code

## What this is
A community userscript (Tampermonkey/Violentmonkey) connecting any MPC
Autofill-based card site to the USER'S OWN locally-hosted Card Conjurer
instance. Personal project under wilfordgrimley — deliberately NOT part of
any card-site org or repo. GPL-3.0-or-later licensed.

## Architecture
- Single userscript: cc-bridge.user.js (plain JS, no build step, no deps).
- Reads semantic data attributes (data-card-name, data-card-identifier,
  data-source-key, data-card-type) and the "mpc:card-selected" CustomEvent
  that MPC Autofill frontends expose — see the DOM API those sites document.
  Degrade gracefully when attributes are absent (older instances).
- Injects a "+ conjure" button beside card elements; on click, opens the
  user's configured Card Conjurer origin in a new tab/window and
  postMessages {name, set_code?, collector_number?, frame_hint?} to it.
- CC origin stored via GM_setValue; configured through a menu command
  (GM_registerMenuCommand) prompt; default http://localhost:4242. THE USER
  SUPPLIES THEIR OWN INSTANCE — this project never provisions one.

## Hard boundaries — read before any edit
- NEVER include Card Conjurer installation/setup instructions, docker
  files, or links to CC repos/downloads. Users bring their own instance;
  its distribution is not this project's business.
- NEVER claim affiliation with, or special integration into, any specific
  card catalog site. Target the MPC Autofill ecosystem generically
  (@match mpcfill.com and user-configurable origins equally).
- postMessage target origin must be the user's configured CC origin
  exactly — never "*". Validate before sending.
- No telemetry, analytics, or non-consensual network calls beyond the
  postMessage. Ever. Narrow exception, added when Drive export was built:
  an explicit, user-initiated OAuth connection (e.g. a "Connect Google
  Drive" action the user deliberately clicks, same pattern as "Set export
  folder") may make network calls strictly to authenticate and upload the
  user's own exported card image — plus minimal accompanying metadata like
  set code/collector number for tagging — to a destination the user
  explicitly chose and authorized. No background or automatic calls, no
  call the user didn't directly trigger, no data goes anywhere except
  exactly where the user pointed it. This exception covers uploading the
  export; it does not license telemetry, analytics, or any other silent
  network use.
  Second narrow exception, added when art-source resolution needed real
  Scryfall data before Card Conjurer itself would otherwise fetch it: a
  user-initiated "+ conjure" action may make a read-only GET request
  directly to Scryfall's public card API (api.scryfall.com) to resolve
  that one card's data (art_crop URL, full_art/border_color/frame, etc.)
  — the exact same public, unauthenticated, CORS-open endpoint Card
  Conjurer's own code already calls once it opens. This exists so the
  fetched card can be handed to Card Conjurer directly (via its own
  importCard()) instead of Card Conjurer redundantly re-fetching the same
  data itself. No request body beyond the lookup querystring, no
  credentials, no data sent anywhere except to Scryfall's own API, and
  only ever in direct response to that one user click. This exception
  covers Scryfall card lookups only; it does not license calls to any
  other third-party API, nor any telemetry/analytics use.
  This also covers fetching that same resolved card's own art image (the
  Scryfall art_crop URL, or — full-art path — the exact art the mpchost
  page is already showing that user for that card) so it can be upscaled
  (Enlarger) before handoff — same single click, same one card, no new
  destination beyond wherever that art already lives. GM_xmlhttpRequest
  (rather than a page/Worker fetch()) is used only because it's needed to
  reliably fetch that one image regardless of the mpchost page's own CSP;
  it does not license using GM_xmlhttpRequest for anything else.

## Local, personal, or machine-specific context
See CLAUDE.local.md (gitignored, not tracked) for git/auth setup and
owner-specific working preferences.
