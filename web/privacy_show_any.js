import { app } from "../../scripts/app.js";

import { selectorApi } from "./api.js";
import { getCanvasRendererLayoutMode, getGraphRendererMode } from "./layout.js";
import { collapseHiddenWidgetLayout, containPointerEvents, setWidgetHeight } from "./ui.js";
import {
    PRIVACY_SHOW_ANY_LAYOUT,
    PRIVACY_SHOW_ANY_NODE_CLASS,
    PRIVACY_SHOW_ANY_STATE_WIDGET,
    decryptTextState,
    encryptTextState,
    extractPrivacyShowAnyText,
    configurePrivacyShowAnyTextarea,
    getPrivacyShowAnyTextAreaHeight,
    getPrivacyShowAnyWidgetHeight,
    getPrivacyShowAnyWidgetStartY,
    getVuePrivacyShowAnyVisualHeight,
    getWidget,
    hidePrivacyShowAnyStateWidget,
    serializedEncryptedWidgetValue,
} from "./privacy_show_any_helpers.js";

const DISPLAY_WIDGET_KEY = "__heltoPrivacyShowAnyWidget";
const CANVAS_WIDGET_KEY = "__heltoPrivacyShowAnyCanvasWidget";
const DISPLAY_TEXT_KEY = "__heltoPrivacyShowAnyText";
const ENCRYPT_PROMISE_KEY = "__heltoPrivacyShowAnyEncryptPromise";
const RESIZE_PATCHED_KEY = "__heltoPrivacyShowAnyResizePatched";
const SIZE_SYNC_PATCHED_KEY = "__heltoPrivacyShowAnySizeSyncPatched";
const CANVAS_INTERACTION_PATCHED_KEY = "__heltoPrivacyShowAnyCanvasInteractionPatched";
const DOM_LAYOUT_STATE_KEY = "__heltoPrivacyShowAnyDomLayoutState";

ensureStylesheet();

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

function classifyRendererName(mode) {
    const value = String(mode ?? "").toLowerCase();
    if (!value) return null;
    if (value.includes("litegraph") || value.includes("canvas") || value.includes("classic") || value.includes("legacy")) return "legacy";
    if (value.includes("vue") || value.includes("dom") || value.includes("modern") || /nodes?\s*2|2\.0/.test(value)) return "vue";
    return null;
}

function explicitRendererMode() {
    return classifyRendererName(getGraphRendererMode(app));
}

function shouldUseLegacyCanvasForNode(node) {
    const explicit = explicitRendererMode();
    if (explicit === "legacy") return true;
    if (explicit === "vue") return false;

    const display = node?.[DISPLAY_WIDGET_KEY];
    if (display?.domWidget?.element?.closest?.(".lg-node")) return false;
    if (document.querySelector?.(".lg-node")) return false;

    const mode = rendererMode();
    if (mode === "legacy" || mode === "ambiguous") return true;

    // In some installs the Vue capability flag remains true while the active canvas is legacy.
    return Boolean(window.LiteGraph);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function isPointInBounds(pos, bounds) {
    if (!pos || !bounds) return false;
    const [x, y] = pos;
    return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, r);
        return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
}

function splitLongCanvasToken(ctx, token, maxWidth) {
    const parts = [];
    let current = "";

    for (const char of token) {
        const candidate = `${current}${char}`;
        if (current && ctx.measureText(candidate).width > maxWidth) {
            parts.push(current);
            current = char;
        } else {
            current = candidate;
        }
    }

    if (current) {
        parts.push(current);
    }
    return parts;
}

function wrapCanvasText(ctx, text, maxWidth) {
    const hardLines = String(text ?? "").split(/\r\n|\r|\n/);
    const wrapped = [];

    for (const hardLine of hardLines) {
        if (!hardLine) {
            wrapped.push("");
            continue;
        }

        let line = "";
        for (const token of hardLine.split(/(\s+)/).filter(Boolean)) {
            const candidate = `${line}${token}`;
            if (!line || ctx.measureText(candidate).width <= maxWidth) {
                line = candidate;
                continue;
            }

            if (line.trimEnd()) {
                wrapped.push(line.trimEnd());
            }
            line = token.trimStart();

            while (line && ctx.measureText(line).width > maxWidth) {
                const parts = splitLongCanvasToken(ctx, line, maxWidth);
                wrapped.push(parts.shift() || "");
                line = parts.join("");
            }
        }

        wrapped.push(line.trimEnd());
    }

    return wrapped.length ? wrapped : [""];
}

