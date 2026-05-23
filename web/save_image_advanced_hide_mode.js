import { app } from "/scripts/app.js";

const NODE_CLASSES = new Map([
    ["HeltoSaveImageAdvanced", "Save Image Advanced"],
    ["HeltoSaveVideoAdvanced", "Save Video Advanced"],
]);
const VIDEO_NODE_CLASS = "HeltoSaveVideoAdvanced";
const PROPERTY_NAME = "hide mode";
const HOVER_STATE = "__heltoHideModePreviewHover";
const ORIGINAL_HIDE_STATE = "__heltoHideModeOriginalHideOutputImages";
const HIDDEN_IMAGES = "__heltoHideModeHiddenImages";
const HIDDEN_NODE_IMAGES = "__heltoHideModeHiddenNodeImages";
const HIDDEN_IMAGE_INDEX = "__heltoHideModeHiddenImageIndex";
const HIDE_MODE_WIDGET = "__heltoHideModeWidget";
const PREVIEW_HIDDEN_STATE = "__heltoHideModePreviewHiddenState";
const PREVIEW_WIDGET_STYLES = "__heltoHideModePreviewWidgetStyles";
const PREVIEW_MEDIA_STYLES = "__heltoHideModePreviewMediaStyles";
const PREVIEW_WATCHER = "__heltoHideModePreviewWatcher";
const PREVIEW_OBSERVER = "__heltoHideModePreviewObserver";
const FORMAT_WIDGETS = "__heltoVideoFormatWidgets";
const FORMAT_WIDGET_COUNT = "__heltoVideoFormatWidgetCount";
const FORMAT_WIDGET_CALLBACK = "__heltoVideoFormatWidgetCallback";
const CANVAS_IMAGE_PREVIEW_WIDGET = "$$canvas-image-preview";
const VIDEO_PREVIEW_WIDGET = "videopreview";
const PLACEHOLDER_SRC = new URL("./hidden_preview_placeholder.png", import.meta.url).href;

let placeholderImage = null;
let placeholderImages = null;
let placeholderLoadStarted = false;
let lastPointerClientPos = null;
let managedHoverRefreshQueued = false;

const managedHideModeNodes = new Set();

function trackPointerPosition(event) {
    lastPointerClientPos = [event.clientX, event.clientY];
    scheduleManagedHoverRefresh();
}

document.addEventListener("pointermove", trackPointerPosition, { capture: true, passive: true });
document.addEventListener("pointerover", trackPointerPosition, { capture: true, passive: true });
document.addEventListener("pointerdown", trackPointerPosition, { capture: true, passive: true });

document.addEventListener("pointerleave", () => {
    lastPointerClientPos = null;
    scheduleManagedHoverRefresh();
}, { capture: true, passive: true });

function getNodeClass(node) {
    const candidates = [
        node?.constructor?.comfyClass,
        node?.constructor?.nodeData?.name,
        node?.constructor?.type,
        node?.comfyClass,
        node?.type,
    ];

    for (const candidate of candidates) {
        if (NODE_CLASSES.has(candidate)) {
            return candidate;
        }
    }

    const title = node?.constructor?.title ?? node?.title;
    for (const [nodeClass, displayName] of NODE_CLASSES) {
        if (title === displayName) {
            return nodeClass;
        }
    }

    return null;
}

function isAdvancedSaveNode(node) {
    return getNodeClass(node) !== null;
}

function isSaveVideoAdvancedNode(node) {
    return getNodeClass(node) === VIDEO_NODE_CLASS;
}

