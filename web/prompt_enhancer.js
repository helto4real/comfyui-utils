import { app } from "/scripts/app.js";

import { selectorApi } from "./api.js";
import { collapseHiddenWidgetLayout, containPointerEvents, createModal, setWidgetHeight } from "./ui.js";
import {
    PROMPT_ENHANCER_NODE_CLASS,
    SCRIPT_WIDGET_NAME,
    addPromptVariable,
    acceptPromptAutocompleteSuggestion,
    autocompleteStateForPrompt,
    emptyAutocompleteState,
    getWidget,
    fetchSystemPrompt,
    hideSerializedSettingsWidgets,
    keepFixedPromptSeed,
    isPointInPromptWidget,
    moveAutocompleteSelection,
    promptAutocompleteShortcutAction,
    PROMPT_EDITOR_HEIGHT,
    PROMPT_EDITOR_WIDGET_NAME,
    promptEditorLayout,
    readPromptEnhancerModelConfig,
    readPromptEnhancerSettings,
    readPromptText,
    readPromptVariables,
    rememberPromptEnhancerProviderModel,
    removePromptVariable,
    resetSystemPrompt,
    saveSystemPrompt,
    serializedPromptValue,
    serializedPromptVariablesValue,
    setGenerateNewEachPrompt,
    setNewFixedPromptSeed,
    shouldRefreshPromptVariables,
    shouldHidePromptWidget,
    updatePromptVariable,
    updateProviderModelOptions,
    writePromptEnhancerModelConfig,
    writePromptEnhancerSettings,
    writePromptText,
    writePromptVariables,
} from "./prompt_enhancer_helpers.js";

const BUTTONS_ADDED = "__heltoPromptEnhancerButtonsAdded";
const SETTINGS_BUTTON = "__heltoPromptEnhancerSettingsButton";
const MODELS_BUTTON = "__heltoPromptEnhancerModelsButton";
const DOWNLOAD_MODEL_BUTTON = "__heltoPromptEnhancerDownloadModelButton";
const UNLOAD_MODEL_BUTTON = "__heltoPromptEnhancerUnloadModelButton";
const VARIABLES_BUTTON = "__heltoPromptEnhancerVariablesButton";
const EDIT_SCRIPT_BUTTON = "__heltoPromptEnhancerEditScriptButton";
const PROVIDER_SELECTOR = "__heltoPromptEnhancerProviderSelector";
const MODEL_SELECTOR = "__heltoPromptEnhancerModelSelector";
const PROVIDER_CATALOG = "__heltoPromptEnhancerProviderCatalog";
const PROMPT_HOVER_STATE = "__heltoPromptEnhancerPromptHover";
const PROMPT_DOM_ELEMENTS = "__heltoPromptEnhancerPromptDomElements";
const PROMPT_EDITOR_STATE = "__heltoPromptEnhancerPromptEditor";
const PROMPT_PRIVACY_SERIALIZATION = "__heltoPromptEnhancerPromptPrivacySerialization";

function isPromptEnhancerNode(node) {
    return node?.comfyClass === PROMPT_ENHANCER_NODE_CLASS || node?.constructor?.comfyClass === PROMPT_ENHANCER_NODE_CLASS;
}

function setCanvasDirty(node) {
    node?.setDirtyCanvas?.(true, true);
    node?.graph?.setDirtyCanvas?.(true, true);
}

function updatePromptHover(node, nextValue) {
    const value = Boolean(nextValue);
    if (node[PROMPT_HOVER_STATE] === value) {
        return;
    }
    node[PROMPT_HOVER_STATE] = value;
    applyPromptDomHideMode(node);
    setCanvasDirty(node);
}

function addButton(node, key, label, callback) {
    if (node[key]) {
        return node[key];
    }
    const widget = node.addWidget?.("button", label, null, callback);
    if (widget) {
        widget.serialize = false;
        widget.options ??= {};
        widget.options.serialize = false;
        node[key] = widget;
    }
    return widget;
}

function getPromptEditorState(node) {
    return node[PROMPT_EDITOR_STATE] ?? null;
}

function autocompleteContextForNode(node) {
    const promptType = String(getWidget(node, "prompt_type")?.value || "image").toLowerCase();
    return {
        promptType,
        imageCount: connectedImageSuggestionCount(node),
    };
}

function connectedImageSuggestionCount(node) {
    const imageInput = node?.inputs?.find?.((input) => input?.name === "images");
    if (Array.isArray(imageInput?.links) && imageInput.links.length > 0) {
        return Math.min(8, Math.max(2, imageInput.links.length));
    }
    return 2;
}

