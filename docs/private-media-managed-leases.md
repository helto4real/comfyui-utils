# Managed private media lease cutover

`shared/private_media_managed.py` is the inactive replacement for the current
encrypted absolute-path tokens and `/helto_utils/private_media` route. It is
staged for the coordinated privacy-suite activation; current node call sites
remain unchanged until the following media-node ticket moves their producers.

The profile fragment defaults the `private-media` scope to private and declares
typed PNG previews, MP4 previews, and the protected `serve-source-media`
operation. Allowed existing sources are Comfy input/output files and enabled
Load Video folders. Those originals are never artifacts or derivatives.
Generated legacy derivatives are every `temp/helto_private/**` file plus the old
Video Comparer, Load Video, Save Video Advanced, and `helto.compare.*` temp
locations.

The consumer codec owns only bytes and that derivative inventory. The source
adapter retains Utils' alias, extension, enabled-folder, allowed-root, and media
type policy, then delegates direct bounded source streaming to `helto-privacy`.
The managed preview facade delegates write, replacement revocation, retirement,
release, and sweep behavior to one shared multi-kind publication service. It
returns an opaque artifact reference that the attested browser handle exchanges
for a preview lease. Source operations return a direct shared stream lease.
Browser code delegates final lease validation and URL resolution to the shared
helper and refuses the legacy token record shape.

Activation later removes `shared/private_media_routes.py`, the token/encrypted
temp helpers in `shared/privacy.py`, and the five legacy browser URL builders.
That deletion is intentionally not part of this staged surface ticket.