function getLocalMousePos(node, event, localPos) {
    if (Array.isArray(localPos) && Number.isFinite(localPos[0]) && Number.isFinite(localPos[1])) {
        return localPos;
    }

    const canvas = app.canvas;
    const graphPos = canvas?.graph_mouse ?? canvas?.last_mouse;

    if (
        Array.isArray(graphPos) &&
        Array.isArray(node.pos) &&
        Number.isFinite(graphPos[0]) &&
        Number.isFinite(graphPos[1])
    ) {
        return [graphPos[0] - node.pos[0], graphPos[1] - node.pos[1]];
    }

    if (event && Number.isFinite(event.canvasX) && Number.isFinite(event.canvasY) && Array.isArray(node.pos)) {
        return [event.canvasX - node.pos[0], event.canvasY - node.pos[1]];
    }

    return null;
}

function normalizeWheelDelta(event) {
    if (Number.isFinite(event?.deltaY)) {
        return event.deltaY;
    }
    if (Number.isFinite(event?.wheelDelta)) {
        return -event.wheelDelta;
    }
    return 0;
}

class PrivacyShowAnyCanvasWidget {
    constructor(node) {
        this.name = "helto_privacy_show_any_canvas";
        this.type = "custom";
        this.node = node;
        this.bounds = null;
        this.copyBounds = null;
        this.textBounds = null;
        this.scrollTop = 0;
        this.contentHeight = 0;
        this.viewportHeight = 0;
        this.cachedText = null;
        this.cachedWidth = null;
        this.cachedLines = null;
        this.statusMessage = "";
        this.statusUntil = 0;
    }

    invalidate() {
        this.cachedText = null;
        this.cachedWidth = null;
        this.cachedLines = null;
        this.scrollTop = 0;
    }

    getText() {
        return String(this.node?.[DISPLAY_TEXT_KEY] ?? "");
    }

    getStatusText(text) {
        if (this.statusMessage && Date.now() < this.statusUntil) {
            return this.statusMessage;
        }
        this.statusMessage = "";
        const length = String(text || "").length;
        return length ? `${length.toLocaleString()} chars` : "No text";
    }

    getWrappedLines(ctx, text, maxWidth) {
        if (this.cachedText === text && this.cachedWidth === maxWidth && this.cachedLines) {
            return this.cachedLines;
        }

        const lines = wrapCanvasText(ctx, text, maxWidth);
        this.cachedText = text;
        this.cachedWidth = maxWidth;
        this.cachedLines = lines;
        return lines;
    }

    drawCopyIcon(ctx, bounds) {
        ctx.save();
        ctx.strokeStyle = "rgba(235, 235, 245, 0.9)";
        ctx.lineWidth = 1.8;
        const backX = bounds.x + 9;
        const backY = bounds.y + 7;
        const frontX = bounds.x + 6;
        const frontY = bounds.y + 10;
        ctx.strokeRect(backX, backY, 10, 10);
        ctx.strokeRect(frontX, frontY, 10, 10);
        ctx.restore();
    }

    draw(ctx, node, width, y) {
        if (!shouldUseLegacyCanvasForNode(node)) {
            this.bounds = null;
            return;
        }

        const nodeWidth = node.size?.[0] ?? width ?? PRIVACY_SHOW_ANY_LAYOUT.minWidth;
        const nodeHeight = node.size?.[1] ?? PRIVACY_SHOW_ANY_LAYOUT.minNodeHeight;
        const height = Math.max(0, nodeHeight - y - PRIVACY_SHOW_ANY_LAYOUT.bottomGutter);
        const bodyPadX = 28;
        const topPad = 8;
        const toolbarHeight = 34;
        const textPad = 8;
        const lineHeight = 17;
        const text = this.getText();

        this.bounds = { x: 0, y, width: nodeWidth, height };
        this.copyBounds = {
            x: Math.max(bodyPadX, nodeWidth - bodyPadX - 30),
            y: y + topPad,
            width: 30,
            height: 30,
        };
        this.textBounds = {
            x: bodyPadX,
            y: y + topPad + toolbarHeight + 8,
            width: Math.max(40, nodeWidth - bodyPadX * 2),
            height: Math.max(0, height - toolbarHeight - topPad - 12),
        };

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, y, nodeWidth, height);
        ctx.clip();