function applyPromptEditorLayout(node) {
    const state = getPromptEditorState(node);
    if (!state) return;
    const layout = promptEditorLayout(node);
    const widthPx = `${layout.width}px`;
    const textareaWidthPx = `${layout.textareaWidth}px`;
    const heightPx = `${layout.height}px`;
    const textareaHeightPx = `${layout.textareaHeight}px`;

    const { domWidget, frame, textarea, suggestions } = state;
    if (domWidget) {
        domWidget.computedHeight = layout.height;
        setWidgetHeight(domWidget, layout.height);
        domWidget.computeSize = () => [layout.width, layout.height];
        if (domWidget.element) {
            domWidget.element.style.boxSizing = "border-box";
            domWidget.element.style.width = widthPx;
            domWidget.element.style.minWidth = widthPx;
            domWidget.element.style.maxWidth = widthPx;
            domWidget.element.style.height = heightPx;
            domWidget.element.style.minHeight = heightPx;
            domWidget.element.style.maxHeight = heightPx;
            domWidget.element.style.overflow = "hidden";
        }
    }

    if (frame) {
        frame.style.boxSizing = "border-box";
        frame.style.width = widthPx;
        frame.style.minWidth = "0";
        frame.style.maxWidth = widthPx;
        frame.style.height = heightPx;
        frame.style.minHeight = heightPx;
        frame.style.maxHeight = heightPx;
        frame.style.overflow = "hidden";
    }
    if (textarea) {
        textarea.style.boxSizing = "border-box";
        textarea.style.width = textareaWidthPx;
        textarea.style.minWidth = "0";
        textarea.style.maxWidth = textareaWidthPx;
        textarea.style.height = textareaHeightPx;
        textarea.style.minHeight = textareaHeightPx;
        textarea.style.maxHeight = textareaHeightPx;
        textarea.style.overflowX = "hidden";
        textarea.style.overflowY = "auto";
    }
    if (suggestions) {
        suggestions.style.maxWidth = `${Math.max(0, layout.width - 20)}px`;
    }
}

async function refreshPromptEditorVariables(node, force = false) {
    const state = getPromptEditorState(node);
    if (!state) return [];
    const serializedValue = serializedPromptVariablesValue(node);
    if (!force && !shouldRefreshPromptVariables(node, state.variablesWidgetValue)) {
        return state.variables;
    }

    const loadId = (state.variablesLoadId ?? 0) + 1;
    state.variablesLoadId = loadId;
    const variables = await readPromptVariables(node, selectorApi);
    if (state.variablesLoadId !== loadId) {
        return state.variables;
    }
    state.variables = variables;
    state.variablesWidgetValue = serializedValue;
    return variables;
}

async function loadPromptEditorText(node, force = false) {
    const state = getPromptEditorState(node);
    if (!state) return "";
    const serializedValue = serializedPromptValue(node);
    if (!force && serializedValue === state.promptWidgetValue) {
        return state.promptText;
    }

    const loadId = (state.promptLoadId ?? 0) + 1;
    state.promptLoadId = loadId;
    const text = await readPromptText(node, selectorApi);
    if (state.promptLoadId !== loadId) {
        return state.promptText;
    }

    state.promptText = text;
    state.promptWidgetValue = serializedValue;
    if (document.activeElement !== state.textarea && state.textarea.value !== text) {
        state.textarea.value = text;
    }
    if (readPromptEnhancerSettings(node).privacyMode && text && serializedValue === text) {
        persistPromptEditorText(node, text, true);
    }
    return text;
}

function persistPromptEditorText(node, text, privacyMode = readPromptEnhancerSettings(node).privacyMode) {
    const state = getPromptEditorState(node);
    const plain = String(text ?? "");
    if (state) {
        state.promptText = plain;
        state.promptSaveId = (state.promptSaveId ?? 0) + 1;
    }
    const saveId = state?.promptSaveId ?? 0;
    const persistPromise = writePromptText(node, plain, privacyMode, selectorApi).then((serialized) => {
        const activeState = getPromptEditorState(node);
        if (!activeState || activeState.promptSaveId === saveId) {
            if (activeState) activeState.promptWidgetValue = serializedPromptValue(node);
        }
        return serialized;
    }).catch((err) => {
        console.error("Prompt enhancer script encryption failed:", err);
        return serializedPromptValue(node);
    });
    if (state) {
        state.promptPersistPromise = persistPromise;
    }
    return persistPromise;
}

function installPromptPrivacySerialization(node) {
    if (node[PROMPT_PRIVACY_SERIALIZATION]) return;
    const promptWidget = getWidget(node, SCRIPT_WIDGET_NAME);
    if (!promptWidget) return;
    promptWidget.serialize = true;
    promptWidget.options ??= {};
    promptWidget.options.serialize = true;
    promptWidget.serializeValue = async () => {
        const state = getPromptEditorState(node);
        if (state?.promptPersistPromise) {
            await state.promptPersistPromise.catch(() => {});
        }
        return serializedPromptValue(node);
    };
    node[PROMPT_PRIVACY_SERIALIZATION] = true;
}

