import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
    previewKeysForNode,
    runWithPreviewPriming,
    storeOutputForPreviewKeys,
} from "./hide_mode_helpers.js";
import {
    SAVE_IMAGE_RELEASE_ROUTE,
    SAVE_VIDEO_RELEASE_ROUTE,
    buildPauseResumePrompt,
} from "./pause_control_helpers.js";

const NODE_CLASSES = new Map([
    ["HeltoSaveImageAdvanced", "Save Image Advanced"],
    ["HeltoSaveVideoAdvanced", "Save Video Advanced"],
    ["HeltoLoadVideo", "Load Video"],
]);
const VIDEO_NODE_CLASS = "HeltoSaveVideoAdvanced";
const VIDEO_NODE_CLASSES = new Set(["HeltoSaveVideoAdvanced", "HeltoLoadVideo"]);
const PROPERTY_NAME = "hide mode";
const HOVER_STATE = "__heltoHideModePreviewHover";
const ORIGINAL_HIDE_STATE = "__heltoHideModeOriginalHideOutputImages";
const HIDDEN_IMAGES = "__heltoHideModeHiddenImages";
const HIDDEN_NODE_IMAGES = "__heltoHideModeHiddenNodeImages";
const HIDDEN_IMAGE_INDEX = "__heltoHideModeHiddenImageIndex";
const HIDE_MODE_WIDGET = "__heltoHideModeWidget";
const PAUSE_CONTROL_WIDGET = "__heltoPauseControlWidget";
const PAUSE_CONTROL_STATE = "__heltoPauseControlState";
const PREVIEW_HIDDEN_STATE = "__heltoHideModePreviewHiddenState";
const PREVIEW_WIDGET_STYLES = "__heltoHideModePreviewWidgetStyles";
const PREVIEW_MEDIA_STYLES = "__heltoHideModePreviewMediaStyles";
const PREVIEW_WATCHER = "__heltoHideModePreviewWatcher";
const PREVIEW_OBSERVER = "__heltoHideModePreviewObserver";
const HOVER_CLEAR_TIMER = "__heltoHideModeHoverClearTimer";
const VUE_NODE_POSITION_STYLE = "__heltoHideModeVueNodePositionStyle";
const DEBUG_STORAGE_KEY = "heltoHideModeDebug";
const RESTORED_OUTPUT_REFRESHED = "__heltoHideModeRestoredOutputRefreshed";
const RESTORE_REFRESH_SCHEDULED = "__heltoHideModeRestoreRefreshScheduled";
const FORMAT_WIDGETS = "__heltoVideoFormatWidgets";
const FORMAT_WIDGET_COUNT = "__heltoVideoFormatWidgetCount";
const FORMAT_WIDGET_CALLBACK = "__heltoVideoFormatWidgetCallback";
const CANVAS_IMAGE_PREVIEW_WIDGET = "$$canvas-image-preview";
const VIDEO_PREVIEW_WIDGET = "videopreview";
const NATIVE_VIDEO_PREVIEW_WIDGET = "video-preview";
const VUE_PLACEHOLDER_ATTR = "data-helto-hide-mode-placeholder";
const VUE_FALLBACK_PLACEHOLDER_ATTR = "data-helto-hide-mode-fallback";
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

function isSaveImageAdvancedNode(node) {
    return getNodeClass(node) === "HeltoSaveImageAdvanced";
}

function isSaveVideoAdvancedNode(node) {
    return VIDEO_NODE_CLASSES.has(getNodeClass(node));
}

function cssEscape(value) {
    return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
}

function getVueNodeElement(node) {
    const nodeId = String(node.id);
    const exactMatch = Array.from(document.querySelectorAll("[data-node-id]")).find((element) => {
        return element.getAttribute("data-node-id") === nodeId;
    });

    return exactMatch ?? document.querySelector(`[data-node-id="${cssEscape(node.id)}"]`);
}

function getVueNodeBodyElement(node) {
    const nodeElement = getVueNodeElement(node);
    return nodeElement?.querySelector?.(`[data-testid="node-body-${cssEscape(node.id)}"]`) ?? null;
}

function isVueRenderedNode(node) {
    return getVueNodeElement(node) instanceof HTMLElement;
}

function hasVueVideoPreview(node) {
    return Boolean(getVueNodeElement(node)?.querySelector?.(".video-preview"));
}

function ensureVideoPreviewMediaType(node) {
    if (isSaveVideoAdvancedNode(node)) {
        node.previewMediaType = "video";
    }
}

