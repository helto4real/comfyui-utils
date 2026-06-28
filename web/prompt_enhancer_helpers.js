export const PROMPT_ENHANCER_NODE_CLASS = "HeltoPromptEnhancer";
export const SCRIPT_WIDGET_NAME = "script";
export const PROMPT_EDITOR_WIDGET_NAME = "script editor";
export const PROMPT_EDITOR_HEIGHT = 180;
export const PROMPT_EDITOR_HORIZONTAL_INSET = 24;
export const PROMPT_EDITOR_PADDING = 6;
export const MAX_FIXED_SEED = 2147483647;
export const SEED_CONTROL_MODES = Object.freeze(["fixed", "increment", "decrement", "randomize"]);
export const ENCRYPTED_PREFIX = "__HELTO_ENC__:";
export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUEUED_SEED_MAX_AGE_MS = 10_000;
const QUEUED_SEED_STATE = "__heltoPromptEnhancerQueuedSeed";

export const SETTINGS_WIDGET_NAMES = Object.freeze([
    "hide_mode",
    "privacy_mode",
    "image_system_prompt_preset",
    "video_system_prompt_preset",
    "ollama_url",
    "ollama_keep_alive",
    "ollama_keep_alive_unit",
    "ollama_timeout",
    "generation_max_tokens",
]);

export const HIDDEN_WIDGET_NAMES = Object.freeze([
    "provider",
    "model_id",
    "model_backend",
    "provider_model_history",
    "vision_provider",
    "vision_model_id",
    "vision_model_backend",
    "model",
    SCRIPT_WIDGET_NAME,
    "variables",
    ...SETTINGS_WIDGET_NAMES,
]);

export function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget?.name === name) ?? null;
}

export function setWidgetValue(widget, value) {
    if (!widget) return;
    widget.value = value;
    if (typeof widget.callback === "function") {
        widget.callback(value);
    }
}

export function isPromptEnhancerNode(node) {
    return (
        node?.type === PROMPT_ENHANCER_NODE_CLASS
        || node?.comfyClass === PROMPT_ENHANCER_NODE_CLASS
        || node?.constructor?.type === PROMPT_ENHANCER_NODE_CLASS
        || node?.constructor?.comfyClass === PROMPT_ENHANCER_NODE_CLASS
        || node?.title === "Prompt enhancer"
    );
}

function randomUnit(random = Math.random) {
    if (random !== Math.random) {
        return random();
    }
    if (globalThis.crypto?.getRandomValues) {
        const values = new Uint32Array(2);
        globalThis.crypto.getRandomValues(values);
        return (((values[0] & 0x1fffff) * 0x100000000) + values[1]) / 0x20000000000000;
    }
    return Math.random();
}

export function randomFixedPromptSeed(random = Math.random) {
    return Math.max(1, Math.floor(randomUnit(random) * MAX_FIXED_SEED));
}

export function validPromptSeedControlMode(value) {
    return SEED_CONTROL_MODES.includes(value) ? value : null;
}

function controlWidgetValues(widget) {
    const values = widget?.options?.values;
    if (Array.isArray(values)) {
        return values;
    }
    if (values && typeof values === "object") {
        return [...Object.keys(values), ...Object.values(values)];
    }
    return [];
}

export function isPromptSeedControlWidget(widget, seedWidget = null) {
    const seedName = String(seedWidget?.name || "seed");
    const name = String(widget?.name || "");
    const label = String(widget?.label || "");
    const values = controlWidgetValues(widget);
    return (
        name === "control_after_generate"
        || label.toLocaleLowerCase() === "control after generate"
        || name === `${seedName}.control_after_generate`
        || name === `${seedName}_control_after_generate`
        || SEED_CONTROL_MODES.every((value) => values.includes(value))
    );
}

export function promptSeedControlWidget(node, seedWidget = getWidget(node, "seed")) {
    for (const widget of seedWidget?.linkedWidgets || []) {
        if (isPromptSeedControlWidget(widget, seedWidget)) {
            return widget;
        }
    }
    return node?.widgets?.find((widget) => widget !== seedWidget && isPromptSeedControlWidget(widget, seedWidget)) || null;
}

export function livePromptSeedControlMode(node) {
    const seedWidget = getWidget(node, "seed");
    const controlWidget = promptSeedControlWidget(node, seedWidget);
    return (
        validPromptSeedControlMode(controlWidget?.value)
        ?? validPromptSeedControlMode(seedWidget?.control_after_generate)
        ?? validPromptSeedControlMode(seedWidget?.options?.control_after_generate)
    );
}

function widgetSerializesToWorkflow(widget) {
    return Boolean(widget) && widget.serialize !== false && widget.options?.serialize !== false;
}

export function serializedWidgetIndex(node, targetWidget) {
    let serializedIndex = 0;
    for (const widget of node?.widgets || []) {
        if (widget === targetWidget) {
            return widgetSerializesToWorkflow(widget) ? serializedIndex : -1;
        }
        if (widgetSerializesToWorkflow(widget)) {
            serializedIndex += 1;
        }
    }
    return -1;
}

export function writeSerializedWidgetValue(node, widget, value) {
    const index = serializedWidgetIndex(node, widget);
    for (const values of [node?.widgets_values, node?.last_serialization?.widgets_values]) {
        if (Array.isArray(values) && index >= 0 && index < values.length) {
            values[index] = value;
        }
    }
}