        ctx.font = "12px Arial, sans-serif";
        ctx.fillStyle = "rgba(220, 220, 226, 0.78)";
        ctx.textBaseline = "middle";
        ctx.fillText(this.getStatusText(text), bodyPadX, y + topPad + 15);

        ctx.fillStyle = "rgba(34, 34, 50, 0.96)";
        drawRoundedRect(ctx, this.copyBounds.x, this.copyBounds.y, this.copyBounds.width, this.copyBounds.height, 6);
        ctx.fill();
        this.drawCopyIcon(ctx, this.copyBounds);

        const textBounds = this.textBounds;
        ctx.fillStyle = "rgb(9, 10, 15)";
        drawRoundedRect(ctx, textBounds.x, textBounds.y, textBounds.width, textBounds.height, 6);
        ctx.fill();

        ctx.save();
        ctx.beginPath();
        ctx.rect(textBounds.x, textBounds.y, textBounds.width, textBounds.height);
        ctx.clip();

        ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        ctx.textBaseline = "top";
        const reservedScrollbarWidth = 12;
        const textWidth = Math.max(16, textBounds.width - textPad * 2 - reservedScrollbarWidth);
        const lines = text
            ? this.getWrappedLines(ctx, text, textWidth)
            : ["Run the node to display text."];
        this.contentHeight = lines.length * lineHeight;
        this.viewportHeight = Math.max(0, textBounds.height - textPad * 2);
        const maxScroll = Math.max(0, this.contentHeight - this.viewportHeight);
        this.scrollTop = clamp(this.scrollTop, 0, maxScroll);

        ctx.fillStyle = text ? "rgba(245, 245, 248, 0.94)" : "rgba(220, 220, 226, 0.48)";
        const firstLine = Math.max(0, Math.floor(this.scrollTop / lineHeight) - 1);
        const lastLine = Math.min(lines.length, firstLine + Math.ceil(this.viewportHeight / lineHeight) + 4);
        for (let i = firstLine; i < lastLine; i++) {
            const lineY = textBounds.y + textPad + (i * lineHeight) - this.scrollTop;
            if (lineY > textBounds.y + textBounds.height) break;
            if (lineY + lineHeight >= textBounds.y) {
                ctx.fillText(lines[i], textBounds.x + textPad, lineY);
            }
        }

        ctx.restore();

        if (maxScroll > 0) {
            const trackX = textBounds.x + textBounds.width - 8;
            const trackY = textBounds.y + 6;
            const trackH = Math.max(20, textBounds.height - 12);
            const thumbH = Math.max(24, trackH * (this.viewportHeight / this.contentHeight));
            const thumbY = trackY + (trackH - thumbH) * (this.scrollTop / maxScroll);

            ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
            drawRoundedRect(ctx, trackX, trackY, 4, trackH, 2);
            ctx.fill();
            ctx.fillStyle = "rgba(235, 235, 240, 0.68)";
            drawRoundedRect(ctx, trackX, thumbY, 4, thumbH, 2);
            ctx.fill();
        }

