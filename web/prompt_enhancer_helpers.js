export const PROMPT_ENHANCER_NODE_CLASS = "HeltoPromptEnhancer";
export const PROMPT_EDITOR_WIDGET_NAME = "prompt editor";
export const PROMPT_EDITOR_HEIGHT = 180;
export const PROMPT_EDITOR_HORIZONTAL_INSET = 24;
export const PROMPT_EDITOR_PADDING = 6;
export const MAX_FIXED_SEED = 2147483647;
export const ENCRYPTED_PREFIX = "__HELTO_ENC__:";
export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SETTINGS_WIDGET_NAMES = Object.freeze([
    "hide_mode",
    "privacy_mode",
    "ollama_url",
    "ollama_keep_alive",
    "ollama_keep_alive_unit",
    "ollama_timeout",
]);

export const HIDDEN_WIDGET_NAMES = Object.freeze([
    "model",
    "prompt",
    "variables",
    ...SETTINGS_WIDGET_NAMES,
]);

export function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget?.name === name) ?? null;
}

export function setWidgetValue(widget, value) {
    if (!widget) return;
    widget.value = value;
    widget.callback?.(value);
}

export function readPromptValue(node) {
    return String(getWidget(node, "prompt")?.value ?? "");
}

export function writePromptValue(node, value) {
    setWidgetValue(getWidget(node, "prompt"), String(value ?? ""));
}

export function serializedPromptVariablesValue(node) {
    return String(getWidget(node, "variables")?.value || "[]");
}

export function shouldRefreshPromptVariables(node, cachedValue) {
    return serializedPromptVariablesValue(node) !== cachedValue;
}

export function promptEditorLayout(node, height = PROMPT_EDITOR_HEIGHT) {
    const rawWidth = Number(node?.size?.[0]);
    const nodeWidth = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : 320;
    const width = Math.max(0, nodeWidth - PROMPT_EDITOR_HORIZONTAL_INSET);
    const textareaWidth = Math.max(0, width - PROMPT_EDITOR_PADDING * 2);
    return {
        width,
        height,
        textareaWidth,
        textareaHeight: Math.max(40, height - PROMPT_EDITOR_PADDING * 2),
    };
}

export function setGenerateNewEachPrompt(node) {
    setWidgetValue(getWidget(node, "seed"), -1);
    return -1;
}

export function keepFixedPromptSeed(node) {
    const seed = getWidget(node, "seed")?.value;
    return Number.isFinite(Number(seed)) ? Number(seed) : -1;
}

export function setNewFixedPromptSeed(node, random = Math.random) {
    const seed = Math.max(1, Math.floor(random() * MAX_FIXED_SEED));
    setWidgetValue(getWidget(node, "seed"), seed);
    return seed;
}

export function readPromptEnhancerSettings(node) {
    return {
        hideMode: Boolean(getWidget(node, "hide_mode")?.value),
        privacyMode: Boolean(getWidget(node, "privacy_mode")?.value ?? true),
        ollamaUrl: String(getWidget(node, "ollama_url")?.value || "http://127.0.0.1:11434"),
        keepAlive: Number(getWidget(node, "ollama_keep_alive")?.value ?? 5),
        keepAliveUnit: String(getWidget(node, "ollama_keep_alive_unit")?.value || "minutes"),
        timeout: Number(getWidget(node, "ollama_timeout")?.value ?? 120),
    };
}

export function writePromptEnhancerSettings(node, settings) {
    setWidgetValue(getWidget(node, "hide_mode"), Boolean(settings.hideMode));
    setWidgetValue(getWidget(node, "privacy_mode"), Boolean(settings.privacyMode));
    setWidgetValue(getWidget(node, "ollama_url"), String(settings.ollamaUrl || "http://127.0.0.1:11434"));
    setWidgetValue(getWidget(node, "ollama_keep_alive"), Number(settings.keepAlive ?? 5));
    setWidgetValue(getWidget(node, "ollama_keep_alive_unit"), String(settings.keepAliveUnit || "minutes"));
    setWidgetValue(getWidget(node, "ollama_timeout"), Number(settings.timeout ?? 120));
}

export function modelOptionsWithCurrentValue(modelWidget, models) {
    const current = String(modelWidget?.value || "").trim();
    const values = Array.isArray(models) ? models.map((model) => String(model || "").trim()).filter(Boolean) : [];
    const uniqueValues = [...new Set(values)];
    if (current && !uniqueValues.includes(current)) {
        uniqueValues.unshift(current);
    }
    return uniqueValues;
}

