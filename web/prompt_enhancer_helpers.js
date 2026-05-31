export const PROMPT_ENHANCER_NODE_CLASS = "HeltoPromptEnhancer";
export const MAX_FIXED_SEED = 2147483647;

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

export function hideSerializedSettingsWidgets(node, collapseWidgetLayout) {
    for (const name of HIDDEN_WIDGET_NAMES) {
        const widget = getWidget(node, name);
        if (!widget) continue;
        widget.hidden = true;
        widget.type = "hidden";
        collapseWidgetLayout?.(widget);
    }
}