        ctx.restore();
    }

    computeSize(width) {
        const nodeWidth = this.node.size?.[0] ?? width ?? PRIVACY_SHOW_ANY_LAYOUT.minWidth;
        return [nodeWidth, shouldUseLegacyCanvasForNode(this.node) ? 1 : -4];
    }

    serializeValue() {
        return undefined;
    }

    handleMouseDown(event, pos) {
        if (!shouldUseLegacyCanvasForNode(this.node) || !isPointInBounds(pos, this.bounds)) {
            return false;
        }

        if (!isPointInBounds(pos, this.copyBounds)) {
            return false;
        }

        event?.preventDefault?.();
        event?.stopPropagation?.();
        copyText(this.getText(), this.node[DISPLAY_WIDGET_KEY]?.textarea).then((ok) => {
            this.statusMessage = ok ? "Copied" : "Copy failed";
            this.statusUntil = Date.now() + 900;
            setCanvasDirty(this.node);
        });
        return true;
    }

    handleWheel(event, pos) {
        if (!shouldUseLegacyCanvasForNode(this.node) || !isPointInBounds(pos, this.textBounds)) {
            return false;
        }

        const maxScroll = Math.max(0, this.contentHeight - this.viewportHeight);
        if (maxScroll <= 0) {
            return false;
        }

        const delta = normalizeWheelDelta(event);
        const nextScroll = clamp(this.scrollTop + delta, 0, maxScroll);
        if (nextScroll === this.scrollTop) {
            return false;
        }

        this.scrollTop = nextScroll;
        event?.preventDefault?.();
        event?.stopPropagation?.();
        setCanvasDirty(this.node);
        return true;
    }
}

function createDisplayElement(node) {
    const frame = document.createElement("div");
    frame.className = "helto-show-any-widget";
    containPointerEvents(frame);

    const panel = document.createElement("div");
    panel.className = "helto-show-any-panel";

    const toolbar = document.createElement("div");
    toolbar.className = "helto-show-any-toolbar";

    const status = document.createElement("div");
    status.className = "helto-show-any-status";
    status.textContent = "No text";

    const copyButton = document.createElement("button");
    copyButton.className = "helto-btn-icon helto-show-any-copy";
    copyButton.type = "button";
    copyButton.title = "Copy text";
    copyButton.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

    const textarea = document.createElement("textarea");
    textarea.className = "helto-show-any-text";
    configurePrivacyShowAnyTextarea(textarea);
    textarea.placeholder = "Run the node to display text.";

    toolbar.appendChild(status);
    toolbar.appendChild(copyButton);
    panel.appendChild(toolbar);
    panel.appendChild(textarea);
    frame.appendChild(panel);

    copyButton.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyText(node[DISPLAY_TEXT_KEY] || "", textarea).then((ok) => {
            status.textContent = ok ? "Copied" : "Copy failed";
            window.setTimeout(() => updateStatus(status, node[DISPLAY_TEXT_KEY] || ""), 900);
        });
    };

    return { node, frame, panel, textarea, status, toolbar };
}

async function copyText(text, textarea) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_err) {
        try {
            textarea.focus();
            textarea.select();
            return document.execCommand("copy");
        } catch (_fallbackErr) {
            return false;
        }
    }
}

function updateStatus(status, text) {
    const length = String(text || "").length;
    status.textContent = length ? `${length.toLocaleString()} chars` : "No text";
}

function setDisplayText(node, text, persist = true) {
    const plain = String(text ?? "");
    node[DISPLAY_TEXT_KEY] = plain;
    node[CANVAS_WIDGET_KEY]?.invalidate?.();
    const widget = node[DISPLAY_WIDGET_KEY];
    if (widget?.textarea) {
        widget.textarea.value = plain;
        updateStatus(widget.status, plain);
    }
    if (persist) {
        node[ENCRYPT_PROMISE_KEY] = persistEncryptedState(node, plain);
    }
    setCanvasDirty(node);
}

async function persistEncryptedState(node, text) {
    const stateWidget = getWidget(node, PRIVACY_SHOW_ANY_STATE_WIDGET);
    if (!stateWidget) return "";
    try {
        stateWidget.value = await encryptTextState(text, selectorApi);
    } catch (err) {
        console.error("Privacy Show Any encryption failed:", err);
        stateWidget.value = "";
    }
    return stateWidget.value || "";
}

async function restoreEncryptedState(node) {
    const stateWidget = getWidget(node, PRIVACY_SHOW_ANY_STATE_WIDGET);
    const encrypted = stateWidget?.value || "";
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
    const stateWidget = hidePrivacyShowAnyStateWidget(node, collapseHiddenWidgetLayout);
    if (!stateWidget) return;
    stateWidget.serializeValue = async () => {
        if (node[ENCRYPT_PROMISE_KEY]) {
            await node[ENCRYPT_PROMISE_KEY];
        }
        return serializedEncryptedWidgetValue(stateWidget);
    };
}