function setCanvasDirty(node) {
    node?.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function privateRecordToUrl(record) {
    if (!record?.private || !record?.token) {
        return null;
    }
    const params = new URLSearchParams({ token: record.token });
    return api.apiURL(`/helto_utils/private_media?${params.toString()}${app.getRandParam?.() ?? ""}`);
}

function privatePreviewUrls(output) {
    if (!Array.isArray(output?.images)) {
        return [];
    }
    return output.images.map(privateRecordToUrl).filter(Boolean);
}

function syncPrivatePreviewUrls(node, output) {
    const urls = privatePreviewUrls(output);
    app.nodePreviewImages ??= {};

    if (urls.length) {
        for (const key of previewKeysForNode(node)) {
            app.nodePreviewImages[key] = urls;
        }
        ensureVideoPreviewMediaType(node);
        return true;
    }

    for (const key of previewKeysForNode(node)) {
        delete app.nodePreviewImages[key];
    }
    return false;
}

function getStoredNodeOutput(node) {
    for (const key of previewKeysForNode(node)) {
        const output = app.nodeOutputs?.[key];
        if (output?.images?.length) {
            return output;
        }
    }
    return null;
}

function applyPrivateImagePreviews(node, records) {
    if (!Array.isArray(records) || records.length === 0) {
        return false;
    }

    const images = [];
    for (const record of records) {
        const url = privateRecordToUrl(record);
        if (!url) {
            continue;
        }
        const image = new Image();
        image.onload = () => setCanvasDirty(node);
        image.src = url;
        images.push(image);
    }

    if (!images.length) {
        return false;
    }

    node.imgs = images;
    node.imageIndex = 0;
    node[HIDDEN_IMAGES] = images;
    node[HIDDEN_IMAGE_INDEX] = 0;
    setCanvasDirty(node);
    return true;
}

function isDebugEnabled() {
    return Boolean(globalThis.HELTO_HIDE_MODE_DEBUG) || localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
}

function getHideModeDebugState(node) {
    const nodeElement = getVueNodeElement(node);
    const nodeId = String(node.id);
    const output = app.nodeOutputs?.[nodeId];

    return {
        id: nodeId,
        type: getNodeClass(node),
        hideMode: Boolean(node.properties?.[PROPERTY_NAME]),
        widgetValue: node[HIDE_MODE_WIDGET]?.value,
        hover: Boolean(node[HOVER_STATE]),
        hiddenState: node[PREVIEW_HIDDEN_STATE],
        hideOutputImages: Boolean(node.hideOutputImages),
        imgs: Array.isArray(node.imgs) ? node.imgs.length : null,
        images: Array.isArray(node.images) ? node.images.length : null,
        hiddenImages: Array.isArray(node[HIDDEN_IMAGES]) ? node[HIDDEN_IMAGES].length : null,
        hiddenNodeImages: Array.isArray(node[HIDDEN_NODE_IMAGES]) ? node[HIDDEN_NODE_IMAGES].length : null,
        nodeOutputs: Array.isArray(output?.images) ? output.images.length : null,
        videoContainer: node.videoContainer instanceof HTMLElement,
        domPreviewWidgets: getDomPreviewWidgets(node).map((widget) => ({
            name: widget.name,
            type: widget.type,
            elements: getWidgetElements(widget).length,
        })),
        vueNode: nodeElement instanceof HTMLElement,
        vuePreviews: nodeElement?.querySelectorAll?.(".video-preview").length ?? null,
        placeholders: nodeElement?.querySelectorAll?.(`[${VUE_PLACEHOLDER_ATTR}]`).length ?? null,
    };
}

function debugHideModeState(node, label, { force = false } = {}) {
    if ((!force && !isDebugEnabled()) || !isSaveVideoAdvancedNode(node)) {
        return null;
    }

    const state = getHideModeDebugState(node);
    console.warn("[Helto hide mode]", label, state);
    return state;
}

function dumpHideModeDebugState() {
    const nodes = app.graph?._nodes ?? [];
    const states = nodes
        .filter(isSaveVideoAdvancedNode)
        .map((node) => debugHideModeState(node, "manual dump", { force: true }))
        .filter(Boolean);

    if (states.length === 0) {
        console.warn("[Helto hide mode] no managed video hide-mode nodes found");
    }

    return states;
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
        (value) => handleHideModeToggle(node, value),
        { on: "true", off: "false" },
    );

    if (!widget) {
        return;
    }

    widget.value = Boolean(node.properties?.[PROPERTY_NAME]);
    widget.callback = (value) => handleHideModeToggle(node, value);
    widget.serialize = false;
    widget.options ??= {};
    widget.options.serialize = false;
    node[HIDE_MODE_WIDGET] = widget;
    node.setSize?.(node.computeSize?.() ?? node.size);
}

function pauseControlFromOutput(output) {
    const controls = output?.helto_pause_control;
    return Array.isArray(controls) && controls.length > 0 ? controls[0] : null;
}

function pauseControlState(node) {
    node[PAUSE_CONTROL_STATE] ??= {
        hasMedia: false,
        paused: false,
        released: false,
        revision: null,
        busy: false,
    };
    return node[PAUSE_CONTROL_STATE];
}

function updatePauseControlState(node, control = {}) {
    const state = pauseControlState(node);
    if ("has_media" in control) state.hasMedia = Boolean(control.has_media);
    if ("paused" in control) state.paused = Boolean(control.paused);
    if ("released" in control) state.released = Boolean(control.released);
    if ("revision" in control) state.revision = control.revision ?? null;
    updatePauseControlWidget(node);
}

function pauseControlLabel(state) {
    if (state.busy) {
        return "queueing";
    }
    if (state.paused && !state.released) {
        return "continue";
    }
    return "run again";
}

function setPauseControlBusy(node, busy) {
    pauseControlState(node).busy = Boolean(busy);
    updatePauseControlWidget(node);
}