function ensurePromptEditor(node) {
    if (node[PROMPT_EDITOR_STATE]) {
        syncPromptEditorFromWidget(node);
        applyPromptEditorLayout(node);
        return node[PROMPT_EDITOR_STATE];
    }
    if (typeof node.addDOMWidget !== "function") {
        return null;
    }

    const frame = document.createElement("div");
    frame.className = "helto-prompt-enhancer-editor-widget";
    containPointerEvents(frame);
    const textarea = document.createElement("textarea");
    textarea.className = "helto-prompt-enhancer-user-prompt";
    textarea.placeholder = "Write an image prompt or segmented video script. Use {{variable_name}} for variables.";
    textarea.spellcheck = false;
    textarea.wrap = "soft";
    textarea.value = "";
    const suggestions = document.createElement("div");
    suggestions.className = "helto-prompt-enhancer-suggestions";
    suggestions.hidden = true;
    frame.appendChild(textarea);
    frame.appendChild(suggestions);

    const state = {
        frame,
        textarea,
        suggestions,
        promptText: "",
        promptWidgetValue: null,
        promptLoadId: 0,
        promptSaveId: 0,
        promptPersistPromise: null,
        variables: [],
        variablesWidgetValue: null,
        variablesLoadId: 0,
        autocomplete: { active: false, options: [], selectedIndex: 0 },
        domWidget: null,
    };

    const refreshAutocomplete = async (selectedIndex = state.autocomplete.selectedIndex || 0) => {
        await refreshPromptEditorVariables(node);
        state.autocomplete = autocompleteStateForPrompt(
            textarea.value,
            textarea.selectionStart,
            state.variables,
            selectedIndex,
            autocompleteContextForNode(node),
        );
        renderPromptSuggestions(node);
    };

    textarea.addEventListener("input", () => {
        persistPromptEditorText(node, textarea.value);
        refreshAutocomplete(0);
        setCanvasDirty(node);
    });
    textarea.addEventListener("focus", () => {
        refreshAutocomplete();
    });
    textarea.addEventListener("click", () => refreshAutocomplete());
    textarea.addEventListener("keyup", (event) => {
        if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
        refreshAutocomplete();
    });
    textarea.addEventListener("keydown", (event) => {
        const action = promptAutocompleteShortcutAction(event, state.autocomplete);
        if (!action) return;
        if (action === "accept") {
            acceptPromptSuggestion(node);
        } else if (action === "next") {
            state.autocomplete.selectedIndex = moveAutocompleteSelection(state.autocomplete, 1);
            renderPromptSuggestions(node);
        } else if (action === "previous") {
            state.autocomplete.selectedIndex = moveAutocompleteSelection(state.autocomplete, -1);
            renderPromptSuggestions(node);
        } else if (action === "close") {
            state.autocomplete = emptyAutocompleteState(textarea.selectionStart);
            renderPromptSuggestions(node);
        }
    });
    textarea.addEventListener("mouseenter", () => updatePromptHover(node, true));
    textarea.addEventListener("mouseleave", () => updatePromptHover(node, false));

    const getEditorHeight = () => PROMPT_EDITOR_HEIGHT;
    const domWidget = node.addDOMWidget(PROMPT_EDITOR_WIDGET_NAME, SCRIPT_WIDGET_NAME, frame, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: getEditorHeight,
        getMaxHeight: getEditorHeight,
        getHeight: getEditorHeight,
    });
    if (domWidget) {
        domWidget.serialize = false;
        domWidget.options ??= {};
        domWidget.options.serialize = false;
        domWidget.options.getMinHeight = getEditorHeight;
        domWidget.options.getMaxHeight = getEditorHeight;
        domWidget.options.getHeight = getEditorHeight;
        domWidget.getMinHeight = getEditorHeight;
        domWidget.getMaxHeight = getEditorHeight;
        domWidget.getHeight = getEditorHeight;
    }
    state.domWidget = domWidget;
    node[PROMPT_EDITOR_STATE] = state;
    applyPromptEditorLayout(node);
    installPromptPrivacySerialization(node);
    loadPromptEditorText(node, true).then(() => {
        refreshAutocomplete();
    });
    refreshPromptEditorVariables(node, true).then(() => {
        renderPromptSuggestions(node);
    });
    return state;
}

function syncPromptEditorFromWidget(node) {
    const state = getPromptEditorState(node);
    if (!state) return;
    applyPromptEditorLayout(node);
    loadPromptEditorText(node);
}

function renderPromptSuggestions(node) {
    const state = getPromptEditorState(node);
    if (!state) return;
    const { suggestions, autocomplete } = state;
    suggestions.innerHTML = "";
    if (!autocomplete.active || autocomplete.options.length === 0) {
        suggestions.hidden = true;
        return;
    }
    suggestions.hidden = false;
    autocomplete.options.forEach((name, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = index === autocomplete.selectedIndex ? "selected" : "";
        button.innerText = name;
        button.onmousedown = (event) => {
            event.preventDefault();
            acceptPromptSuggestion(node, name);
        };
        suggestions.appendChild(button);
    });
}

function acceptPromptSuggestion(node, explicitName = null) {
    const state = getPromptEditorState(node);
    if (!state?.autocomplete?.active) return;
    const result = acceptPromptAutocompleteSuggestion(
        state.textarea.value,
        state.autocomplete,
        state.variables,
        autocompleteContextForNode(node),
        explicitName,
    );
    state.textarea.value = result.text;
    state.textarea.setSelectionRange(result.cursor, result.cursor);
    persistPromptEditorText(node, result.text);
    state.autocomplete = result.autocomplete;
    renderPromptSuggestions(node);
    setCanvasDirty(node);
    state.textarea.focus();
}

function ensureModelSelector(node) {
    if (node[MODEL_SELECTOR]) {
        return node[MODEL_SELECTOR];
    }
    const config = readPromptEnhancerModelConfig(node);
    const providerWidget = getWidget(node, "provider");
    const modelIdWidget = getWidget(node, "model_id");
    const modelWidget = getWidget(node, "model");
    const current = config.modelId;
    const widget = node.addWidget?.("combo", "model selector", current, (value) => {
        const selected = String(value || "").trim();
        if (selected) {
            const provider = String(node[PROVIDER_SELECTOR]?.value || providerWidget?.value || "ollama");
            const catalog = node[PROVIDER_CATALOG] || { models: [] };
            const selectedModel = catalog.models?.find?.((model) => model.provider === provider && model.model_id === selected);
            writePromptEnhancerModelConfig(node, {
                provider,
                modelId: selected,
                modelBackend: selectedModel?.backend || (provider === "ollama" ? "ollama" : ""),
            });
            rememberPromptEnhancerProviderModel(node);
            modelIdWidget?.callback?.(selected);
            modelWidget?.callback?.(selected);
            setCanvasDirty(node);
        }
    }, { values: [current] });
    if (widget) {
        widget.serialize = false;
        widget.options ??= {};
        widget.options.serialize = false;
        node[MODEL_SELECTOR] = widget;
    }
    return widget;
}

