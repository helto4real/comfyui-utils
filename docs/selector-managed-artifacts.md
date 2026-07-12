# Selector managed-artifact lifecycle

The selector uses `helto_selector_backend/managed_artifacts.py` for private
masks and thumbnails. Product code generates bytes and validates roots;
`helto-privacy` stores them and issues short-lived browser leases.

The active contract declares:

- `selector-mask` as a durable adjunct owned by the workflow-mask
  transaction, with PNG product bytes and `preview`/`use` lease operations;
- `selector-thumbnail` as a regenerable source-revision cache with WebP product
  bytes and a `preview` lease operation;
- allowed-root validation before any source image is encoded, read, leased, or
  retired;
- legacy plaintext mask and thumbnail derivatives separately, so regenerable
  thumbnails may be purged while durable plaintext masks block transition until
  their later verified migration.

`comfyui-utils` retains image normalization, root authorization, thumbnail
generation, cache-key calculation, and source-revision decisions.
`helto-privacy` owns ciphertext-only atomic storage, purpose binding, owners,
retention, opaque leases, cleanup retry, and startup sweep.

Synthetic integration tests bind the real shared artifact handle. They cover a
provenance-recorded historical `HELTO_PRIV3` mask, current WebP regeneration,
unreadable-cache replacement, opaque leases, startup cleanup, and injected
storage and retirement failures. They do not inspect live ComfyUI data.

Privacy-bearing tests bypass only the unpublished signed-suite gate. They still
exercise authorization, keystore state, envelope encryption, managed storage,
legacy conversion, and fail-closed errors.
