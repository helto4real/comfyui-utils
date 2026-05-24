import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "HeltoVideoComparer";
const DISPLAY_NAME = "Video Comparer";
const HIDE_PROPERTY = "hide mode";
const AUDIO_PROPERTY = "audio source";
const HIDE_MODE_WIDGET = "__heltoVideoComparerHideModeWidget";
const PREVIEW_WIDGET = "__heltoVideoComparerPreviewWidget";
const HOVER_STATE = "__heltoVideoComparerHoverState";
const PLACEHOLDER_SRC = new URL("./hidden_preview_placeholder.png", import.meta.url).href;
const AUDIO_SOURCES = ["video 1", "video 2", "muted"];

let stylesInjected = false;

function injectStyles() {
    if (stylesInjected) {
        return;
    }

    stylesInjected = true;
    const style = document.createElement("style");
    style.textContent = `
        .helto-video-comparer {
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            gap: 6px;
            height: 100%;
            padding: 4px;
            width: 100%;
        }
        .helto-video-comparer[hidden] {
            display: none !important;
            height: 0 !important;
            min-height: 0 !important;
            overflow: hidden !important;
            padding: 0 !important;
        }
        .helto-video-comparer__stage {
            background: rgba(0, 0, 0, 0.28);
            border-radius: 4px;
            display: grid;
            flex: 1 1 auto;
            gap: 6px;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            min-height: 112px;
            overflow: hidden;
            position: relative;
        }
        .helto-video-comparer__pane {
            align-items: center;
            background: #050505;
            display: flex;
            min-width: 0;
            overflow: hidden;
            position: relative;
        }
        .helto-video-comparer__pane video {
            height: 100%;
            object-fit: contain;
            width: 100%;
        }
        .helto-video-comparer__placeholder {
            background: #111;
            inset: 4px;
            position: absolute;
            z-index: 2;
        }
        .helto-video-comparer__placeholder img {
            height: 100%;
            object-fit: cover;
            width: 100%;
        }
        .helto-video-comparer__controls {
            align-items: center;
            display: grid;
            flex: 0 0 28px;
            gap: 6px;
            grid-template-columns: 28px 28px minmax(0, 1fr) 82px 88px;
        }
        .helto-video-comparer__button,
        .helto-video-comparer__select {
            background: rgba(20, 20, 20, 0.82);
            border: 1px solid rgba(255, 255, 255, 0.16);
            border-radius: 4px;
            color: #ddd;
            font: 11px sans-serif;
            height: 24px;
        }
        .helto-video-comparer__button {
            cursor: pointer;
            padding: 0;
        }
        .helto-video-comparer__select {
            min-width: 0;
            padding: 0 3px;
        }
        .helto-video-comparer__timeline {
            min-width: 0;
            width: 100%;
        }
        .helto-video-comparer__time {
            color: #ccc;
            font: 10px monospace;
            overflow: hidden;
            text-align: right;
            white-space: nowrap;
        }
    `;
    document.head.appendChild(style);
}

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

function isVideoComparerNode(node) {
    return getNodeClass(node) === NODE_CLASS;
}