function ensureProviderSelector(node) {
    if (node[PROVIDER_SELECTOR]) {
        return node[PROVIDER_SELECTOR];
    }
    const config = readPromptEnhancerModelConfig(node);
    const widget = node.addWidget?.("combo", "provider", config.provider, (value) => {
        const provider = String(value || "ollama").trim() || "ollama";
        const catalog = node[PROVIDER_CATALOG] || { providers: [{ id: provider }], models: [] };
        rememberPromptEnhancerProviderModel(node);
        updateProviderModelOptions(widget, ensureModelSelector(node), node, catalog);
        setCanvasDirty(node);
    }, { values: [config.provider] });
    if (widget) {
        widget.serialize = false;
        widget.options ??= {};
        widget.options.serialize = false;
        node[PROVIDER_SELECTOR] = widget;
    }
    return widget;
}

async function fetchProviderModels(node) {
    const settings = readPromptEnhancerSettings(node);
    const response = await fetch("/helto_prompt_enhancer/providers/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            url: settings.ollamaUrl,
            timeout: settings.timeout,
        }),
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || "Failed to fetch Prompt Enhancer models.");
    }
    return data;
}

async function refreshModels(node) {
    const button = node[MODELS_BUTTON];
    const previousName = button?.name;
    if (button) button.name = "refreshing models";
    setCanvasDirty(node);
    try {
        const catalog = await fetchProviderModels(node);
        node[PROVIDER_CATALOG] = catalog;
        updateProviderModelOptions(ensureProviderSelector(node), ensureModelSelector(node), node, catalog);
        if (catalog.ollama_error) {
            console.warn("Prompt enhancer Ollama model refresh failed:", catalog.ollama_error);
        }
    } catch (err) {
        console.warn("Prompt enhancer model refresh failed:", err);
        app.extensionManager?.toast?.add?.({
            severity: "error",
            summary: "Model refresh error",
            detail: err.message || "Failed to fetch Prompt Enhancer models.",
            life: 5000,
        });
    } finally {
        if (button) button.name = previousName || "refresh models";
        setCanvasDirty(node);
    }
}

async function postProviderAction(path, payload) {
    const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || "Prompt Enhancer provider action failed.");
    }
    return data;
}

async function fetchProviderSettings() {
    const response = await fetch("/helto_prompt_enhancer/providers/settings");
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || "Failed to fetch Prompt Enhancer provider settings.");
    }
    return data;
}

async function saveProviderSettings(payload) {
    return postProviderAction("/helto_prompt_enhancer/providers/settings", payload);
}

async function downloadSelectedModel(node) {
    const config = readPromptEnhancerModelConfig(node);
    if (config.provider === "ollama") {
        app.extensionManager?.toast?.add?.({
            severity: "info",
            summary: "Ollama model",
            detail: "Ollama models are managed by Ollama.",
            life: 4000,
        });
        return;
    }
    const button = node[DOWNLOAD_MODEL_BUTTON];
    const previousName = button?.name;
    if (button) button.name = "downloading model";
    try {
        await postProviderAction("/helto_prompt_enhancer/providers/download", { model_id: config.modelId });
        await refreshModels(node);
    } catch (err) {
        console.error("Prompt enhancer model download failed:", err);
        alert(err.message || "Failed to download model.");
    } finally {
        if (button) button.name = previousName || "download model";
        setCanvasDirty(node);
    }
}

async function unloadSelectedModel(node) {
    const config = readPromptEnhancerModelConfig(node);
    if (config.provider === "ollama") {
        app.extensionManager?.toast?.add?.({
            severity: "info",
            summary: "Ollama model",
            detail: "Use keep alive 0 seconds to unload Ollama models after generation.",
            life: 4000,
        });
        return;
    }
    const button = node[UNLOAD_MODEL_BUTTON];
    const previousName = button?.name;
    if (button) button.name = "unloading model";
    try {
        await postProviderAction("/helto_prompt_enhancer/providers/unload", { model_id: config.modelId });
        await refreshModels(node);
    } catch (err) {
        console.error("Prompt enhancer model unload failed:", err);
        alert(err.message || "Failed to unload model.");
    } finally {
        if (button) button.name = previousName || "unload model";
        setCanvasDirty(node);
    }
}

function settingsSection(title, rows) {
    return `
        <div class="helto-prompt-enhancer-section">
            <div class="settings-title">${title}</div>
            ${rows}
        </div>
    `;
}