function rendererMode() {
    return getCanvasRendererLayoutMode({ app, document, window });
}

function shouldUseVuePath(display) {
    if (display?.node && shouldUseLegacyCanvasForNode(display.node)) return false;
    return rendererMode() === "vue" || !!display?.domWidget?.element?.closest?.(".lg-node");
}

function rememberDomWidgetLayout(domWidget) {
    if (!domWidget || domWidget[DOM_LAYOUT_STATE_KEY]) return;
    domWidget[DOM_LAYOUT_STATE_KEY] = {
        computeSize: domWidget.computeSize,
        computeLayoutSize: domWidget.computeLayoutSize,
        getHeight: domWidget.getHeight,
        getMinHeight: domWidget.getMinHeight,
        getMaxHeight: domWidget.getMaxHeight,
    };
}

function restoreDomWidgetLayout(domWidget) {
    const state = domWidget?.[DOM_LAYOUT_STATE_KEY];
    if (!state) return;

    for (const [key, value] of Object.entries(state)) {
        if (value === undefined) {
            delete domWidget[key];
        } else {
            domWidget[key] = value;
        }
    }
}

function collapseDomDisplayWidget(display) {
    const domWidget = display?.domWidget;
    if (!domWidget) return;

    rememberDomWidgetLayout(domWidget);
    domWidget.computeSize = () => [0, -4];
    domWidget.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
    domWidget.getHeight = () => 0;
    domWidget.getMinHeight = () => 0;
    domWidget.getMaxHeight = () => 0;
    domWidget.computedHeight = 0;
    setWidgetHeight(domWidget, 0);

    if (domWidget.element) {
        domWidget.element.style.display = "none";
        domWidget.element.style.height = "0px";
        domWidget.element.style.minHeight = "0px";
        domWidget.element.style.maxHeight = "0px";
    }
    if (display.frame) {
        display.frame.style.display = "none";
    }
}

function restoreDomDisplayWidget(display) {
    const domWidget = display?.domWidget;
    if (!domWidget) return;

    restoreDomWidgetLayout(domWidget);
    if (domWidget.element) {
        domWidget.element.style.display = "";
    }
    if (display.frame) {
        display.frame.style.display = "";
    }
}

function syncRendererPresentation(node) {
    const display = node?.[DISPLAY_WIDGET_KEY];
    const useLegacyCanvas = shouldUseLegacyCanvasForNode(node);

    if (useLegacyCanvas) {
        collapseDomDisplayWidget(display);
    } else {
        restoreDomDisplayWidget(display);
    }

    return useLegacyCanvas;
}

function applyHeightToDisplay(display, height) {
    const normalized = Math.max(PRIVACY_SHOW_ANY_LAYOUT.minWidgetHeight, height);
    const px = `${normalized}px`;
    const { domWidget, frame, panel, textarea, toolbar } = display;
    const toolbarHeight = toolbar?.offsetHeight || toolbar?.clientHeight || PRIVACY_SHOW_ANY_LAYOUT.toolbarHeight;
    const textHeight = getPrivacyShowAnyTextAreaHeight(normalized, toolbarHeight);
    const textPx = `${textHeight}px`;

    if (domWidget) {
        domWidget.computedHeight = normalized;
        setWidgetHeight(domWidget, normalized);
        if (domWidget.element) {
            domWidget.element.style.height = px;
            domWidget.element.style.minHeight = px;
            domWidget.element.style.maxHeight = shouldUseVuePath(display) ? px : "";
        }
    }

    frame.style.height = px;
    frame.style.minHeight = px;
    frame.style.maxHeight = px;
    if (panel) {
        panel.style.height = px;
        panel.style.minHeight = px;
        panel.style.maxHeight = px;
    }

    if (textarea) {
        textarea.style.height = textPx;
        textarea.style.minHeight = textPx;
        textarea.style.maxHeight = textPx;
        textarea.style.flexBasis = textPx;
    }
}

