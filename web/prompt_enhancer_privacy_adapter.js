// Inactive browser adapters for the shared Prompt Enhancer privacy profile.

export const PROMPT_ENHANCER_SCRIPT_FIELD_ID = "prompt-enhancer-script";
export const PROMPT_ENHANCER_VARIABLES_FIELD_ID = "prompt-enhancer-variables";

const NODE_TYPE = "HeltoPromptEnhancer";
const EDITOR_STATE = "__heltoPromptEnhancerPromptEditor";
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELD_FACTS = Object.freeze({
    [PROMPT_ENHANCER_SCRIPT_FIELD_ID]: Object.freeze({ widget: "script" }),
    [PROMPT_ENHANCER_VARIABLES_FIELD_ID]: Object.freeze({ widget: "variables" }),
});

function failure() {
    throw new Error("PRIVACY_PROMPT_ENHANCER_STATE_INVALID");
}

function facts(declaration) {
    const fieldId = declaration?.fieldId ?? declaration?.id;
    const value = FIELD_FACTS[fieldId];
    if (!value) failure();
    if (declaration?.location?.name !== undefined && declaration.location.name !== value.widget) failure();
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

export function createPromptEnhancerWorkflowBrowserAdapter() {
    let sessionLocked = false;
    return {
        normalize(value, declaration) {
            const field = facts(declaration);
            const state = editor(value);
            const live = field.widget === "script" ? state.promptText : state.variables;
            return normalizeValue(live, declaration);
        },
        readProtected(node, declaration) {
            return widget(node, declaration).value;
        },
        writeProtected(node, declaration, protectedValue) {
            widget(node, declaration).value = protectedValue;
        },
        apply(node, value, declaration) {
            const normalized = normalizeValue(value, declaration).value;
            const state = editor(node);
            if (declaration.id === PROMPT_ENHANCER_SCRIPT_FIELD_ID) {
                state.promptText = normalized;
                if (state.textarea) state.textarea.value = normalized;
            } else {
                state.variables = structuredClone(normalized);
            }
        },
        clear(node, declaration) {
            const state = editor(node);
            facts(declaration);
            if (declaration.id === PROMPT_ENHANCER_SCRIPT_FIELD_ID) {
                state.promptText = "";
                if (state.textarea) state.textarea.value = "";
            } else {
                state.variables = [];
            }
        },
        reconcileNode(node) {
            if (sessionLocked) clearEditor(node);
        },
        reconcileNodeDefinition() {},
        onPrivacySessionChange(snapshot) {
            sessionLocked = snapshot?.state !== "ready" && snapshot?.state !== "unlocked";
        },
    };
}
