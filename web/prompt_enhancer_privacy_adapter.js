// Browser adapters for the shared Prompt Enhancer privacy profile.

import {
    createUtilsExternalWorkflowTransition,
    isUtilsCurrentModeEnvelope,
    managedNodeType,
    parseUtilsModeTransitionStorage,
    serializedWidgetIndex,
} from "./managed_mode_transition.js";

export const PROMPT_ENHANCER_SCRIPT_FIELD_ID = "prompt-enhancer-script";
export const PROMPT_ENHANCER_VARIABLES_FIELD_ID = "prompt-enhancer-variables";

const NODE_TYPE = "HeltoPromptEnhancer";
const EDITOR_STATE = "__heltoPromptEnhancerPromptEditor";
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CURRENT_SCHEMA = "helto.comfyui-utils";
const FIELD_FACTS = Object.freeze({
    [PROMPT_ENHANCER_SCRIPT_FIELD_ID]: Object.freeze({ widget: "script" }),
    [PROMPT_ENHANCER_VARIABLES_FIELD_ID]: Object.freeze({ widget: "variables" }),
});

function failure() {
    throw new Error("PRIVACY_PROMPT_ENHANCER_STATE_INVALID");
}

function facts(declaration) {
    const source = declaration?.field ?? declaration;
    const fieldId = source?.fieldId ?? source?.id;
    const value = FIELD_FACTS[fieldId];
    if (!value) failure();
    if (source?.location?.name !== undefined && source.location.name !== value.widget) failure();
    return value;
}

function widget(node, declaration) {
    const found = node?.widgets?.find((item) => item?.name === facts(declaration).widget);
    if (!found) failure();
    return found;
}

function unwrap(value) {
    if (value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === 1 && "value" in value) return value.value;
    return value;
}

function normalizeVariables(value) {
    let parsed = unwrap(value);
    if (typeof parsed === "string") {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            failure();
        }
    }
    if (!Array.isArray(parsed)) failure();
    const result = [];
    const names = new Set();
    for (const item of parsed) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const name = String(item.name || "").trim();
        if (!VARIABLE_NAME.test(name) || names.has(name)) continue;
        const values = Array.isArray(item.values)
            ? item.values.filter((entry) => entry !== null && entry !== undefined).map(String)
            : [];
        const fixedIndex = Math.max(
            0,
            Math.min(Number.parseInt(item.fixed_index ?? 0, 10) || 0, Math.max(values.length - 1, 0)),
        );
        result.push({
            name,
            mode: item.mode === "fixed" ? "fixed" : "random",
            values,
            fixed_index: fixedIndex,
        });
        names.add(name);
    }
    return result;
}

function normalizeValue(value, declaration) {
    const field = facts(declaration);
    const unwrapped = unwrap(value);
    if (field.widget === "script") {
        if (typeof unwrapped !== "string") failure();
        return { value: unwrapped };
    }
    return { value: normalizeVariables(unwrapped) };
}

function editor(node) {
    const state = node?.[EDITOR_STATE];
    if (!state || typeof state !== "object") failure();
    return state;
}

function clearEditor(node) {
    if (!node || (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE)) return;
    const state = node[EDITOR_STATE];
    if (!state || typeof state !== "object") return;
    state.promptText = "";
    state.variables = [];
    if (state.textarea) state.textarea.value = "";
}

export function createPromptEnhancerModeBrowserAdapter() {
    return {
        readDeclaredMode(node) {
            const value = node?.widgets?.find((item) => item?.name === "privacy_mode")?.value;
            return value === false ? "public" : "private";
        },
        writeDeclaredMode(node, mode) {
            if (!node || !["private", "public"].includes(mode)) failure();
            const modeWidget = node.widgets?.find((item) => item?.name === "privacy_mode");
            if (!modeWidget) failure();
            modeWidget.value = mode === "private";
        },
        reconcileNode(node) {
            const modeWidget = node?.widgets?.find((item) => item?.name === "privacy_mode");
            if (!modeWidget) failure();
            if (modeWidget.value === undefined) modeWidget.value = true;
        },
        reconcileNodeDefinition() {},
        onPrivacySessionChange() {},
    };
}

