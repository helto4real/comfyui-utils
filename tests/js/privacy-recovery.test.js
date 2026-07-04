import assert from "node:assert/strict";
import test from "node:test";

import { __setPrivacyModuleForTests } from "../../web/privacy_common.js";

function envelope(text = "encrypted", schema = "helto.comfyui-utils") {
    return JSON.stringify({
        algorithm: "AES-256-GCM",
        ciphertext: Buffer.from(String(text)).toString("base64"),
        encrypted: true,
        keyId: "test-key",
        nonce: "test-nonce",
        schema,
        version: 1,
    });
}

function widget(node, name) {
    return node.widgets?.find((item) => item.name === name) ?? null;
}

function isAcceptedEnvelope(value, schema = "helto.comfyui-utils") {
    try {
        const parsed = JSON.parse(String(value || ""));
        return parsed?.encrypted === true
            && parsed?.algorithm === "AES-256-GCM"
            && parsed?.schema === schema;
    } catch {
        return false;
    }
}

function nodeType(node) {
    return node.comfyClass || node.type || node.class_type || "";
}

function targetFor(node, field) {
    if (field.kind === "property") {
        return {
            exists: Object.prototype.hasOwnProperty.call(node.properties || {}, field.name),
            get: () => node.properties?.[field.name],
            set: (value) => {
                node.properties ??= {};
                node.properties[field.name] = value;
            },
        };
    }
    const found = widget(node, field.name);
    return {
        exists: Boolean(found),
        get: () => found?.value,
        set: (value) => {
            if (found) found.value = value;
        },
    };
}

function graphNodes(graph) {
    return graph?.nodes ?? graph?._nodes ?? [];
}