function setCanvasDirty(node) {
    node?.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function ensureHideModeProperty(node) {
    node.properties ??= {};

    if (node.properties[PROPERTY_NAME] === undefined) {
        if (typeof node.addProperty === "function") {
            node.addProperty(PROPERTY_NAME, false, "boolean");
        } else {
            node.properties[PROPERTY_NAME] = false;
        }
    }
}

function ensureHideModeWidget(node) {
    if (node[HIDE_MODE_WIDGET]) {
        return;
    }

    const existingWidget = node.widgets?.find((widget) => widget.name === PROPERTY_NAME);
    const widget = existingWidget ?? node.addWidget?.(
        "toggle",
        PROPERTY_NAME,
        Boolean(node.properties?.[PROPERTY_NAME]),
        (value) => {
            node.properties[PROPERTY_NAME] = Boolean(value);
            syncHideOutputImages(node);
            setCanvasDirty(node);
        },
        { on: "true", off: "false" },
    );

    if (!widget) {
        return;
    }

    widget.value = Boolean(node.properties?.[PROPERTY_NAME]);
    widget.callback = (value) => {
        node.properties[PROPERTY_NAME] = Boolean(value);
        syncHideOutputImages(node);
        setCanvasDirty(node);
    };
    widget.serialize = false;
    widget.options ??= {};
    widget.options.serialize = false;
    node[HIDE_MODE_WIDGET] = widget;
    node.setSize?.(node.computeSize?.() ?? node.size);
}

function setHideModeValue(node, value) {
    node.properties ??= {};
    node.properties[PROPERTY_NAME] = Boolean(value);

    if (node[HIDE_MODE_WIDGET]) {
        node[HIDE_MODE_WIDGET].value = node.properties[PROPERTY_NAME];
    }
}

function syncHideModePropertyFromWidget(node) {
    const widget = node[HIDE_MODE_WIDGET];

    if (widget) {
        setHideModeValue(node, widget.value);
    } else {
        setHideModeValue(node, node.properties?.[PROPERTY_NAME]);
    }
}

function isHideModeEnabled(node) {
    syncHideModePropertyFromWidget(node);
    return Boolean(node.properties?.[PROPERTY_NAME]);
}

function getPlaceholderImages(node) {
    if (placeholderImage?.complete && placeholderImage.naturalWidth > 0) {
        placeholderImages ??= [placeholderImage];
        return placeholderImages;
    }

    if (!placeholderLoadStarted) {
        placeholderLoadStarted = true;
        placeholderImage = new Image();
        placeholderImage.onload = () => setCanvasDirty(node);
        placeholderImage.src = PLACEHOLDER_SRC;
    }

    return null;
}

function isPlaceholderImages(images) {
    return placeholderImages && images === placeholderImages;
}

function hasHiddenPreviewContent(node) {
    return (
        (Array.isArray(node[HIDDEN_IMAGES]) && node[HIDDEN_IMAGES].length > 0) ||
        (Array.isArray(node[HIDDEN_NODE_IMAGES]) && node[HIDDEN_NODE_IMAGES].length > 0)
    );
}

function getHiddenPreviewRecords(node) {
    return [
        ...(Array.isArray(node[HIDDEN_IMAGES]) ? node[HIDDEN_IMAGES] : []),
        ...(Array.isArray(node[HIDDEN_NODE_IMAGES]) ? node[HIDDEN_NODE_IMAGES] : []),
    ].filter((item) => item && typeof item === "object");
}

function getVideoPreviewWidgets(node) {
    return node.widgets?.filter((widget) => widget.name === VIDEO_PREVIEW_WIDGET) ?? [];
}

function getDomPreviewWidgets(node) {
    return node.widgets?.filter(isPreviewWidget) ?? [];
}

function getWidgetElements(widget) {
    const candidates = [
        widget.element,
        widget.el,
        widget.inputEl,
        widget.parentEl,
        widget.domElement,
        widget.container,
        widget.value instanceof HTMLElement ? widget.value : null,
    ];

    return candidates.filter((element, index) => {
        return element instanceof HTMLElement && candidates.indexOf(element) === index;
    });
}

function pauseWidgetVideos(widget) {
    const videos = [
        widget.videoEl instanceof HTMLVideoElement ? widget.videoEl : null,
        ...getWidgetElements(widget).flatMap((element) => Array.from(element.querySelectorAll("video"))),
    ].filter((video, index, values) => video instanceof HTMLVideoElement && values.indexOf(video) === index);

    for (const video of videos) {
        video.pause();
        video.autoplay = false;
    }
}

function mediaMatchesPreviewRecords(media, records) {
    const src = media?.currentSrc || media?.src || "";

    if (!src || records.length === 0) {
        return false;
    }

    const decodedSrc = decodeURIComponent(src);

    return records.some((record) => {
        if (!record.filename) {
            return false;
        }

        const filename = String(record.filename);
        const subfolder = record.subfolder ? String(record.subfolder) : "";
        return decodedSrc.includes(filename) && (!subfolder || decodedSrc.includes(subfolder));
    });
}

function getNodePreviewClientRects(node) {
    const canvas = app.canvas;
    const canvasElement = canvas?.canvas;
    const scale = canvas?.ds?.scale ?? 1;
    const offset = canvas?.ds?.offset ?? [0, 0];

    if (!canvasElement || !Array.isArray(node?.pos) || !Array.isArray(node?.size)) {
        return [];
    }

    const area = getPreviewArea(node);
    const canvasRect = canvasElement.getBoundingClientRect();
    const graphX = node.pos[0] + area.x;
    const graphY = node.pos[1] + area.y;
    const size = {
        width: area.width * scale,
        height: area.height * scale,
    };

    const candidates = [
        [
            canvasRect.left + (graphX + offset[0]) * scale,
            canvasRect.top + (graphY + offset[1]) * scale,
        ],
        [
            canvasRect.left + graphX * scale + offset[0],
            canvasRect.top + graphY * scale + offset[1],
        ],
    ];

    return candidates.map(([left, top]) => ({
        left,
        top,
        right: left + size.width,
        bottom: top + size.height,
        ...size,
    }));
}

function rectOverlapArea(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
}

function mediaOverlapsNodePreview(media, nodeRects) {
    if (!nodeRects.length) {
        return false;
    }

    const mediaRect = media.getBoundingClientRect();
    if (mediaRect.width < 20 || mediaRect.height < 20) {
        return false;
    }

    const mediaArea = mediaRect.width * mediaRect.height;
    return nodeRects.some((nodeRect) => {
        const overlap = rectOverlapArea(mediaRect, nodeRect);
        const nodeArea = nodeRect.width * nodeRect.height;
        return overlap > Math.min(mediaArea, nodeArea) * 0.25;
    });
}

function getManagedMediaElements(media, nodeRects) {
    const elements = [media];
    let parent = media.parentElement;

    while (parent && parent !== document.body) {
        const parentRect = parent.getBoundingClientRect();
        const overlapsPreview = nodeRects.some((nodeRect) => {
            const overlap = rectOverlapArea(parentRect, nodeRect);
            const parentArea = parentRect.width * parentRect.height;
            const nodeArea = nodeRect.width * nodeRect.height;
            return parentArea > 0 && overlap > Math.min(parentArea, nodeArea) * 0.25;
        });

        if (!overlapsPreview) {
            break;
        }

        elements.push(parent);
        parent = parent.parentElement;
    }

    return elements;
}

function isPointerOverPreviewRect(node) {
    if (!lastPointerClientPos) {
        return false;
    }

    const [x, y] = lastPointerClientPos;
    const isOverNodeRect = getNodePreviewClientRects(node).some((rect) => {
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });

    if (isOverNodeRect) {
        return true;
    }

    for (const element of node[PREVIEW_MEDIA_STYLES]?.keys?.() ?? []) {
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) {
            continue;
        }

        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            return true;
        }
    }

    return false;
}