function getPromptDomElements(node) {
    const cached = node[PROMPT_DOM_ELEMENTS];
    if (Array.isArray(cached) && cached.every((element) => element?.isConnected !== false)) {
        return cached;
    }

    const widget = getWidget(node, SCRIPT_WIDGET_NAME);
    const candidates = [
        getPromptEditorState(node)?.textarea,
        getPromptEditorState(node)?.frame,
        widget?.element,
        widget?.inputEl,
        widget?.input,
        widget?.textarea,
    ].filter((element) => element instanceof HTMLElement);
    const elements = [];
    for (const candidate of candidates) {
        if (candidate.matches?.("textarea, input")) {
            elements.push(candidate);
        }
        elements.push(...candidate.querySelectorAll?.("textarea, input") ?? []);
    }

    node[PROMPT_DOM_ELEMENTS] = [...new Set(elements)];
    return node[PROMPT_DOM_ELEMENTS];
}

function applyPromptDomHideMode(node) {
    const shouldHide = shouldHidePromptWidget(node, node[PROMPT_HOVER_STATE]);
    for (const element of getPromptDomElements(node)) {
        element.classList.toggle("helto-prompt-enhancer-prompt-hidden", shouldHide);
    }
}

function promptKindLabel(kind) {
    return kind === "image" ? "image" : "video";
}

async function openSystemPromptEditor(kind) {
    const label = promptKindLabel(kind);
    const data = await fetchSystemPrompt(kind);
    const content = `
        <textarea class="helto-prompt-enhancer-textarea" id="helto-pe-system-prompt-editor">${escapeHtml(data.prompt || "")}</textarea>
    `;
    const modal = createModal(`Edit ${label} system prompt`, content, async (body) => {
        await saveSystemPrompt(kind, body.querySelector("#helto-pe-system-prompt-editor").value);
        return true;
    }, {
        actionText: "Save",
        cardClass: "helto-prompt-enhancer-editor-card",
        bodyClass: "helto-prompt-enhancer-editor-body",
    });

    const resetButton = document.createElement("button");
    resetButton.className = "helto-modal-btn btn-secondary";
    resetButton.innerText = "Reset to default";
    resetButton.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        resetButton.disabled = true;
        try {
            const resetData = await resetSystemPrompt(kind);
            modal.body.querySelector("#helto-pe-system-prompt-editor").value = resetData.prompt || resetData.default_prompt || "";
        } catch (err) {
            console.error("Prompt enhancer system prompt reset failed:", err);
            alert(err.message || "Reset failed.");
        } finally {
            resetButton.disabled = false;
        }
    };
    modal.footer.insertBefore(resetButton, modal.actionBtn);
}

async function openScriptEditor(node) {
    const state = getPromptEditorState(node);
    const currentText = state?.textarea?.value ?? await readPromptText(node, selectorApi);
    const variables = await readPromptVariables(node, selectorApi);
    const content = `
        <div class="helto-prompt-enhancer-large-editor">
            <textarea class="helto-prompt-enhancer-textarea helto-prompt-enhancer-large-script" id="helto-pe-script-editor"></textarea>
            <div class="helto-prompt-enhancer-suggestions helto-prompt-enhancer-modal-suggestions" id="helto-pe-script-suggestions" hidden></div>
            <div class="helto-prompt-enhancer-script-help">
                Use --- on its own line to separate segments. Use [key=value] for settings, >> for continuity, and @image1:start for image references.
            </div>
        </div>
    `;
    const modal = createModal("Edit script", content, async (body) => {
        const text = body.querySelector("#helto-pe-script-editor")?.value ?? "";
        await persistPromptEditorText(node, text, readPromptEnhancerSettings(node).privacyMode);
        const activeState = getPromptEditorState(node);
        if (activeState?.textarea) {
            activeState.textarea.value = text;
            activeState.promptText = text;
            activeState.promptWidgetValue = serializedPromptValue(node);
        }
        applyPromptDomHideMode(node);
        setCanvasDirty(node);
        return true;
    }, {
        actionText: "Save",
        cardClass: "helto-prompt-enhancer-script-card",
        bodyClass: "helto-prompt-enhancer-script-body",
    });

    const textarea = modal.body.querySelector("#helto-pe-script-editor");
    const suggestions = modal.body.querySelector("#helto-pe-script-suggestions");
    textarea.value = currentText;
    textarea.focus();

    let autocomplete = { active: false, options: [], selectedIndex: 0 };
    const render = () => {
        suggestions.innerHTML = "";
        if (!autocomplete.active || autocomplete.options.length === 0) {
            suggestions.hidden = true;
            return;
        }
        suggestions.hidden = false;
        autocomplete.options.forEach((name, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = index === autocomplete.selectedIndex ? "selected" : "";
            button.innerText = name;
            button.onmousedown = (event) => {
                event.preventDefault();
                accept(name);
            };
            suggestions.appendChild(button);
        });
    };
    const refresh = (selectedIndex = autocomplete.selectedIndex || 0) => {
        autocomplete = autocompleteStateForPrompt(
            textarea.value,
            textarea.selectionStart,
            variables,
            selectedIndex,
            autocompleteContextForNode(node),
        );
        render();
    };
    const accept = (explicitName = null) => {
        if (!autocomplete.active) return;
        const result = acceptPromptAutocompleteSuggestion(
            textarea.value,
            autocomplete,
            variables,
            autocompleteContextForNode(node),
            explicitName,
        );
        textarea.value = result.text;
        textarea.setSelectionRange(result.cursor, result.cursor);
        autocomplete = result.autocomplete;
        render();
        textarea.focus();
    };

    textarea.addEventListener("input", () => refresh(0));
    textarea.addEventListener("click", () => refresh());
    textarea.addEventListener("keyup", (event) => {
        if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
        refresh();
    });
    textarea.addEventListener("keydown", (event) => {
        const action = promptAutocompleteShortcutAction(event, autocomplete);
        if (!action) return;
        if (action === "accept") {
            accept();
        } else if (action === "next") {
            autocomplete.selectedIndex = moveAutocompleteSelection(autocomplete, 1);
            render();
        } else if (action === "previous") {
            autocomplete.selectedIndex = moveAutocompleteSelection(autocomplete, -1);
            render();
        } else if (action === "close") {
            autocomplete = emptyAutocompleteState(textarea.selectionStart);
            render();
        }
    });
    refresh(0);
}

