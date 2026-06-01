import { app } from "/scripts/app.js";

import { collapseHiddenWidgetLayout, createModal } from "./ui.js";
import {
    PROMPT_ENHANCER_NODE_CLASS,
    getWidget,
    fetchSystemPrompt,
    hideSerializedSettingsWidgets,
    keepFixedPromptSeed,
    isPointInPromptWidget,
    promptWidgetBounds,
    readPromptEnhancerSettings,
    resetSystemPrompt,
    saveSystemPrompt,
    setGenerateNewEachPrompt,
    setNewFixedPromptSeed,
    shouldHidePromptWidget,
    updateModelOptions,
    writePromptEnhancerSettings,
} from "./prompt_enhancer_helpers.js";

const BUTTONS_ADDED = "__heltoPromptEnhancerButtonsAdded";
const SETTINGS_BUTTON = "__heltoPromptEnhancerSettingsButton";
const MODELS_BUTTON = "__heltoPromptEnhancerModelsButton";
const MODEL_SELECTOR = "__heltoPromptEnhancerModelSelector";
const PROMPT_HOVER_STATE = "__heltoPromptEnhancerPromptHover";
const PROMPT_DOM_ELEMENTS = "__heltoPromptEnhancerPromptDomElements";

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

function drawHiddenPromptOverlay(node, ctx) {
    if (!shouldHidePromptWidget(node, node[PROMPT_HOVER_STATE])) {
        return;
    }
    const bounds = promptWidgetBounds(node);
    if (!bounds) {
        return;
    }

    ctx.save();
    ctx.fillStyle = "rgba(12, 13, 18, 0.96)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 1;
    const radius = 6;
    const x = bounds.x + 6;
    const y = bounds.y + 2;
    const width = Math.max(0, bounds.width - 12);
    const height = Math.max(0, bounds.height - 4);
    if (width <= 0 || height <= 0) {
        ctx.restore();
        return;
    }
    if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, radius);
        ctx.fill();
        ctx.stroke();
    } else {
        ctx.fillRect(x, y, width, height);
        ctx.strokeRect(x, y, width, height);
    }
    ctx.restore();
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
        writePromptEnhancerSettings(node, {
            hideMode: body.querySelector("#helto-pe-hide-mode").checked,
            privacyMode: body.querySelector("#helto-pe-privacy-mode").checked,
            ollamaUrl: body.querySelector("#helto-pe-ollama-url").value,
            keepAlive: body.querySelector("#helto-pe-keep-alive").value,
            keepAliveUnit: body.querySelector("#helto-pe-keep-alive-unit").value,
            timeout: body.querySelector("#helto-pe-timeout").value,
        });
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

        nodeType.prototype.onDrawForeground = function (ctx) {
            const result = onDrawForeground?.apply(this, arguments);
            applyPromptDomHideMode(this);
            drawHiddenPromptOverlay(this, ctx);
            return result;
        };
    },
});