export function writePromptEnhancerWidgetValue(node, widget, value) {
    if (!node || !widget) {
        return false;
    }
    const previousValue = widget.value;
    widget.value = value;
    if (typeof widget.callback === "function") {
        widget.callback(value, undefined, node, widget);
    }
    node.onWidgetChanged?.(widget.name ?? "", value, previousValue, widget);
    node.graph?.incrementVersion?.();
    node?.setDirtyCanvas?.(true, true);
    node?.graph?.setDirtyCanvas?.(true, true);
    return true;
}

export function writePromptSeedValue(node, seed) {
    const seedWidget = getWidget(node, "seed");
    if (!writePromptEnhancerWidgetValue(node, seedWidget, seed)) {
        return false;
    }
    writeSerializedWidgetValue(node, seedWidget, seed);
    return true;
}

export function writePromptSeedControlMode(node, mode) {
    const controlMode = validPromptSeedControlMode(mode);
    if (!controlMode) {
        return false;
    }
    const seedWidget = getWidget(node, "seed");
    const controlWidget = promptSeedControlWidget(node, seedWidget);
    if (!writePromptEnhancerWidgetValue(node, controlWidget, controlMode)) {
        return false;
    }
    writeSerializedWidgetValue(node, controlWidget, controlMode);
    return true;
}

export function promptEnhancerGraphNodes(graph) {
    const nodes = [];
    const seenNodes = new Set();
    const seenGraphs = new Set();

    function visit(currentGraph) {
        if (!currentGraph || seenGraphs.has(currentGraph)) {
            return;
        }
        seenGraphs.add(currentGraph);
        for (const node of currentGraph.nodes || currentGraph._nodes || []) {
            if (!node || seenNodes.has(node)) {
                continue;
            }
            seenNodes.add(node);
            nodes.push(node);
            if (node.subgraph) {
                visit(node.subgraph);
            }
        }
        const subgraphs = currentGraph.subgraphs;
        if (subgraphs instanceof Map) {
            for (const subgraph of subgraphs.values()) {
                visit(subgraph);
            }
        } else if (Array.isArray(subgraphs)) {
            for (const subgraph of subgraphs) {
                visit(subgraph);
            }
        } else if (subgraphs && typeof subgraphs === "object") {
            for (const subgraph of Object.values(subgraphs)) {
                visit(subgraph);
            }
        }
    }

    visit(graph);
    return nodes;
}

export function suspendPromptSeedControlCallbacks(controlWidget) {
    if (!controlWidget) {
        return null;
    }
    const beforeQueued = controlWidget.beforeQueued;
    const afterQueued = controlWidget.afterQueued;
    const beforeQueuedNoop = () => {};
    const afterQueuedNoop = () => {};
    controlWidget.beforeQueued = beforeQueuedNoop;
    controlWidget.afterQueued = afterQueuedNoop;
    return {
        controlWidget,
        beforeQueued,
        afterQueued,
        beforeQueuedNoop,
        afterQueuedNoop,
    };
}

export function restorePromptSeedControlCallbacks(suspended) {
    for (const item of suspended) {
        if (!item) {
            continue;
        }
        if (item.controlWidget.beforeQueued === item.beforeQueuedNoop) {
            item.controlWidget.beforeQueued = item.beforeQueued;
        }
        if (item.controlWidget.afterQueued === item.afterQueuedNoop) {
            item.controlWidget.afterQueued = item.afterQueued;
        }
    }
}

export function randomizePromptEnhancerSeedsBeforeQueue(graph, options = {}) {
    const queuedSeeds = [];
    const random = typeof options.random === "function" ? options.random : Math.random;
    const now = typeof options.now === "function" ? options.now : Date.now;
    for (const node of promptEnhancerGraphNodes(graph)) {
        if (!isPromptEnhancerNode(node) || livePromptSeedControlMode(node) !== "randomize") {
            continue;
        }
        const seedWidget = getWidget(node, "seed");
        const controlWidget = promptSeedControlWidget(node, seedWidget);
        const seed = randomFixedPromptSeed(random);
        if (!writePromptSeedValue(node, seed)) {
            continue;
        }
        node[QUEUED_SEED_STATE] = { seed, at: now() };
        queuedSeeds.push({
            node,
            seed,
            suspended: suspendPromptSeedControlCallbacks(controlWidget),
        });
    }
    return queuedSeeds;
}

export function restoreQueuedPromptEnhancerSeeds(queuedSeeds, options = {}) {
    const now = typeof options.now === "function" ? options.now : Date.now;
    restorePromptSeedControlCallbacks(queuedSeeds.map((item) => item.suspended).filter(Boolean));
    for (const { node, seed } of queuedSeeds) {
        const queuedSeed = node?.[QUEUED_SEED_STATE];
        if (!queuedSeed || queuedSeed.seed !== seed || now() - queuedSeed.at > QUEUED_SEED_MAX_AGE_MS) {
            continue;
        }
        if (Number(getWidget(node, "seed")?.value) !== Number(seed)) {
            writePromptSeedValue(node, seed);
        }
    }
}

export function readPromptValue(node) {
    return String(getWidget(node, SCRIPT_WIDGET_NAME)?.value ?? "");
}

export function writePromptValue(node, value) {
    setWidgetValue(getWidget(node, SCRIPT_WIDGET_NAME), String(value ?? ""));
}

export function serializedPromptValue(node) {
    return String(getWidget(node, SCRIPT_WIDGET_NAME)?.value || "");
}

export function isEncryptedText(value) {
    return String(value || "").startsWith(ENCRYPTED_PREFIX);
}

