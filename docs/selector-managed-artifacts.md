# Selector managed-artifact staging

The selector mask and thumbnail replacement path is staged in
`helto_selector_backend/managed_artifacts.py`. It is intentionally inactive:
the existing selector routes continue to use `mask_storage.py` and
`thumbnail_cache.py` until the selector workflow migration can commit its
encrypted fields and durable mask references in one receipt.

The staged contract declares:

- `selector-mask` as a durable adjunct owned by the future workflow-mask
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

Privacy-bearing test modules explicitly opt into a pytest fixture that bypasses
only the unpublished suite's outer activation gate. Production activation
remains mandatory, future activation tests are unaffected unless they opt in,
and the marked tests still exercise token authorization, keystore state,
envelope encryption, managed storage, and fail-closed errors.
