# Privacy Show Any managed privacy

Privacy Show Any is bound to the complete Utils `helto-privacy` profile. The
backend uses the bound workflow handle and the frontend uses the shared snapshot
coordinator.

The fragment declares one private-by-default `privacy-show-any` scope and
one logical protected text field. Its property location and mirrored widget
location are both explicit profile facts. A save or legacy migration protects
the normalized text once and writes that exact settled envelope to both
locations; a partial mirror write rolls back instead of serializing mismatched
state.

Arbitrary input conversion remains product-owned and bounded to the existing
200,000-character limit. The managed node adapter delegates protection to the
shared workflow handle and exposes only the protected envelope to the UI
payload. The node's normal text output is unchanged for downstream graph use.

Live display text is available only through the declared `display-result`
operation. The operation first passes shared scope authorization, then obtains
the narrow `snapshot.reveal` authority and reveals the exact current envelope.
Lock, stale authority, malformed payload, decrypt failure, and presenter
failure all block the display path. The shared protected-display controller
restores the prior protected value and clears transient plaintext on every
reveal failure. The product adapter clears live display state on session lock
without replacing the protected mirrors. If either restoration or clearing is
rejected, the adapter hides the display and blocks further serialization until
the node is recovered or reloaded.

Migration recognizes all four historical Utils workflow generations after the
declared binary key imports. It reads both historical mirrors through the same
generation-specific reader binding, requires their normalized plaintext to
agree, protects once, and settles both obligations under one grouped receipt.
Any write or verification failure restores both original historical values;
a concurrent source change is never overwritten.