function applyExternalMediaVisibility(node, shouldHide) {
    const records = getHiddenPreviewRecords(node);
    const nodeRects = getNodePreviewClientRects(node);
    node[PREVIEW_MEDIA_STYLES] ??= new Map();

    for (const media of document.querySelectorAll("video, img")) {
        const shouldAffectMedia = mediaMatchesPreviewRecords(media, records) || mediaOverlapsNodePreview(media, nodeRects);

        const managedElements = shouldAffectMedia ? getManagedMediaElements(media, nodeRects) : [media];

        if (!shouldAffectMedia) {
            if (!shouldHide) {
                for (const element of managedElements) {
                    if (!node[PREVIEW_MEDIA_STYLES].has(element)) {
                        continue;
                    }

                    const original = node[PREVIEW_MEDIA_STYLES].get(element);
                    element.style.visibility = original.visibility;
                    element.style.pointerEvents = original.pointerEvents;
                    node[PREVIEW_MEDIA_STYLES].delete(element);
                }
            }
            continue;
        }

        for (const element of managedElements) {
            if (!node[PREVIEW_MEDIA_STYLES].has(element)) {
                node[PREVIEW_MEDIA_STYLES].set(element, {
                    visibility: element.style.visibility,
                    pointerEvents: element.style.pointerEvents,
                });
            }

            const original = node[PREVIEW_MEDIA_STYLES].get(element);
            element.style.visibility = element === media && shouldHide ? "hidden" : original.visibility;
            element.style.pointerEvents = shouldHide ? "none" : original.pointerEvents;
        }

        if (shouldHide && media instanceof HTMLVideoElement) {
            media.pause();
            media.autoplay = false;
        }
    }
}

