# Queue Manager managed privacy cutover

Queue Manager uses the coordinated Utils profile. State load/save and queue
lifecycle operations are declared typed operations; the old local state route
and independent persistence implementation have been removed.

The replacement declares one always-private `queue-manager-state` blob
singleton; the obsolete local encryption toggle has been removed. Its product
adapter retains queue normalization, ordering, retries,
batching, semantic comparison excluding `updated_at`, SQLite row identity, and
generic queue/history/running counts. The SQLite adapter persists one revisioned
shared envelope and contains no queue-specific encryption or token logic.

Capture and replay use `helto-privacy`'s shared queue coordinator. Every batch
capture runs after all registered workflow coordinators settle. Replay rebuilds
the prompt from the stored workflow inside a new `replay` snapshot transaction,
so old executable payloads and session grants are never resubmitted.

Current JSON and SQLite wrappers are decoded only by exact shared reader units;
strictly flagged plaintext-current forms are immediately rewritten private.
Historical PRIV1/PRIV2/PRIV3 JSON and SQLite forms are bound to the removable
shared reader units. Migration protects and reveals the managed singleton only
through its bound typed handle, normalizes the full read-back, and only then
deletes the JSON source or drops the legacy SQLite table. Unknown, locked,
malformed, or changed sources fail closed without retiring the source.