async function openVariablesEditor(node) {
    let variables = await readPromptVariables(node, selectorApi);
    const content = `
        <div class="helto-prompt-enhancer-variable-toolbar">
            <button type="button" class="helto-modal-btn btn-secondary" id="helto-pe-add-variable">Add variable</button>
        </div>
        <div class="helto-prompt-enhancer-variable-list" id="helto-pe-variable-list"></div>
    `;
    const modal = createModal("Prompt enhancer variables", content, async () => {
        await writePromptVariables(node, variables, readPromptEnhancerSettings(node).privacyMode, selectorApi);
        const state = getPromptEditorState(node);
        if (state) {
            state.variables = variables;
            state.variablesWidgetValue = serializedPromptVariablesValue(node);
            renderPromptSuggestions(node);
        }
        setCanvasDirty(node);
        return true;
    }, {
        actionText: "Save",
        cardClass: "helto-prompt-enhancer-variables-card",
        bodyClass: "helto-prompt-enhancer-variables-body",
    });

    const list = modal.body.querySelector("#helto-pe-variable-list");
    const render = () => {
        list.innerHTML = "";
        if (variables.length === 0) {
            const empty = document.createElement("div");
            empty.className = "helto-prompt-enhancer-empty";
            empty.innerText = "No variables yet.";
            list.appendChild(empty);
            return;
        }
        variables.forEach((variable, variableIndex) => {
            const row = document.createElement("div");
            row.className = "helto-prompt-enhancer-variable-row";

            const header = document.createElement("div");
            header.className = "helto-prompt-enhancer-variable-header";

            const nameInput = document.createElement("input");
            nameInput.className = "helto-prompt-enhancer-input";
            nameInput.value = variable.name;
            nameInput.placeholder = "variable_name";
            nameInput.oninput = () => {
                variables[variableIndex].name = nameInput.value;
            };

            const modeSelect = document.createElement("select");
            modeSelect.className = "helto-select";
            modeSelect.innerHTML = `
                <option value="random">random</option>
                <option value="fixed">fixed</option>
            `;
            modeSelect.value = variable.mode;
            modeSelect.onchange = () => {
                variables = updatePromptVariable(variables, variableIndex, { mode: modeSelect.value });
                render();
            };

            const removeButton = document.createElement("button");
            removeButton.type = "button";
            removeButton.className = "helto-modal-btn btn-secondary";
            removeButton.innerText = "Remove";
            removeButton.onclick = () => {
                variables = removePromptVariable(variables, variableIndex);
                render();
            };

            header.appendChild(nameInput);
            header.appendChild(modeSelect);
            header.appendChild(removeButton);
            row.appendChild(header);

            const values = document.createElement("div");
            values.className = "helto-prompt-enhancer-variable-values";
            variable.values.forEach((value, valueIndex) => {
                const valueRow = document.createElement("div");
                valueRow.className = "helto-prompt-enhancer-value-row";

                const fixedRadio = document.createElement("input");
                fixedRadio.type = "radio";
                fixedRadio.name = `helto-pe-fixed-${variableIndex}`;
                fixedRadio.checked = variable.fixed_index === valueIndex;
                fixedRadio.disabled = variable.mode !== "fixed";
                fixedRadio.onchange = () => {
                    variables = updatePromptVariable(variables, variableIndex, { fixed_index: valueIndex });
                };

                const valueInput = document.createElement("input");
                valueInput.className = "helto-prompt-enhancer-input";
                valueInput.value = value;
                valueInput.placeholder = "value";
                valueInput.oninput = () => {
                    const nextValues = [...variable.values];
                    nextValues[valueIndex] = valueInput.value;
                    variables = updatePromptVariable(variables, variableIndex, { values: nextValues });
                    variable = variables[variableIndex] || variable;
                };

                const removeValueButton = document.createElement("button");
                removeValueButton.type = "button";
                removeValueButton.className = "helto-modal-btn btn-secondary";
                removeValueButton.innerText = "Remove";
                removeValueButton.onclick = () => {
                    const nextValues = variable.values.filter((_item, itemIndex) => itemIndex !== valueIndex);
                    variables = updatePromptVariable(variables, variableIndex, { values: nextValues });
                    render();
                };

                valueRow.appendChild(fixedRadio);
                valueRow.appendChild(valueInput);
                valueRow.appendChild(removeValueButton);
                values.appendChild(valueRow);
            });

            const addValueButton = document.createElement("button");
            addValueButton.type = "button";
            addValueButton.className = "helto-modal-btn btn-secondary";
            addValueButton.innerText = "Add value";
            addValueButton.onclick = () => {
                variables = updatePromptVariable(variables, variableIndex, { values: [...variable.values, ""] });
                render();
            };
            values.appendChild(addValueButton);
            row.appendChild(values);
            list.appendChild(row);
        });
    };

    modal.body.querySelector("#helto-pe-add-variable").onclick = () => {
        variables = addPromptVariable(variables);
        render();
    };
    render();
}