function applyLivePreviewVisibility(node) {
    const shouldHide = isHideModeEnabled(node) && !node[HOVER_STATE];
    applyDomPreviewVisibility(node, shouldHide);
}

function startPreviewWatcher(node) {
    if (node[PREVIEW_WATCHER]) {
        return;
    }

    node[PREVIEW_WATCHER] = setInterval(() => {
        if (!isHideModeEnabled(node) || node[HOVER_STATE]) {
            stopPreviewWatcher(node);
            return;
        }

        applyLivePreviewVisibility(node);
    }, 150);

    if (!node[PREVIEW_OBSERVER]) {
        node[PREVIEW_OBSERVER] = new MutationObserver(() => {
            if (isHideModeEnabled(node) && !node[HOVER_STATE]) {
                requestAnimationFrame(() => applyLivePreviewVisibility(node));
            }
        });
        node[PREVIEW_OBSERVER].observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["src", "style", "class"],
        });
    }
}

function stopPreviewWatcher(node) {
    if (node[PREVIEW_WATCHER]) {
        clearInterval(node[PREVIEW_WATCHER]);
        node[PREVIEW_WATCHER] = null;
    }
}

function disconnectPreviewObserver(node) {
    stopPreviewWatcher(node);

    if (node[PREVIEW_OBSERVER]) {
        node[PREVIEW_OBSERVER].disconnect();
        node[PREVIEW_OBSERVER] = null;
    }
}

function applyDomPreviewVisibility(node, shouldHide) {
    for (const widget of getDomPreviewWidgets(node)) {
        widget.value ??= {};
        if (widget.name === VIDEO_PREVIEW_WIDGET) {
            widget.value.hidden = shouldHide;
        }

        widget[PREVIEW_WIDGET_STYLES] ??= new Map();

        for (const element of getWidgetElements(widget)) {
            if (!widget[PREVIEW_WIDGET_STYLES].has(element)) {
                widget[PREVIEW_WIDGET_STYLES].set(element, {
                    visibility: element.style.visibility,
                    pointerEvents: element.style.pointerEvents,
                });
            }

            const original = widget[PREVIEW_WIDGET_STYLES].get(element);
            element.style.visibility = shouldHide ? "hidden" : original.visibility;
            element.style.pointerEvents = shouldHide ? "none" : original.pointerEvents;
        }

        if (widget.parentEl) {
            widget.parentEl.hidden = false;
        }

        if (shouldHide) {
            pauseWidgetVideos(widget);
            continue;
        }

        if (widget.videoEl && !widget.value.paused && widget.videoEl.hidden === false) {
            widget.videoEl.play?.();
        }
    }

    applyExternalMediaVisibility(node, shouldHide);
}

function applyPreviewVisibility(node, shouldHide) {
    if (shouldHide) {
        if (Array.isArray(node.imgs) && node.imgs.length > 0 && !isPlaceholderImages(node.imgs)) {
            node[HIDDEN_IMAGES] = node.imgs;
            node[HIDDEN_IMAGE_INDEX] = node.imageIndex ?? null;
        }

        if (Array.isArray(node.images) && node.images.length > 0) {
            node[HIDDEN_NODE_IMAGES] = node.images;
        }

        if (hasHiddenPreviewContent(node)) {
            getPlaceholderImages(node);
            node.imgs = [];
            node.images = [];
            node.imageIndex = null;
        }

        applyDomPreviewVisibility(node, true);
        return;
    }

    if (
        (!Array.isArray(node.imgs) || node.imgs.length === 0 || isPlaceholderImages(node.imgs)) &&
        Array.isArray(node[HIDDEN_IMAGES])
    ) {
        node.imgs = node[HIDDEN_IMAGES];
        node.imageIndex = node[HIDDEN_IMAGE_INDEX] ?? null;
    }

    if (
        (!Array.isArray(node.images) || node.images.length === 0) &&
        Array.isArray(node[HIDDEN_NODE_IMAGES])
    ) {
        node.images = node[HIDDEN_NODE_IMAGES];
    }

    applyDomPreviewVisibility(node, false);
}

