import { app } from "/scripts/app.js";

const NODE_CLASS = "HeltoSaveImageAdvanced";
const PROPERTY_NAME = "hide mode";
const HOVER_STATE = "__heltoHideModePreviewHover";
const ORIGINAL_HIDE_STATE = "__heltoHideModeOriginalHideOutputImages";
const HIDDEN_IMAGES = "__heltoHideModeHiddenImages";
const HIDE_MODE_WIDGET = "__heltoHideModeWidget";

function isSaveImageAdvancedNode(node) {
    return (
        node?.constructor?.comfyClass === NODE_CLASS ||
        node?.constructor?.nodeData?.name === NODE_CLASS ||
        node?.constructor?.type === NODE_CLASS ||
        node?.constructor?.title === "Save Image Advanced" ||
        node?.comfyClass === NODE_CLASS ||
        node?.type === NODE_CLASS ||
        node?.title === "Save Image Advanced"
    );
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

function applyPreviewVisibility(node, shouldHide) {
    if (shouldHide) {
        if (Array.isArray(node.imgs) && node.imgs.length > 0) {
            node[HIDDEN_IMAGES] = node.imgs;
            node.imgs = [];
        }

        return;
    }

    if ((!Array.isArray(node.imgs) || node.imgs.length === 0) && Array.isArray(node[HIDDEN_IMAGES])) {
        node.imgs = node[HIDDEN_IMAGES];
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

function getWidgetBottom(node) {
    const widgets = node.widgets ?? [];
    const width = node.size?.[0] ?? 0;
    const defaultWidgetHeight = globalThis.LiteGraph?.NODE_WIDGET_HEIGHT ?? 20;
    let bottom = 0;

    for (const widget of widgets) {
        if (widget.hidden || widget.options?.hidden) {
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
    if (Number.isFinite(node.imageOffset)) {
        return node.imageOffset;
    }

    const widgetBottom = getWidgetBottom(node);
    return Math.max(widgetBottom, 0);
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
    node.onDrawForeground = function (...args) {
        syncHideOutputImages(this);
        return originalOnDrawForeground?.apply(this, args);
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

app.registerExtension({
    name: "Helto.SaveImageAdvanced.HideMode",
    nodeCreated(node) {
        if (!isSaveImageAdvancedNode(node)) {
            return;
        }

        setupHideMode(node);
    },
});
