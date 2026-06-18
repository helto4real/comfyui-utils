import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

import { selectorApi } from "./api.js";
import { ICONS } from "./constants.js";
import { collapseHiddenWidgetLayout } from "./ui.js";
import {
    PRIVACY_SHOW_ANY_LAYOUT,
    PRIVACY_SHOW_ANY_NODE_CLASS,
    PRIVACY_SHOW_ANY_STATE_WIDGET,
    decryptTextState,
    encryptTextState,
    extractPrivacyShowAnyText,
    flushPrivacyShowAnyEncryption,
    getWidget,
    hidePrivacyShowAnyStateWidget,
    encryptedPrivacyShowAnyState,
    privacyShowAnyDisplayState,
    sanitizePrivacyShowAnySerializedProperties,
    setEncryptedPrivacyShowAnyState,
    serializedEncryptedWidgetValue,
} from "./privacy_show_any_helpers.js";

const DISPLAY_WIDGET_KEY = "__heltoPrivacyShowAnyWidget";
const DISPLAY_TEXT_KEY = "__heltoPrivacyShowAnyText";
const ENCRYPT_PROMISE_KEY = "__heltoPrivacyShowAnyEncryptPromise";
const STATE_WIDGET_KEY = "__heltoPrivacyShowAnyStateWidget";
const SERIALIZATION_PATCHED_KEY = "__heltoPrivacyShowAnySerializationPatched";
const LIFECYCLE_FLUSH_PATCHED_KEY = "__heltoPrivacyShowAnyLifecycleFlushPatched";
const COPY_BUTTON_GUARD_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu"];

ensureStylesheet();
installPrivacyShowAnyLifecycleFlush();

function ensureStylesheet() {
    if (document.getElementById("helto-utils-styles")) return;
    const link = document.createElement("link");
    link.id = "helto-utils-styles";
    link.rel = "stylesheet";
    link.href = new URL("./styles.css", import.meta.url).href;
    document.head.appendChild(link);
}