export function updateModelOptions(selectorWidget, modelWidget, models) {
    const values = modelOptionsWithCurrentValue(modelWidget, models);
    if (!selectorWidget || !modelWidget || values.length === 0) {
        return false;
    }
    selectorWidget.options ??= {};
    selectorWidget.options.values = values;
    const current = String(modelWidget.value || "").trim();
    selectorWidget.value = values.includes(current) ? current : values[0];
    if (!current) {
        setWidgetValue(modelWidget, selectorWidget.value);
    }
    return true;
}

export function isPromptHideModeEnabled(node) {
    return Boolean(getWidget(node, "hide_mode")?.value);
}

export function promptWidgetBounds(node) {
    const widget = getWidget(node, PROMPT_EDITOR_WIDGET_NAME) || getWidget(node, "prompt");
    if (!widget) {
        return null;
    }

    const width = Number(node?.size?.[0]) || 320;
    const y = Number.isFinite(widget.last_y) ? widget.last_y : null;
    if (y === null) {
        return null;
    }

    const computedHeight = Number(widget.computedHeight);
    const explicitHeight = Number(widget.height);
    const computedSize = widget.computeSize?.(width);
    const computedSizeHeight = Array.isArray(computedSize) ? Number(computedSize[1]) : NaN;
    const height = [computedHeight, explicitHeight, computedSizeHeight]
        .find((value) => Number.isFinite(value) && value > 0) ?? 80;

    return {
        x: 0,
        y,
        width,
        height,
    };
}

export function isPointInPromptWidget(node, point) {
    const bounds = promptWidgetBounds(node);
    if (!bounds || !Array.isArray(point)) {
        return false;
    }
    const [x, y] = point;
    return x >= bounds.x &&
        x <= bounds.x + bounds.width &&
        y >= bounds.y &&
        y <= bounds.y + bounds.height;
}

export function shouldHidePromptWidget(node, promptHovered = false) {
    return isPromptHideModeEnabled(node) && !promptHovered;
}

export function isEncryptedVariables(value) {
    return String(value || "").startsWith(ENCRYPTED_PREFIX);
}

export function normalizePromptVariables(rawVariables) {
    const variables = Array.isArray(rawVariables) ? rawVariables : [];
    const normalized = [];
    const seenNames = new Set();
    for (const item of variables) {
        if (!item || typeof item !== "object") continue;
        const name = String(item.name || "").trim();
        if (!VARIABLE_NAME_PATTERN.test(name) || seenNames.has(name)) continue;
        const values = Array.isArray(item.values)
            ? item.values.filter((value) => value !== null && value !== undefined).map((value) => String(value))
            : [];
        const fixedIndex = Math.max(0, Math.min(Number.parseInt(item.fixed_index ?? 0, 10) || 0, Math.max(values.length - 1, 0)));
        normalized.push({
            name,
            mode: item.mode === "fixed" ? "fixed" : "random",
            values,
            fixed_index: fixedIndex,
        });
        seenNames.add(name);
    }
    return normalized;
}

export function parsePromptVariablesJson(value) {
    if (!value) return [];
    try {
        return normalizePromptVariables(JSON.parse(String(value)));
    } catch (err) {
        return [];
    }
}

export function serializePromptVariables(variables) {
    return JSON.stringify(normalizePromptVariables(variables));
}

export async function readPromptVariables(node, selectorApi) {
    const value = serializedPromptVariablesValue(node);
    if (!isEncryptedVariables(value)) {
        return parsePromptVariablesJson(value);
    }
    try {
        const response = await selectorApi.decrypt(value);
        return parsePromptVariablesJson(response?.data || "[]");
    } catch (err) {
        console.warn("Prompt enhancer variable decrypt failed:", err);
        return [];
    }
}

export async function writePromptVariables(node, variables, privacyMode, selectorApi) {
    const widget = getWidget(node, "variables");
    const plainJson = serializePromptVariables(variables);
    if (!privacyMode) {
        setWidgetValue(widget, plainJson);
        return plainJson;
    }
    const response = await selectorApi.encrypt(plainJson);
    const encrypted = String(response?.encrypted || "");
    if (!encrypted.startsWith(ENCRYPTED_PREFIX)) {
        throw new Error("Failed to encrypt Prompt enhancer variables.");
    }
    setWidgetValue(widget, encrypted);
    return widget?.value || "";
}