export async function decryptPromptText(value, selectorApi) {
    const serialized = String(value || "");
    if (!isEncryptedText(serialized)) {
        return serialized;
    }
    const response = await selectorApi.decrypt(serialized);
    const data = typeof response?.data === "string" ? response.data : "";
    return data === "[]" ? "" : data;
}

export async function readPromptText(node, selectorApi) {
    return decryptPromptText(serializedPromptValue(node), selectorApi);
}

export async function writePromptText(node, prompt, privacyMode, selectorApi) {
    const plain = String(prompt ?? "");
    if (!privacyMode) {
        writePromptValue(node, plain);
        return plain;
    }
    if (!plain) {
        writePromptValue(node, "");
        return "";
    }
    if (!isEncryptedText(serializedPromptValue(node))) {
        writePromptValue(node, "");
    }
    const response = await selectorApi.encrypt(plain);
    const encrypted = String(response?.encrypted || "");
    if (!isEncryptedText(encrypted)) {
        throw new Error("Failed to encrypt Prompt enhancer script.");
    }
    writePromptValue(node, encrypted);
    return encrypted;
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
    if (writePromptSeedControlMode(node, "randomize")) {
        return "randomize";
    }
    writePromptSeedValue(node, -1);
    return -1;
}

export function keepFixedPromptSeed(node) {
    writePromptSeedControlMode(node, "fixed");
    const seed = getWidget(node, "seed")?.value;
    return Number.isFinite(Number(seed)) ? Number(seed) : -1;
}

export function setNewFixedPromptSeed(node, random = Math.random) {
    const seed = randomFixedPromptSeed(random);
    writePromptSeedValue(node, seed);
    writePromptSeedControlMode(node, "fixed");
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
        maxTokens: Number(getWidget(node, "generation_max_tokens")?.value ?? 0),
        imageSystemPromptPreset: String(getWidget(node, "image_system_prompt_preset")?.value || "default"),
        videoSystemPromptPreset: String(getWidget(node, "video_system_prompt_preset")?.value || "default"),
    };
}

export function writePromptEnhancerSettings(node, settings) {
    setWidgetValue(getWidget(node, "hide_mode"), Boolean(settings.hideMode));
    setWidgetValue(getWidget(node, "privacy_mode"), Boolean(settings.privacyMode));
    setWidgetValue(getWidget(node, "image_system_prompt_preset"), String(settings.imageSystemPromptPreset || "default"));
    setWidgetValue(getWidget(node, "video_system_prompt_preset"), String(settings.videoSystemPromptPreset || "default"));
    setWidgetValue(getWidget(node, "ollama_url"), String(settings.ollamaUrl || "http://127.0.0.1:11434"));
    setWidgetValue(getWidget(node, "ollama_keep_alive"), Number(settings.keepAlive ?? 5));
    setWidgetValue(getWidget(node, "ollama_keep_alive_unit"), String(settings.keepAliveUnit || "minutes"));
    setWidgetValue(getWidget(node, "ollama_timeout"), Number(settings.timeout ?? 120));
    setWidgetValue(getWidget(node, "generation_max_tokens"), Number(settings.maxTokens ?? 0));
}

export function readPromptEnhancerModelConfig(node) {
    const legacyModel = String(getWidget(node, "model")?.value || "").trim();
    const provider = String(getWidget(node, "provider")?.value || "ollama").trim() || "ollama";
    const defaultModel = provider === "ollama" ? "llava:latest" : "";
    const modelId = String(getWidget(node, "model_id")?.value || legacyModel || defaultModel).trim();
    return {
        provider,
        modelId,
        modelBackend: String(getWidget(node, "model_backend")?.value || (provider === "ollama" ? "ollama" : "")).trim(),
        legacyModel,
    };
}

export function writePromptEnhancerModelConfig(node, config) {
    const provider = String(config?.provider || "ollama").trim() || "ollama";
    const modelId = String(config?.modelId || config?.model_id || config?.model || "").trim();
    const backend = String(config?.modelBackend || config?.backend || (provider === "ollama" ? "ollama" : "")).trim();
    setWidgetValue(getWidget(node, "provider"), provider);
    setWidgetValue(getWidget(node, "model_id"), modelId);
    setWidgetValue(getWidget(node, "model_backend"), backend);
    setWidgetValue(getWidget(node, "model"), modelId);
    return { provider, modelId, modelBackend: backend };
}

export function readPromptEnhancerVisionModelConfig(node) {
    const provider = String(getWidget(node, "vision_provider")?.value || "local_transformers_vlm").trim() || "local_transformers_vlm";
    const defaultModel = provider === "local_transformers_vlm" ? "qwen3_vl_4b_fast" : "";
    const modelId = String(getWidget(node, "vision_model_id")?.value || defaultModel).trim();
    return {
        provider,
        modelId,
        modelBackend: String(getWidget(node, "vision_model_backend")?.value || (provider === "ollama" ? "ollama" : "")).trim(),
    };
}

export function writePromptEnhancerVisionModelConfig(node, config) {
    const provider = String(config?.provider || "local_transformers_vlm").trim() || "local_transformers_vlm";
    const modelId = String(config?.modelId || config?.model_id || config?.model || "").trim();
    const backend = String(config?.modelBackend || config?.backend || (provider === "ollama" ? "ollama" : "")).trim();
    setWidgetValue(getWidget(node, "vision_provider"), provider);
    setWidgetValue(getWidget(node, "vision_model_id"), modelId);
    setWidgetValue(getWidget(node, "vision_model_backend"), backend);
    return { provider, modelId, modelBackend: backend };
}