function setCanvasDirty(node) {
    node?.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function ensureProperties(node) {
    node.properties ??= {};

    if (node.properties[HIDE_PROPERTY] === undefined) {
        if (typeof node.addProperty === "function") {
            node.addProperty(HIDE_PROPERTY, false, "boolean");
        } else {
            node.properties[HIDE_PROPERTY] = false;
        }
    }

    if (!AUDIO_SOURCES.includes(node.properties[AUDIO_PROPERTY])) {
        node.properties[AUDIO_PROPERTY] = AUDIO_SOURCES[0];
    }
}

function ensureHideModeWidget(node) {
    if (node[HIDE_MODE_WIDGET]) {
        return;
    }

    const existingWidget = node.widgets?.find((widget) => widget.name === HIDE_PROPERTY);
    const widget = existingWidget ?? node.addWidget?.(
        "toggle",
        HIDE_PROPERTY,
        Boolean(node.properties?.[HIDE_PROPERTY]),
        (value) => {
            node.properties[HIDE_PROPERTY] = Boolean(value);
            node[PREVIEW_WIDGET]?.applyHideMode();
            setCanvasDirty(node);
        },
        { on: "true", off: "false" },
    );

    if (!widget) {
        return;
    }

    widget.value = Boolean(node.properties?.[HIDE_PROPERTY]);
    widget.callback = (value) => {
        node.properties[HIDE_PROPERTY] = Boolean(value);
        node[PREVIEW_WIDGET]?.applyHideMode();
        setCanvasDirty(node);
    };
    widget.serialize = false;
    widget.options ??= {};
    widget.options.serialize = false;
    node[HIDE_MODE_WIDGET] = widget;
}

function syncHideModeProperty(node) {
    if (node[HIDE_MODE_WIDGET]) {
        node.properties[HIDE_PROPERTY] = Boolean(node[HIDE_MODE_WIDGET].value);
    } else {
        node.properties[HIDE_PROPERTY] = Boolean(node.properties?.[HIDE_PROPERTY]);
    }
}

function isHideModeEnabled(node) {
    syncHideModeProperty(node);
    return Boolean(node.properties?.[HIDE_PROPERTY]);
}

function recordToUrl(record) {
    if (!record?.filename || !record?.type) {
        return null;
    }

    const params = new URLSearchParams({
        filename: record.filename,
        type: record.type,
        subfolder: record.subfolder ?? "",
    });

    return api.apiURL(`/view?${params.toString()}${app.getRandParam?.() ?? ""}`);
}

function formatTime(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return "0:00";
    }

    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

class VideoComparerPreviewWidget {
    constructor(node) {
        injectStyles();
        this.name = "helto_video_comparer_preview";
        this.type = "custom";
        this.node = node;
        this.hasSources = false;
        this.syncing = false;
        this.domWidget = null;

        this.element = document.createElement("div");
        this.element.className = "helto-video-comparer";
        this.element.addEventListener("mouseenter", () => this.setHover(true));
        this.element.addEventListener("mouseleave", () => this.setHover(false));

        this.stage = document.createElement("div");
        this.stage.className = "helto-video-comparer__stage";
        this.stage.addEventListener("click", () => this.togglePlay());

        this.video1 = this.createVideo();
        this.video2 = this.createVideo();
        this.stage.append(this.createPane(this.video1), this.createPane(this.video2));

        this.placeholder = document.createElement("div");
        this.placeholder.className = "helto-video-comparer__placeholder";
        this.placeholder.hidden = true;
        const placeholderImage = document.createElement("img");
        placeholderImage.src = PLACEHOLDER_SRC;
        this.placeholder.append(placeholderImage);
        this.stage.append(this.placeholder);

        this.controls = document.createElement("div");
        this.controls.className = "helto-video-comparer__controls";

        this.playButton = this.createButton("Play", () => this.togglePlay());
        this.resetButton = this.createButton("Reset", () => this.seekBoth(0));
        this.timeline = document.createElement("input");
        this.timeline.className = "helto-video-comparer__timeline";
        this.timeline.type = "range";
        this.timeline.min = "0";
        this.timeline.max = "1";
        this.timeline.step = "0.001";
        this.timeline.value = "0";
        this.timeline.addEventListener("input", () => this.seekBoth(Number(this.timeline.value)));

        this.timeLabel = document.createElement("span");
        this.timeLabel.className = "helto-video-comparer__time";
        this.timeLabel.textContent = "0:00 / 0:00";

        this.audioSelect = document.createElement("select");
        this.audioSelect.className = "helto-video-comparer__select";
        for (const source of AUDIO_SOURCES) {
            const option = document.createElement("option");
            option.value = source;
            option.textContent = source;
            this.audioSelect.append(option);
        }
        this.audioSelect.value = node.properties?.[AUDIO_PROPERTY] ?? AUDIO_SOURCES[0];
        this.audioSelect.addEventListener("change", () => {
            this.node.properties[AUDIO_PROPERTY] = this.audioSelect.value;
            this.updateAudioSource();
        });

        this.controls.append(this.playButton, this.resetButton, this.timeline, this.timeLabel, this.audioSelect);
        this.element.append(this.stage, this.controls);
        this.bindVideoEvents();
        this.setVisible(false);
        this.applyHideMode();
    }

    createPane(video) {
        const pane = document.createElement("div");
        pane.className = "helto-video-comparer__pane";
        pane.append(video);
        return pane;
    }

    createButton(label, callback) {
        const button = document.createElement("button");
        button.className = "helto-video-comparer__button";
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            callback();
        });
        return button;
    }

    createVideo() {
        const video = document.createElement("video");
        video.controls = false;
        video.loop = true;
        video.playsInline = true;
        video.preload = "metadata";
        video.muted = true;
        return video;
    }

    bindVideoEvents() {
        for (const video of this.videos()) {
            video.addEventListener("loadedmetadata", () => {
                this.updateTimeline();
                this.resizeNode();
            });
            video.addEventListener("timeupdate", () => this.updateTimeline());
            video.addEventListener("play", () => {
                if (!this.syncing) {
                    this.playBoth(video);
                }
            });
            video.addEventListener("pause", () => {
                if (!this.syncing && !this.node[HOVER_STATE]) {
                    this.pauseBoth();
                }
            });
            video.addEventListener("seeking", () => {
                if (!this.syncing) {
                    this.seekBoth(video.currentTime);
                }
            });
        }
    }

    videos() {
        return [this.video1, this.video2];
    }

    setVideos(records, frameRate) {
        const urls = (records ?? []).map(recordToUrl);
        this.hasSources = urls.every(Boolean);
        this.frameRate = frameRate;
        this.setVisible(this.hasSources);

        for (const [index, video] of this.videos().entries()) {
            video.pause();
            video.removeAttribute("src");
            video.load();

            if (urls[index]) {
                video.src = urls[index];
            }
        }

        this.updateAudioSource();
        this.updateTimeline();
        this.applyHideMode();
        this.resizeNode();
    }

    setHover(value) {
        if (this.node[HOVER_STATE] === value) {
            return;
        }

        this.node[HOVER_STATE] = value;
        this.applyHideMode();
    }

    shouldHide() {
        return this.hasSources && isHideModeEnabled(this.node) && !this.node[HOVER_STATE];
    }

    applyHideMode() {
        const shouldHide = this.shouldHide();
        this.setVisible(this.hasSources);
        this.placeholder.hidden = !shouldHide;
        this.stage.querySelectorAll(".helto-video-comparer__pane").forEach((pane) => {
            pane.style.visibility = shouldHide ? "hidden" : "";
            pane.style.pointerEvents = shouldHide ? "none" : "";
        });
        this.controls.style.visibility = shouldHide ? "hidden" : "";
        this.controls.style.pointerEvents = shouldHide ? "none" : "";

        if (shouldHide) {
            this.pauseVideosOnly();
        } else if (this.hasSources && !this.isPaused()) {
            this.playBoth();
        }

        setCanvasDirty(this.node);
    }

    setVisible(isVisible) {
        this.element.hidden = !isVisible;
        this.element.style.display = isVisible ? "" : "none";
        this.element.style.height = isVisible ? "100%" : "0px";
        this.element.style.minHeight = isVisible ? "" : "0px";

        if (this.domWidget?.parentEl instanceof HTMLElement) {
            this.domWidget.parentEl.hidden = !isVisible;
            this.domWidget.parentEl.style.display = isVisible ? "" : "none";
            this.domWidget.parentEl.style.height = isVisible ? "" : "0px";
            this.domWidget.parentEl.style.minHeight = isVisible ? "" : "0px";
        }
    }

    isPaused() {
        return this.playButton.textContent === "Play";
    }

    playBoth(source = this.video1) {
        if (!this.hasSources || this.shouldHide()) {
            return;
        }

        this.syncing = true;
        const time = Number.isFinite(source?.currentTime) ? source.currentTime : 0;
        for (const video of this.videos()) {
            this.setVideoTime(video, time);
            video.play().catch(() => {});
        }
        this.syncing = false;
        this.playButton.textContent = "Pause";
    }

    pauseVideosOnly() {
        this.syncing = true;
        for (const video of this.videos()) {
            video.pause();
        }
        this.syncing = false;
    }

    pauseBoth() {
        this.pauseVideosOnly();
        this.playButton.textContent = "Play";
    }

    togglePlay() {
        if (!this.hasSources || this.shouldHide()) {
            return;
        }

        if (this.isPaused()) {
            this.playBoth();
        } else {
            this.pauseBoth();
        }
    }

    seekBoth(time) {
        this.syncing = true;
        for (const video of this.videos()) {
            this.setVideoTime(video, time);
        }
        this.syncing = false;
        this.updateTimeline();
    }

    setVideoTime(video, time) {
        if (!Number.isFinite(video.duration) || video.duration <= 0) {
            return;
        }

        const target = Math.min(Math.max(time % video.duration, 0), video.duration);
        if (Math.abs(video.currentTime - target) > 0.05) {
            video.currentTime = target;
        }
    }

    updateAudioSource() {
        const source = this.audioSelect.value;
        this.node.properties[AUDIO_PROPERTY] = AUDIO_SOURCES.includes(source) ? source : AUDIO_SOURCES[0];
        this.audioSelect.value = this.node.properties[AUDIO_PROPERTY];
        this.video1.muted = this.node.properties[AUDIO_PROPERTY] !== "video 1";
        this.video2.muted = this.node.properties[AUDIO_PROPERTY] !== "video 2";
    }

    updateTimeline() {
        const duration = Math.max(
            ...this.videos().map((video) => Number.isFinite(video.duration) ? video.duration : 0),
            0,
        );
        const current = this.video1.currentTime || this.video2.currentTime || 0;

        this.timeline.max = String(Math.max(duration, 1));
        if (document.activeElement !== this.timeline) {
            this.timeline.value = String(Math.min(current, duration || 0));
        }
        this.timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    }

    resizeNode() {
        requestAnimationFrame(() => {
            const computedSize = this.node.computeSize?.();
            if (computedSize && Array.isArray(this.node.size)) {
                computedSize[0] = Math.max(computedSize[0], this.node.size[0]);
            }
            this.node.setSize?.(computedSize ?? this.node.size);
            setCanvasDirty(this.node);
        });
    }

    computeSize(width) {
        const nodeWidth = this.node.size?.[0] ?? width ?? 360;

        if (!this.hasSources) {
            return [nodeWidth, -4];
        }

        const stageHeight = Math.max(112, Math.round(((nodeWidth - 22) / 2) * 9 / 16));
        return [nodeWidth, stageHeight + 46];
    }

    getHeight() {
        return this.computeSize(this.node.size?.[0])[1];
    }

    getMinHeight() {
        return this.getHeight();
    }

    getMaxHeight() {
        return this.getHeight();
    }

    serializeValue() {
        return undefined;
    }
}