export function createPromptEnhancerWorkflowBrowserAdapter({ app = null } = {}) {
    let sessionLocked = false;
    const owners = new Set();

    function applyValue(node, value, context) {
        const normalized = normalizeValue(value, context).value;
        const state = editor(node);
        if ((context?.field?.id ?? context?.fieldId ?? context?.id) === PROMPT_ENHANCER_SCRIPT_FIELD_ID) {
            state.promptText = normalized;
            if (state.textarea) state.textarea.value = normalized;
        } else {
            state.variables = structuredClone(normalized);
        }
    }

    function clearValue(node, context) {
        const state = editor(node);
        facts(context);
        if ((context?.field?.id ?? context?.fieldId ?? context?.id) === PROMPT_ENHANCER_SCRIPT_FIELD_ID) {
            state.promptText = "";
            if (state.textarea) state.textarea.value = "";
        } else {
            state.variables = [];
        }
    }

    function reconcileOwner(node) {
        if (managedNodeType(node) !== NODE_TYPE) failure();
        owners.add(node);
        transition.synchronizeOwner(node);
        if (sessionLocked) clearEditor(node);
    }

    function detachedWidgetValue(node, serializedNode, context) {
        if (!Array.isArray(serializedNode?.widgets_values)) failure();
        const target = widget(node, context);
        const index = serializedWidgetIndex(node, target);
        if (!Number.isInteger(index) || index < 0 || index >= serializedNode.widgets_values.length) {
            failure();
        }
        const value = serializedNode.widgets_values[index];
        if (typeof value !== "string") failure();
        return value;
    }

    const transition = createUtilsExternalWorkflowTransition({
        app,
        owners,
        registerNode: reconcileOwner,
        readStorage(node, context) {
            return String(widget(node, context).value || "");
        },
        writeStorage(node, value, context) {
            widget(node, context).value = value;
        },
        readDetachedStorage: detachedWidgetValue,
        reloadRuntime(node, value, context) {
            const payload = parseUtilsModeTransitionStorage(value, failure);
            if (isUtilsCurrentModeEnvelope(payload, CURRENT_SCHEMA)) clearValue(node, context);
            else applyValue(node, payload, context);
        },
        reconcileRuntime(node) {
            if (sessionLocked) clearEditor(node);
        },
        fail: failure,
    });

    return {
        normalize(node, context) {
            const field = facts(context);
            const state = editor(node);
            const live = field.widget === "script" ? state.promptText : state.variables;
            return normalizeValue(live, context);
        },
        readProtected(node, context) {
            return String(widget(node, context).value || "");
        },
        writeProtected(node, protectedValue, context) {
            if (typeof protectedValue !== "string") failure();
            transition.withInternalMutation(() => {
                widget(node, context).value = protectedValue;
            });
        },
        writeWorkflowProjection(node, serializedNode, protectedValue, context) {
            if (typeof protectedValue !== "string" || !Array.isArray(serializedNode?.widgets_values)) {
                failure();
            }
            const target = widget(node, context);
            const index = serializedWidgetIndex(node, target);
            if (!Number.isInteger(index) || index < 0 || index >= serializedNode.widgets_values.length) {
                failure();
            }
            serializedNode.widgets_values[index] = protectedValue;
        },
        apply(node, value, context) {
            transition.requireMutable();
            applyValue(node, value, context);
        },
        clear(node, context) {
            transition.requireMutable();
            clearValue(node, context);
        },
        reconcileNode(node) {
            reconcileOwner(node);
        },
        reconcileNodeDefinition() {},
        onPrivacySessionChange(snapshot) {
            sessionLocked = snapshot?.state !== "ready" && snapshot?.state !== "unlocked";
        },
        ...transition,
    };
}