function setCanvasDirty(node) {
    node?.setDirtyCanvas?.(true, true);
    node?.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function captureWorkflowState(node) {
    node?.graph?.change?.();
    const trackers = [
        app.extensionManager?.workflow?.activeWorkflow?.changeTracker,
        app.workflowManager?.activeWorkflow?.changeTracker,
    ];
    for (const tracker of trackers) {
        try {
            if (typeof tracker?.captureCanvasState === "function") {
                tracker.captureCanvasState();
            } else {
                tracker?.checkState?.();
            }
        } catch (_err) {
            // Older ComfyUI builds can expose different workflow manager surfaces.
        }
    }
}

function getStateWidget(node) {
    const widget = getWidget(node, PRIVACY_SHOW_ANY_STATE_WIDGET) ?? node?.[STATE_WIDGET_KEY] ?? null;
    if (widget) {
        node[STATE_WIDGET_KEY] = widget;
    }
    return widget;
}

function detachStateWidgetFromInteractiveList(node, stateWidget) {
    if (!stateWidget || !Array.isArray(node?.widgets)) return;

    const index = node.widgets.indexOf(stateWidget);
    if (index >= 0) {
        node.widgets.splice(index, 1);
    }
}

function syncDisplayTextVisibility(display) {
    if (!display) return;

    const state = privacyShowAnyDisplayState(display.node?.[DISPLAY_TEXT_KEY], display.textRevealed);
    if (display.textWidget) {
        display.textWidget.value = state.value;
    }
    if (display.inputEl) {
        display.inputEl.value = state.value;
        display.inputEl.placeholder = state.placeholder;
    } else if (display.textarea) {
        display.textarea.value = state.value;
        display.textarea.placeholder = state.placeholder;
    }
}

function setDisplayText(node, text, persist = true) {
    const plain = String(text ?? "");
    node[DISPLAY_TEXT_KEY] = plain;
    const display = node[DISPLAY_WIDGET_KEY];
    if (display) {
        syncDisplayTextVisibility(display);
        resizePrivacyShowAnyNativeWidget(node);
    }
    if (persist) {
        node[ENCRYPT_PROMISE_KEY] = persistEncryptedState(node, plain);
    }
    setCanvasDirty(node);
}

async function persistEncryptedState(node, text) {
    const stateWidget = getStateWidget(node);
    const plain = String(text ?? "");
    if (!plain) {
        setEncryptedPrivacyShowAnyState(node, stateWidget, "");
        captureWorkflowState(node);
        return "";
    }
    try {
        const encrypted = await encryptTextState(plain, selectorApi);
        const safe = setEncryptedPrivacyShowAnyState(node, stateWidget, encrypted);
        captureWorkflowState(node);
        return safe;
    } catch (err) {
        console.error("Privacy Show Any encryption failed:", err);
        setEncryptedPrivacyShowAnyState(node, stateWidget, "");
        captureWorkflowState(node);
    }
    return "";
}

async function flushPrivacyShowAnyState(graph = app.rootGraph) {
    await flushPrivacyShowAnyEncryption(graph, ENCRYPT_PROMISE_KEY, (node, err) => {
        console.error("Privacy Show Any encryption flush failed:", err);
        setEncryptedPrivacyShowAnyState(node, getStateWidget(node), "");
        captureWorkflowState(node);
    });
}

function installPrivacyShowAnyLifecycleFlush() {
    if (app[LIFECYCLE_FLUSH_PATCHED_KEY]) return;

    const originalLoadGraphData = app.loadGraphData;
    if (typeof originalLoadGraphData === "function") {
        app.loadGraphData = async function (...args) {
            await flushPrivacyShowAnyState(this.rootGraph ?? app.rootGraph);
            return originalLoadGraphData.apply(this, args);
        };
    }

    const originalGraphToPrompt = app.graphToPrompt;
    if (typeof originalGraphToPrompt === "function") {
        app.graphToPrompt = async function (graph = this.rootGraph, ...args) {
            await flushPrivacyShowAnyState(graph ?? this.rootGraph ?? app.rootGraph);
            return originalGraphToPrompt.apply(this, [graph, ...args]);
        };
    }

    app[LIFECYCLE_FLUSH_PATCHED_KEY] = true;
}

async function restoreEncryptedState(node) {
    const stateWidget = getStateWidget(node);
    const encrypted = encryptedPrivacyShowAnyState(node, stateWidget);
    if (!encrypted) {
        setDisplayText(node, "", false);
        return;
    }
    try {
        const text = await decryptTextState(encrypted, selectorApi);
        setDisplayText(node, text, false);
    } catch (err) {
        console.error("Privacy Show Any decryption failed:", err);
        setDisplayText(node, "", false);
    }
}

function ensureStateSerialization(node) {
    const existingStateWidget = getStateWidget(node);
    const stateWidget = existingStateWidget
        ? hidePrivacyShowAnyStateWidget({ widgets: [existingStateWidget] }, collapseHiddenWidgetLayout)
        : hidePrivacyShowAnyStateWidget(node, collapseHiddenWidgetLayout);
    if (!stateWidget) return;
    node[STATE_WIDGET_KEY] = stateWidget;
    stateWidget.serialize = true;
    stateWidget.options ??= {};
    stateWidget.options.serialize = true;
    stateWidget.options.hidden = true;
    stateWidget.serializeValue = async () => {
        if (node[ENCRYPT_PROMISE_KEY]) {
            await node[ENCRYPT_PROMISE_KEY];
        }
        return serializedEncryptedWidgetValue(stateWidget);
    };
    detachStateWidgetFromInteractiveList(node, stateWidget);
}

function installPrivacyShowAnySerialization(node) {
    if (node[SERIALIZATION_PATCHED_KEY]) return;
    const originalOnSerialize = node.onSerialize;

    node.onSerialize = function (info) {
        const result = originalOnSerialize?.apply(this, arguments);
        const stateWidget = getStateWidget(this);
        const encrypted = encryptedPrivacyShowAnyState(this, stateWidget);
        if (info && stateWidget) {
            info.widgets_values = [serializedEncryptedWidgetValue({ value: encrypted })];
        }
        sanitizePrivacyShowAnySerializedProperties(info, encrypted);
        return result;
    };

    node[SERIALIZATION_PATCHED_KEY] = true;
}

function markDisplayWidgetPrivate(widget) {
    if (!widget) return widget;
    widget.serialize = false;
    widget.options ??= {};
    widget.options.serialize = false;
    widget.serializeValue = () => undefined;
    return widget;
}

function resizePrivacyShowAnyNativeWidget(node) {
    window.requestAnimationFrame?.(() => {
        const size = node.computeSize?.();
        if (Array.isArray(size) && Array.isArray(node.size)) {
            size[0] = Math.max(size[0] || 0, node.size[0] || 0, PRIVACY_SHOW_ANY_LAYOUT.minWidth);
            size[1] = Math.max(size[1] || 0, node.size[1] || 0, PRIVACY_SHOW_ANY_LAYOUT.minNodeHeight);
            node.onResize?.(size);
        }
        app.graph?.setDirtyCanvas?.(true, false);
        setCanvasDirty(node);
    });
}

function setCopyButtonState(button, label, copied = false) {
    if (!button) return;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.classList.toggle("is-copied", copied);
}

function copyTextFallback(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
        return document.execCommand?.("copy") === true;
    } finally {
        textarea.remove();
    }
}

