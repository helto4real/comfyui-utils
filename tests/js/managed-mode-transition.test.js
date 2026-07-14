import assert from "node:assert/strict";
import test from "node:test";

import {
    PRIVACY_SHOW_ANY_FIELD_ID,
    createPrivacyShowAnyWorkflowBrowserAdapter,
} from "../../web/privacy_show_any_managed_adapter.js";
import {
    PROMPT_ENHANCER_SCRIPT_FIELD_ID,
    createPromptEnhancerWorkflowBrowserAdapter,
} from "../../web/prompt_enhancer_privacy_adapter.js";
import {
    SELECTOR_SELECTED_FIELD_ID,
    createSelectorWorkflowBrowserAdapter,
} from "../../web/selector_privacy_adapter.js";

const TRANSITION_METHODS = Object.freeze([
    "settleModeTransition",
    "inventoryModeTransitionOwners",
    "readModeTransitionOwnerExact",
    "applyModeTransitionOwnerExact",
    "extractDetachedModeTransitionOwnerExact",
    "restoreModeTransitionOwnerExact",
    "reloadModeTransitionRuntime",
    "reconcileModeTransitionRuntime",
]);

function context(fieldId, nodeType) {
    return {
        field: {
            id: fieldId,
            nodeTypes: [nodeType],
            externalTransitionPolicy: {
                maxOwners: 8,
                maxOriginalBytesPerOwner: 4096,
                maxTargetBytesPerOwner: 4096,
                maxTotalBytes: 32768,
                leaseSeconds: 300,
            },
        },
    };
}

function selectorFixture() {
    const node = {
        id: 1,
        comfyClass: "HeltoImageSelector",
        widgets: [
            { name: "selected_images", value: "[]" },
            { name: "edited_masks", value: "{}" },
            { name: "edited_bboxes", value: "{}" },
        ],
        selectedPaths: [],
        editedMasks: {},
        editedBboxes: {},
    };
    const graph = {
        _nodes: [node],
        serialize() {
            return {
                nodes: [{
                    id: node.id,
                    type: node.comfyClass,
                    widgets_values: node.widgets.map((widget) => widget.value),
                }],
            };
        },
    };
    node.graph = graph;
    return { node, app: { graph } };
}

test("all browser-owned Utils workflow adapters expose the recoverable V3 contract", () => {
    const adapters = [
        createSelectorWorkflowBrowserAdapter(),
        createPrivacyShowAnyWorkflowBrowserAdapter(),
        createPromptEnhancerWorkflowBrowserAdapter(),
    ];

    for (const adapter of adapters) {
        assert.equal(typeof adapter.writeWorkflowProjection, "function");
        for (const method of TRANSITION_METHODS) {
            assert.equal(typeof adapter[method], "function", method);
        }
    }
    assert.equal(PRIVACY_SHOW_ANY_FIELD_ID, "privacy-show-any-text");
    assert.equal(PROMPT_ENHANCER_SCRIPT_FIELD_ID, "prompt-enhancer-script");
});

test("selector external transition inventories, applies, verifies, reloads, and reconciles exact bytes", async () => {
    const { node, app } = selectorFixture();
    const adapter = createSelectorWorkflowBrowserAdapter({ app });
    const declaration = context(SELECTOR_SELECTED_FIELD_ID, node.comfyClass);
    adapter.reconcileNode(node);

    const settlement = adapter.settleModeTransition(declaration);
    assert.deepEqual(await settlement.settled, { offlineRepresentationCount: 0 });
    assert.throws(
        () => adapter.apply(node, { value: ["/synthetic/blocked.png"] }, declaration),
        /PRIVACY_SELECTOR_STATE_INVALID/,
    );

    const [inventory] = adapter.inventoryModeTransitionOwners(declaration);
    assert.equal(inventory.nodeId, "1");
    assert.equal(
        new TextDecoder().decode(adapter.readModeTransitionOwnerExact(inventory.owner, declaration)),
        "[]",
    );

    const target = new TextEncoder().encode('{"value":["/synthetic/a.png"]}');
    adapter.applyModeTransitionOwnerExact(inventory.owner, target, declaration);
    assert.deepEqual(
        adapter.extractDetachedModeTransitionOwnerExact(
            inventory.owner,
            app.graph.serialize(),
            declaration,
        ),
        target,
    );
    assert.deepEqual(
        adapter.readModeTransitionOwnerExact(inventory.owner, declaration),
        target,
    );
    adapter.reloadModeTransitionRuntime(inventory.owner, declaration);
    adapter.reconcileModeTransitionRuntime(inventory.owner, declaration);
    assert.deepEqual(node.selectedPaths, ["/synthetic/a.png"]);
    assert.deepEqual(
        adapter.readModeTransitionOwnerExact(inventory.owner, declaration),
        target,
    );

    await settlement.release();
    adapter.apply(node, { value: ["/synthetic/editable.png"] }, declaration);
    assert.deepEqual(node.selectedPaths, ["/synthetic/editable.png"]);
});
