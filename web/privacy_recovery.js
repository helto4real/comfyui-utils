import { selectorApi } from "./api.js";
import {
    registerPrivacyRecoveryDescriptors,
    recoverPrivacyIssues,
    scanPrivacyRecoveryIssues,
    showPrivacyRecoveryDialog,
} from "./privacy_common.js";
import { forgetPrivacyEnvelope, PRIVACY_ENVELOPE_SCHEMA } from "./privacy_envelope.js";

const SOURCE_ID = "comfyui-utils";
const SELECTOR_NODE = "HeltoImageSelector";
const PROMPT_ENHANCER_NODE = "HeltoPromptEnhancer";
const PRIVACY_SHOW_ANY_NODE = "HeltoPrivacyShowAny";
const SHOW_ANY_STATE_PROPERTY = "helto_privacy_show_any_encrypted_text_state";
const SHOW_ANY_PRIVACY_PROPERTY = "helto_privacy_show_any_privacy_mode";
const PROMPT_EDITOR_STATE = "__heltoPromptEnhancerPromptEditor";
const SHOW_ANY_DISPLAY_STATE = "__heltoPrivacyShowAnyText";
const SHOW_ANY_ENCRYPT_PROMISE = "__heltoPrivacyShowAnyEncryptPromise";
const SHOW_ANY_DISPLAY_WIDGET = "__heltoPrivacyShowAnyWidget";

let registrationPromise = null;
let globalAutoRecoveryPromise = null;
const AUTO_RECOVERY_PROMISES = new WeakMap();

function markNodeDirty(node) {
    node?.setDirtyCanvas?.(true, true);
    node?.graph?.setDirtyCanvas?.(true, true);
    globalThis.app?.canvas?.setDirty?.(true, true);
}

function forgetFieldMemo(node, field) {
    forgetPrivacyEnvelope(node, field?.name);
}

function isResetRecovery(field, issue) {
    if (!field || field.defaultValue === undefined) return false;
    const value = issue?._target?.get?.();
    return String(value ?? "") === String(field.defaultValue ?? "");
}

function resetSelectorRuntime(node, context = {}) {
    const { field, issue } = context;
    forgetFieldMemo(node, field);
    if (!isResetRecovery(field, issue)) return;
    if (!node) return;
    if (field?.name === "selected_images") node.selectedPaths = [];
    if (field?.name === "edited_masks") node.editedMasks = {};
    if (field?.name === "edited_bboxes") node.editedBboxes = {};
    node.syncUIWithProperties?.();
    node.onResize?.();
    markNodeDirty(node);
}

function resetPromptEnhancerRuntime(node, context = {}) {
    const { field, issue } = context;
    forgetFieldMemo(node, field);
    if (!isResetRecovery(field, issue)) return;
    const state = node?.[PROMPT_EDITOR_STATE];
    if (field?.name === "script") {
        if (state) {
            state.promptText = "";
            state.promptWidgetValue = null;
            if (state.textarea) state.textarea.value = "";
        }
    }
    if (field?.name === "variables") {
        if (state) {
            state.variables = [];
            state.variablesWidgetValue = null;
        }
    }
    markNodeDirty(node);
}

function resetPrivacyShowAnyRuntime(node, context = {}) {
    const { field, issue } = context;
    forgetFieldMemo(node, field);
    if (!isResetRecovery(field, issue)) return;
    if (!node) return;
    delete node[SHOW_ANY_DISPLAY_STATE];
    delete node[SHOW_ANY_ENCRYPT_PROMISE];
    if (node.properties) {
        delete node.properties[SHOW_ANY_STATE_PROPERTY];
    }
    const display = node[SHOW_ANY_DISPLAY_WIDGET];
    if (display?.textWidget) display.textWidget.value = "";
    if (display?.inputEl) display.inputEl.value = "";
    if (display?.textarea) display.textarea.value = "";
    markNodeDirty(node);
}

function encryptForRecovery(plaintext) {
    return selectorApi.encrypt(String(plaintext ?? ""));
}

