import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    PROMPT_ENHANCER_SCRIPT_FIELD_ID,
    PROMPT_ENHANCER_VARIABLES_FIELD_ID,
    createPromptEnhancerModeBrowserAdapter,
    createPromptEnhancerWorkflowBrowserAdapter,
} from "../../web/prompt_enhancer_privacy_adapter.js";


const context = (fieldId) => ({ fieldId });
const script = context(PROMPT_ENHANCER_SCRIPT_FIELD_ID);
const variables = context(PROMPT_ENHANCER_VARIABLES_FIELD_ID);
const historicalFixture = JSON.parse(readFileSync(
    new URL("../fixtures/historical/utils_legacy_formats.json", import.meta.url),
    "utf8",
));
const historicalVariables = JSON.parse(
    historicalFixture.generations.priv3.promptEnhancerMigration.variables.expected,
);

function node() {
    return {
        comfyClass: "HeltoPromptEnhancer",
        widgets: [
            { name: "privacy_mode", value: undefined },
            { name: "script", value: "CURRENT_SCRIPT_CIPHERTEXT" },
            { name: "variables", value: "CURRENT_VARIABLES_CIPHERTEXT" },
        ],
        __heltoPromptEnhancerPromptEditor: {
            promptText: "old prompt",
            variables: [{ name: "old", mode: "random", values: [], fixed_index: 0 }],
            textarea: { value: "old prompt" },
        },
    };
}


test("prompt enhancer mode defaults private and only explicit public opts out", () => {
    const target = node();
    const adapter = createPromptEnhancerModeBrowserAdapter();

    assert.equal(adapter.readDeclaredMode(target), "private");
    adapter.reconcileNode(target);
    assert.equal(target.widgets[0].value, true);
    adapter.writeDeclaredMode(target, "public");
    assert.equal(target.widgets[0].value, false);
    assert.equal(adapter.readDeclaredMode(target), "public");
});


test("workflow adapter keeps plaintext in editor memory and ciphertext in widgets", () => {
    const target = node();
    const adapter = createPromptEnhancerWorkflowBrowserAdapter();
    const normalizedVariables = historicalVariables;

    target.__heltoPromptEnhancerPromptEditor.promptText = "new prompt";
    target.__heltoPromptEnhancerPromptEditor.variables = normalizedVariables;
    assert.deepEqual(
        adapter.normalize(target, { fieldId: PROMPT_ENHANCER_SCRIPT_FIELD_ID }),
        { value: "new prompt" },
    );
    assert.deepEqual(
        adapter.normalize(target, { fieldId: PROMPT_ENHANCER_VARIABLES_FIELD_ID }),
        { value: normalizedVariables },
    );
    target.__heltoPromptEnhancerPromptEditor.variables = "not-json";
    assert.throws(
        () => adapter.normalize(target, { fieldId: PROMPT_ENHANCER_VARIABLES_FIELD_ID }),
        /PRIVACY_PROMPT_ENHANCER_STATE_INVALID/,
    );
    target.__heltoPromptEnhancerPromptEditor.variables = normalizedVariables;

    adapter.apply(target, { value: "new prompt" }, script);
    adapter.apply(target, { value: normalizedVariables }, variables);
    assert.equal(target.__heltoPromptEnhancerPromptEditor.promptText, "new prompt");
    assert.equal(target.__heltoPromptEnhancerPromptEditor.textarea.value, "new prompt");
    assert.deepEqual(target.__heltoPromptEnhancerPromptEditor.variables, normalizedVariables);
    assert.equal(adapter.readProtected(target, script), "CURRENT_SCRIPT_CIPHERTEXT");
    assert.equal(adapter.readProtected(target, variables), "CURRENT_VARIABLES_CIPHERTEXT");
});


test("lock clears both editor fields without replacing protected widgets", () => {
    const target = node();
    const adapter = createPromptEnhancerWorkflowBrowserAdapter();

    adapter.onPrivacySessionChange({ state: "locked" });
    adapter.reconcileNode(target);

    assert.equal(target.__heltoPromptEnhancerPromptEditor.promptText, "");
    assert.equal(target.__heltoPromptEnhancerPromptEditor.textarea.value, "");
    assert.deepEqual(target.__heltoPromptEnhancerPromptEditor.variables, []);
    assert.equal(target.widgets[1].value, "CURRENT_SCRIPT_CIPHERTEXT");
    assert.equal(target.widgets[2].value, "CURRENT_VARIABLES_CIPHERTEXT");
});
