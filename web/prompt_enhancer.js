import { app } from "/scripts/app.js";

import { selectorApi } from "./api.js";
import { ICONS } from "./constants.js";
import { collapseHiddenWidgetLayout, containPointerEvents, createModal, setWidgetHeight } from "./ui.js";
import {
    PROMPT_ENHANCER_NODE_CLASS,
    SCRIPT_WIDGET_NAME,
    addPromptVariable,
    acceptPromptAutocompleteSuggestion,
    autocompleteStateForPrompt,
    shouldSuppressPromptAutocompleteRefresh,
    dismissPromptAutocompleteUntilInput,
    emptyAutocompleteState,
    getWidget,
    deleteSystemPromptPreset,
    fetchSystemPromptPresets,
    hideSerializedSettingsWidgets,
    keepFixedPromptSeed,
    isPointInPromptWidget,
    moveAutocompleteSelection,
    promptAutocompleteShortcutAction,
    promptAutocompleteShortcutGuardAction,
    promptSuggestionPopupPosition,
    PROMPT_EDITOR_HEIGHT,
    PROMPT_EDITOR_WIDGET_NAME,
    promptEditorLayout,
    readPromptEnhancerModelConfig,
    readPromptEnhancerSettings,
    readPromptEnhancerVisionModelConfig,
    readPromptText,
    readPromptVariables,
    rememberPromptEnhancerProviderModel,
    removePromptVariable,
    resetDefaultSystemPrompt,
    saveDefaultSystemPrompt,
    saveSystemPromptPreset,
    serializedPromptValue,
    serializedPromptVariablesValue,
    setGenerateNewEachPrompt,
    setNewFixedPromptSeed,
    shouldRefreshPromptVariables,
    shouldHidePromptWidget,
    syncPromptEnhancerSelectorsFromSerializedState,
    updatePromptVariable,
    updateProviderModelOptions,
    updateVisionProviderModelOptions,
    writePromptEnhancerModelConfig,
    writePromptEnhancerVisionModelConfig,
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
const VISION_PROVIDER_SELECTOR = "__heltoPromptEnhancerVisionProviderSelector";
const VISION_MODEL_SELECTOR = "__heltoPromptEnhancerVisionModelSelector";
const PROVIDER_CATALOG = "__heltoPromptEnhancerProviderCatalog";
const PROVIDER_REFRESH_SEQUENCE = "__heltoPromptEnhancerProviderRefreshSequence";
const PROMPT_HOVER_STATE = "__heltoPromptEnhancerPromptHover";
const PROMPT_DOM_ELEMENTS = "__heltoPromptEnhancerPromptDomElements";
const PROMPT_EDITOR_STATE = "__heltoPromptEnhancerPromptEditor";
const PROMPT_PRIVACY_SERIALIZATION = "__heltoPromptEnhancerPromptPrivacySerialization";
const PROMPT_AUTOCOMPLETE_VISIBLE = "__heltoPromptEnhancerAutocompleteVisible";
const PROMPT_AUTOCOMPLETE_SHORTCUT_CLEANUP = "__heltoPromptEnhancerAutocompleteShortcutCleanup";
const SYSTEM_PROMPT_PRESET_ACTIONS = [
    { action: "new", label: "New preset", icon: "plus" },
    { action: "duplicate", label: "Duplicate preset", icon: "copy" },
    { action: "edit", label: "Edit preset", icon: "pencil" },
    { action: "rename", label: "Rename preset", icon: "rename" },
    { action: "delete", label: "Delete preset", icon: "trash", danger: true },
];

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

function installPromptAutocompleteShortcutGuard({ getAutocomplete, isEditorFocused, onAction }) {
    const listener = (event) => {
        const action = promptAutocompleteShortcutGuardAction(event, getAutocomplete(), isEditorFocused());
        if (!action) return;
        onAction(action, event);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
}

function connectedImageSuggestionCount(node) {
    const imageInput = node?.inputs?.find?.((input) => input?.name === "images");
    if (Array.isArray(imageInput?.links) && imageInput.links.length > 0) {
        return Math.min(8, Math.max(2, imageInput.links.length));
    }
    return 2;
}

function cssPixels(value, fallback = 0) {
    const number = Number.parseFloat(String(value || ""));
    return Number.isFinite(number) ? number : fallback;
}

function textareaLineHeight(textarea) {
    const style = getComputedStyle(textarea);
    const fontSize = cssPixels(style.fontSize, 12);
    return cssPixels(style.lineHeight, fontSize * 1.45);
}

function textareaVisualCaretTop(textarea, container) {
    const cursor = Math.max(0, Math.min(Number(textarea.selectionStart) || 0, textarea.value.length));
    const style = getComputedStyle(textarea);
    const containerRect = container?.getBoundingClientRect?.() ?? { top: 0 };
    const textareaRect = textarea.getBoundingClientRect?.() ?? { top: 0 };
    const offsetTop = Number.isFinite(textarea.offsetTop)
        ? textarea.offsetTop
        : Math.max(0, textareaRect.top - (containerRect.top || 0));
    const mirror = document.createElement("div");
    const marker = document.createElement("span");
    const copiedStyles = [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "fontStyle",
        "letterSpacing",
        "lineHeight",
        "textTransform",
        "wordSpacing",
        "tabSize",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "borderTopWidth",
        "borderRightWidth",
        "borderBottomWidth",
        "borderLeftWidth",
    ];
    for (const property of copiedStyles) {
        mirror.style[property] = style[property];
    }
    mirror.style.boxSizing = "border-box";
    mirror.style.left = "-10000px";
    mirror.style.overflow = "hidden";
    mirror.style.position = "absolute";
    mirror.style.top = "0";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.overflowWrap = "break-word";
    mirror.style.wordBreak = style.wordBreak || "break-word";
    mirror.style.width = `${textarea.clientWidth || textareaRect.width}px`;
    mirror.textContent = textarea.value.slice(0, cursor) || "\u200b";
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    try {
        const mirrorRect = mirror.getBoundingClientRect();
        const markerRect = marker.getBoundingClientRect();
        return offsetTop + Math.max(0, markerRect.top - mirrorRect.top) - textarea.scrollTop;
    } finally {
        mirror.remove();
    }
}

function positionPromptSuggestionsElement(textarea, suggestions, container, options = {}) {
    if (!textarea || !suggestions || suggestions.hidden) return;
    const style = getComputedStyle(textarea);
    const containerRect = container?.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const textareaRect = textarea.getBoundingClientRect?.() ?? { width: 0, height: 0, top: 0, left: 0 };
    const offsetTop = Number.isFinite(textarea.offsetTop)
        ? textarea.offsetTop
        : Math.max(0, textareaRect.top - (containerRect.top || 0));
    const offsetLeft = Number.isFinite(textarea.offsetLeft)
        ? textarea.offsetLeft
        : Math.max(0, textareaRect.left - (containerRect.left || 0));
    const lineHeight = textareaLineHeight(textarea);
    const position = promptSuggestionPopupPosition({
        text: textarea.value,
        cursor: textarea.selectionStart,
        lineHeight,
        paddingTop: cssPixels(style.paddingTop, 0),
        paddingLeft: cssPixels(style.paddingLeft, 0),
        scrollTop: textarea.scrollTop,
        visualLineTop: textareaVisualCaretTop(textarea, container),
        textareaHeight: textarea.clientHeight || textareaRect.height,
        textareaWidth: textarea.clientWidth || textareaRect.width,
        textareaOffsetTop: offsetTop,
        textareaOffsetLeft: offsetLeft,
        containerHeight: container?.clientHeight || containerRect.height || textarea.clientHeight || textareaRect.height,
        containerWidth: container?.clientWidth || containerRect.width || textarea.clientWidth || textareaRect.width,
        popupHeight: suggestions.offsetHeight || 132,
        popupWidth: suggestions.offsetWidth || 160,
        preferBelow: Boolean(options.preferBelow),
    });
    suggestions.style.left = `${Math.round(position.left)}px`;
    suggestions.style.top = `${Math.round(position.top)}px`;
    suggestions.style.maxWidth = `${Math.max(1, Math.floor(position.maxWidth))}px`;
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
            domWidget.element.style.overflow = suggestions && !suggestions.hidden ? "visible" : "hidden";
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
        frame.style.overflow = suggestions && !suggestions.hidden ? "visible" : "hidden";
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
        positionPromptSuggestionsElement(textarea, suggestions, frame, { preferBelow: true });
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
        autocompleteDismissal: null,
        domWidget: null,
    };

    const refreshAutocomplete = async (selectedIndex = state.autocomplete.selectedIndex || 0) => {
        if (shouldSuppressPromptAutocompleteRefresh(state.autocompleteDismissal, textarea.value, textarea.selectionStart)) {
            state.autocomplete = emptyAutocompleteState(textarea.selectionStart);
            renderPromptSuggestions(node);
            return;
        }
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
    const handleAutocompleteAction = (action) => {
        if (action === "accept") {
            acceptPromptSuggestion(node);
        } else if (action === "next") {
            state.autocomplete.selectedIndex = moveAutocompleteSelection(state.autocomplete, 1);
            renderPromptSuggestions(node);
        } else if (action === "previous") {
            state.autocomplete.selectedIndex = moveAutocompleteSelection(state.autocomplete, -1);
            renderPromptSuggestions(node);
        } else if (action === "close") {
            state.autocompleteDismissal = dismissPromptAutocompleteUntilInput(textarea.value, textarea.selectionStart);
            state.autocomplete = emptyAutocompleteState(textarea.selectionStart);
            renderPromptSuggestions(node);
        }
    };
    node[PROMPT_AUTOCOMPLETE_SHORTCUT_CLEANUP]?.();
    node[PROMPT_AUTOCOMPLETE_SHORTCUT_CLEANUP] = installPromptAutocompleteShortcutGuard({
        getAutocomplete: () => state.autocomplete,
        isEditorFocused: () => document.activeElement === textarea,
        onAction: handleAutocompleteAction,
    });

    textarea.addEventListener("input", () => {
        persistPromptEditorText(node, textarea.value);
        state.autocompleteDismissal = null;
        refreshAutocomplete(0);
        setCanvasDirty(node);
    });
    textarea.addEventListener("focus", () => {
        refreshAutocomplete();
    });
    textarea.addEventListener("click", () => refreshAutocomplete());
    textarea.addEventListener("scroll", () => {
        positionPromptSuggestionsElement(textarea, suggestions, frame, { preferBelow: true });
    });
    textarea.addEventListener("keyup", (event) => {
        if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
        refreshAutocomplete();
    });
    textarea.addEventListener("keydown", (event) => {
        const action = promptAutocompleteShortcutAction(event, state.autocomplete);
        if (!action) return;
        handleAutocompleteAction(action);
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
    const { suggestions, autocomplete, textarea, frame, domWidget } = state;
    suggestions.innerHTML = "";
    if (!autocomplete.active || autocomplete.options.length === 0) {
        suggestions.hidden = true;
        if (frame) frame.style.overflow = "hidden";
        if (domWidget?.element) domWidget.element.style.overflow = "hidden";
        node[PROMPT_AUTOCOMPLETE_VISIBLE] = false;
        applyPromptDomHideMode(node);
        return;
    }
    suggestions.hidden = false;
    if (frame) frame.style.overflow = "visible";
    if (domWidget?.element) domWidget.element.style.overflow = "visible";
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
    positionPromptSuggestionsElement(textarea, suggestions, frame, { preferBelow: true });
    node[PROMPT_AUTOCOMPLETE_VISIBLE] = true;
    applyPromptDomHideMode(node);
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
    state.autocompleteDismissal = result.autocomplete?.active
        ? null
        : dismissPromptAutocompleteUntilInput(result.text, result.cursor);
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

function ensureVisionModelSelector(node) {
    if (node[VISION_MODEL_SELECTOR]) {
        return node[VISION_MODEL_SELECTOR];
    }
    const config = readPromptEnhancerVisionModelConfig(node);
    const current = config.modelId;
    const widget = node.addWidget?.("combo", "vision model selector", current, (value) => {
        const selected = String(value || "").trim();
        if (selected) {
            const provider = String(node[VISION_PROVIDER_SELECTOR]?.value || getWidget(node, "vision_provider")?.value || "local_transformers_vlm");
            const catalog = node[PROVIDER_CATALOG] || { models: [] };
            const selectedModel = catalog.models?.find?.((model) => model.provider === provider && model.model_id === selected);
            writePromptEnhancerVisionModelConfig(node, {
                provider,
                modelId: selected,
                modelBackend: selectedModel?.backend || (provider === "ollama" ? "ollama" : ""),
            });
            setCanvasDirty(node);
        }
    }, { values: [current] });
    if (widget) {
        widget.serialize = false;
        widget.options ??= {};
        widget.options.serialize = false;
        node[VISION_MODEL_SELECTOR] = widget;
    }
    return widget;
}

function ensureVisionProviderSelector(node) {
    if (node[VISION_PROVIDER_SELECTOR]) {
        return node[VISION_PROVIDER_SELECTOR];
    }
    const config = readPromptEnhancerVisionModelConfig(node);
    const widget = node.addWidget?.("combo", "vision provider", config.provider, () => {
        const catalog = node[PROVIDER_CATALOG] || { providers: [{ id: config.provider }], models: [] };
        updateVisionProviderModelOptions(widget, ensureVisionModelSelector(node), node, catalog);
        setCanvasDirty(node);
    }, { values: [config.provider] });
    if (widget) {
        widget.serialize = false;
        widget.options ??= {};
        widget.options.serialize = false;
        node[VISION_PROVIDER_SELECTOR] = widget;
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
    const sequence = (Number(node[PROVIDER_REFRESH_SEQUENCE]) || 0) + 1;
    node[PROVIDER_REFRESH_SEQUENCE] = sequence;
    const button = node[MODELS_BUTTON];
    const previousName = button?.name === "refreshing models" ? "refresh models" : button?.name;
    if (button) button.name = "refreshing models";
    setCanvasDirty(node);
    try {
        const catalog = await fetchProviderModels(node);
        if (node[PROVIDER_REFRESH_SEQUENCE] !== sequence) {
            return;
        }
        node[PROVIDER_CATALOG] = catalog;
        syncPromptEnhancerSelectorsFromSerializedState(
            node,
            ensureProviderSelector(node),
            ensureModelSelector(node),
            ensureVisionProviderSelector(node),
            ensureVisionModelSelector(node),
        );
        updateProviderModelOptions(ensureProviderSelector(node), ensureModelSelector(node), node, catalog);
        updateVisionProviderModelOptions(ensureVisionProviderSelector(node), ensureVisionModelSelector(node), node, catalog);
        if (catalog.ollama_error) {
            console.warn("Prompt enhancer Ollama model refresh failed:", catalog.ollama_error);
        }
    } catch (err) {
        if (node[PROVIDER_REFRESH_SEQUENCE] !== sequence) {
            return;
        }
        console.warn("Prompt enhancer model refresh failed:", err);
        app.extensionManager?.toast?.add?.({
            severity: "error",
            summary: "Model refresh error",
            detail: err.message || "Failed to fetch Prompt Enhancer models.",
            life: 5000,
        });
    } finally {
        if (node[PROVIDER_REFRESH_SEQUENCE] === sequence) {
            if (button) button.name = previousName || "refresh models";
            setCanvasDirty(node);
        }
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
    const shouldHide = shouldHidePromptWidget(node, node[PROMPT_HOVER_STATE], node[PROMPT_AUTOCOMPLETE_VISIBLE]);
    for (const element of getPromptDomElements(node)) {
        element.classList.toggle("helto-prompt-enhancer-prompt-hidden", shouldHide);
    }
}

function promptKindLabel(kind) {
    return kind === "image" ? "image" : "video";
}

function promptPresetSettingName(kind) {
    return kind === "image" ? "imageSystemPromptPreset" : "videoSystemPromptPreset";
}

function promptPresetSelectId(kind) {
    return `helto-pe-${kind}-system-prompt-preset`;
}

function systemPromptPresetActionButtons(kind) {
    return SYSTEM_PROMPT_PRESET_ACTIONS.map(({ action, label, icon, danger }) => `
        <button
            type="button"
            class="helto-btn-icon helto-pe-system-preset-action${danger ? " is-danger" : ""}"
            title="${escapeHtml(label)}"
            aria-label="${escapeHtml(label)}"
            data-preset-action="${escapeHtml(action)}"
            data-kind="${escapeHtml(kind)}"
        >${ICONS[icon]}</button>
    `).join("");
}

function systemPromptPresetRows(settings) {
    return ["image", "video"].map((kind) => {
        const label = promptKindLabel(kind);
        const selectedId = settings[promptPresetSettingName(kind)] || "default";
        return `
            <div class="settings-modal-row helto-prompt-enhancer-field-row helto-pe-system-preset-row" data-system-prompt-kind="${kind}">
                <label class="settings-modal-text" for="${promptPresetSelectId(kind)}">
                    <div class="settings-title">${label} system prompt</div>
                    <div class="settings-desc">Selected preset for this node.</div>
                </label>
                <div class="helto-pe-system-preset-controls">
                    <select class="helto-select helto-pe-system-preset-select" id="${promptPresetSelectId(kind)}">
                        <option value="${escapeHtml(selectedId)}">${escapeHtml(selectedId)}</option>
                    </select>
                    <div class="helto-pe-system-preset-actions" aria-label="${escapeHtml(label)} system prompt actions">
                        ${systemPromptPresetActionButtons(kind)}
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

function selectedSystemPromptPreset(kind, state) {
    const entry = state[kind] ?? {};
    const selectedId = String(entry.selectedId || "default");
    return entry.presets?.find((preset) => preset.id === selectedId)
        ?? entry.presets?.find((preset) => preset.id === "default")
        ?? { id: "default", name: "Default", prompt: "", is_builtin: true };
}

function uniqueSystemPromptPresetCopyName(kind, state, baseName) {
    const entry = state[kind] ?? {};
    const usedNames = new Set((entry.presets || []).map((preset) => String(preset.name || preset.id || "").trim().toLowerCase()));
    const rootName = `Copy of ${baseName || "Default"}`;
    let candidate = rootName;
    let index = 2;
    while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${rootName} ${index}`;
        index += 1;
    }
    return candidate;
}

function renderSystemPromptPresetSelect(modal, kind, state, selectedId = null) {
    const select = modal.body.querySelector(`#${promptPresetSelectId(kind)}`);
    if (!select) return;
    const entry = state[kind] ??= { presets: [], selectedId: "default" };
    const nextId = selectedId || entry.selectedId || "default";
    const presets = Array.isArray(entry.presets) ? entry.presets : [];
    const hasNext = presets.some((preset) => preset.id === nextId);
    entry.selectedId = hasNext ? nextId : "default";
    select.innerHTML = presets.map((preset) => (
        `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name || preset.id)}</option>`
    )).join("");
    if (!select.innerHTML) {
        select.innerHTML = '<option value="default">Default</option>';
        entry.selectedId = "default";
    }
    select.value = entry.selectedId;
}

async function refreshSystemPromptPresets(modal, kind, state, selectedId = null) {
    const entry = state[kind] ??= {};
    const refreshSequence = (entry.refreshSequence || 0) + 1;
    entry.refreshSequence = refreshSequence;
    const data = await fetchSystemPromptPresets(kind);
    if (entry.refreshSequence !== refreshSequence) {
        return entry.presets || [];
    }
    entry.presets = Array.isArray(data.presets) ? data.presets : [];
    if (selectedId) {
        entry.selectedId = selectedId;
    }
    renderSystemPromptPresetSelect(modal, kind, state, selectedId);
    return entry.presets;
}

async function ensureSystemPromptPresetsLoaded(modal, kind, state, selectedId = null) {
    const entry = state[kind] ??= {};
    const nextId = selectedId || entry.selectedId || "default";
    if (!Array.isArray(entry.presets) || entry.presets.length === 0) {
        await refreshSystemPromptPresets(modal, kind, state, nextId);
    } else {
        entry.selectedId = nextId;
        renderSystemPromptPresetSelect(modal, kind, state, nextId);
    }
    return selectedSystemPromptPreset(kind, state);
}

async function openSystemPromptPresetEditor(kind, preset, state, settingsModal) {
    const label = promptKindLabel(kind);
    const activePreset = preset ?? selectedSystemPromptPreset(kind, state);
    const isDefault = activePreset.id === "default";
    const nameInput = isDefault
        ? ""
        : `
            <label class="settings-modal-text" for="helto-pe-system-preset-name">
                <div class="settings-title">Name</div>
            </label>
            <input class="helto-prompt-enhancer-input" id="helto-pe-system-preset-name" type="text" value="${escapeHtml(activePreset.name || "")}">
        `;
    const content = `
        ${nameInput}
        <textarea class="helto-prompt-enhancer-textarea" id="helto-pe-system-prompt-editor">${escapeHtml(activePreset.prompt || "")}</textarea>
    `;
    const modal = createModal(`Edit ${label} system prompt`, content, async (body) => {
        const prompt = body.querySelector("#helto-pe-system-prompt-editor").value;
        const saved = isDefault
            ? await saveDefaultSystemPrompt(kind, prompt)
            : await saveSystemPromptPreset(kind, {
                id: activePreset.id,
                name: body.querySelector("#helto-pe-system-preset-name").value,
                prompt,
            });
        if (settingsModal && state) {
            state[kind].selectedId = saved.id || activePreset.id || "default";
            await refreshSystemPromptPresets(settingsModal, kind, state, state[kind].selectedId);
        }
        return true;
    }, {
        actionText: "Save",
        cardClass: "helto-prompt-enhancer-editor-card",
        bodyClass: "helto-prompt-enhancer-editor-body",
    });

    if (isDefault) {
        const resetButton = document.createElement("button");
        resetButton.className = "helto-modal-btn btn-secondary";
        resetButton.innerText = "Reset to packaged";
        resetButton.onclick = async (event) => {
            event.preventDefault();
            event.stopPropagation();
            resetButton.disabled = true;
            try {
                const resetData = await resetDefaultSystemPrompt(kind);
                modal.body.querySelector("#helto-pe-system-prompt-editor").value = resetData.prompt || resetData.default_prompt || "";
                if (settingsModal && state) {
                    await refreshSystemPromptPresets(settingsModal, kind, state, "default");
                }
            } catch (err) {
                console.error("Prompt enhancer system prompt reset failed:", err);
                alert(err.message || "Reset failed.");
            } finally {
                resetButton.disabled = false;
            }
        };
        modal.footer.insertBefore(resetButton, modal.actionBtn);
    }
}

function selectedPresetId(modal, kind) {
    return modal.body.querySelector(`#${promptPresetSelectId(kind)}`)?.value || "default";
}

function setupSystemPromptPresetControls(modal, state) {
    for (const kind of ["image", "video"]) {
        const select = modal.body.querySelector(`#${promptPresetSelectId(kind)}`);
        if (!select) continue;
        select.onchange = () => {
            state[kind].selectedId = select.value || "default";
        };
        refreshSystemPromptPresets(modal, kind, state, state[kind].selectedId).catch((err) => {
            console.error(`Prompt enhancer ${kind} prompt preset refresh failed:`, err);
        });
    }

    for (const button of modal.body.querySelectorAll("[data-preset-action]")) {
        button.onclick = async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const kind = button.dataset.kind;
            const action = button.dataset.presetAction;
            const selectedId = selectedPresetId(modal, kind);
            state[kind].selectedId = selectedId;
            button.disabled = true;
            try {
                const preset = await ensureSystemPromptPresetsLoaded(modal, kind, state, selectedId);
                if (action === "new") {
                    const name = window.prompt(`New ${promptKindLabel(kind)} system prompt name`, "");
                    if (!name?.trim()) return;
                    await openSystemPromptPresetEditor(kind, { id: "", name: name.trim(), prompt: "", is_builtin: false }, state, modal);
                    return;
                }
                if (action === "duplicate") {
                    const name = window.prompt("Duplicate preset name", uniqueSystemPromptPresetCopyName(kind, state, preset.name || selectedId));
                    if (!name?.trim()) return;
                    const saved = await saveSystemPromptPreset(kind, { name: name.trim(), prompt: preset.prompt || "" });
                    state[kind].selectedId = saved.id || "default";
                    await refreshSystemPromptPresets(modal, kind, state, state[kind].selectedId);
                    return;
                }
                if (action === "edit") {
                    await openSystemPromptPresetEditor(kind, preset, state, modal);
                    return;
                }
                if (action === "rename") {
                    if (preset.id === "default") {
                        alert("The default preset name cannot be changed.");
                        return;
                    }
                    const name = window.prompt("Preset name", preset.name || "");
                    if (!name?.trim()) return;
                    const saved = await saveSystemPromptPreset(kind, { id: preset.id, name: name.trim(), prompt: preset.prompt || "" });
                    state[kind].selectedId = saved.id || preset.id;
                    await refreshSystemPromptPresets(modal, kind, state, state[kind].selectedId);
                    return;
                }
                if (action === "delete") {
                    if (preset.id === "default") {
                        alert("The default preset cannot be deleted.");
                        return;
                    }
                    if (!window.confirm(`Delete "${preset.name || preset.id}"?`)) return;
                    await deleteSystemPromptPreset(kind, preset.id);
                    state[kind].selectedId = "default";
                    await refreshSystemPromptPresets(modal, kind, state, "default");
                }
            } catch (err) {
                console.error("Prompt enhancer system prompt preset action failed:", err);
                alert(err.message || "System prompt preset action failed.");
            } finally {
                button.disabled = false;
            }
        };
    }
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
        clearModalAutocompleteReveal();
        return true;
    }, {
        actionText: "Save",
        cardClass: "helto-prompt-enhancer-script-card",
        bodyClass: "helto-prompt-enhancer-script-body",
    });

    const textarea = modal.body.querySelector("#helto-pe-script-editor");
    const suggestions = modal.body.querySelector("#helto-pe-script-suggestions");
    const suggestionContainer = modal.body.querySelector(".helto-prompt-enhancer-large-editor");
    textarea.value = currentText;
    textarea.focus();

    let autocomplete = { active: false, options: [], selectedIndex: 0 };
    let autocompleteDismissal = null;
    let cleanupShortcutGuard = null;
    const clearModalAutocompleteReveal = () => {
        autocomplete = emptyAutocompleteState(textarea.selectionStart);
        node[PROMPT_AUTOCOMPLETE_VISIBLE] = false;
        cleanupShortcutGuard?.();
        cleanupShortcutGuard = null;
        applyPromptDomHideMode(node);
    };
    modal.card.querySelector(".helto-modal-close-btn")?.addEventListener("click", clearModalAutocompleteReveal);
    modal.cancelBtn?.addEventListener("click", clearModalAutocompleteReveal);
    modal.overlay?.addEventListener("click", (event) => {
        if (event.target === modal.overlay) {
            clearModalAutocompleteReveal();
        }
    });
    const render = () => {
        suggestions.innerHTML = "";
        if (!autocomplete.active || autocomplete.options.length === 0) {
            suggestions.hidden = true;
            node[PROMPT_AUTOCOMPLETE_VISIBLE] = false;
            applyPromptDomHideMode(node);
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
        positionPromptSuggestionsElement(textarea, suggestions, suggestionContainer);
        node[PROMPT_AUTOCOMPLETE_VISIBLE] = true;
        applyPromptDomHideMode(node);
    };
    const refresh = (selectedIndex = autocomplete.selectedIndex || 0) => {
        if (shouldSuppressPromptAutocompleteRefresh(autocompleteDismissal, textarea.value, textarea.selectionStart)) {
            autocomplete = emptyAutocompleteState(textarea.selectionStart);
            render();
            return;
        }
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
        autocompleteDismissal = result.autocomplete.active ? null : dismissPromptAutocompleteUntilInput(result.text, result.cursor);
        render();
        textarea.focus();
    };
    const handleAutocompleteAction = (action) => {
        if (action === "accept") {
            accept();
        } else if (action === "next") {
            autocomplete.selectedIndex = moveAutocompleteSelection(autocomplete, 1);
            render();
        } else if (action === "previous") {
            autocomplete.selectedIndex = moveAutocompleteSelection(autocomplete, -1);
            render();
        } else if (action === "close") {
            autocompleteDismissal = dismissPromptAutocompleteUntilInput(textarea.value, textarea.selectionStart);
            autocomplete = emptyAutocompleteState(textarea.selectionStart);
            render();
        }
    };
    cleanupShortcutGuard = installPromptAutocompleteShortcutGuard({
        getAutocomplete: () => autocomplete,
        isEditorFocused: () => document.activeElement === textarea,
        onAction: handleAutocompleteAction,
    });

    textarea.addEventListener("input", () => {
        autocompleteDismissal = null;
        refresh(0);
    });
    textarea.addEventListener("click", () => refresh());
    textarea.addEventListener("scroll", () => {
        positionPromptSuggestionsElement(textarea, suggestions, suggestionContainer);
    });
    textarea.addEventListener("keyup", (event) => {
        if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
        refresh();
    });
    textarea.addEventListener("keydown", (event) => {
        const action = promptAutocompleteShortcutAction(event, autocomplete);
        if (!action) return;
        handleAutocompleteAction(action);
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
            ${systemPromptPresetRows(settings)}
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
            <div class="settings-modal-row helto-prompt-enhancer-field-row">
                <label class="settings-modal-text" for="helto-pe-max-tokens">
                    <div class="settings-title">Max tokens</div>
                    <div class="settings-desc">Maximum writer generation tokens. 0 keeps provider defaults.</div>
                </label>
                <input class="helto-prompt-enhancer-number" id="helto-pe-max-tokens" type="number" min="0" max="4096" value="${settings.maxTokens}">
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
            maxTokens: body.querySelector("#helto-pe-max-tokens").value,
            imageSystemPromptPreset: body.querySelector(`#${promptPresetSelectId("image")}`)?.value || "default",
            videoSystemPromptPreset: body.querySelector(`#${promptPresetSelectId("video")}`)?.value || "default",
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
    }, {
        cardClass: "helto-prompt-enhancer-settings-card",
    });

    setupSystemPromptPresetControls(modal, {
        image: { presets: [], selectedId: settings.imageSystemPromptPreset || "default" },
        video: { presets: [], selectedId: settings.videoSystemPromptPreset || "default" },
    });
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
    ensureVisionProviderSelector(node);
    ensureVisionModelSelector(node);
    syncPromptEnhancerSelectorsFromSerializedState(
        node,
        ensureProviderSelector(node),
        ensureModelSelector(node),
        ensureVisionProviderSelector(node),
        ensureVisionModelSelector(node),
    );
    node[PROMPT_HOVER_STATE] ??= false;
    applyPromptDomHideMode(node);

    if (node[BUTTONS_ADDED]) {
        refreshModels(node);
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
        const onRemoved = nodeType.prototype.onRemoved;

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

        nodeType.prototype.onRemoved = function () {
            this[PROMPT_AUTOCOMPLETE_SHORTCUT_CLEANUP]?.();
            this[PROMPT_AUTOCOMPLETE_SHORTCUT_CLEANUP] = null;
            return onRemoved?.apply(this, arguments);
        };
    },
});
