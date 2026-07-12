# Selector shared workflow and operations

The active selector binding lives in
`helto_selector_backend/managed_workflow.py` and
`web/selector_privacy_adapter.js`; atomic legacy coordination lives in the
focused `helto_selector_backend/managed_migration.py` service module. Only the
complete Utils profile is installed; selector-only partial activation is not
supported.

The selector slice declares one private-by-default `selector` scope,
one workflow resource containing `selected_images`, `edited_masks`, and
`edited_bboxes`, and one semantic execution projection containing exactly the
three normalized product values. The server adapter and browser adapter retain
widget lookup, runtime-field application, clearing, and selector-specific JSON
normalization in this repository. Invalid or incomplete state fails closed; it
is never replaced by empty execution data.

Folder discovery, scanning, thumbnails, source viewing, mask CRUD/migration,
image paste/delete, cache clearing, and root registration are declared as
protected operations. `SelectorProtectedOperations` authorizes each declared
operation through the pack-bound authorization handle and supplies only the
bound workflow and artifact handles to the product adapter. Root validation,
image/mask encoding, folder scanning, deletion, and paste semantics remain
consumer-owned.

## Atomic historical migration

Every selector field binds all four exact Utils workflow-container readers:
raw XOR, `HELTO_PRIV1`, `HELTO_PRIV2`, and `HELTO_PRIV3`. Durable masks bind the
matching byte readers, while the two historical binary key sources remain
decrypt-only imports.

`SelectorWorkflowMigrationTransaction` captures the exact original field and
mask bytes, stages current envelopes and all managed mask artifacts, commits
the three fields together, then reads every field and artifact back. The shared
`complete_many(...)` migration API closes all field and mask obligations under
one receipt. A failure restores the exact field bytes, retains every legacy
mask source, retires incomplete managed artifacts, and leaves all obligations open.
Legacy mask files are unlinked only during finalization after the receipt is
durable.

`SelectorMigrationCoordinator` performs the production discovery: it probes
each field and referenced mask through the declared exact readers, collects the
resulting obligations, and invokes `complete_many(...)` with the selector
transaction. The coordinator runs the synchronous migration journal in a
worker thread while managed-artifact calls are submitted to the route event
loop; direct event-loop-thread use is rejected to prevent deadlock. Protected
mask migration mints the separate read, protect, disposition, and completion
capabilities from the same authenticated request before invoking the
coordinator.

There is one deliberately narrower browser-load bridge for workflows whose
field envelope is already current but whose `edited_masks` value still names a
legacy mask file. The `selector.mask-migrate` operation reads that file through
the declared reader, writes a managed artifact, and returns the current
reference for the browser to re-save. It intentionally leaves the legacy source
and its migration obligation in place until the re-saved workflow can be
audited and finalized through the full coordinator. This bridge is isolated in
`_migrate_legacy_mask_references(...)`; after workflows have been checked and
re-saved, it and the exact legacy readers can be removed together.

The fixture `tests/fixtures/historical/utils_legacy_formats.json` was generated
by the genuine Utils writers at commit
`d19f6845bf3c2f83a3ae3d6c48bce7e7897475a8`. Tests bind every generation to the
consumer profile, decode its workflow and mask bytes with test-only derived
keys, and run each mask generation through the field-plus-adjunct transaction.
No user workflow, mask, key, path, or browser state is inspected.