function syncHideOutputImages(node, { force = false } = {}) {
    if (!(ORIGINAL_HIDE_STATE in node)) {
        node[ORIGINAL_HIDE_STATE] = Boolean(node.hideOutputImages);
    }

    const shouldHide = isHideModeEnabled(node) && !node[HOVER_STATE];
    const nextValue = shouldHide || node[ORIGINAL_HIDE_STATE];

    if (force || node[PREVIEW_HIDDEN_STATE] !== shouldHide) {
        applyPreviewVisibility(node, shouldHide);
        node[PREVIEW_HIDDEN_STATE] = shouldHide;
        if (shouldHide) {
            startPreviewWatcher(node);
        } else {
            stopPreviewWatcher(node);
        }
        setCanvasDirty(node);
    }

    if (node.hideOutputImages !== nextValue) {
        node.hideOutputImages = nextValue;
        setCanvasDirty(node);
    }
}

function getLocalPos(node, event, localPos) {
    if (Array.isArray(localPos)) {
        return localPos;
    }

    const canvas = app.canvas;
    const graphPos = canvas?.graph_mouse ?? canvas?.last_mouse;

    if (Array.isArray(graphPos) && Array.isArray(node.pos)) {
        return [graphPos[0] - node.pos[0], graphPos[1] - node.pos[1]];
    }

    return event && Number.isFinite(event.canvasX) && Number.isFinite(event.canvasY)
        ? [event.canvasX - node.pos[0], event.canvasY - node.pos[1]]
        : null;
}

function isPreviewWidget(widget) {
    return widget?.name === CANVAS_IMAGE_PREVIEW_WIDGET ||
        widget?.name === VIDEO_PREVIEW_WIDGET ||
        widget?.type === "IMAGE_PREVIEW";
}

function getWidgetBottom(node) {
    const widgets = node.widgets ?? [];
    const width = node.size?.[0] ?? 0;
    const defaultWidgetHeight = globalThis.LiteGraph?.NODE_WIDGET_HEIGHT ?? 20;
    let bottom = 0;

    for (const widget of widgets) {
        if (widget.hidden || widget.options?.hidden || isPreviewWidget(widget)) {
            continue;
        }

        if (Number.isFinite(widget.last_y)) {
            const widgetHeight = widget.computeSize?.(width)?.[1] ?? defaultWidgetHeight;
            bottom = Math.max(bottom, widget.last_y + widgetHeight);
            continue;
        }

        const widgetHeight = widget.computeSize?.(width)?.[1] ?? defaultWidgetHeight;
        bottom += widgetHeight + 4;
    }

    return bottom;
}

function getPreviewAreaTop(node) {
    const previewWidget = node.widgets?.find(isPreviewWidget);

    if (previewWidget && Number.isFinite(previewWidget.last_y)) {
        return previewWidget.last_y;
    }

    if (Number.isFinite(node.imageOffset)) {
        return node.imageOffset;
    }

    const widgetBottom = getWidgetBottom(node);
    return Math.max(widgetBottom, 0);
}

function getPreviewArea(node) {
    const previewWidget = node.widgets?.find(isPreviewWidget);
    const width = node.size?.[0] ?? 0;
    const height = node.size?.[1] ?? 0;

    if (previewWidget && Number.isFinite(previewWidget.last_y)) {
        const top = previewWidget.last_y;
        const widgetHeight = previewWidget.computedHeight ?? previewWidget.computeSize?.(width)?.[1] ?? height - top;
        return {
            x: 0,
            y: top,
            width,
            height: Math.max(0, widgetHeight),
        };
    }

    const top = getPreviewAreaTop(node);
    return {
        x: 0,
        y: top,
        width,
        height: Math.max(0, height - top),
    };
}