function updatePauseControlWidget(node) {
    const widget = node[PAUSE_CONTROL_WIDGET];
    if (!widget) {
        return;
    }

    const state = pauseControlState(node);
    widget.name = pauseControlLabel(state);
    widget.disabled = !state.hasMedia || state.busy;
    widget.options ??= {};
    widget.options.disabled = widget.disabled;
    setCanvasDirty(node);
}

function moveWidgetToTop(node, widget) {
    const widgets = node.widgets;
    if (!Array.isArray(widgets) || !widget) {
        return;
    }

    const currentIndex = widgets.indexOf(widget);
    if (currentIndex <= 0) {
        return;
    }

    widgets.splice(currentIndex, 1);
    widgets.unshift(widget);
}

function ensurePauseControlWidget(node) {
    if (node[PAUSE_CONTROL_WIDGET]) {
        updatePauseControlWidget(node);
        return;
    }

    const existingWidget = node.widgets?.find((widget) => widget.name === "continue" || widget.name === "run again");
    const widget = existingWidget ?? node.addWidget?.("button", "continue", null, () => handlePauseControlButton(node));
    if (!widget) {
        return;
    }

    widget.callback = () => handlePauseControlButton(node);
    widget.serialize = false;
    widget.options ??= {};
    widget.options.serialize = false;
    node[PAUSE_CONTROL_WIDGET] = widget;
    moveWidgetToTop(node, widget);
    updatePauseControlWidget(node);
    node.setSize?.(node.computeSize?.() ?? node.size);
}

async function postPauseRelease(node) {
    const state = pauseControlState(node);
    const route = getNodeClass(node) === VIDEO_NODE_CLASS ? SAVE_VIDEO_RELEASE_ROUTE : SAVE_IMAGE_RELEASE_ROUTE;
    const body = JSON.stringify({
        node_id: String(node.id),
        revision: state.revision,
    });
    const response = await (api.fetchApi?.(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    }) ?? fetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    }));
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || "Failed to release stored media.");
    }
    return payload;
}

async function queuePauseResumePrompt(node) {
    const prompt = await app.graphToPrompt();
    const { prompt: nextPrompt, downstreamNodeIds } = buildPauseResumePrompt(prompt, node.id, "images");
    if (downstreamNodeIds.length === 0) {
        throw new Error("No downstream nodes are connected to the images output.");
    }

    await postPauseRelease(node);
    return api.queuePrompt?.(-1, nextPrompt) ?? app.queuePrompt?.(0);
}

async function handlePauseControlButton(node) {
    const state = pauseControlState(node);
    if (!state.hasMedia || state.busy) {
        return;
    }

    setPauseControlBusy(node, true);
    try {
        await queuePauseResumePrompt(node);
        state.paused = false;
        state.released = true;
    } catch (error) {
        console.error("[Helto pause control]", error);
    } finally {
        setPauseControlBusy(node, false);
    }
}