function openSettingsModal(node) {
    const settings = readPromptEnhancerSettings(node);
    const hideChecked = settings.hideMode ? "checked" : "";
    const privacyChecked = settings.privacyMode ? "checked" : "";
    const secondsSelected = settings.keepAliveUnit === "seconds" ? "selected" : "";
    const minutesSelected = settings.keepAliveUnit === "minutes" ? "selected" : "";
    const hoursSelected = settings.keepAliveUnit === "hours" ? "selected" : "";

    const content = `
        ${settingsSection("General", `
            <div class="settings-modal-row">
                <div class="settings-modal-text">
                    <div class="settings-title">Hide mode</div>
                    <div class="settings-desc">Hides prompt text unless the cursor is over the prompt box.</div>
                </div>
                <label class="helto-switch">
                    <input type="checkbox" id="helto-pe-hide-mode" ${hideChecked}>
                    <span class="helto-switch-slider"></span>
                </label>
            </div>
            <div class="settings-modal-row">
                <div class="settings-modal-text">
                    <div class="settings-title">Privacy mode</div>
                    <div class="settings-desc">Stored for future privacy-aware prompt debugging behavior.</div>
                </div>
                <label class="helto-switch">
                    <input type="checkbox" id="helto-pe-privacy-mode" ${privacyChecked}>
                    <span class="helto-switch-slider"></span>
                </label>
            </div>
        `)}
        ${settingsSection("System prompts", `
            <div class="settings-modal-row helto-prompt-enhancer-prompt-actions">
                <button type="button" class="helto-modal-btn btn-secondary" id="helto-pe-edit-image-prompt">edit image system prompt</button>
                <button type="button" class="helto-modal-btn btn-secondary" id="helto-pe-edit-video-prompt">edit video system prompt</button>
            </div>
        `)}
        ${settingsSection("Ollama settings", `
            <div class="settings-modal-row helto-prompt-enhancer-field-row">
                <label class="settings-modal-text" for="helto-pe-ollama-url">
                    <div class="settings-title">URL</div>
                    <div class="settings-desc">Ollama server base URL.</div>
                </label>
                <input class="helto-prompt-enhancer-input" id="helto-pe-ollama-url" type="text" value="${escapeHtml(settings.ollamaUrl)}">
            </div>
            <div class="settings-modal-row helto-prompt-enhancer-field-row">
                <label class="settings-modal-text" for="helto-pe-keep-alive">
                    <div class="settings-title">Keep alive</div>
                    <div class="settings-desc">How long Ollama keeps the selected model loaded.</div>
                </label>
                <input class="helto-prompt-enhancer-number" id="helto-pe-keep-alive" type="number" min="-1" max="120" value="${settings.keepAlive}">
                <select class="helto-select" id="helto-pe-keep-alive-unit">
                    <option value="seconds" ${secondsSelected}>seconds</option>
                    <option value="minutes" ${minutesSelected}>minutes</option>
                    <option value="hours" ${hoursSelected}>hours</option>
                </select>
            </div>
            <div class="settings-modal-row helto-prompt-enhancer-field-row">
                <label class="settings-modal-text" for="helto-pe-timeout">
                    <div class="settings-title">Timeout</div>
                    <div class="settings-desc">Request timeout in seconds.</div>
                </label>
                <input class="helto-prompt-enhancer-number" id="helto-pe-timeout" type="number" min="1" max="3600" value="${settings.timeout}">
            </div>
        `)}
        ${settingsSection("Local model settings", `
            <div class="settings-modal-row helto-prompt-enhancer-field-row">
                <label class="settings-modal-text" for="helto-pe-hf-token">
                    <div class="settings-title">Hugging Face token</div>
                    <div class="settings-desc" id="helto-pe-hf-status">Checking token status...</div>
                </label>
                <input class="helto-prompt-enhancer-input" id="helto-pe-hf-token" type="password" value="" placeholder="leave blank to keep current token">
            </div>
            <div class="settings-modal-row">
                <div class="settings-modal-text">
                    <div class="settings-title">Clear stored token</div>
                    <div class="settings-desc">Remove the locally saved Hugging Face token.</div>
                </div>
                <label class="helto-switch">
                    <input type="checkbox" id="helto-pe-hf-clear">
                    <span class="helto-switch-slider"></span>
                </label>
            </div>
        `)}
    `;

    const modal = createModal("Prompt enhancer settings", content, async (body) => {
        const variables = await readPromptVariables(node, selectorApi);
        const editorState = getPromptEditorState(node);
        const promptText = editorState?.textarea?.value ?? await readPromptText(node, selectorApi);
        const privacyMode = body.querySelector("#helto-pe-privacy-mode").checked;
        writePromptEnhancerSettings(node, {
            hideMode: body.querySelector("#helto-pe-hide-mode").checked,
            privacyMode,
            ollamaUrl: body.querySelector("#helto-pe-ollama-url").value,
            keepAlive: body.querySelector("#helto-pe-keep-alive").value,
            keepAliveUnit: body.querySelector("#helto-pe-keep-alive-unit").value,
            timeout: body.querySelector("#helto-pe-timeout").value,
        });
        const hfToken = body.querySelector("#helto-pe-hf-token")?.value || "";
        const clearToken = Boolean(body.querySelector("#helto-pe-hf-clear")?.checked);
        if (clearToken || hfToken.trim()) {
            await saveProviderSettings(clearToken ? { clear: true } : { hf_token: hfToken });
        }
        await persistPromptEditorText(node, promptText, privacyMode);
        await writePromptVariables(node, variables, privacyMode, selectorApi);
        const state = getPromptEditorState(node);
        if (state) {
            state.promptText = promptText;
            state.promptWidgetValue = serializedPromptValue(node);
            state.variables = variables;
            state.variablesWidgetValue = serializedPromptVariablesValue(node);
        }
        await refreshModels(node);
        applyPromptDomHideMode(node);
        setCanvasDirty(node);
        return true;
    });

    modal.body.querySelector("#helto-pe-edit-image-prompt").onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openSystemPromptEditor("image").catch((err) => {
            console.error("Prompt enhancer image prompt editor failed:", err);
            alert(err.message || "Failed to open system prompt editor.");
        });
    };
    modal.body.querySelector("#helto-pe-edit-video-prompt").onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openSystemPromptEditor("video").catch((err) => {
            console.error("Prompt enhancer video prompt editor failed:", err);
            alert(err.message || "Failed to open system prompt editor.");
        });
    };
    fetchProviderSettings().then((status) => {
        const statusEl = modal.body.querySelector("#helto-pe-hf-status");
        if (statusEl) {
            statusEl.innerText = `Auth source: ${status.authSource || "anonymous"}. Stored token: ${status.tokenConfigured ? "yes" : "no"}.`;
        }
    }).catch((err) => {
        const statusEl = modal.body.querySelector("#helto-pe-hf-status");
        if (statusEl) statusEl.innerText = err.message || "Could not read token status.";
    });
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function ensurePromptEnhancerUi(node) {
    if (!isPromptEnhancerNode(node)) {
        return;
    }
    hideSerializedSettingsWidgets(node, collapseHiddenWidgetLayout);
    installPromptPrivacySerialization(node);
    ensurePromptEditor(node);
    ensureProviderSelector(node);
    ensureModelSelector(node);
    node[PROMPT_HOVER_STATE] ??= false;
    applyPromptDomHideMode(node);

    if (node[BUTTONS_ADDED]) {
        return;
    }
    node[BUTTONS_ADDED] = true;

    addButton(node, "__heltoPromptEnhancerRandomSeedButton", "generate new each prompt", () => {
        setGenerateNewEachPrompt(node);
        setCanvasDirty(node);
    });
    addButton(node, "__heltoPromptEnhancerKeepSeedButton", "fixed prompt", () => {
        keepFixedPromptSeed(node);
        setCanvasDirty(node);
    });
    addButton(node, "__heltoPromptEnhancerNewSeedButton", "new fixed prompt", () => {
        setNewFixedPromptSeed(node);
        setCanvasDirty(node);
    });
    addButton(node, SETTINGS_BUTTON, "settings", () => openSettingsModal(node));
    addButton(node, EDIT_SCRIPT_BUTTON, "edit script", () => {
        openScriptEditor(node).catch((err) => {
            console.error("Prompt enhancer script editor failed:", err);
            alert(err.message || "Failed to open script editor.");
        });
    });
    addButton(node, VARIABLES_BUTTON, "variables", () => {
        openVariablesEditor(node).catch((err) => {
            console.error("Prompt enhancer variable editor failed:", err);
            alert(err.message || "Failed to open variable editor.");
        });
    });
    addButton(node, MODELS_BUTTON, "refresh models", () => refreshModels(node));
    addButton(node, DOWNLOAD_MODEL_BUTTON, "download model", () => downloadSelectedModel(node));
    addButton(node, UNLOAD_MODEL_BUTTON, "unload model", () => unloadSelectedModel(node));

    refreshModels(node);
}

