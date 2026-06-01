import { app } from "/scripts/app.js";

import { selectorApi } from "./api.js";
import { collapseHiddenWidgetLayout, containPointerEvents, createModal, setWidgetHeight } from "./ui.js";
import {
    PROMPT_ENHANCER_NODE_CLASS,
    addPromptVariable,
    autocompleteStateForPrompt,
    getWidget,
    fetchSystemPrompt,
    hideSerializedSettingsWidgets,
    insertVariableSuggestion,
    keepFixedPromptSeed,
    isPointInPromptWidget,
    moveAutocompleteSelection,
    PROMPT_EDITOR_HEIGHT,
    PROMPT_EDITOR_WIDGET_NAME,
    promptEditorLayout,
    readPromptValue,
    readPromptEnhancerSettings,
    readPromptVariables,
    removePromptVariable,
    resetSystemPrompt,
    saveSystemPrompt,
    setGenerateNewEachPrompt,
    setNewFixedPromptSeed,
    shouldHidePromptWidget,
    updatePromptVariable,
    updateModelOptions,
    writePromptEnhancerSettings,
    writePromptValue,
    writePromptVariables,
} from "./prompt_enhancer_helpers.js";

const BUTTONS_ADDED = "__heltoPromptEnhancerButtonsAdded";
const SETTINGS_BUTTON = "__heltoPromptEnhancerSettingsButton";
const MODELS_BUTTON = "__heltoPromptEnhancerModelsButton";
const VARIABLES_BUTTON = "__heltoPromptEnhancerVariablesButton";
const MODEL_SELECTOR = "__heltoPromptEnhancerModelSelector";
const PROMPT_HOVER_STATE = "__heltoPromptEnhancerPromptHover";
const PROMPT_DOM_ELEMENTS = "__heltoPromptEnhancerPromptDomElements";
const PROMPT_EDITOR_STATE = "__heltoPromptEnhancerPromptEditor";

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
    textarea.placeholder = "Describe the result you want. Use {{variable_name}} for variables.";
    textarea.spellcheck = false;
    textarea.wrap = "soft";
    textarea.value = readPromptValue(node);
    const suggestions = document.createElement("div");
    suggestions.className = "helto-prompt-enhancer-suggestions";
    suggestions.hidden = true;
    frame.appendChild(textarea);
    frame.appendChild(suggestions);

    const state = {
        frame,
        textarea,
        suggestions,
        variables: [],
        autocomplete: { active: false, options: [], selectedIndex: 0 },
        domWidget: null,
    };

    const refreshAutocomplete = (selectedIndex = state.autocomplete.selectedIndex || 0) => {
        state.autocomplete = autocompleteStateForPrompt(
            textarea.value,
            textarea.selectionStart,
            state.variables,
            selectedIndex,
        );
        renderPromptSuggestions(node);
    };

    textarea.addEventListener("input", () => {
        writePromptValue(node, textarea.value);
        refreshAutocomplete(0);
        setCanvasDirty(node);
    });
    textarea.addEventListener("click", () => refreshAutocomplete());
    textarea.addEventListener("keyup", (event) => {
        if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
        refreshAutocomplete();
    });
    textarea.addEventListener("keydown", (event) => {
        if (!state.autocomplete.active) return;
        const key = event.key.toLowerCase();
        if (event.ctrlKey && key === "y") {
            event.preventDefault();
            acceptPromptSuggestion(node);
        } else if (event.ctrlKey && key === "n") {
            event.preventDefault();
            state.autocomplete.selectedIndex = moveAutocompleteSelection(state.autocomplete, 1);
            renderPromptSuggestions(node);
        } else if (event.ctrlKey && key === "p") {
            event.preventDefault();
            state.autocomplete.selectedIndex = moveAutocompleteSelection(state.autocomplete, -1);
            renderPromptSuggestions(node);
        } else if (event.key === "Escape") {
            event.preventDefault();
            state.autocomplete = { active: false, options: [], selectedIndex: 0 };
            renderPromptSuggestions(node);
        }
    });
    textarea.addEventListener("mouseenter", () => updatePromptHover(node, true));
    textarea.addEventListener("mouseleave", () => updatePromptHover(node, false));

    const getEditorHeight = () => PROMPT_EDITOR_HEIGHT;
    const domWidget = node.addDOMWidget(PROMPT_EDITOR_WIDGET_NAME, "prompt", frame, {
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
    readPromptVariables(node, selectorApi).then((variables) => {
        state.variables = variables;
        renderPromptSuggestions(node);
    });
    return state;
}

function syncPromptEditorFromWidget(node) {
    const state = getPromptEditorState(node);
    if (!state) return;
    applyPromptEditorLayout(node);
    const value = readPromptValue(node);
    if (state.textarea.value !== value && document.activeElement !== state.textarea) {
        state.textarea.value = value;
    }
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
    const result = insertVariableSuggestion(state.textarea.value, state.autocomplete, explicitName);
    state.textarea.value = result.text;
    state.textarea.setSelectionRange(result.cursor, result.cursor);
    writePromptValue(node, result.text);
    state.autocomplete = { active: false, options: [], selectedIndex: 0 };
    renderPromptSuggestions(node);
    setCanvasDirty(node);
    state.textarea.focus();
}

function ensureModelSelector(node) {
    if (node[MODEL_SELECTOR]) {
        return node[MODEL_SELECTOR];
    }
    const modelWidget = getWidget(node, "model");
    const current = String(modelWidget?.value || "llava:latest").trim() || "llava:latest";
    const widget = node.addWidget?.("combo", "model selector", current, (value) => {
        const selected = String(value || "").trim();
        if (selected && modelWidget) {
            modelWidget.value = selected;
            modelWidget.callback?.(selected);
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

async function fetchOllamaModels(node) {
    const settings = readPromptEnhancerSettings(node);
    const response = await fetch("/helto_prompt_enhancer/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            url: settings.ollamaUrl,
            timeout: settings.timeout,
        }),
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || "Failed to fetch Ollama models.");
    }
    return Array.isArray(data.models) ? data.models : [];
}

async function refreshModels(node) {
    const button = node[MODELS_BUTTON];
    const previousName = button?.name;
    if (button) button.name = "refreshing models";
    setCanvasDirty(node);
    try {
        const models = await fetchOllamaModels(node);
        updateModelOptions(ensureModelSelector(node), getWidget(node, "model"), models);
    } catch (err) {
        console.warn("Prompt enhancer model refresh failed:", err);
        app.extensionManager?.toast?.add?.({
            severity: "error",
            summary: "Ollama connection error",
            detail: err.message || "Failed to fetch Ollama models.",
            life: 5000,
        });
    } finally {
        if (button) button.name = previousName || "refresh models";
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

    const widget = getWidget(node, "prompt");
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
    `;

    const modal = createModal("Prompt enhancer settings", content, async (body) => {
        const variables = await readPromptVariables(node, selectorApi);
        const privacyMode = body.querySelector("#helto-pe-privacy-mode").checked;
        writePromptEnhancerSettings(node, {
            hideMode: body.querySelector("#helto-pe-hide-mode").checked,
            privacyMode,
            ollamaUrl: body.querySelector("#helto-pe-ollama-url").value,
            keepAlive: body.querySelector("#helto-pe-keep-alive").value,
            keepAliveUnit: body.querySelector("#helto-pe-keep-alive-unit").value,
            timeout: body.querySelector("#helto-pe-timeout").value,
        });
        await writePromptVariables(node, variables, privacyMode, selectorApi);
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
    ensurePromptEditor(node);
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
    addButton(node, VARIABLES_BUTTON, "variables", () => {
        openVariablesEditor(node).catch((err) => {
            console.error("Prompt enhancer variable editor failed:", err);
            alert(err.message || "Failed to open variable editor.");
        });
    });
    addButton(node, MODELS_BUTTON, "refresh models", () => refreshModels(node));

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
