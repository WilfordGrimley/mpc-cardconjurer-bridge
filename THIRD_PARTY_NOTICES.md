# Third-party notices

This project's own code is MIT licensed (see the `@license` field in
`cc-bridge.user.js`). One bundled asset carries different terms:

## Ultramix (Balanced) — `models/4x-UltraMix_Balanced.onnx`

- **Author:** Kim2091
- **Source:** https://huggingface.co/Kim2091/UltraSharp (`Interpolations/4x-UltraMix_Balanced.pth`)
- **License:** CC BY-NC-SA 4.0 (Attribution-NonCommercial-ShareAlike) — https://creativecommons.org/licenses/by-nc-sa/4.0/
- **What's here:** an unmodified conversion of the original `.pth` weights
  to ONNX (same architecture, same weights, same numerical behavior —
  verified against the PyTorch reference to ~3.5e-6 max absolute
  difference), so it can run with `onnxruntime-web` in-browser.

This model is used as the *default* upscaler for the Enlarger hand-off
(see `resolveUpscaleModelUrl` / `isBundledUltramixEnabled` in
`cc-bridge.user.js`) — it ships enabled, since that's what the script
includes out of the box, but it's not "the project's license." Using it
means you're using Kim2091's model under CC BY-NC-SA 4.0: attribution,
non-commercial use only, and any redistribution of the model itself (not
this project's own code) must carry the same license.

If you don't want a non-commercial-licensed asset engaged at all, use the
"Disable bundled Ultramix upscaling" menu command — Enlarger falls back to
a classical (Lanczos) resize with no third-party model involved. You can
also point the "Configure upscale model weights" menu command at any ONNX
model of your own choosing, which fully replaces the bundled default.
