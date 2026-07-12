import assert from "node:assert/strict";
import test from "node:test";

import {
    SELECTOR_BBOXES_FIELD_ID,
    SELECTOR_MASKS_FIELD_ID,
    SELECTOR_SELECTED_FIELD_ID,
    createSelectorModeBrowserAdapter,
    createSelectorWorkflowBrowserAdapter,
} from "../../web/selector_privacy_adapter.js";

function node() {
    return {
        comfyClass: "HeltoImageSelector",
        properties: {},
        widgets: [
            { name: "selected_images", value: "[]" },
            { name: "edited_masks", value: "{}" },
            { name: "edited_bboxes", value: "{}" },
        ],
        selectedPaths: ["stale"],
        editedMasks: { stale: true },
        editedBboxes: { stale: true },
    };
}

const contexts = {
    [SELECTOR_SELECTED_FIELD_ID]: {
        fieldId: SELECTOR_SELECTED_FIELD_ID,
    },
    [SELECTOR_MASKS_FIELD_ID]: {
        fieldId: SELECTOR_MASKS_FIELD_ID,
    },
    [SELECTOR_BBOXES_FIELD_ID]: {
        fieldId: SELECTOR_BBOXES_FIELD_ID,
    },
};

test("selector browser adapters default private and map the three runtime fields", () => {
    const target = node();
    const mode = createSelectorModeBrowserAdapter();
    const state = createSelectorWorkflowBrowserAdapter();

    assert.equal(mode.readDeclaredMode(target), "private");
    mode.writeDeclaredMode(target, "public");
    assert.equal(target.properties.privacyMode, false);

    state.apply(
        target,
        { value: ["/synthetic/root/a.png"] },
        contexts[SELECTOR_SELECTED_FIELD_ID],
    );
    assert.deepEqual(target.selectedPaths, ["/synthetic/root/a.png"]);
    state.clear(target, contexts[SELECTOR_SELECTED_FIELD_ID]);
    assert.deepEqual(target.selectedPaths, []);
});
test("selector browser normalization is canonical and fail closed", () => {
    const state = createSelectorWorkflowBrowserAdapter();

    assert.deepEqual(
        state.normalize(
            { selectedPaths: ["/synthetic/root/a.png", 12, "/synthetic/root/a.png"] },
            contexts[SELECTOR_SELECTED_FIELD_ID],
        ),
        { value: ["/synthetic/root/a.png"] },
    );
    assert.deepEqual(
        state.normalize(
            { editedMasks: { "/synthetic/root/a.png": { id: "managed" } } },
            contexts[SELECTOR_MASKS_FIELD_ID],
        ),
        { value: { "/synthetic/root/a.png": { id: "managed" } } },
    );
    assert.throws(
        () => state.normalize(
            { selectedPaths: "not-json" },
            contexts[SELECTOR_SELECTED_FIELD_ID],
        ),
        /PRIVACY_SELECTOR_STATE_INVALID/,
    );
});

test("selector browser adapter reads and writes only declared hidden widgets", () => {
    const target = node();
    const state = createSelectorWorkflowBrowserAdapter();
    const context = contexts[SELECTOR_MASKS_FIELD_ID];

    state.writeProtected(target, "CURRENT_ENVELOPE", context);
    assert.equal(state.readProtected(target, context), "CURRENT_ENVELOPE");
    state.onPrivacySessionChange({ state: "locked" });
    state.reconcileNode(target);
    assert.deepEqual(target.selectedPaths, []);
    assert.deepEqual(target.editedMasks, {});
    assert.deepEqual(target.editedBboxes, {});
});

test("selector browser adapter schedules replacement of revealed legacy mask references", async () => {
    const target = node();
    let migrations = 0;
    target.migrateLegacyMasks = async () => { migrations += 1; };
    const state = createSelectorWorkflowBrowserAdapter();

    state.apply(
        target,
        { value: { "/synthetic/root/a.png": { key: "legacy-mask-key" } } },
        contexts[SELECTOR_MASKS_FIELD_ID],
    );
    await new Promise((resolve) => queueMicrotask(resolve));

    assert.equal(migrations, 1);
});
