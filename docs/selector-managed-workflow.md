# Selector shared workflow and operations staging

The coordinated selector replacement is staged in
`helto_selector_backend/managed_workflow.py` and
`web/selector_privacy_adapter.js`; atomic legacy coordination lives in the
focused `helto_selector_backend/managed_migration.py` service module. It is
intentionally not installed yet: the
current selector remains usable while the rest of the `comfyui-utils` privacy
profile is assembled. The complete Utils profile will activate all slices at
once; it must not install this selector-only profile as a partial runtime.

The staged selector slice declares one private-by-default `selector` scope,
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
mask source, retires staged managed artifacts, and leaves all obligations open.
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

The fixture `tests/fixtures/historical/utils_legacy_formats.json` was generated
by the genuine Utils writers at commit
`d19f6845bf3c2f83a3ae3d6c48bce7e7897475a8`. Tests bind every generation to the
consumer profile, decode its workflow and mask bytes with test-only derived
keys, and run each mask generation through the field-plus-adjunct transaction.
No user workflow, mask, key, path, or browser state is inspected.