function syncPrivacyShowAnySize(node, markDirty = true) {
    const display = node[DISPLAY_WIDGET_KEY];
    if (!display?.domWidget) return;

    if (syncRendererPresentation(node)) {
        if (markDirty) {
            setCanvasDirty(node);
        }
        return;
    }

    const { domWidget } = display;
    const vuePath = shouldUseVuePath(display);
    const height = vuePath
        ? getVuePrivacyShowAnyVisualHeight(node, domWidget)
        : getPrivacyShowAnyWidgetHeight(node, getPrivacyShowAnyWidgetStartY(node, domWidget));

    if (!vuePath) {
        applyLegacyOverflow(display);
    }
    applyHeightToDisplay(display, height);
    if (markDirty) {
        setCanvasDirty(node);
    }
}

function applyLegacyOverflow(display) {
    const { domWidget, frame, panel } = display;
    if (frame) {
        frame.style.overflow = "visible";
    }
    if (panel) {
        panel.style.overflow = "hidden";
    }

    let element = domWidget?.element?.parentElement;
    for (let i = 0; element && i < 4; i++) {
        element.style.overflow = "visible";
        element = element.parentElement;
    }
}

function installPrivacyShowAnySizeSync(node) {
    if (node[SIZE_SYNC_PATCHED_KEY]) return;
    const originalOnResize = node.onResize;
    const originalOnDrawForeground = node.onDrawForeground;

    node.onResize = function (...args) {
        const result = originalOnResize?.apply(this, args);
        syncPrivacyShowAnySize(this, false);
        return result;
    };

    node.onDrawForeground = function (...args) {
        const result = originalOnDrawForeground?.apply(this, args);
        syncPrivacyShowAnySize(this, false);
        return result;
    };

    node[SIZE_SYNC_PATCHED_KEY] = true;
}

function installLegacyCanvasInteractions(node) {
    if (node[CANVAS_INTERACTION_PATCHED_KEY]) return;
    const originalOnMouseDown = node.onMouseDown;
    const originalOnMouseWheel = node.onMouseWheel;

    node.onMouseDown = function (event, localPos, ...args) {
        const pos = getLocalMousePos(this, event, localPos);
        if (this[CANVAS_WIDGET_KEY]?.handleMouseDown(event, pos)) {
            return true;
        }
        return originalOnMouseDown?.call(this, event, localPos, ...args);
    };

    node.onMouseWheel = function (event, localPos, ...args) {
        const pos = getLocalMousePos(this, event, localPos);
        if (this[CANVAS_WIDGET_KEY]?.handleWheel(event, pos)) {
            return true;
        }
        return originalOnMouseWheel?.call(this, event, localPos, ...args);
    };

    node[CANVAS_INTERACTION_PATCHED_KEY] = true;
}

function ensureLegacyCanvasWidget(node) {
    if (node[CANVAS_WIDGET_KEY]) {
        return;
    }

    const widget = new PrivacyShowAnyCanvasWidget(node);
    if (typeof node.addCustomWidget === "function") {
        node.addCustomWidget(widget);
    } else {
        node.widgets ??= [];
        node.widgets.push(widget);
    }

    node[CANVAS_WIDGET_KEY] = widget;
    installLegacyCanvasInteractions(node);
}