export function syncPromptEnhancerSelectorsFromSerializedState(
    node,
    providerSelector,
    modelSelector,
    visionProviderSelector,
    visionModelSelector,
) {
    const config = readPromptEnhancerModelConfig(node);
    syncSelectorValue(providerSelector, config.provider);
    syncSelectorValue(modelSelector, config.modelId);

    const visionConfig = readPromptEnhancerVisionModelConfig(node);
    syncSelectorValue(visionProviderSelector, visionConfig.provider);
    syncSelectorValue(visionModelSelector, visionConfig.modelId);
    return { model: config, vision: visionConfig };
}

function syncSelectorValue(selector, value) {
    const nextValue = String(value || "").trim();
    if (!selector || !nextValue) {
        return;
    }
    selector.options ??= {};
    const values = Array.isArray(selector.options.values) ? selector.options.values.map(String) : [];
    if (!values.includes(nextValue)) {
        values.unshift(nextValue);
    }
    selector.options.values = values;
    selector.value = nextValue;
}

export function readProviderModelHistory(node) {
    const raw = String(getWidget(node, "provider_model_history")?.value || "{}");
    let parsed = {};
    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
    }
    const history = {};
    for (const [provider, entry] of Object.entries(parsed)) {
        const providerId = String(provider || "").trim();
        if (!providerId || !entry || typeof entry !== "object" || Array.isArray(entry)) {
            continue;
        }
        const modelId = String(entry.modelId || entry.model_id || entry.model || "").trim();
        if (!modelId) {
            continue;
        }
        history[providerId] = {
            modelId,
            modelBackend: String(entry.modelBackend || entry.backend || (providerId === "ollama" ? "ollama" : "")).trim(),
        };
    }
    return history;
}

export function writeProviderModelHistory(node, history) {
    const normalized = {};
    if (history && typeof history === "object" && !Array.isArray(history)) {
        for (const [provider, entry] of Object.entries(history)) {
            const providerId = String(provider || "").trim();
            const modelId = String(entry?.modelId || entry?.model_id || entry?.model || "").trim();
            if (!providerId || !modelId) {
                continue;
            }
            normalized[providerId] = {
                modelId,
                modelBackend: String(entry?.modelBackend || entry?.backend || (providerId === "ollama" ? "ollama" : "")).trim(),
            };
        }
    }
    const serialized = JSON.stringify(normalized);
    setWidgetValue(getWidget(node, "provider_model_history"), serialized);
    return normalized;
}

export function rememberPromptEnhancerProviderModel(node, config = readPromptEnhancerModelConfig(node)) {
    const provider = String(config?.provider || "ollama").trim() || "ollama";
    const modelId = String(config?.modelId || config?.model_id || config?.model || "").trim();
    if (!modelId) {
        return readProviderModelHistory(node);
    }
    const history = readProviderModelHistory(node);
    history[provider] = {
        modelId,
        modelBackend: String(config?.modelBackend || config?.backend || (provider === "ollama" ? "ollama" : "")).trim(),
    };
    return writeProviderModelHistory(node, history);
}