app.registerExtension({
    name: "Helto.PromptEnhancer",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== PROMPT_ENHANCER_NODE_CLASS) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        const onConfigure = nodeType.prototype.onConfigure;
        const onMouseMove = nodeType.prototype.onMouseMove;
        const onMouseLeave = nodeType.prototype.onMouseLeave;
        const onResize = nodeType.prototype.onResize;
        const onDrawForeground = nodeType.prototype.onDrawForeground;

        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            ensurePromptEnhancerUi(this);
            return result;
        };

        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            ensurePromptEnhancerUi(this);
            return result;
        };

        nodeType.prototype.onMouseMove = function (event, localPos) {
            updatePromptHover(this, isPointInPromptWidget(this, localPos));
            return onMouseMove?.apply(this, arguments);
        };

        nodeType.prototype.onMouseLeave = function () {
            updatePromptHover(this, false);
            return onMouseLeave?.apply(this, arguments);
        };

        nodeType.prototype.onResize = function () {
            const result = onResize?.apply(this, arguments);
            applyPromptEditorLayout(this);
            return result;
        };

        nodeType.prototype.onDrawForeground = function (ctx) {
            const result = onDrawForeground?.apply(this, arguments);
            applyPromptEditorLayout(this);
            applyPromptDomHideMode(this);
            return result;
        };
    },
});
