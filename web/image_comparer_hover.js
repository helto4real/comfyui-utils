import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "HeltoImageComparer";
const DISPLAY_NAME = "Image Comparer";
const PROPERTY_NAME = "hide mode";
const HIDE_MODE_WIDGET = "__heltoImageComparerHideModeWidget";
const PREVIEW_WIDGET = "__heltoImageComparerPreviewWidget";
const HOVER_STATE = "__heltoImageComparerHover";
const POINTER_X = "__heltoImageComparerPointerX";

function getNodeClass(node) {
    const candidates = [
        node?.constructor?.comfyClass,
        node?.constructor?.nodeData?.name,
        node?.constructor?.type,
        node?.comfyClass,
        node?.type,
    ];

    if (candidates.includes(NODE_CLASS)) {
        return NODE_CLASS;
    }

    const title = node?.constructor?.title ?? node?.title;
    return title === DISPLAY_NAME ? NODE_CLASS : null;
}

function isImageComparerNode(node) {
    return getNodeClass(node) === NODE_CLASS;
}

function setCanvasDirty(node) {
    node?.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function ensureHideModeProperty(node) {
    node.properties ??= {};

    if (node.properties[PROPERTY_NAME] === undefined) {
        if (typeof node.addProperty === "function") {
            node.addProperty(PROPERTY_NAME, true, "boolean");
        } else {
            node.properties[PROPERTY_NAME] = true;
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
        setCanvasDirty(node);
    };
    widget.serialize = false;
    widget.options ??= {};
    widget.options.serialize = false;
    node[HIDE_MODE_WIDGET] = widget;
}

function syncHideModePropertyFromWidget(node) {
    if (node[HIDE_MODE_WIDGET]) {
        node.properties[PROPERTY_NAME] = Boolean(node[HIDE_MODE_WIDGET].value);
    } else {
        node.properties[PROPERTY_NAME] = Boolean(node.properties?.[PROPERTY_NAME]);
    }
}

function isHideModeEnabled(node) {
    syncHideModePropertyFromWidget(node);
    return Boolean(node.properties?.[PROPERTY_NAME]);
}

function imageRecordToUrl(record) {
    if (!record?.filename || !record?.type) {
        return null;
    }

    const params = new URLSearchParams({
        filename: record.filename,
        type: record.type,
        subfolder: record.subfolder ?? "",
    });

    return api.apiURL(`/view?${params.toString()}${app.getPreviewFormatParam?.() ?? ""}${app.getRandParam?.() ?? ""}`);
}

function createPreviewImage(node, record) {
    const url = imageRecordToUrl(record);

    if (!url) {
        return null;
    }

    const image = new Image();
    image.onload = () => setCanvasDirty(node);
    image.src = url;
    return image;
}

function getFittedRect(image, x, y, width, height) {
    const imageAspect = image.naturalWidth / image.naturalHeight;
    const areaAspect = width / height;
    let drawWidth = width;
    let drawHeight = height;

    if (imageAspect > areaAspect) {
        drawHeight = width / imageAspect;
    } else {
        drawWidth = height * imageAspect;
    }

    return {
        x: x + (width - drawWidth) / 2,
        y: y + (height - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight,
    };
}

function drawContainedImage(ctx, image, x, y, width, height) {
    if (!image?.naturalWidth || !image?.naturalHeight || width <= 0 || height <= 0) {
        return null;
    }

    const rect = getFittedRect(image, x, y, width, height);
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    return rect;
}

function drawSplitImage(ctx, originalImage, newImage, x, y, width, height, splitX) {
    const originalRect = drawContainedImage(ctx, originalImage, x, y, width, height);

    if (!newImage?.naturalWidth || !newImage?.naturalHeight) {
        return;
    }

    const clampedSplitX = Math.min(Math.max(splitX, x), x + width);
    ctx.save();
    ctx.beginPath();
    ctx.rect(clampedSplitX, y, x + width - clampedSplitX, height);
    ctx.clip();
    const newRect = drawContainedImage(ctx, newImage, x, y, width, height);
    ctx.restore();

    const dividerTop = Math.min(originalRect?.y ?? y, newRect?.y ?? y);
    const dividerBottom = Math.max(
        (originalRect?.y ?? y) + (originalRect?.height ?? height),
        (newRect?.y ?? y) + (newRect?.height ?? height),
    );

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(clampedSplitX, dividerTop);
    ctx.lineTo(clampedSplitX, dividerBottom);
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = "rgba(160, 160, 160, 0.75)";
    ctx.stroke();
    ctx.restore();
}

class ImageComparerPreviewWidget {
    constructor(node) {
        this.name = "helto_image_comparer_preview";
        this.type = "custom";
        this.node = node;
        this.originalImage = null;
        this.newImage = null;
    }

    setImages(originalRecord, newRecord) {
        this.originalImage = createPreviewImage(this.node, originalRecord);
        this.newImage = createPreviewImage(this.node, newRecord);
        this.node.setSize?.(this.node.computeSize?.() ?? this.node.size);
        setCanvasDirty(this.node);
    }

    hasImages() {
        return Boolean(this.originalImage || this.newImage);
    }

    draw(ctx, node, width, y) {
        if (!this.hasImages()) {
            return;
        }

        const nodeWidth = node.size?.[0] ?? width;
        const height = Math.max(0, node.size[1] - y);
        const shouldSplit = !isHideModeEnabled(node) || Boolean(node[HOVER_STATE]);
        const splitX = Number.isFinite(node[POINTER_X]) ? node[POINTER_X] : nodeWidth / 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, y, nodeWidth, height);
        ctx.clip();
        ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
        ctx.fillRect(0, y, nodeWidth, height);

        if (shouldSplit && this.originalImage && this.newImage) {
            drawSplitImage(ctx, this.originalImage, this.newImage, 0, y, nodeWidth, height, splitX);
        } else if (this.originalImage) {
            drawContainedImage(ctx, this.originalImage, 0, y, nodeWidth, height);
        }

        ctx.restore();
    }

    computeSize(width) {
        const nodeWidth = this.node.size?.[0] ?? width ?? 260;

        if (!this.hasImages()) {
            return [nodeWidth, 0];
        }

        const previewWidth = nodeWidth;
        return [previewWidth, Math.max(180, Math.round(previewWidth * 0.75))];
    }

    serializeValue() {
        return undefined;
    }
}

function ensurePreviewWidget(node) {
    if (node[PREVIEW_WIDGET]) {
        return;
    }

    const widget = new ImageComparerPreviewWidget(node);
    if (typeof node.addCustomWidget === "function") {
        node.addCustomWidget(widget);
    } else {
        node.widgets ??= [];
        node.widgets.push(widget);
    }

    node[PREVIEW_WIDGET] = widget;
}

function updatePreviewHover(node, isHovering) {
    if (node[HOVER_STATE] === isHovering) {
        return;
    }

    node[HOVER_STATE] = isHovering;
    setCanvasDirty(node);
}

function getLocalMouseX(node, event, localPos) {
    if (Array.isArray(localPos) && Number.isFinite(localPos[0])) {
        return localPos[0];
    }

    const canvas = app.canvas;
    const graphPos = canvas?.graph_mouse ?? canvas?.last_mouse;

    if (Array.isArray(graphPos) && Array.isArray(node.pos) && Number.isFinite(graphPos[0])) {
        return graphPos[0] - node.pos[0];
    }

    if (event && Number.isFinite(event.canvasX) && Array.isArray(node.pos)) {
        return event.canvasX - node.pos[0];
    }

    return null;
}

function updatePointerPosition(node, event, localPos) {
    const localX = getLocalMouseX(node, event, localPos);

    if (!Number.isFinite(localX)) {
        return;
    }

    const nodeWidth = node.size?.[0] ?? localX;
    node[POINTER_X] = Math.min(Math.max(localX, 0), nodeWidth);
    setCanvasDirty(node);
}

function setupImageComparer(node) {
    ensureHideModeProperty(node);
    ensureHideModeWidget(node);
    ensurePreviewWidget(node);
    node[HOVER_STATE] = false;
    node[POINTER_X] = (node.size?.[0] ?? 0) / 2;

    const originalOnConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
        const result = originalOnConfigure?.apply(this, args);
        ensureHideModeProperty(this);
        ensureHideModeWidget(this);
        ensurePreviewWidget(this);

        if (this[HIDE_MODE_WIDGET]) {
            this[HIDE_MODE_WIDGET].value = Boolean(this.properties?.[PROPERTY_NAME]);
        }
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

    const originalOnExecuted = node.onExecuted;
    node.onExecuted = function (output, ...args) {
        const result = originalOnExecuted?.call(this, output, ...args);
        const originalRecord = output?.a_images?.[0] ?? output?.images?.[0] ?? null;
        const newRecord = output?.b_images?.[0] ?? output?.images?.[1] ?? null;
        this[PREVIEW_WIDGET]?.setImages(originalRecord, newRecord);
        setCanvasDirty(this);
        return result;
    };

    const originalOnMouseEnter = node.onMouseEnter;
    node.onMouseEnter = function (...args) {
        updatePreviewHover(this, true);
        return originalOnMouseEnter?.apply(this, args);
    };

    const originalOnMouseMove = node.onMouseMove;
    node.onMouseMove = function (event, localPos, ...args) {
        updatePointerPosition(this, event, localPos);
        updatePreviewHover(this, true);
        return originalOnMouseMove?.call(this, event, localPos, ...args);
    };

    const originalOnMouseLeave = node.onMouseLeave;
    node.onMouseLeave = function (...args) {
        updatePreviewHover(this, false);
        return originalOnMouseLeave?.apply(this, args);
    };

    node.setSize?.(node.computeSize?.() ?? node.size);
    setCanvasDirty(node);
}

app.registerExtension({
    name: "Helto.ImageComparer.HoverPreview",
    nodeCreated(node) {
        if (!isImageComparerNode(node)) {
            return;
        }

        setupImageComparer(node);
    },
});