export function seedProviderModelHistory(node) {
    const config = readPromptEnhancerModelConfig(node);
    const history = readProviderModelHistory(node);
    if (config.modelId && !history[config.provider]) {
        history[config.provider] = {
            modelId: config.modelId,
            modelBackend: config.modelBackend,
        };
        return writeProviderModelHistory(node, history);
    }
    return history;
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

export function normalizeProviderCatalog(payload) {
    const models = Array.isArray(payload?.models)
        ? payload.models
            .filter((model) => model && typeof model === "object")
            .map((model) => ({
                provider: String(model.provider || "ollama").trim() || "ollama",
                model_id: String(model.model_id || model.alias || model.label || "").trim(),
                alias: String(model.alias || model.model_id || model.label || "").trim(),
                label: String(model.label || model.alias || model.model_id || "").trim(),
                backend: String(model.backend || "").trim(),
                status: String(model.status || "").trim(),
                downloaded: Boolean(model.downloaded),
                loaded: Boolean(model.loaded),
                local_path: String(model.local_path || ""),
                missing_dependencies: Array.isArray(model.missing_dependencies) ? model.missing_dependencies.map(String) : [],
                supports_images: Boolean(model.supports_images),
                generator_supported: Boolean(model.generator_supported ?? true),
            }))
            .filter((model) => model.model_id)
        : [];
    const providerIds = new Set(models.map((model) => model.provider));
    const providers = Array.isArray(payload?.providers)
        ? payload.providers
            .filter((provider) => provider && provider.id)
            .map((provider) => ({ id: String(provider.id), label: String(provider.label || provider.id) }))
        : [];
    if (providers.length === 0) {
        providers.push({ id: "ollama", label: "Ollama" });
    }
    for (const providerId of providerIds) {
        if (!providers.some((provider) => provider.id === providerId)) {
            providers.push({ id: providerId, label: providerId });
        }
    }
    return {
        ok: Boolean(payload?.ok ?? true),
        providers,
        models,
        ollama_error: String(payload?.ollama_error || ""),
    };
}

export function modelOptionsForProvider(catalog, provider, currentModelId = "") {
    const providerId = String(provider || "ollama");
    const current = String(currentModelId || "").trim();
    const values = normalizeProviderCatalog(catalog).models
        .filter((model) => model.provider === providerId)
        .map((model) => model.model_id);
    const uniqueValues = [...new Set(values)];
    if (current && !uniqueValues.includes(current)) {
        uniqueValues.unshift(current);
    }
    return uniqueValues;
}

export function modelSupportsImages(catalog, provider, modelId) {
    const providerId = String(provider || "ollama");
    const id = String(modelId || "").trim();
    const model = normalizeProviderCatalog(catalog).models
        .find((entry) => entry.provider === providerId && entry.model_id === id);
    return Boolean(model?.supports_images);
}

export function updateProviderModelOptions(providerSelector, modelSelector, node, catalogPayload) {
    const catalog = normalizeProviderCatalog(catalogPayload);
    const config = readPromptEnhancerModelConfig(node);
    let history = seedProviderModelHistory(node);
    const providerValues = catalog.providers.map((provider) => provider.id);
    if (!providerValues.includes(config.provider)) {
        providerValues.unshift(config.provider);
    }
    const requestedProvider = String(providerSelector?.value || config.provider || "ollama").trim() || "ollama";
    const nextProvider = providerValues.includes(requestedProvider) ? requestedProvider : providerValues[0];
    if (nextProvider !== config.provider && config.modelId) {
        history[config.provider] = {
            modelId: config.modelId,
            modelBackend: config.modelBackend,
        };
        history = writeProviderModelHistory(node, history);
    }
    if (providerSelector) {
        providerSelector.options ??= {};
        providerSelector.options.values = providerValues;
        providerSelector.value = nextProvider;
    }
    const provider = String(providerSelector?.value || nextProvider || "ollama");
    const modelValues = [...new Set(catalog.models
        .filter((model) => model.provider === provider)
        .map((model) => model.model_id))];
    if (!modelSelector || modelValues.length === 0) {
        return false;
    }
    modelSelector.options ??= {};
    modelSelector.options.values = modelValues;
    const remembered = history[provider];
    if (remembered?.modelId && modelValues.includes(remembered.modelId)) {
        modelSelector.value = remembered.modelId;
    } else if (!remembered?.modelId && provider === config.provider && config.modelId && modelValues.includes(config.modelId)) {
        modelSelector.value = config.modelId;
    } else {
        modelSelector.value = modelValues[0];
    }
    const selectedModel = catalog.models.find((model) => model.provider === provider && model.model_id === modelSelector.value);
    const written = writePromptEnhancerModelConfig(node, {
        provider,
        modelId: modelSelector.value,
        modelBackend: selectedModel?.backend || (provider === "ollama" ? "ollama" : ""),
    });
    rememberPromptEnhancerProviderModel(node, written);
    return true;
}

export function updateVisionProviderModelOptions(providerSelector, modelSelector, node, catalogPayload) {
    const catalog = normalizeProviderCatalog(catalogPayload);
    const config = readPromptEnhancerVisionModelConfig(node);
    const imageProviders = catalog.providers
        .filter((provider) => catalog.models.some((model) => (
            model.provider === provider.id && model.supports_images && model.generator_supported
        )));
    const providerValues = imageProviders.map((provider) => provider.id);
    if (config.provider && !providerValues.includes(config.provider)) {
        providerValues.unshift(config.provider);
    }
    if (providerValues.length === 0) {
        return false;
    }
    const requestedProvider = String(providerSelector?.value || config.provider || providerValues[0]).trim() || providerValues[0];
    const provider = providerValues.includes(requestedProvider) ? requestedProvider : providerValues[0];
    if (providerSelector) {
        providerSelector.options ??= {};
        providerSelector.options.values = providerValues;
        providerSelector.value = provider;
    }
    const modelValues = [...new Set(catalog.models
        .filter((model) => model.provider === provider && model.supports_images && model.generator_supported)
        .map((model) => model.model_id))];
    if (!modelSelector || modelValues.length === 0) {
        return false;
    }
    modelSelector.options ??= {};
    modelSelector.options.values = modelValues;
    modelSelector.value = modelValues.includes(config.modelId) ? config.modelId : modelValues[0];
    const selectedModel = catalog.models.find((model) => model.provider === provider && model.model_id === modelSelector.value);
    writePromptEnhancerVisionModelConfig(node, {
        provider,
        modelId: modelSelector.value,
        modelBackend: selectedModel?.backend || (provider === "ollama" ? "ollama" : ""),
    });
    return true;
}

export function isPromptHideModeEnabled(node) {
    return Boolean(getWidget(node, "hide_mode")?.value);
}

export function promptWidgetBounds(node) {
    const widget = getWidget(node, PROMPT_EDITOR_WIDGET_NAME) || getWidget(node, SCRIPT_WIDGET_NAME);
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

export function shouldHidePromptWidget(node, promptHovered = false, autocompleteVisible = false) {
    return isPromptHideModeEnabled(node) && !promptHovered && !autocompleteVisible;
}

export function isEncryptedVariables(value) {
    return isEncryptedText(value);
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
    if (!isEncryptedText(encrypted)) {
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

export function autocompleteStateForPrompt(text, cursor, variables, selectedIndex = 0, context = {}) {
    const value = String(text ?? "");
    const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, value.length));
    const beforeCursor = value.slice(0, safeCursor);
    const openIndex = beforeCursor.lastIndexOf("{{");
    if (openIndex < 0) {
        return scriptAutocompleteState(value, safeCursor, selectedIndex, context);
    }
    if (beforeCursor.lastIndexOf("}}") > openIndex) {
        return scriptAutocompleteState(value, safeCursor, selectedIndex, context);
    }

    const prefix = beforeCursor.slice(openIndex + 2);
    if (!/^[A-Za-z0-9_]*$/.test(prefix)) {
        return scriptAutocompleteState(value, safeCursor, selectedIndex, context);
    }
    const names = variableNames(variables);
    const options = names.filter((name) => name.startsWith(prefix));
    const boundedIndex = options.length ? ((selectedIndex % options.length) + options.length) % options.length : 0;
    return {
        active: true,
        kind: "variable",
        start: openIndex,
        end: safeCursor,
        prefix,
        options,
        selectedIndex: boundedIndex,
    };
}

export const VIDEO_METADATA_COMPLETIONS = Object.freeze([
    "rating=",
    "style=",
    "default_reference_mode=",
    "reference_mode=",
    "camera=",
    "duration=",
    "continuity=",
    "continuity_mode=",
]);

export const VIDEO_REFERENCE_MODE_COMPLETIONS = Object.freeze([
    "none",
    "start_frame",
    "end_guidance",
    "start_and_end_transition",
    "character_reference",
    "style_reference",
    "mixed",
]);

export const VIDEO_IMAGE_ROLE_COMPLETIONS = Object.freeze([
    "start",
    "end",
    "character",
    "style",
    "pose",
    "setting",
    "motion",
]);

export const VIDEO_IMAGE_MODIFIER_COMPLETIONS = Object.freeze([
    "describe",
]);

export function scriptAutocompleteState(text, cursor, selectedIndex = 0, context = {}) {
    const value = String(text ?? "");
    const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, value.length));
    const beforeCursor = value.slice(0, safeCursor);
    const lineStart = beforeCursor.lastIndexOf("\n") + 1;
    const linePrefix = beforeCursor.slice(lineStart);
    const promptType = String(context?.promptType || "").toLowerCase();
    const isVideoPrompt = promptType === "video" || promptType === "multi scene video" || context?.videoScript === true;
    if (!isVideoPrompt) {
        return inactiveAutocomplete(safeCursor);
    }

    const metadata = metadataAutocomplete(linePrefix, lineStart, safeCursor, selectedIndex);
    if (metadata.active) return metadata;

    const modifier = imageModifierAutocomplete(beforeCursor, safeCursor, selectedIndex);
    if (modifier.active) return modifier;

    const role = imageRoleAutocomplete(beforeCursor, safeCursor, selectedIndex);
    if (role.active) return role;

    const image = imageReferenceAutocomplete(beforeCursor, safeCursor, selectedIndex, context);
    if (image.active) return image;

    const continuity = continuityAutocomplete(linePrefix, lineStart, safeCursor, selectedIndex);
    if (continuity.active) return continuity;

    return inactiveAutocomplete(safeCursor);
}