export function variableNames(variables) {
    return normalizePromptVariables(variables).map((variable) => variable.name);
}

export function addPromptVariable(variables, name = "variable") {
    const existing = new Set(variableNames(variables));
    let candidate = String(name || "variable").replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z_]/.test(candidate)) {
        candidate = `var_${candidate}`;
    }
    candidate = candidate || "variable";
    let uniqueName = candidate;
    let counter = 2;
    while (existing.has(uniqueName)) {
        uniqueName = `${candidate}_${counter}`;
        counter += 1;
    }
    return [
        ...normalizePromptVariables(variables),
        { name: uniqueName, mode: "random", values: [""], fixed_index: 0 },
    ];
}

export function updatePromptVariable(variables, index, patch) {
    const normalized = normalizePromptVariables(variables);
    if (!normalized[index]) return normalized;
    const next = [...normalized];
    next[index] = { ...next[index], ...patch };
    return normalizePromptVariables(next);
}

export function removePromptVariable(variables, index) {
    return normalizePromptVariables(variables).filter((_variable, itemIndex) => itemIndex !== index);
}

export function autocompleteStateForPrompt(text, cursor, variables, selectedIndex = 0) {
    const value = String(text ?? "");
    const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, value.length));
    const beforeCursor = value.slice(0, safeCursor);
    const openIndex = beforeCursor.lastIndexOf("{{");
    if (openIndex < 0) {
        return { active: false, start: safeCursor, end: safeCursor, prefix: "", options: [], selectedIndex: 0 };
    }
    if (beforeCursor.lastIndexOf("}}") > openIndex) {
        return { active: false, start: safeCursor, end: safeCursor, prefix: "", options: [], selectedIndex: 0 };
    }

    const prefix = beforeCursor.slice(openIndex + 2);
    if (!/^[A-Za-z0-9_]*$/.test(prefix)) {
        return { active: false, start: safeCursor, end: safeCursor, prefix: "", options: [], selectedIndex: 0 };
    }
    const names = variableNames(variables);
    const options = names.filter((name) => name.startsWith(prefix));
    const boundedIndex = options.length ? ((selectedIndex % options.length) + options.length) % options.length : 0;
    return {
        active: true,
        start: openIndex,
        end: safeCursor,
        prefix,
        options,
        selectedIndex: boundedIndex,
    };
}

export function moveAutocompleteSelection(state, delta) {
    if (!state?.active || !state.options?.length) return 0;
    return ((state.selectedIndex + delta) % state.options.length + state.options.length) % state.options.length;
}

export function insertVariableSuggestion(text, state, name) {
    const value = String(text ?? "");
    const selectedName = String(name || state?.options?.[state?.selectedIndex] || "");
    if (!state?.active || !selectedName) {
        return { text: value, cursor: Number(state?.end) || value.length };
    }
    const insertion = `{{${selectedName}}}`;
    const nextText = `${value.slice(0, state.start)}${insertion}${value.slice(state.end)}`;
    return { text: nextText, cursor: state.start + insertion.length };
}

async function parsePromptEnhancerResponse(response, fallbackMessage) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || fallbackMessage);
    }
    return data;
}

export async function fetchSystemPrompt(kind, fetchImpl = fetch) {
    const query = new URLSearchParams({ kind: String(kind || "") });
    const response = await fetchImpl(`/helto_prompt_enhancer/system_prompt?${query.toString()}`);
    return parsePromptEnhancerResponse(response, "Failed to load system prompt.");
}

export async function saveSystemPrompt(kind, prompt, fetchImpl = fetch) {
    const response = await fetchImpl("/helto_prompt_enhancer/system_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            kind,
            prompt,
        }),
    });
    return parsePromptEnhancerResponse(response, "Failed to save system prompt.");
}

export async function resetSystemPrompt(kind, fetchImpl = fetch) {
    const response = await fetchImpl("/helto_prompt_enhancer/system_prompt/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
    });
    return parsePromptEnhancerResponse(response, "Failed to reset system prompt.");
}

export function hideSerializedSettingsWidgets(node, collapseWidgetLayout) {
    for (const name of HIDDEN_WIDGET_NAMES) {
        const widget = getWidget(node, name);
        if (!widget) continue;
        widget.hidden = true;
        widget.type = "hidden";
        collapseWidgetLayout?.(widget);
    }
}
