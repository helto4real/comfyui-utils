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

const declarations = {
    [SELECTOR_SELECTED_FIELD_ID]: {
        id: SELECTOR_SELECTED_FIELD_ID,
        location: { name: "selected_images" },
    },
    [SELECTOR_MASKS_FIELD_ID]: {
        id: SELECTOR_MASKS_FIELD_ID,
        location: { name: "edited_masks" },
    },
    [SELECTOR_BBOXES_FIELD_ID]: {
        id: SELECTOR_BBOXES_FIELD_ID,
        location: { name: "edited_bboxes" },
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
        declarations[SELECTOR_SELECTED_FIELD_ID],
    );
    assert.deepEqual(target.selectedPaths, ["/synthetic/root/a.png"]);
    state.clear(target, declarations[SELECTOR_SELECTED_FIELD_ID]);
    assert.deepEqual(target.selectedPaths, []);
});
test("selector browser normalization is canonical and fail closed", () => {
    const state = createSelectorWorkflowBrowserAdapter();

    assert.deepEqual(
        state.normalize(
            '["/synthetic/root/a.png", 12, "/synthetic/root/a.png"]',
            declarations[SELECTOR_SELECTED_FIELD_ID],
        ),
        { value: ["/synthetic/root/a.png"] },
    );
    assert.deepEqual(
        state.normalize(
            '{"/synthetic/root/a.png":{"id":"managed"}}',
            declarations[SELECTOR_MASKS_FIELD_ID],
        ),
        { value: { "/synthetic/root/a.png": { id: "managed" } } },
    );
    assert.throws(
        () => state.normalize("not-json", declarations[SELECTOR_SELECTED_FIELD_ID]),
        /PRIVACY_SELECTOR_STATE_INVALID/,
    );
});

test("selector browser adapter reads and writes only declared hidden widgets", () => {
    const target = node();
    const state = createSelectorWorkflowBrowserAdapter();
    const declaration = declarations[SELECTOR_MASKS_FIELD_ID];

    state.writeProtected(target, declaration, "CURRENT_ENVELOPE");
    assert.equal(state.readProtected(target, declaration), "CURRENT_ENVELOPE");
    state.onPrivacySessionChange({ state: "locked" });
    state.reconcileNode(target);
    assert.deepEqual(target.selectedPaths, []);
    assert.deepEqual(target.editedMasks, {});
    assert.deepEqual(target.editedBboxes, {});
});