function handleHideModeToggle(node, value) {
    const enabled = Boolean(value);
    node.properties[PROPERTY_NAME] = enabled;
    if (node[HIDE_MODE_WIDGET]) {
        node[HIDE_MODE_WIDGET].value = enabled;
    }

    if (isSaveVideoAdvancedNode(node)) {
        node[RESTORED_OUTPUT_REFRESHED] = false;
    }

    syncHideOutputImages(node);

    if (isSaveVideoAdvancedNode(node) && !enabled) {
        applyDomPreviewVisibility(node, false);
        scheduleRestoredVueOutputRefresh(node, { force: true });
    }

    setCanvasDirty(node);
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

function applyImagePreviewVisibility(node, shouldHide) {
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

function syncImageHideOutputImages(node) {
    if (!(ORIGINAL_HIDE_STATE in node)) {
        node[ORIGINAL_HIDE_STATE] = Boolean(node.hideOutputImages);
    }

    const shouldHide = isHideModeEnabled(node) && !node[HOVER_STATE];
    const nextValue = shouldHide || node[ORIGINAL_HIDE_STATE];

    applyImagePreviewVisibility(node, shouldHide);

    if (node.hideOutputImages !== nextValue) {
        node.hideOutputImages = nextValue;
        setCanvasDirty(node);
    }
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
    return node.widgets?.filter(isVideoPreviewWidget) ?? [];
}

function getDomPreviewWidgets(node) {
    return node.widgets?.filter(isDomPreviewWidget) ?? [];
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

    if (isPointerOverNodeVideoContainer(node, x, y)) {
        return true;
    }

    if (isPointerOverVuePreview(node, x, y)) {
        return true;
    }

    for (const element of node[PREVIEW_MEDIA_STYLES]?.keys?.() ?? []) {
        if (isPointInsideElement(element, x, y)) {
            return true;
        }
    }

    return false;
}

function isPointInsideElement(element, x, y) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) {
        return false;
    }

    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isVueHiddenPlaceholderElement(element) {
    return element instanceof HTMLElement &&
        (element.hasAttribute(VUE_PLACEHOLDER_ATTR) || Boolean(element.closest?.(`[${VUE_PLACEHOLDER_ATTR}]`)));
}

function isPointerOverNodeVideoContainer(node, x, y) {
    if (!(node.videoContainer instanceof HTMLElement)) {
        return false;
    }

    if (isPointInsideElement(node.videoContainer, x, y)) {
        return true;
    }

    return Array.from(node.videoContainer.querySelectorAll("video, img")).some((element) => {
        return isPointInsideElement(element, x, y);
    });
}

function isPointerOverVuePreview(node, x, y) {
    const nodeElement = getVueNodeElement(node);
    if (!(nodeElement instanceof HTMLElement)) {
        return false;
    }

    return Array.from(nodeElement.querySelectorAll(`.video-preview, [${VUE_PLACEHOLDER_ATTR}]`)).some((element) => {
        return isPointInsideElement(element, x, y);
    });
}

function applyExternalMediaVisibility(node, shouldHide) {
    const records = getHiddenPreviewRecords(node);
    const nodeRects = getNodePreviewClientRects(node);
    node[PREVIEW_MEDIA_STYLES] ??= new Map();

    for (const media of document.querySelectorAll("video, img")) {
        if (isVueHiddenPlaceholderElement(media)) {
            continue;
        }

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

function applyManagedElementVisibility(node, element, shouldHide) {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    node[PREVIEW_MEDIA_STYLES] ??= new Map();

    if (!node[PREVIEW_MEDIA_STYLES].has(element)) {
        node[PREVIEW_MEDIA_STYLES].set(element, {
            visibility: element.style.visibility,
            pointerEvents: element.style.pointerEvents,
        });
    }

    const original = node[PREVIEW_MEDIA_STYLES].get(element);
    element.style.visibility = shouldHide ? "hidden" : original.visibility;
    element.style.pointerEvents = shouldHide ? "none" : original.pointerEvents;

    if (!shouldHide) {
        node[PREVIEW_MEDIA_STYLES].delete(element);
    }
}

function applyNodeVideoContainerVisibility(node, shouldHide) {
    if (!(node.videoContainer instanceof HTMLElement)) {
        return;
    }

    const elements = [
        node.videoContainer,
        ...node.videoContainer.querySelectorAll("video, img"),
    ];

    for (const element of elements) {
        applyManagedElementVisibility(node, element, shouldHide);

        if (shouldHide && element instanceof HTMLVideoElement) {
            element.pause();
            element.autoplay = false;
        }
    }
}

function elementContainsMatchingMedia(element, records) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    const mediaElements = element.matches?.("video, img")
        ? [element]
        : Array.from(element.querySelectorAll("video, img"));

    return mediaElements.some((media) => mediaMatchesPreviewRecords(media, records));
}

function elementOverlapsAnyNodeRect(element, nodeRects) {
    if (!(element instanceof HTMLElement) || !nodeRects.length) {
        return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) {
        return false;
    }

    const elementArea = rect.width * rect.height;
    return nodeRects.some((nodeRect) => {
        const overlap = rectOverlapArea(rect, nodeRect);
        const nodeArea = nodeRect.width * nodeRect.height;
        return overlap > Math.min(elementArea, nodeArea) * 0.25;
    });
}

function getNodeCssScale(nodeElement) {
    const nodeRect = nodeElement.getBoundingClientRect();
    const nodeWidth = nodeElement.offsetWidth;

    if (!nodeWidth || nodeRect.width <= 0) {
        return 1;
    }

    return nodeRect.width / nodeWidth;
}

function getVuePreviewOverlayRect(nodeElement, previewRoot, placeholder) {
    const nodeRect = nodeElement.getBoundingClientRect();
    const previewRect = previewRoot.getBoundingClientRect();
    const scale = getNodeCssScale(nodeElement);
    const sourceRect = previewRect.width > 0 && previewRect.height > 0
        ? previewRect
        : placeholder.getBoundingClientRect();

    if (!sourceRect.width || !sourceRect.height) {
        return null;
    }

    const top = (sourceRect.top - nodeRect.top) / scale;
    const left = (sourceRect.left - nodeRect.left) / scale;
    const right = (nodeRect.right - sourceRect.right) / scale;

    if (![top, left, right].every(Number.isFinite)) {
        return null;
    }

    return {
        top: Math.max(0, top),
        left: Math.max(0, left),
        right: Math.max(0, right),
    };
}

function createVueHiddenPlaceholder() {
    const placeholder = document.createElement("div");
    placeholder.setAttribute(VUE_PLACEHOLDER_ATTR, "true");
    placeholder.style.background = "#050505";
    placeholder.style.borderRadius = "4px";
    placeholder.style.boxSizing = "border-box";
    placeholder.style.flex = "0 0 auto";
    placeholder.style.overflow = "hidden";
    placeholder.style.maxWidth = "100%";
    placeholder.style.minWidth = "0";
    placeholder.style.width = "100%";

    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.src = PLACEHOLDER_SRC;
    image.style.display = "block";
    image.style.height = "100%";
    image.style.objectFit = "cover";
    image.style.width = "100%";
    placeholder.append(image);

    return placeholder;
}

function getVueHiddenPlaceholder(mountElement) {
    let placeholder = mountElement.querySelector(`[${VUE_PLACEHOLDER_ATTR}]`);
    if (!placeholder) {
        placeholder = createVueHiddenPlaceholder();
    }

    if (placeholder.parentElement !== mountElement) {
        mountElement.append(placeholder);
    }

    return placeholder;
}

function prepareAbsoluteVuePlaceholder(node, nodeElement, placeholder) {
    placeholder.style.display = "";
    placeholder.style.pointerEvents = "auto";
    placeholder.style.position = "absolute";
    placeholder.style.zIndex = "3";
    placeholder.style.boxSizing = "border-box";
    placeholder.style.flex = "";
    placeholder.style.maxWidth = "100%";
    placeholder.style.minWidth = "0";

    if (!(VUE_NODE_POSITION_STYLE in node)) {
        node[VUE_NODE_POSITION_STYLE] = nodeElement.style.position;
    }
    if (getComputedStyle(nodeElement).position === "static") {
        nodeElement.style.position = "relative";
    }
}

function applyVuePlaceholderOverlayRect(placeholder, overlayRect) {
    placeholder.style.setProperty("top", `${Math.round(overlayRect.top)}px`, "important");
    placeholder.style.setProperty("left", `${Math.round(overlayRect.left)}px`, "important");
    placeholder.style.setProperty("right", `${Math.round(overlayRect.right)}px`, "important");
    placeholder.style.setProperty("bottom", `${Math.round(overlayRect.bottom ?? 16)}px`, "important");
    placeholder.style.setProperty("width", "auto", "important");
    placeholder.style.setProperty("height", "auto", "important");
    placeholder.style.setProperty("min-height", "64px", "important");
}

function ensureVueHiddenPlaceholder(node, previewRoot) {
    const parent = previewRoot.parentElement;
    if (!(parent instanceof HTMLElement)) {
        return null;
    }

    const nodeElement = getVueNodeElement(node) ?? previewRoot.closest?.("[data-node-id]");
    const mountElement = nodeElement instanceof HTMLElement ? nodeElement : parent;
    const placeholder = getVueHiddenPlaceholder(mountElement);
    placeholder.removeAttribute(VUE_FALLBACK_PLACEHOLDER_ATTR);

    if (nodeElement instanceof HTMLElement) {
        prepareAbsoluteVuePlaceholder(node, nodeElement, placeholder);

        const overlayRect = getVuePreviewOverlayRect(nodeElement, previewRoot, placeholder);
        if (overlayRect) {
            applyVuePlaceholderOverlayRect(placeholder, overlayRect);
        }
        return placeholder;
    }

    const previewHeight = previewRoot.getBoundingClientRect().height || previewRoot.offsetHeight || 352;
    placeholder.style.height = `${Math.max(64, Math.round(previewHeight))}px`;
    return placeholder;
}

function removeVueHiddenPlaceholderByNode(node, previewRoot = null) {
    const parent = previewRoot?.parentElement;
    const nodeElement = getVueNodeElement(node) ?? previewRoot?.closest?.("[data-node-id]");
    parent?.querySelector?.(`[${VUE_PLACEHOLDER_ATTR}]`)?.remove();
    nodeElement?.querySelector?.(`[${VUE_PLACEHOLDER_ATTR}]`)?.remove();

    if (node && VUE_NODE_POSITION_STYLE in node && nodeElement instanceof HTMLElement) {
        nodeElement.style.position = node[VUE_NODE_POSITION_STYLE];
        delete node[VUE_NODE_POSITION_STYLE];
    }
}

function removeVueHiddenPlaceholder(node, previewRoot) {
    removeVueHiddenPlaceholderByNode(node, previewRoot);
}

function getVueFallbackContentBottom(nodeElement, bodyElement) {
    const nodeRect = nodeElement.getBoundingClientRect();
    const bodyRect = bodyElement.getBoundingClientRect();
    const placeholderSelector = `[${VUE_PLACEHOLDER_ATTR}]`;
    const widgetRegionBottom = nodeRect.top + (nodeRect.height * 0.75);
    const candidates = Array.from(bodyElement.querySelectorAll("*")).filter((element) => {
        if (!(element instanceof HTMLElement) || element.closest?.(placeholderSelector)) {
            return false;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width <= 20 || rect.height <= 8 || rect.height > 72) {
            return false;
        }
        if (rect.top < nodeRect.top || rect.bottom > widgetRegionBottom) {
            return false;
        }

        const overlapsBody = rect.bottom > bodyRect.top && rect.top < bodyRect.bottom;
        const looksLikeControlRow = rect.width >= Math.min(120, bodyRect.width * 0.2);
        return overlapsBody && looksLikeControlRow;
    });

    if (!candidates.length) {
        return null;
    }

    return candidates.reduce((bottom, element) => {
        const rect = element.getBoundingClientRect();
        return Math.max(bottom, rect.bottom);
    }, 0) || null;
}

function getVueFallbackOverlayRect(node, nodeElement, bodyElement) {
    const nodeRect = nodeElement.getBoundingClientRect();
    const bodyRect = bodyElement.getBoundingClientRect();
    const scale = getNodeCssScale(nodeElement);
    const titleHeight = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
    const previewTop = getPreviewAreaTop(node);
    const contentBottom = getVueFallbackContentBottom(nodeElement, bodyElement);
    const top = contentBottom
        ? (contentBottom - nodeRect.top) / scale + 8
        : titleHeight + previewTop + 8;
    const left = (bodyRect.left - nodeRect.left) / scale;
    const right = (nodeRect.right - bodyRect.right) / scale;

    if (![top, left, right].every(Number.isFinite)) {
        return null;
    }

    return {
        top: Math.max(0, top),
        left: Math.max(0, left),
        right: Math.max(0, right),
        bottom: 16,
    };
}

function ensureVueFallbackHiddenPlaceholder(node) {
    const nodeElement = getVueNodeElement(node);
    const bodyElement = getVueNodeBodyElement(node);
    if (!(nodeElement instanceof HTMLElement) || !(bodyElement instanceof HTMLElement)) {
        return null;
    }

    const placeholder = getVueHiddenPlaceholder(nodeElement);
    placeholder.setAttribute(VUE_FALLBACK_PLACEHOLDER_ATTR, "true");
    prepareAbsoluteVuePlaceholder(node, nodeElement, placeholder);

    const overlayRect = getVueFallbackOverlayRect(node, nodeElement, bodyElement);
    if (overlayRect) {
        applyVuePlaceholderOverlayRect(placeholder, overlayRect);
    }

    return placeholder;
}

function applyVuePreviewRootVisibility(node, previewRoot, shouldHide) {
    if (!(previewRoot instanceof HTMLElement)) {
        return;
    }

    if (shouldHide) {
        if (previewRoot.dataset.heltoHideModeDisplay === undefined) {
            previewRoot.dataset.heltoHideModeDisplay = previewRoot.style.display;
        }
        if (previewRoot.dataset.heltoHideModePointerEvents === undefined) {
            previewRoot.dataset.heltoHideModePointerEvents = previewRoot.style.pointerEvents;
        }

        ensureVueHiddenPlaceholder(node, previewRoot);
        previewRoot.style.display = "none";
        previewRoot.style.pointerEvents = "none";
        return;
    }

    removeVueHiddenPlaceholder(node, previewRoot);
    if (previewRoot.dataset.heltoHideModeDisplay !== undefined) {
        previewRoot.style.display = previewRoot.dataset.heltoHideModeDisplay;
        delete previewRoot.dataset.heltoHideModeDisplay;
    }
    if (previewRoot.dataset.heltoHideModePointerEvents !== undefined) {
        previewRoot.style.pointerEvents = previewRoot.dataset.heltoHideModePointerEvents;
        delete previewRoot.dataset.heltoHideModePointerEvents;
    }
}

function applyVueVideoPreviewVisibility(node, shouldHide, { retryMissingPreview = true } = {}) {
    ensureVideoPreviewMediaType(node);

    const records = getHiddenPreviewRecords(node);
    const nodeRects = getNodePreviewClientRects(node);
    const nodeElement = getVueNodeElement(node);
    const candidates = nodeElement
        ? nodeElement.querySelectorAll(".video-preview")
        : document.querySelectorAll(".video-preview");

    let affectedPreviewCount = 0;

    for (const candidate of candidates) {
        const previewRoot = candidate.closest?.(".video-preview") ?? candidate;
        const shouldAffectPreview = Boolean(nodeElement) ||
            elementContainsMatchingMedia(previewRoot, records) ||
            elementOverlapsAnyNodeRect(previewRoot, nodeRects);

        if (!shouldAffectPreview) {
            if (!shouldHide) {
                applyManagedElementVisibility(node, previewRoot, false);
                applyVuePreviewRootVisibility(node, previewRoot, false);
            }
            continue;
        }

        affectedPreviewCount += 1;
        applyVuePreviewRootVisibility(node, previewRoot, shouldHide);

        for (const video of previewRoot.querySelectorAll?.("video") ?? []) {
            if (shouldHide && video instanceof HTMLVideoElement) {
                video.pause();
                video.autoplay = false;
            }
        }
    }

    if (nodeElement && affectedPreviewCount === 0) {
        if (shouldHide) {
            ensureVueFallbackHiddenPlaceholder(node);
        } else if (retryMissingPreview) {
            scheduleRestoredVueOutputRefresh(node, { force: true });
            setTimeout(() => applyVueVideoPreviewVisibility(node, false, { retryMissingPreview: false }), 100);
            setTimeout(() => applyVueVideoPreviewVisibility(node, false, { retryMissingPreview: false }), 500);

            if (hasVueVideoPreview(node)) {
                removeVueHiddenPlaceholderByNode(node);
            }
        } else if (hasVueVideoPreview(node)) {
            removeVueHiddenPlaceholderByNode(node);
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
        const widgetValue = widget.value;
        const hasObjectValue = widgetValue !== null && typeof widgetValue === "object";

        if (isVideoPreviewWidget(widget) && hasObjectValue) {
            widgetValue.hidden = shouldHide;
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

        if (widget.videoEl && !(hasObjectValue && widgetValue.paused) && widget.videoEl.hidden === false) {
            widget.videoEl.play?.();
        }
    }

    applyNodeVideoContainerVisibility(node, shouldHide);
    applyExternalMediaVisibility(node, shouldHide);
    applyVueVideoPreviewVisibility(node, shouldHide);
}

function refreshVideoDomLayerVisibility(node) {
    if (!isSaveVideoAdvancedNode(node) || !isHideModeEnabled(node)) {
        return;
    }

    applyDomPreviewVisibility(node, !node[HOVER_STATE]);
}

function applyVideoPreviewVisibility(node, shouldHide) {
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

        if (isSaveVideoAdvancedNode(node)) {
            applyDomPreviewVisibility(node, true);
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

    if (
        (!Array.isArray(node.images) || node.images.length === 0) &&
        Array.isArray(node[HIDDEN_NODE_IMAGES])
    ) {
        node.images = node[HIDDEN_NODE_IMAGES];
    }

    if (isSaveVideoAdvancedNode(node)) {
        applyDomPreviewVisibility(node, false);
    }
}

function syncHideOutputImages(node, options = {}) {
    if (isSaveImageAdvancedNode(node)) {
        syncImageHideOutputImages(node);
        return;
    }

    syncVideoHideOutputImages(node, options);
}

function syncVideoHideOutputImages(node, { force = false } = {}) {
    if (!(ORIGINAL_HIDE_STATE in node)) {
        node[ORIGINAL_HIDE_STATE] = Boolean(node.hideOutputImages);
    }

    const shouldHide = isHideModeEnabled(node) && !node[HOVER_STATE];
    const isVideoNode = isSaveVideoAdvancedNode(node);
    const nextValue = isVideoNode ? shouldHide : shouldHide || node[ORIGINAL_HIDE_STATE];
    const hideOutputImagesChanged = node.hideOutputImages !== nextValue;

    if (hideOutputImagesChanged) {
        node.hideOutputImages = nextValue;
        setCanvasDirty(node);
    }

    const shouldApplyPreviewVisibility = force || hideOutputImagesChanged || !isVideoNode || node[PREVIEW_HIDDEN_STATE] !== shouldHide;

    if (shouldApplyPreviewVisibility) {
        applyVideoPreviewVisibility(node, shouldHide);
        node[PREVIEW_HIDDEN_STATE] = shouldHide;

        if (isVideoNode && shouldHide) {
            startPreviewWatcher(node);
        } else if (isVideoNode) {
            stopPreviewWatcher(node);
        }
        setCanvasDirty(node);
    }

    debugHideModeState(node, force ? "sync forced" : "sync");
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

function isDomPreviewWidget(widget) {
    return isPreviewWidget(widget) || isVideoPreviewWidget(widget);
}

function isVideoPreviewWidget(widget) {
    return widget?.name === VIDEO_PREVIEW_WIDGET ||
        widget?.name === NATIVE_VIDEO_PREVIEW_WIDGET ||
        widget?.type === "video";
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

function drawImageHiddenPlaceholder(node, ctx) {
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

function updateImagePreviewHover(node, isHovering) {
    if (node[HOVER_STATE] === isHovering) {
        return;
    }

    node[HOVER_STATE] = isHovering;
    syncImageHideOutputImages(node);
    setCanvasDirty(node);
}

function clearHoverClearTimer(node) {
    if (!node?.[HOVER_CLEAR_TIMER]) {
        return;
    }

    clearTimeout(node[HOVER_CLEAR_TIMER]);
    node[HOVER_CLEAR_TIMER] = null;
}

function updatePreviewHover(node, isHovering, { deferHide = true } = {}) {
    if (isHovering) {
        clearHoverClearTimer(node);
        ensureVideoPreviewMediaType(node);
        if (isVueRenderedNode(node) && !hasVueVideoPreview(node)) {
            scheduleRestoredVueOutputRefresh(node, { force: true });
        }
    } else if (deferHide && node[HOVER_STATE]) {
        if (!node[HOVER_CLEAR_TIMER]) {
            node[HOVER_CLEAR_TIMER] = setTimeout(() => {
                node[HOVER_CLEAR_TIMER] = null;
                updatePreviewHover(node, isPointerOverPreviewRect(node), { deferHide: false });
            }, 150);
        }
        return;
    }

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
        if (!isSaveVideoAdvancedNode(node)) {
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
    setTimeout(() => syncHideOutputImages(node, { force: true }), 1000);
}

function refreshRestoredVueOutput(node, { force = false } = {}) {
    if (!isSaveVideoAdvancedNode(node) || (!force && node[RESTORED_OUTPUT_REFRESHED])) {
        return;
    }

    if (isHideModeEnabled(node) && !node[HOVER_STATE]) {
        return;
    }

    const nodeId = String(node.id);
    const output = getStoredNodeOutput(node);
    if (!output?.images?.length || typeof api.dispatchEvent !== "function" || typeof CustomEvent === "undefined") {
        return;
    }

    applyDomPreviewVisibility(node, false);
    syncPrivatePreviewUrls(node, output);
    ensureVideoPreviewMediaType(node);
    const refreshedOutput = {
        ...output,
        images: output.images.map((image) => ({ ...image })),
        animated: Array.isArray(output.animated) ? [...output.animated] : output.animated,
    };
    node[RESTORED_OUTPUT_REFRESHED] = true;
    api.dispatchEvent(new CustomEvent("executed", {
        detail: {
            node: nodeId,
            display_node: nodeId,
            output: refreshedOutput,
            prompt_id: "helto_hide_mode_restored_preview",
        },
    }));
}

function scheduleRestoredVueOutputRefresh(node, options = {}) {
    if (node[RESTORE_REFRESH_SCHEDULED]) {
        return;
    }

    node[RESTORE_REFRESH_SCHEDULED] = true;
    const run = () => {
        refreshRestoredVueOutput(node, options);
    };

    requestAnimationFrame(run);
    setTimeout(run, 100);
    setTimeout(() => {
        run();
        node[RESTORE_REFRESH_SCHEDULED] = false;
    }, 500);
}

function setupImageHideMode(node) {
    ensureHideModeProperty(node);
    ensureHideModeWidget(node);
    ensurePauseControlWidget(node);
    node[HOVER_STATE] = false;

    const originalOnConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
        const result = originalOnConfigure?.apply(this, args);
        ensureHideModeProperty(this);
        ensureHideModeWidget(this);
        ensurePauseControlWidget(this);
        setHideModeValue(this, this.properties?.[PROPERTY_NAME]);
        syncImageHideOutputImages(this);
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
        syncImageHideOutputImages(this);
        return result;
    };

    const originalOnExecuted = node.onExecuted;
    node.onExecuted = function (output, ...args) {
        const result = originalOnExecuted?.call(this, output, ...args);
        updatePauseControlState(this, pauseControlFromOutput(output) ?? {});
        if (applyPrivateImagePreviews(this, output?.helto_private_images)) {
            syncImageHideOutputImages(this);
        }
        return result;
    };

    const originalOnDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (ctx, ...args) {
        syncImageHideOutputImages(this);
        const result = originalOnDrawForeground?.call(this, ctx, ...args);
        drawImageHiddenPlaceholder(this, ctx);
        return result;
    };

    const originalOnMouseMove = node.onMouseMove;
    node.onMouseMove = function (event, localPos, graphCanvas) {
        updateImagePreviewHover(this, isInPreviewArea(this, event, localPos));
        return originalOnMouseMove?.call(this, event, localPos, graphCanvas);
    };

    const originalOnMouseLeave = node.onMouseLeave;
    node.onMouseLeave = function (...args) {
        updateImagePreviewHover(this, false);
        return originalOnMouseLeave?.apply(this, args);
    };

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
        applyImagePreviewVisibility(this, false);

        if (ORIGINAL_HIDE_STATE in this) {
            this.hideOutputImages = this[ORIGINAL_HIDE_STATE];
        }

        return originalOnRemoved?.apply(this, args);
    };

    syncImageHideOutputImages(node);
    updatePauseControlWidget(node);
}

function setupVideoHideMode(node) {
    ensureHideModeProperty(node);
    ensureHideModeWidget(node);
    if (getNodeClass(node) === VIDEO_NODE_CLASS) {
        ensurePauseControlWidget(node);
    }
    ensureVideoPreviewMediaType(node);
    node[HOVER_STATE] = false;
    managedHideModeNodes.add(node);

    const originalOnConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
        const result = originalOnConfigure?.apply(this, args);
        ensureHideModeProperty(this);
        ensureHideModeWidget(this);
        if (getNodeClass(this) === VIDEO_NODE_CLASS) {
            ensurePauseControlWidget(this);
        }
        ensureVideoPreviewMediaType(this);
        setHideModeValue(this, this.properties?.[PROPERTY_NAME]);
        scheduleRestoredVueOutputRefresh(this);
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
    node.onExecuted = function (output, ...args) {
        storeOutputForPreviewKeys(app, this, output);
        syncPrivatePreviewUrls(this, output);
        if (getNodeClass(this) === VIDEO_NODE_CLASS) {
            updatePauseControlState(this, pauseControlFromOutput(output) ?? {});
        }
        ensureVideoPreviewMediaType(this);
        const result = runWithPreviewPriming(this, () => originalOnExecuted?.call(this, output, ...args));
        scheduleHideModeSync(this);
        return result;
    };

    const originalOnDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (ctx, ...args) {
        const result = originalOnDrawForeground?.call(this, ctx, ...args);
        refreshVideoDomLayerVisibility(this);
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
        clearHoverClearTimer(this);
        applyVideoPreviewVisibility(this, false);
        disconnectPreviewObserver(this);

        if (ORIGINAL_HIDE_STATE in this) {
            this.hideOutputImages = this[ORIGINAL_HIDE_STATE];
        }

        return originalOnRemoved?.apply(this, args);
    };

    syncHideOutputImages(node);
    if (getNodeClass(node) === VIDEO_NODE_CLASS) {
        updatePauseControlWidget(node);
    }
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

        if (isSaveImageAdvancedNode(node)) {
            setupImageHideMode(node);
            return;
        }

        if (isSaveVideoAdvancedNode(node)) {
            setupVideoHideMode(node);
            if (getNodeClass(node) === VIDEO_NODE_CLASS) {
                setupFormatWidgets(node);
            }
        }
    },
    afterConfigureGraph() {
        for (const node of managedHideModeNodes) {
            scheduleRestoredVueOutputRefresh(node);
            debugHideModeState(node, "afterConfigureGraph");
            setTimeout(() => debugHideModeState(node, "afterConfigureGraph +500ms"), 500);
            setTimeout(() => debugHideModeState(node, "afterConfigureGraph +2000ms"), 2000);
        }
    },
});

globalThis.HELTO_HIDE_MODE_DUMP = dumpHideModeDebugState;