function drawHiddenPlaceholder(node, ctx) {
    if (!ctx || !isHideModeEnabled(node) || node[HOVER_STATE] || !hasHiddenPreviewContent(node)) {
        return;
    }

    const placeholder = getPlaceholderImages(node)?.[0];

    if (!placeholder) {
        return;
    }

    const area = getPreviewArea(node);

    if (area.width <= 0 || area.height <= 0) {
        return;
    }

    ctx.save();
    ctx.drawImage(placeholder, area.x, area.y, area.width, area.height);
    ctx.restore();
}

function isInPreviewArea(node, event, localPos) {
    const pos = getLocalPos(node, event, localPos);

    if (!pos || !node.size) {
        return false;
    }

    const [x, y] = pos;
    const [width, height] = node.size;
    const previewTop = getPreviewAreaTop(node);

    return x >= 0 && x <= width && y >= previewTop && y <= height;
}

function updatePreviewHover(node, isHovering) {
    if (node[HOVER_STATE] === isHovering) {
        return;
    }

    node[HOVER_STATE] = isHovering;
    syncHideOutputImages(node);
    setCanvasDirty(node);
}

function scheduleManagedHoverRefresh() {
    if (managedHoverRefreshQueued) {
        return;
    }

    managedHoverRefreshQueued = true;
    requestAnimationFrame(() => {
        managedHoverRefreshQueued = false;
        refreshManagedHoverStates();
    });
}

function refreshManagedHoverStates() {
    for (const node of managedHideModeNodes) {
        if (!isAdvancedSaveNode(node)) {
            managedHideModeNodes.delete(node);
            continue;
        }

        if (!isHideModeEnabled(node)) {
            updatePreviewHover(node, false);
            continue;
        }

        updatePreviewHover(node, isPointerOverPreviewRect(node));
    }
}

function scheduleHideModeSync(node) {
    syncHideOutputImages(node, { force: true });
    requestAnimationFrame(() => syncHideOutputImages(node, { force: true }));
    setTimeout(() => syncHideOutputImages(node, { force: true }), 100);
    setTimeout(() => syncHideOutputImages(node, { force: true }), 500);
}

function setupHideMode(node) {
    ensureHideModeProperty(node);
    ensureHideModeWidget(node);
    node[HOVER_STATE] = false;
    managedHideModeNodes.add(node);

    const originalOnConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
        const result = originalOnConfigure?.apply(this, args);
        ensureHideModeProperty(this);
        ensureHideModeWidget(this);
        setHideModeValue(this, this.properties?.[PROPERTY_NAME]);
        syncHideOutputImages(this);
        return result;
    };

    const originalOnSerialize = node.onSerialize;
    node.onSerialize = function (info) {
        const result = originalOnSerialize?.apply(this, arguments);
        syncHideModePropertyFromWidget(this);

        if (info) {
            info.properties ??= {};
            info.properties[PROPERTY_NAME] = this.properties[PROPERTY_NAME];
        }

        return result;
    };

    const originalOnDrawBackground = node.onDrawBackground;
    node.onDrawBackground = function (...args) {
        const result = originalOnDrawBackground?.apply(this, args);
        return result;
    };

    const originalOnExecuted = node.onExecuted;
    node.onExecuted = function (...args) {
        const result = originalOnExecuted?.apply(this, args);
        scheduleHideModeSync(this);
        return result;
    };

    const originalOnDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (ctx, ...args) {
        const result = originalOnDrawForeground?.call(this, ctx, ...args);
        drawHiddenPlaceholder(this, ctx);
        return result;
    };

    const originalOnMouseMove = node.onMouseMove;
    node.onMouseMove = function (event, localPos, graphCanvas) {
        updatePreviewHover(this, isInPreviewArea(this, event, localPos) || isPointerOverPreviewRect(this));
        return originalOnMouseMove?.call(this, event, localPos, graphCanvas);
    };

    const originalOnMouseLeave = node.onMouseLeave;
    node.onMouseLeave = function (...args) {
        setTimeout(() => {
            updatePreviewHover(this, isPointerOverPreviewRect(this));
        }, 80);
        return originalOnMouseLeave?.apply(this, args);
    };

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
        managedHideModeNodes.delete(this);
        applyPreviewVisibility(this, false);
        disconnectPreviewObserver(this);

        if (ORIGINAL_HIDE_STATE in this) {
            this.hideOutputImages = this[ORIGINAL_HIDE_STATE];
        }

        return originalOnRemoved?.apply(this, args);
    };

    syncHideOutputImages(node);
}