function fakePrivacyModule() {
    const descriptorMap = new Map();
    const module = {
        registerPrivacyRecoveryDescriptors(sourceId, descriptors) {
            const unique = new Map();
            for (const descriptor of descriptors) {
                unique.set(descriptor.id, descriptor);
            }
            descriptorMap.set(sourceId, [...unique.values()]);
            return {
                sourceId,
                descriptorCount: unique.size,
                totalDescriptors: [...descriptorMap.values()].flat().length,
            };
        },
        registeredPrivacyRecoveryDescriptors() {
            return [...descriptorMap.values()].flat().map((descriptor) => ({
                id: descriptor.id,
                sourceId: "comfyui-utils",
                nodeTypes: [descriptor.nodeType],
                fieldCount: descriptor.fields.length,
            }));
        },
        scanPrivacyRecoveryIssues(graph) {
            const issues = [];
            for (const node of graphNodes(graph)) {
                for (const descriptor of [...descriptorMap.values()].flat()) {
                    if (descriptor.nodeType !== nodeType(node)) continue;
                    const privacy = descriptor.privacy ? targetFor(node, {
                        kind: descriptor.privacy.widget ? "widget" : "property",
                        name: descriptor.privacy.name || descriptor.privacy.widget || descriptor.privacy.property,
                    }) : null;
                    const privacyMissing = privacy && (!privacy.exists || privacy.get() === undefined || privacy.get() === "");
                    const privacyEnabled = privacyMissing ? descriptor.privacy.default !== false : privacy?.get() !== false;
                    if (privacyMissing) {
                        issues.push({ type: "missing_privacy_setting", descriptor, field: null, node, target: privacy });
                    }
                    for (const field of descriptor.fields) {
                        const target = targetFor(node, field);
                        const value = target.get();
                        if (!target.exists || value === undefined || value === null || value === "" || String(value) === String(field.defaultValue)) {
                            continue;
                        }
                        if (!privacyEnabled) continue;
                        if (String(value).startsWith("__HELTO_ENC__:")) {
                            issues.push({ type: "legacy_encrypted_value", descriptor, field, node, target });
                        } else if (!isAcceptedEnvelope(value, descriptor.schema)) {
                            issues.push({ type: "plaintext_sensitive_value", descriptor, field, node, target });
                        }
                    }
                }
            }
            return issues.map((issue, index) => {
                const publicIssue = {
                    id: `issue-${index}`,
                    type: issue.type,
                    nodeType: nodeType(issue.node),
                    fieldName: issue.field?.name || issue.target?.name || "",
                    canReset: Boolean(issue.field?.defaultValue !== undefined),
                };
                Object.defineProperty(publicIssue, "_raw", { value: issue, enumerable: false });
                return publicIssue;
            });
        },
        async recoverPrivacyIssues({ action = "all_safe_defaults", graph, issues = module.scanPrivacyRecoveryIssues(graph) } = {}) {
            let appliedCount = 0;
            for (const issue of issues) {
                const raw = issue._raw;
                if (!raw) continue;
                if (raw.type === "missing_privacy_setting" && (action === "all_safe_defaults" || action === "enable_privacy")) {
                    raw.target.set(raw.descriptor.privacy.default);
                    appliedCount += 1;
                    continue;
                }
                if (raw.field && (action === "all_safe_defaults" || action === "reset")) {
                    raw.target.set(raw.field.defaultValue);
                    const callbackIssue = {};
                    Object.defineProperty(callbackIssue, "_target", { value: raw.target, enumerable: false });
                    raw.field.clearRuntimeState?.(raw.node, { field: raw.field, issue: callbackIssue });
                    appliedCount += 1;
                    continue;
                }
                if (raw.field && action === "reencrypt") {
                    const response = await raw.field.reencrypt(raw.target.get(), { node: raw.node, field: raw.field, issue });
                    raw.target.set(response.encrypted);
                    const callbackIssue = {};
                    Object.defineProperty(callbackIssue, "_target", { value: raw.target, enumerable: false });
                    raw.field.clearRuntimeState?.(raw.node, { field: raw.field, issue: callbackIssue });
                    appliedCount += 1;
                }
            }
            return { ok: true, action, appliedCount, skippedCount: 0, failedCount: 0 };
        },
        async showPrivacyRecoveryDialog(options = {}) {
            const issues = module.scanPrivacyRecoveryIssues(options.graph);
            const result = await module.recoverPrivacyIssues({ ...options, issues, action: "all_safe_defaults" });
            return { model: { totalIssues: issues.length }, result };
        },
        async ensureEncryptedPrivacyValue(options = {}) {
            const response = await options.encrypt(options.value);
            const encrypted = response?.encrypted ?? response;
            if (!isAcceptedEnvelope(encrypted, options.schema)) {
                throw new Error("PRIVACY_ENCRYPTION_FAILED");
            }
            return encrypted;
        },
        isPrivacyUnlockRequiredError(error) {
            return String(error?.message ?? error ?? "").includes("PRIVACY_LOCKED");
        },
    };
    return module;
}

async function loadRecoveryWithFakePrivacy() {
    const privacy = fakePrivacyModule();
    __setPrivacyModuleForTests(privacy);
    const recovery = await import(`../../web/privacy_recovery.js?test=${Date.now()}-${Math.random()}`);
    await recovery.ensurePrivacyRecoveryRegistered();
    return { privacy, recovery };
}

test("privacy recovery descriptors register once and expose manual entry point", async () => {
    const { privacy, recovery } = await loadRecoveryWithFakePrivacy();
    const first = await recovery.ensurePrivacyRecoveryRegistered();
    const second = await recovery.ensurePrivacyRecoveryRegistered();

    assert.equal(first.descriptorCount, 3);
    assert.equal(second.descriptorCount, 3);
    assert.deepEqual(
        privacy.registeredPrivacyRecoveryDescriptors().map((item) => item.id).sort(),
        [
            "comfyui-utils:privacy-show-any",
            "comfyui-utils:prompt-enhancer",
            "comfyui-utils:selector",
        ],
    );
    assert.equal(typeof globalThis.heltoPrivacyRecovery.open, "function");
    __setPrivacyModuleForTests(null);
});