function descriptors() {
    return [
        {
            id: `${SOURCE_ID}:selector`,
            nodeType: SELECTOR_NODE,
            label: "Helto Multi-Image Selector",
            schema: PRIVACY_ENVELOPE_SCHEMA,
            privacy: { property: "privacyMode", default: true },
            fields: [
                {
                    kind: "widget",
                    name: "selected_images",
                    label: "Selected images",
                    defaultValue: "[]",
                    sensitive: true,
                    reencrypt: encryptForRecovery,
                    clearRuntimeState: resetSelectorRuntime,
                },
                {
                    kind: "widget",
                    name: "edited_masks",
                    label: "Edited masks",
                    defaultValue: "{}",
                    sensitive: true,
                    reencrypt: encryptForRecovery,
                    clearRuntimeState: resetSelectorRuntime,
                },
                {
                    kind: "widget",
                    name: "edited_bboxes",
                    label: "Edited bounding boxes",
                    defaultValue: "{}",
                    sensitive: true,
                    reencrypt: encryptForRecovery,
                    clearRuntimeState: resetSelectorRuntime,
                },
            ],
        },
        {
            id: `${SOURCE_ID}:prompt-enhancer`,
            nodeType: PROMPT_ENHANCER_NODE,
            label: "Helto Prompt Enhancer",
            schema: PRIVACY_ENVELOPE_SCHEMA,
            privacy: { widget: "privacy_mode", default: true },
            fields: [
                {
                    kind: "widget",
                    name: "script",
                    label: "Prompt script",
                    defaultValue: "",
                    sensitive: true,
                    reencrypt: encryptForRecovery,
                    clearRuntimeState: resetPromptEnhancerRuntime,
                },
                {
                    kind: "widget",
                    name: "variables",
                    label: "Prompt variables",
                    defaultValue: "[]",
                    sensitive: true,
                    reencrypt: encryptForRecovery,
                    clearRuntimeState: resetPromptEnhancerRuntime,
                },
            ],
        },
        {
            id: `${SOURCE_ID}:privacy-show-any`,
            nodeType: PRIVACY_SHOW_ANY_NODE,
            label: "Helto Privacy Show Any",
            schema: PRIVACY_ENVELOPE_SCHEMA,
            privacy: { property: SHOW_ANY_PRIVACY_PROPERTY, default: true },
            fields: [
                {
                    kind: "widget",
                    name: "encrypted_text_state",
                    label: "Displayed text state",
                    defaultValue: "",
                    sensitive: true,
                    reencrypt: encryptForRecovery,
                    clearRuntimeState: resetPrivacyShowAnyRuntime,
                },
                {
                    kind: "property",
                    name: SHOW_ANY_STATE_PROPERTY,
                    label: "Displayed text state",
                    defaultValue: "",
                    sensitive: true,
                    reencrypt: encryptForRecovery,
                    clearRuntimeState: resetPrivacyShowAnyRuntime,
                },
            ],
        },
    ];
}

export function ensurePrivacyRecoveryRegistered() {
    if (!registrationPromise) {
        registrationPromise = registerPrivacyRecoveryDescriptors(SOURCE_ID, descriptors()).then((result) => {
            installManualPrivacyRecoveryEntryPoint();
            return result;
        });
    }
    return registrationPromise;
}

export async function showManualPrivacyRecovery(graph = globalThis.app?.graph ?? globalThis.app?.rootGraph) {
    await ensurePrivacyRecoveryRegistered();
    return showPrivacyRecoveryDialog({ mode: "manual", graph });
}

export async function showAutoPrivacyRecoveryIfIssues(graph = globalThis.app?.graph ?? globalThis.app?.rootGraph) {
    await ensurePrivacyRecoveryRegistered();
    const issues = await scanPrivacyRecoveryIssues(graph);
    if (!issues.length) {
        return { model: { totalIssues: 0, counts: {}, nodes: [] }, result: null };
    }

    if (graph && (typeof graph === "object" || typeof graph === "function")) {
        const existing = AUTO_RECOVERY_PROMISES.get(graph);
        if (existing) return existing;
        const pending = showPrivacyRecoveryDialog({ mode: "auto", graph }).finally(() => {
            AUTO_RECOVERY_PROMISES.delete(graph);
        });
        AUTO_RECOVERY_PROMISES.set(graph, pending);
        return pending;
    }

    if (!globalAutoRecoveryPromise) {
        globalAutoRecoveryPromise = showPrivacyRecoveryDialog({ mode: "auto", graph }).finally(() => {
            globalAutoRecoveryPromise = null;
        });
    }
    return globalAutoRecoveryPromise;
}

export async function recoverPrivacyWorkflowIssues(options = {}) {
    await ensurePrivacyRecoveryRegistered();
    return recoverPrivacyIssues(options);
}

export async function scanPrivacyWorkflowIssues(graph = globalThis.app?.graph ?? globalThis.app?.rootGraph) {
    await ensurePrivacyRecoveryRegistered();
    return scanPrivacyRecoveryIssues(graph);
}

function installManualPrivacyRecoveryEntryPoint() {
    const entryPoint = {
        open: showManualPrivacyRecovery,
        scan: scanPrivacyWorkflowIssues,
        recover: recoverPrivacyWorkflowIssues,
    };
    globalThis.heltoPrivacyRecovery = entryPoint;
    globalThis.showHeltoPrivacyRecovery = showManualPrivacyRecovery;
}
