import assert from "node:assert/strict";
import test from "node:test";

import {
    PRIVACY_SHOW_ANY_FIELD_ID,
    createPrivacyShowAnyDisplayController,
    createPrivacyShowAnyModeBrowserAdapter,
    createPrivacyShowAnyWorkflowBrowserAdapter,
} from "../../web/privacy_show_any_managed_adapter.js";


const context = { fieldId: PRIVACY_SHOW_ANY_FIELD_ID };
let lifecycleOptions;

function createProtectedDisplayController(options) {
    lifecycleOptions = options;
    return {
        async display(target, protectedValue, declaration) {
            if (typeof protectedValue !== "string") {
                options.adapter.clear(target, declaration);
                throw new Error(options.failureCode);
            }
            const result = await options.invoke(protectedValue);
            const revealed = options.project(result);
            options.adapter.apply(target, revealed, declaration);
            return revealed;
        },
    };
}

function node() {
    return {
        comfyClass: "HeltoPrivacyShowAny",
        properties: {},
        widgets: [{ name: "encrypted_text_state", value: "" }],
        __heltoPrivacyShowAnyText: "Synthetic private display",
        __heltoPrivacyShowAnyWidget: {
            textRevealed: true,
            textWidget: { value: "Synthetic private display" },
            inputEl: { value: "Synthetic private display", placeholder: "" },
        },
    };
}


test("mode defaults private and only explicit property false opts out", () => {
    const target = node();
    const adapter = createPrivacyShowAnyModeBrowserAdapter();

    assert.equal(adapter.readDeclaredMode(target), "private");
    adapter.reconcileNode(target);
    assert.equal(target.properties.helto_privacy_show_any_privacy_mode, true);
    adapter.writeDeclaredMode(target, "public");
    assert.equal(target.properties.helto_privacy_show_any_privacy_mode, false);
});


test("one protected write is mirrored exactly and failed writes roll back", () => {
    const target = node();
    const adapter = createPrivacyShowAnyWorkflowBrowserAdapter();
    const envelope = "SYNTHETIC_CURRENT_ENVELOPE";

    adapter.writeProtected(target, envelope, context);
    assert.equal(target.widgets[0].value, envelope);
    assert.equal(
        target.properties.helto_privacy_show_any_encrypted_text_state,
        envelope,
    );
    assert.equal(adapter.readProtected(target, context), envelope);

    const originalProperties = target.properties;
    target.properties = new Proxy(originalProperties, {
        set(object, key, value) {
            if (key === "helto_privacy_show_any_encrypted_text_state") throw new Error("blocked");
            object[key] = value;
            return true;
        },
    });
    assert.throws(
        () => adapter.writeProtected(target, "NEW_ENVELOPE", context),
        /PRIVACY_SHOW_ANY_MIRROR_WRITE_FAILED/,
    );
    assert.equal(target.widgets[0].value, envelope);
    assert.equal(
        originalProperties.helto_privacy_show_any_encrypted_text_state,
        envelope,
    );
});


test("workflow projection updates the detached state widget slot and mirrored property", () => {
    const target = node();
    const stateWidget = target.widgets[0];
    target.__heltoPrivacyShowAnyStateWidget = stateWidget;
    target.widgets = [];
    const serialized = { widgets_values: ["OLD"], properties: {} };
    const adapter = createPrivacyShowAnyWorkflowBrowserAdapter();

    adapter.writeWorkflowProjection(target, serialized, "CURRENT_ENVELOPE", context);

    assert.equal(serialized.widgets_values[0], "CURRENT_ENVELOPE");
    assert.equal(
        serialized.properties.helto_privacy_show_any_encrypted_text_state,
        "CURRENT_ENVELOPE",
    );
});


test("normalize reads bounded live state and lock clears only plaintext", () => {
    const target = node();
    const adapter = createPrivacyShowAnyWorkflowBrowserAdapter();
    adapter.writeProtected(target, "CURRENT_ENVELOPE", context);

    assert.deepEqual(adapter.normalize(target, context), {
        value: "Synthetic private display",
    });
    adapter.onPrivacySessionChange({ state: "locked" });
    adapter.reconcileNode(target);

    assert.equal(target.__heltoPrivacyShowAnyText, "");
    assert.equal(target.__heltoPrivacyShowAnyWidget.textWidget.value, "");
    assert.equal(target.__heltoPrivacyShowAnyWidget.inputEl.value, "");
    assert.equal(adapter.readProtected(target, context), "CURRENT_ENVELOPE");
});


test("canonical truncation remains stable when authorized text is applied", () => {
    const target = node();
    const adapter = createPrivacyShowAnyWorkflowBrowserAdapter();
    target.__heltoPrivacyShowAnyText = "x".repeat(200_010);
    const normalized = adapter.normalize(target, context);

    adapter.apply(target, normalized, context);

    assert.equal(normalized.value.endsWith("<truncated 10 character(s)>"), true);
    assert.equal(target.__heltoPrivacyShowAnyText, normalized.value);
    assert.deepEqual(adapter.normalize(target, context), normalized);
});


test("privacy cleanup fallback hides plaintext and blocks further serialization", () => {
    const target = node();
    const adapter = createPrivacyShowAnyWorkflowBrowserAdapter();
    adapter.writeProtected(target, "CURRENT_ENVELOPE", context);

    adapter.block(target, context);

    assert.equal(target.__heltoPrivacyShowAnyText, "");
    assert.equal(target.__heltoPrivacyShowAnyWidget.textWidget.value, "");
    assert.equal(target.widgets[0].value, "CURRENT_ENVELOPE");
    assert.throws(
        () => adapter.readProtected(target, context),
        /PRIVACY_SHOW_ANY_PRIVACY_BLOCKED/,
    );
});


test("display binding delegates authorized reveal lifecycle to the shared controller", async () => {
    const target = node();
    const adapter = createPrivacyShowAnyWorkflowBrowserAdapter();
    adapter.writeProtected(target, "PREVIOUS_ENVELOPE", context);
    const controller = createPrivacyShowAnyDisplayController(
        createProtectedDisplayController,
        adapter,
        { displayResult: async () => ({ text: "Authorized display" }) },
    );

    await controller.display(target, { protected: "CURRENT_ENVELOPE" }, context);
    assert.equal(target.__heltoPrivacyShowAnyText, "Authorized display");
    assert.equal(lifecycleOptions.adapter, adapter);
    assert.equal(lifecycleOptions.failureCode, "PRIVACY_SHOW_ANY_REVEAL_BLOCKED");
    await assert.rejects(
        controller.display(target, { protected: { invalid: true } }, context),
        /PRIVACY_SHOW_ANY_REVEAL_BLOCKED/,
    );
    assert.equal(target.__heltoPrivacyShowAnyText, "");
});
