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
const HIDDEN_IMAGE_INDEX = "__heltoHideModeHiddenImageIndex";
const HIDE_MODE_WIDGET = "__heltoHideModeWidget";
const FORMAT_WIDGETS = "__heltoVideoFormatWidgets";
const FORMAT_WIDGET_COUNT = "__heltoVideoFormatWidgetCount";
const FORMAT_WIDGET_CALLBACK = "__heltoVideoFormatWidgetCallback";
const CANVAS_IMAGE_PREVIEW_WIDGET = "$$canvas-image-preview";
const PLACEHOLDER_SRC = new URL("./hidden_preview_placeholder.png", import.meta.url).href;

let placeholderImage = null;
let placeholderImages = null;
let placeholderLoadStarted = false;

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

function applyPreviewVisibility(node, shouldHide) {
    if (shouldHide) {
        if (Array.isArray(node.imgs) && node.imgs.length > 0 && !isPlaceholderImages(node.imgs)) {
            node[HIDDEN_IMAGES] = node.imgs;
            node[HIDDEN_IMAGE_INDEX] = node.imageIndex ?? null;
        }

        if (Array.isArray(node[HIDDEN_IMAGES]) && node[HIDDEN_IMAGES].length > 0) {
            getPlaceholderImages(node);
            node.imgs = [];
            node.imageIndex = null;
        }

        return;
    }

    if (
        (!Array.isArray(node.imgs) || node.imgs.length === 0 || isPlaceholderImages(node.imgs)) &&
        Array.isArray(node[HIDDEN_IMAGES])
    ) {
        node.imgs = node[HIDDEN_IMAGES];
        node.imageIndex = node[HIDDEN_IMAGE_INDEX] ?? null;
    }
}

function syncHideOutputImages(node) {
    if (!(ORIGINAL_HIDE_STATE in node)) {
        node[ORIGINAL_HIDE_STATE] = Boolean(node.hideOutputImages);
    }

    const shouldHide = isHideModeEnabled(node) && !node[HOVER_STATE];
    const nextValue = shouldHide || node[ORIGINAL_HIDE_STATE];

    applyPreviewVisibility(node, shouldHide);

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
    return widget?.name === CANVAS_IMAGE_PREVIEW_WIDGET || widget?.type === "IMAGE_PREVIEW";
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
    if (!ctx || !isHideModeEnabled(node) || node[HOVER_STATE] || !Array.isArray(node[HIDDEN_IMAGES]) || node[HIDDEN_IMAGES].length === 0) {
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

function setupHideMode(node) {
    ensureHideModeProperty(node);
    ensureHideModeWidget(node);
    node[HOVER_STATE] = false;

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
        syncHideOutputImages(this);
        return result;
    };

    const originalOnDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (ctx, ...args) {
        syncHideOutputImages(this);
        const result = originalOnDrawForeground?.call(this, ctx, ...args);
        drawHiddenPlaceholder(this, ctx);
        return result;
    };

    const originalOnMouseMove = node.onMouseMove;
    node.onMouseMove = function (event, localPos, graphCanvas) {
        updatePreviewHover(this, isInPreviewArea(this, event, localPos));
        return originalOnMouseMove?.call(this, event, localPos, graphCanvas);
    };

    const originalOnMouseLeave = node.onMouseLeave;
    node.onMouseLeave = function (...args) {
        updatePreviewHover(this, false);
        return originalOnMouseLeave?.apply(this, args);
    };

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
        applyPreviewVisibility(this, false);

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