async function writeClipboardText(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
    }
    return copyTextFallback(text);
}

function createCopyButton(display) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "helto-btn-icon helto-show-any-native-copy";
    button.innerHTML = ICONS.copy;
    setCopyButtonState(button, "Copy text");

    for (const eventName of COPY_BUTTON_GUARD_EVENTS) {
        button.addEventListener(eventName, (event) => {
            if (event.type === "contextmenu" || event.type === "dblclick") {
                event.preventDefault();
            }
            event.stopPropagation();
            event.stopImmediatePropagation?.();
        }, true);
    }

    button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const text = String(display.node?.[DISPLAY_TEXT_KEY] ?? "");
        try {
            await writeClipboardText(text);
            setCopyButtonState(button, "Copied", true);
            window.setTimeout?.(() => setCopyButtonState(button, "Copy text"), 1200);
        } catch (err) {
            console.error("Privacy Show Any copy failed:", err);
            setCopyButtonState(button, "Copy failed");
            window.setTimeout?.(() => setCopyButtonState(button, "Copy text"), 1600);
        }
    });

    return button;
}

function createNativeTextDisplay(node) {
    const created = ComfyWidgets?.STRING?.(
        node,
        "helto_privacy_show_any_text",
        ["STRING", { multiline: true }],
        app,
    )?.widget;
    if (!created) {
        console.warn("Privacy Show Any could not create a native STRING display widget.");
        return {
            node,
            textWidget: null,
            inputEl: null,
            textRevealed: false,
        };
    }

    markDisplayWidgetPrivate(created);
    const inputEl = created.inputEl ?? null;
    const container = inputEl?.parentElement ?? null;
    if (inputEl) {
        inputEl.readOnly = true;
        inputEl.spellcheck = false;
        inputEl.wrap = "soft";
        inputEl.style.opacity = 0.6;
        inputEl.classList?.add("helto-show-any-native-text");
    }
    container?.classList?.add("helto-show-any-native-wrap");

    const display = {
        node,
        textWidget: created,
        inputEl,
        container,
        textRevealed: false,
    };

    const revealText = () => {
        display.textRevealed = true;
        syncDisplayTextVisibility(display);
    };
    const hideText = () => {
        display.textRevealed = false;
        syncDisplayTextVisibility(display);
    };

    const hoverElement = container ?? inputEl;
    hoverElement?.addEventListener("pointerenter", revealText);
    hoverElement?.addEventListener("pointerleave", hideText);
    hoverElement?.addEventListener("mouseenter", revealText);
    hoverElement?.addEventListener("mouseleave", hideText);

    if (container) {
        display.copyButton = createCopyButton(display);
        container.appendChild(display.copyButton);
    }
    syncDisplayTextVisibility(display);
    return display;
}

function ensurePrivacyShowAnyUi(node) {
    ensureStateSerialization(node);
    installPrivacyShowAnySerialization(node);
    if (node.inputs) {
        node.inputs = node.inputs.filter((input) => input.name !== PRIVACY_SHOW_ANY_STATE_WIDGET);
    }
    if (!node[DISPLAY_WIDGET_KEY]) {
        node[DISPLAY_WIDGET_KEY] = createNativeTextDisplay(node);
    }
    if (Array.isArray(node.size)) {
        node.setSize?.([
            Math.max(node.size[0], PRIVACY_SHOW_ANY_LAYOUT.minWidth),
            Math.max(node.size[1], PRIVACY_SHOW_ANY_LAYOUT.minNodeHeight),
        ]);
    }

    syncDisplayTextVisibility(node[DISPLAY_WIDGET_KEY]);
    resizePrivacyShowAnyNativeWidget(node);
}

app.registerExtension({
    name: "Helto.PrivacyShowAny",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== PRIVACY_SHOW_ANY_NODE_CLASS) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        const onConfigure = nodeType.prototype.onConfigure;
        const onExecuted = nodeType.prototype.onExecuted;

        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            ensurePrivacyShowAnyUi(this);
            restoreEncryptedState(this);
            return result;
        };

        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            ensurePrivacyShowAnyUi(this);
            restoreEncryptedState(this);
            return result;
        };

        nodeType.prototype.onExecuted = function (output, ...args) {
            const result = onExecuted?.apply(this, [output, ...args]);
            ensurePrivacyShowAnyUi(this);
            setDisplayText(this, extractPrivacyShowAnyText(output));
            return result;
        };
    },
});