function getNodeData(node) {
    return node?.constructor?.nodeData ?? globalThis.LiteGraph?.registered_node_types?.[node.type]?.nodeData;
}

function getFormatDefinitions(node) {
    return getNodeData(node)?.input?.required?.format?.[1]?.formats ?? {};
}

function getWidgetType(widgetDefinition) {
    let type = widgetDefinition?.[2]?.widgetType ?? widgetDefinition?.[1];

    if (Array.isArray(type)) {
        type = "COMBO";
    }

    return type;
}

function removeInputByName(node, name) {
    const slot = node.inputs?.findIndex((input) => input.name === name) ?? -1;

    if (slot >= 0) {
        node.removeInput(slot);
    }
}

function addFormatWidgetInput(node, widget) {
    if (!widget?.config || !Array.isArray(node.inputs)) {
        return;
    }

    const existingInput = node.inputs.find((input) => input.name === widget.name);
    if (existingInput) {
        existingInput.type = widget.config[0];
        existingInput.widget ??= {};
        existingInput.widget.name = widget.name;
        return;
    }

    node.addInput?.(widget.name, widget.config[0], { widget: { name: widget.name } });
}

function createFormatWidget(node, widgetDefinition) {
    const type = getWidgetType(widgetDefinition);
    const factory = app.widgets?.[type];

    if (!factory) {
        return null;
    }

    factory(node, widgetDefinition[0], widgetDefinition.slice(1), app);
    const widget = node.widgets?.pop();

    if (!widget) {
        return null;
    }

    widget.config = widgetDefinition.slice(1);
    return widget;
}

function refreshFormatWidgets(node, formatValue) {
    const definitions = getFormatDefinitions(node);
    const formatWidget = node.widgets?.find((widget) => widget.name === "format");
    const formatWidgetIndex = node.widgets?.findIndex((widget) => widget === formatWidget) ?? -1;

    if (!formatWidget || formatWidgetIndex < 0) {
        return;
    }

    const oldWidgets = node[FORMAT_WIDGETS] ?? [];
    for (const widget of oldWidgets) {
        removeInputByName(node, widget.name);
        widget.onRemove?.();
    }

    const newWidgets = [];
    for (const widgetDefinition of definitions?.[formatValue] ?? []) {
        const widget = createFormatWidget(node, widgetDefinition);
        if (widget) {
            newWidgets.push(widget);
        }
    }

    node.widgets.splice(formatWidgetIndex + 1, node[FORMAT_WIDGET_COUNT] ?? 0, ...newWidgets);
    node[FORMAT_WIDGETS] = newWidgets;
    node[FORMAT_WIDGET_COUNT] = newWidgets.length;

    for (const widget of newWidgets) {
        addFormatWidgetInput(node, widget);
    }

    node.setSize?.(node.computeSize?.() ?? node.size);
    setCanvasDirty(node);
}

function setupFormatWidgets(node) {
    if (node[FORMAT_WIDGET_CALLBACK]) {
        return;
    }

    const formatWidget = node.widgets?.find((widget) => widget.name === "format");
    if (!formatWidget) {
        return;
    }

    const originalCallback = formatWidget.callback;
    formatWidget.callback = function (value, ...args) {
        const result = originalCallback?.call(this, value, ...args);
        refreshFormatWidgets(node, value);
        return result;
    };
    node[FORMAT_WIDGET_CALLBACK] = true;
    refreshFormatWidgets(node, formatWidget.value);
}

app.registerExtension({
    name: "Helto.AdvancedSave.HideMode",
    nodeCreated(node) {
        if (!isAdvancedSaveNode(node)) {
            return;
        }

        setupHideMode(node);

        if (isSaveVideoAdvancedNode(node)) {
            setupFormatWidgets(node);
        }
    },
});
