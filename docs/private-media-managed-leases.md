# Managed media-node lifecycle cutover

`shared/private_media_managed.py` now contains the complete inactive
replacement for Utils media-node preview, thumbnail-cache, private staging, and
Save Video replay behavior. It remains staged for the coordinated privacy-suite
activation, so current live node call sites and workflow schemas are unchanged.

Each affected node has its own fail-closed mode scope. The legacy
`privacy_mode` input maps only explicit `false`/`public` to public; missing,
malformed, inherited, and all other values remain private. Every private
managed entry point resolves that node-local declaration through the bound
shared mode handle, including supplied privacy floors, before work and checks
the shared execution cancellation at encode/write boundaries. Replay captures
the effective mode with its node/revision run and discards it if release occurs
under a different resolved mode. Load Video source serving no
longer accepts a request privacy boolean: its allowed-root adapter authorizes
the source and the shared protected operation returns a direct opaque stream
lease.

The media fragment does not invent an execution projection for tensors, audio,
or saved-output paths: those values are runtime product inputs, not protected
workflow fields. Its producer adapters instead accept the
`ExecutionCancellation` issued by an orchestrating shared execution dispatch
and checkpoint it before and after encoding and managed publication. This keeps
grant issuance in `helto-privacy` without serializing plaintext media into an
execution reference.

The artifact inventory is product-specific:

- Image Comparer and Save Image PNG previews and Video Comparer MP4 previews
  are served transients.
- Save Video GIF, WebP, AVI, Matroska, QuickTime, MP4, and WebM previews use
  distinct declarations so the shared response preserves the encoded media
  type. The inactive encoder writes animated output to memory and FFmpeg video,
  metadata, stderr, and audio-mux output through anonymous file descriptors;
  it never supplies a named private output or staging directory.
- Load Video WebP thumbnails are regenerable caches keyed by the existing
  consumer cache key and source revision.
- Save Video replay payloads are run-scoped spills owned by the in-memory
  node/revision binding. Pause release reads through the same session and then
  closes it exactly once.

Utils keeps image/video encoding, output routing, filenames and counters,
folder/source rules, thumbnail cache keys, replay serialization, and pause
semantics. `helto-privacy` owns encrypted persistence, atomic replacement,
leases, revocation, run cleanup, transition purge, and restart sweep. Managed
records contain only an artifact kind and opaque reference; filenames, paths,
payload bytes, credentials, and legacy tokens never cross to the browser.

Transition cleanup enumerates only generated derivatives: comparer previews,
Load Video thumbnails/copies, save preview copies, Save Video private staging,
and plaintext/encrypted legacy replay caches. User-requested saved output files
and original allowed-root media are not derivatives and are never purged. The
inactive public Save Image adapter routes previews into the dedicated
`helto_save_image_advanced` temp subfolder so a public-to-private transition can
delete the exact generated directory without matching user filename prefixes.

Final suite activation will switch the five node producers and browser
consumers to this staged surface, then delete `shared/private_media_routes.py`,
the token/encrypted-temp helpers in `shared/privacy.py`, named private staging,
local replay encryption, and the five legacy token URL builders.