export function moveAutocompleteSelection(state, delta) {
    if (!state?.active || !state.options?.length) return 0;
    return ((state.selectedIndex + delta) % state.options.length + state.options.length) % state.options.length;
}

export function emptyAutocompleteState(cursor = 0) {
    return inactiveAutocomplete(cursor);
}

export function isPromptAutocompleteVisible(autocomplete, suggestionsHidden = false) {
    return Boolean(autocomplete?.active && autocomplete?.options?.length > 0 && !suggestionsHidden);
}

export function promptSuggestionPopupPosition(options = {}) {
    const lineHeight = positiveNumber(options.lineHeight, 18);
    const paddingTop = Math.max(0, numberOr(options.paddingTop, 0));
    const paddingLeft = Math.max(0, numberOr(options.paddingLeft, 0));
    const scrollTop = Math.max(0, numberOr(options.scrollTop, 0));
    const textareaHeight = Math.max(1, positiveNumber(options.textareaHeight, 120));
    const textareaOffsetTop = numberOr(options.textareaOffsetTop, 0);
    const textareaOffsetLeft = numberOr(options.textareaOffsetLeft, 0);
    const containerHeight = Math.max(1, positiveNumber(options.containerHeight, textareaHeight + textareaOffsetTop));
    const containerWidth = Math.max(1, positiveNumber(options.containerWidth, positiveNumber(options.textareaWidth, 240)));
    const popupHeight = Math.max(1, positiveNumber(options.popupHeight, 132));
    const popupWidth = Math.max(1, positiveNumber(options.popupWidth, 160));
    const gap = Math.max(0, numberOr(options.gap, 4));
    const cursor = Math.max(0, Math.min(Number(options.cursor) || 0, String(options.text ?? "").length));
    const lineIndex = String(options.text ?? "").slice(0, cursor).split("\n").length - 1;
    const estimatedLineTop = textareaOffsetTop + paddingTop + (lineIndex * lineHeight) - scrollTop;
    const visualLineTop = options.visualLineTop;
    const lineTop = Number.isFinite(Number(visualLineTop)) ? Number(visualLineTop) : estimatedLineTop;
    const belowTop = lineTop + lineHeight + gap;
    const aboveTop = lineTop - popupHeight - gap;
    const maxTop = Math.max(0, containerHeight - popupHeight);
    const preferBelow = Boolean(options.preferBelow);
    const top = preferBelow
        ? belowTop
        : belowTop + popupHeight <= containerHeight
        ? belowTop
        : aboveTop >= 0
            ? aboveTop
            : clamp(belowTop, 0, maxTop);
    const maxLeft = Math.max(0, containerWidth - popupWidth);
    const left = clamp(textareaOffsetLeft + paddingLeft, 0, maxLeft);

    return {
        left,
        top: preferBelow ? Math.max(0, top) : clamp(top, 0, maxTop),
        maxWidth: Math.max(1, containerWidth - left),
        placement: preferBelow || belowTop + popupHeight <= containerHeight ? "below" : "above",
    };
}

