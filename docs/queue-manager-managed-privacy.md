# Queue Manager managed privacy cutover

This inactive slice stages Queue Manager for the coordinated Utils profile. The
current `/helto_queue_manager/state` route and UI remain authoritative until
atomic profile activation.

The replacement declares one private-by-default `queue-manager-state` blob
singleton. Its product adapter retains queue normalization, ordering, retries,
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
shared reader units. Migration writes the managed singleton, decrypts and
normalizes a full read-back, and only then deletes the JSON source or drops the
legacy SQLite table. Unknown, locked, malformed, or changed sources fail closed
without retiring the source.