function ensurePreviewWidget(node) {
    if (node[PREVIEW_WIDGET]) {
        return;
    }

    const widget = new VideoComparerPreviewWidget(node);
    if (typeof node.addDOMWidget === "function") {
        const createdWidget = node.addDOMWidget(widget.name, "preview", widget.element, {
            serialize: false,
            hideOnZoom: false,
            getValue() {
                return undefined;
            },
            setValue() {},
        });
        const domWidget = createdWidget ?? node.widgets?.[node.widgets.length - 1];
        if (domWidget) {
            widget.domWidget = domWidget;
            domWidget.serialize = false;
            domWidget.value = undefined;
            domWidget.options ??= {};
            domWidget.options.serialize = false;
            domWidget.computeSize = widget.computeSize.bind(widget);
            domWidget.getHeight = widget.getHeight.bind(widget);
            domWidget.getMinHeight = widget.getMinHeight.bind(widget);
            domWidget.getMaxHeight = widget.getMaxHeight.bind(widget);
            domWidget.serializeValue = widget.serializeValue.bind(widget);
            widget.setVisible(false);
        }
        node[PREVIEW_WIDGET] = widget;
        return;
    }

    if (typeof node.addCustomWidget === "function") {
        node.addCustomWidget(widget);
    } else {
        node.widgets ??= [];
        node.widgets.push(widget);
    }
    node[PREVIEW_WIDGET] = widget;
}