export function promptAutocompleteShortcutAction(event, autocomplete) {
    return promptAutocompleteShortcutGuardAction(event, autocomplete, true);
}

export function promptAutocompleteShortcutGuardAction(event, autocomplete, editorFocused = true) {
    if (!editorFocused || !isPromptAutocompleteVisible(autocomplete)) return "";
    const key = String(event?.key || "");
    const normalizedKey = key.toLowerCase();
    const hasTextModifier = Boolean(event?.ctrlKey || event?.metaKey || event?.altKey);
    let action = "";
    if (key === "Escape") {
        action = "close";
    } else if (event?.ctrlKey && normalizedKey === "y") {
        action = "accept";
    } else if (!hasTextModifier && (key === "Enter" || key === "Tab")) {
        action = "accept";
    } else if (!hasTextModifier && key === "ArrowDown") {
        action = "next";
    } else if (!hasTextModifier && key === "ArrowUp") {
        action = "previous";
    }
    if (action) {
        consumeAutocompleteShortcutEvent(event);
    }
    return action;
}

export function acceptPromptAutocompleteSuggestion(text, autocomplete, variables = [], context = {}, explicitName = null) {
    const result = insertVariableSuggestion(text, autocomplete, explicitName);
    const nextAutocomplete = autocompleteStateForPrompt(result.text, result.cursor, variables, 0, context);
    return {
        text: result.text,
        cursor: result.cursor,
        autocomplete: shouldContinueAutocompleteAfterAccept(autocomplete, nextAutocomplete)
            ? nextAutocomplete
            : emptyAutocompleteState(result.cursor),
    };
}

export function createPromptAutocompleteDismissalState(text = "", cursor = 0) {
    return {
        suppressed: false,
        text: String(text ?? ""),
        cursor: Math.max(0, Number(cursor) || 0),
    };
}

export function dismissPromptAutocompleteUntilInput(text, cursor, state = null) {
    const next = state || createPromptAutocompleteDismissalState();
    next.suppressed = true;
    next.text = String(text ?? "");
    next.cursor = Math.max(0, Number(cursor) || 0);
    return next;
}

export function clearPromptAutocompleteDismissal(state, text, cursor) {
    const next = state || createPromptAutocompleteDismissalState();
    next.suppressed = false;
    next.text = String(text ?? "");
    next.cursor = Math.max(0, Number(cursor) || 0);
    return next;
}

export function shouldSuppressPromptAutocompleteRefresh(state, text, cursor) {
    if (!state?.suppressed) {
        return false;
    }
    return state.text === String(text ?? "");
}

function consumeAutocompleteShortcutEvent(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
}

function shouldContinueAutocompleteAfterAccept(previousAutocomplete, nextAutocomplete) {
    if (!previousAutocomplete?.active || !nextAutocomplete?.active) return false;
    return previousAutocomplete.kind === "metadata_key" && nextAutocomplete.kind === "metadata_value";
}

function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function insertVariableSuggestion(text, state, name) {
    const value = String(text ?? "");
    const selectedName = String(name || state?.options?.[state?.selectedIndex] || "");
    if (!state?.active || !selectedName) {
        return { text: value, cursor: Number(state?.end) || value.length };
    }
    let insertion = selectedName;
    if (state.kind === "variable" || !state.kind) {
        insertion = `{{${selectedName}}}`;
    } else if (state.kind === "metadata_key") {
        insertion = `[${selectedName}`;
    } else if (state.kind === "metadata_value") {
        insertion = `[${state.key}=${selectedName}]`;
    } else if (state.kind === "continuity") {
        insertion = ">> ";
    }
    const nextText = `${value.slice(0, state.start)}${insertion}${value.slice(state.end)}`;
    return { text: nextText, cursor: state.start + insertion.length };
}

function inactiveAutocomplete(cursor) {
    return { active: false, start: cursor, end: cursor, prefix: "", options: [], selectedIndex: 0 };
}

function boundedAutocompleteIndex(options, selectedIndex) {
    return options.length ? ((selectedIndex % options.length) + options.length) % options.length : 0;
}

function metadataAutocomplete(linePrefix, lineStart, safeCursor, selectedIndex) {
    const openIndex = linePrefix.lastIndexOf("[");
    if (openIndex < 0 || linePrefix.includes("]")) {
        return inactiveAutocomplete(safeCursor);
    }
    const token = linePrefix.slice(openIndex + 1);
    if (!/^[A-Za-z0-9_]*(=.*)?$/.test(token)) {
        return inactiveAutocomplete(safeCursor);
    }
    const absoluteStart = lineStart + openIndex;
    if (token.includes("=")) {
        const [rawKey, ...rest] = token.split("=");
        const key = rawKey.trim();
        const prefix = rest.join("=");
        const candidates = metadataValueCompletions(key);
        const options = candidates.filter((option) => option.startsWith(prefix));
        return {
            active: options.length > 0,
            kind: "metadata_value",
            key,
            start: absoluteStart,
            end: safeCursor,
            prefix,
            options,
            selectedIndex: boundedAutocompleteIndex(options, selectedIndex),
        };
    }
    const options = VIDEO_METADATA_COMPLETIONS.filter((option) => option.startsWith(token));
    return {
        active: options.length > 0,
        kind: "metadata_key",
        start: absoluteStart,
        end: safeCursor,
        prefix: token,
        options,
        selectedIndex: boundedAutocompleteIndex(options, selectedIndex),
    };
}