test("privacy recovery resets selector plaintext and legacy state to safe defaults", async () => {
    const { recovery } = await loadRecoveryWithFakePrivacy();
    const selector = {
        comfyClass: "HeltoImageSelector",
        properties: { privacyMode: true },
        selectedPaths: ["/secret/image.png"],
        editedMasks: { "/secret/image.png": "mask" },
        editedBboxes: { "/secret/image.png": [{ x: 1 }] },
        widgets: [
            { name: "selected_images", value: "[\"/secret/image.png\"]" },
            { name: "edited_masks", value: "__HELTO_ENC__:old" },
            { name: "edited_bboxes", value: "{\"/secret/image.png\":[{\"x\":1}]" },
        ],
    };
    const graph = { nodes: [selector] };

    const issues = await recovery.scanPrivacyWorkflowIssues(graph);
    assert.equal(JSON.stringify(issues).includes("/secret/image.png"), false);

    const result = await recovery.showAutoPrivacyRecoveryIfIssues(graph);

    assert.equal(result.result.appliedCount, 3);
    assert.equal(widget(selector, "selected_images").value, "[]");
    assert.equal(widget(selector, "edited_masks").value, "{}");
    assert.equal(widget(selector, "edited_bboxes").value, "{}");
    assert.deepEqual(selector.selectedPaths, []);
    assert.deepEqual(selector.editedMasks, {});
    assert.deepEqual(selector.editedBboxes, {});
    __setPrivacyModuleForTests(null);
});

test("privacy recovery resets prompt enhancer and privacy show any state", async () => {
    const { recovery } = await loadRecoveryWithFakePrivacy();
    const promptState = {
        promptText: "secret prompt",
        promptWidgetValue: "secret prompt",
        textarea: { value: "secret prompt" },
        variables: [{ name: "secret", values: ["x"] }],
        variablesWidgetValue: "[{\"name\":\"secret\"}]",
    };
    const promptEnhancer = {
        comfyClass: "HeltoPromptEnhancer",
        __heltoPromptEnhancerPromptEditor: promptState,
        widgets: [
            { name: "privacy_mode", value: true },
            { name: "script", value: "secret prompt" },
            { name: "variables", value: "[{\"name\":\"secret\"}]" },
        ],
    };
    const showAny = {
        comfyClass: "HeltoPrivacyShowAny",
        properties: { helto_privacy_show_any_encrypted_text_state: "secret text" },
        __heltoPrivacyShowAnyText: "secret text",
        __heltoPrivacyShowAnyEncryptPromise: Promise.resolve("secret text"),
        widgets: [{ name: "encrypted_text_state", value: "secret text" }],
    };
    const graph = { nodes: [promptEnhancer, showAny] };

    const result = await recovery.showAutoPrivacyRecoveryIfIssues(graph);

    assert.equal(result.result.appliedCount, 5);
    assert.equal(widget(promptEnhancer, "script").value, "");
    assert.equal(widget(promptEnhancer, "variables").value, "[]");
    assert.equal(promptState.promptText, "");
    assert.equal(promptState.textarea.value, "");
    assert.deepEqual(promptState.variables, []);
    assert.equal(widget(showAny, "encrypted_text_state").value, "");
    assert.equal("helto_privacy_show_any_encrypted_text_state" in showAny.properties, false);
    assert.equal("__heltoPrivacyShowAnyText" in showAny, false);
    assert.equal("__heltoPrivacyShowAnyEncryptPromise" in showAny, false);
    __setPrivacyModuleForTests(null);
});

test("privacy recovery can re-encrypt plaintext when preserving data is selected", async () => {
    const { recovery } = await loadRecoveryWithFakePrivacy();
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        assert.equal(String(url), "/helto_selector/encrypt");
        return {
            ok: true,
            async json() {
                return { encrypted: envelope("preserved") };
            },
        };
    };
    const selector = {
        comfyClass: "HeltoImageSelector",
        properties: { privacyMode: true },
        widgets: [{ name: "selected_images", value: "[\"/secret/image.png\"]" }],
    };
    const graph = { nodes: [selector] };

    try {
        const result = await recovery.recoverPrivacyWorkflowIssues({
            action: "reencrypt",
            graph,
            issues: await recovery.scanPrivacyWorkflowIssues(graph),
        });

        assert.equal(result.appliedCount, 1);
        assert.equal(isAcceptedEnvelope(widget(selector, "selected_images").value), true);
    } finally {
        globalThis.fetch = oldFetch;
        __setPrivacyModuleForTests(null);
    }
});