function setupVideoComparer(node) {
    ensureProperties(node);
    ensureHideModeWidget(node);
    ensurePreviewWidget(node);
    node[HOVER_STATE] = false;

    const originalOnConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
        const result = originalOnConfigure?.apply(this, args);
        ensureProperties(this);
        ensureHideModeWidget(this);
        ensurePreviewWidget(this);

        if (this[HIDE_MODE_WIDGET]) {
            this[HIDE_MODE_WIDGET].value = Boolean(this.properties?.[HIDE_PROPERTY]);
        }
        if (this[PREVIEW_WIDGET]?.audioSelect) {
            this[PREVIEW_WIDGET].audioSelect.value = this.properties?.[AUDIO_PROPERTY] ?? AUDIO_SOURCES[0];
            this[PREVIEW_WIDGET].updateAudioSource();
        }
        this[PREVIEW_WIDGET]?.applyHideMode();
        return result;
    };

    const originalOnSerialize = node.onSerialize;
    node.onSerialize = function (info) {
        const result = originalOnSerialize?.apply(this, arguments);
        syncHideModeProperty(this);

        if (this[PREVIEW_WIDGET]?.audioSelect) {
            this.properties[AUDIO_PROPERTY] = this[PREVIEW_WIDGET].audioSelect.value;
        }

        if (info) {
            info.properties ??= {};
            info.properties[HIDE_PROPERTY] = this.properties[HIDE_PROPERTY];
            info.properties[AUDIO_PROPERTY] = this.properties[AUDIO_PROPERTY];
        }

        return result;
    };

    const originalOnExecuted = node.onExecuted;
    node.onExecuted = function (output, ...args) {
        const result = originalOnExecuted?.call(this, output, ...args);
        const comparison = Array.isArray(output?.video_comparison)
            ? output.video_comparison[0]
            : output?.video_comparison;
        if (comparison) {
            this[PREVIEW_WIDGET]?.setVideos(comparison.videos, comparison.frame_rate);
        }
        return result;
    };

    const originalOnMouseEnter = node.onMouseEnter;
    node.onMouseEnter = function (...args) {
        this[HOVER_STATE] = true;
        this[PREVIEW_WIDGET]?.applyHideMode();
        return originalOnMouseEnter?.apply(this, args);
    };

    const originalOnMouseLeave = node.onMouseLeave;
    node.onMouseLeave = function (...args) {
        this[HOVER_STATE] = false;
        this[PREVIEW_WIDGET]?.applyHideMode();
        return originalOnMouseLeave?.apply(this, args);
    };

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
        this[PREVIEW_WIDGET]?.pauseBoth();
        return originalOnRemoved?.apply(this, args);
    };
}

app.registerExtension({
    name: "Helto.VideoComparer.Preview",
    nodeCreated(node) {
        if (!isVideoComparerNode(node)) {
            return;
        }

        setupVideoComparer(node);
    },
});