function metadataValueCompletions(key) {
    if (key === "rating") return ["SFW", "NSFW"];
    if (key === "reference_mode" || key === "default_reference_mode") return VIDEO_REFERENCE_MODE_COMPLETIONS;
    return [];
}

function imageRoleAutocomplete(beforeCursor, safeCursor, selectedIndex) {
    const match = beforeCursor.match(/@image\d+:([A-Za-z_]*)$/i);
    if (!match) {
        return inactiveAutocomplete(safeCursor);
    }
    const prefix = match[1] || "";
    const normalizedPrefix = prefix.toLowerCase();
    const options = VIDEO_IMAGE_ROLE_COMPLETIONS.filter((option) => option.startsWith(normalizedPrefix));
    if (options.length === 1 && options[0] === normalizedPrefix) {
        return inactiveAutocomplete(safeCursor);
    }
    return {
        active: options.length > 0,
        kind: "image_role",
        start: safeCursor - prefix.length,
        end: safeCursor,
        prefix,
        options,
        selectedIndex: boundedAutocompleteIndex(options, selectedIndex),
    };
}

function imageModifierAutocomplete(beforeCursor, safeCursor, selectedIndex) {
    const match = beforeCursor.match(/@image\d+:[A-Za-z_][A-Za-z0-9_-]*:([A-Za-z_]*)$/i);
    if (!match) {
        return inactiveAutocomplete(safeCursor);
    }
    const prefix = match[1] || "";
    const normalizedPrefix = prefix.toLowerCase();
    const options = VIDEO_IMAGE_MODIFIER_COMPLETIONS.filter((option) => option.startsWith(normalizedPrefix));
    if (options.length === 1 && options[0] === normalizedPrefix) {
        return inactiveAutocomplete(safeCursor);
    }
    return {
        active: options.length > 0,
        kind: "image_modifier",
        start: safeCursor - prefix.length,
        end: safeCursor,
        prefix,
        options,
        selectedIndex: boundedAutocompleteIndex(options, selectedIndex),
    };
}

function imageReferenceAutocomplete(beforeCursor, safeCursor, selectedIndex, context) {
    const match = beforeCursor.match(/@([A-Za-z0-9_]*)$/);
    if (!match) {
        return inactiveAutocomplete(safeCursor);
    }
    const prefix = match[1] || "";
    const imageCount = Math.max(2, Math.min(Number(context?.imageCount) || 2, 8));
    const candidates = Array.from({ length: imageCount }, (_item, index) => `@image${index + 1}`);
    const options = candidates.filter((option) => option.slice(1).startsWith(prefix));
    return {
        active: options.length > 0,
        kind: "image_ref",
        start: safeCursor - prefix.length - 1,
        end: safeCursor,
        prefix,
        options,
        selectedIndex: boundedAutocompleteIndex(options, selectedIndex),
    };
}

function continuityAutocomplete(linePrefix, lineStart, safeCursor, selectedIndex) {
    const trimmed = linePrefix.trim();
    if (trimmed !== ">>" && trimmed !== "> >") {
        return inactiveAutocomplete(safeCursor);
    }
    const options = ["Continuity note"];
    return {
        active: true,
        kind: "continuity",
        start: lineStart,
        end: safeCursor,
        prefix: trimmed,
        options,
        selectedIndex: boundedAutocompleteIndex(options, selectedIndex),
    };
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

export async function fetchSystemPromptPresets(kind, fetchImpl = fetch) {
    const query = new URLSearchParams({ kind: String(kind || "") });
    const response = await fetchImpl(`/helto_prompt_enhancer/system_prompts?${query.toString()}`);
    return parsePromptEnhancerResponse(response, "Failed to load system prompt presets.");
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

export async function saveSystemPromptPreset(kind, preset, fetchImpl = fetch) {
    const response = await fetchImpl("/helto_prompt_enhancer/system_prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            kind,
            id: preset?.id,
            name: preset?.name,
            prompt: preset?.prompt,
        }),
    });
    return parsePromptEnhancerResponse(response, "Failed to save system prompt preset.");
}

export async function saveDefaultSystemPrompt(kind, prompt, fetchImpl = fetch) {
    const response = await fetchImpl("/helto_prompt_enhancer/system_prompts/default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, prompt }),
    });
    return parsePromptEnhancerResponse(response, "Failed to save default system prompt.");
}

export async function resetSystemPrompt(kind, fetchImpl = fetch) {
    const response = await fetchImpl("/helto_prompt_enhancer/system_prompt/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
    });
    return parsePromptEnhancerResponse(response, "Failed to reset system prompt.");
}

export async function resetDefaultSystemPrompt(kind, fetchImpl = fetch) {
    const response = await fetchImpl("/helto_prompt_enhancer/system_prompts/reset_default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
    });
    return parsePromptEnhancerResponse(response, "Failed to reset default system prompt.");
}

export async function deleteSystemPromptPreset(kind, id, fetchImpl = fetch) {
    const response = await fetchImpl("/helto_prompt_enhancer/system_prompts/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id }),
    });
    return parsePromptEnhancerResponse(response, "Failed to delete system prompt preset.");
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