function installLegacySizing(node, display) {
    if (node[RESIZE_PATCHED_KEY] || !display?.domWidget || shouldUseLegacyCanvasForNode(node) || shouldUseVuePath(display)) return;
    const { domWidget } = display;
    const originalOnResize = node.onResize;
    const originalComputeSize = node.computeSize;

    function computeNodeSize(width) {
        const currentWidth = Array.isArray(node.size) && Number.isFinite(node.size[0]) ? node.size[0] : width;
        const currentHeight = Array.isArray(node.size) && Number.isFinite(node.size[1]) ? node.size[1] : PRIVACY_SHOW_ANY_LAYOUT.minNodeHeight;
        return [
            Math.max(PRIVACY_SHOW_ANY_LAYOUT.minWidth, currentWidth || 0),
            Math.max(PRIVACY_SHOW_ANY_LAYOUT.minNodeHeight, currentHeight || 0),
        ];
    }

    node.onResize = function (...args) {
        const result = originalOnResize?.apply(this, args);
        syncPrivacyShowAnySize(this);
        return result;
    };

    node.computeSize = function (width, ...args) {
        const base = originalComputeSize?.apply(this, [width, ...args]);
        const computed = computeNodeSize(width);
        if (Array.isArray(base)) {
            computed[0] = Math.max(computed[0], base[0] || 0);
            computed[1] = Math.max(computed[1], base[1] || 0);
        }
        return computed;
    };

    domWidget.computeSize = function (width) {
        const nodeWidth = Array.isArray(node.size) && Number.isFinite(node.size[0]) ? node.size[0] : width;
        const height = getPrivacyShowAnyWidgetHeight(node, getPrivacyShowAnyWidgetStartY(node, domWidget));
        return [Math.max(PRIVACY_SHOW_ANY_LAYOUT.minWidth, nodeWidth || 0), height];
    };
    domWidget.computeLayoutSize = function () {
        const height = getPrivacyShowAnyWidgetHeight(node, getPrivacyShowAnyWidgetStartY(node, domWidget));
        return {
            minHeight: height,
            maxHeight: height,
            minWidth: 0,
        };
    };
    domWidget.serializeValue = () => undefined;

    node[RESIZE_PATCHED_KEY] = true;
}

function getCurrentPrivacyShowAnyHeight(node, domWidget, display) {
    if (domWidget && !shouldUseVuePath(display)) {
        return getPrivacyShowAnyWidgetHeight(node, getPrivacyShowAnyWidgetStartY(node, domWidget));
    }
    return domWidget?.computedHeight || PRIVACY_SHOW_ANY_LAYOUT.defaultWidgetHeight;
}

function ensurePrivacyShowAnyUi(node) {
    ensureStateSerialization(node);
    if (node.inputs) {
        node.inputs = node.inputs.filter((input) => input.name !== PRIVACY_SHOW_ANY_STATE_WIDGET);
    }
    if (!node[DISPLAY_WIDGET_KEY]) {
        const display = createDisplayElement(node);
        let domWidget = null;
        const getCurrentHeight = () => {
            const activeDisplay = node[DISPLAY_WIDGET_KEY];
            return getCurrentPrivacyShowAnyHeight(node, activeDisplay?.domWidget ?? domWidget, activeDisplay ?? display);
        };
        domWidget = node.addDOMWidget?.("helto_privacy_show_any_ui", "preview", display.frame, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: getCurrentHeight,
            getMaxHeight: getCurrentHeight,
            getHeight: getCurrentHeight,
            onDraw: () => {
                if (!shouldUseVuePath(node[DISPLAY_WIDGET_KEY] ?? display)) {
                    syncPrivacyShowAnySize(node, false);
                }
            },
        });
        if (domWidget) {
            domWidget.serialize = false;
            domWidget.options ??= {};
            domWidget.options.serialize = false;
            domWidget.options.getMinHeight = getCurrentHeight;
            domWidget.options.getMaxHeight = getCurrentHeight;
            domWidget.options.getHeight = getCurrentHeight;
            domWidget.getMinHeight = getCurrentHeight;
            domWidget.getMaxHeight = getCurrentHeight;
            domWidget.getHeight = getCurrentHeight;
        }
        node[DISPLAY_WIDGET_KEY] = { ...display, domWidget };
    }
    ensureLegacyCanvasWidget(node);
    if (Array.isArray(node.size)) {
        node.setSize?.([
            Math.max(node.size[0], PRIVACY_SHOW_ANY_LAYOUT.minWidth),
            Math.max(node.size[1], PRIVACY_SHOW_ANY_LAYOUT.minNodeHeight),
        ]);
    }

    installPrivacyShowAnySizeSync(node);
    installLegacySizing(node, node[DISPLAY_WIDGET_KEY]);
    syncPrivacyShowAnySize(node);
    window.requestAnimationFrame?.(() => syncPrivacyShowAnySize(node, false));
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
