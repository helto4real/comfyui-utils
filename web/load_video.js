import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "HeltoLoadVideo";
const DISPLAY_NAME = "Load Video";
const ROUTE_PREFIX = "/helto_load_video";
const HIDE_PROPERTY = "hide mode";
const HIDE_WIDGET = "__heltoLoadVideoHideModeWidget";
const PREVIEW_WIDGET = "__heltoLoadVideoPreviewWidget";
const HOVER_STATE = "__heltoLoadVideoHoverState";
const PICKER_BUTTON = "__heltoLoadVideoPickerButton";
const PLACEHOLDER_SRC = new URL("./hidden_preview_placeholder.png", import.meta.url).href;
const PREVIEW_HEIGHT = 180;

let stylesInjected = false;

function injectStyles() {
    if (stylesInjected) {
        return;
    }
    stylesInjected = true;
    const style = document.createElement("style");
    style.textContent = `
        .helto-load-video-preview {
            background: #050505;
            box-sizing: border-box;
            display: block;
            height: 180px;
            margin: 0;
            max-width: 100%;
            min-height: 0;
            min-width: 0;
            overflow: hidden;
            position: relative;
            width: 100%;
        }
        .helto-load-video-preview video,
        .helto-load-video-preview img {
            display: block;
            height: 100%;
            max-width: 100%;
            object-fit: contain;
            width: 100%;
        }
        .helto-load-video-preview img {
            object-fit: cover;
        }
        .helto-load-video-preview[hidden] {
            display: none !important;
        }
        .helto-load-video-dialog {
            align-items: center;
            background: rgba(0, 0, 0, 0.55);
            display: flex;
            inset: 0;
            justify-content: center;
            position: fixed;
            z-index: 10001;
        }
        .helto-load-video-panel {
            background: #222;
            border: 1px solid #555;
            border-radius: 6px;
            color: #ddd;
            display: flex;
            flex-direction: column;
            font: 12px Arial, sans-serif;
            max-height: 86vh;
            max-width: 92vw;
            padding: 14px;
            width: 760px;
        }
        .helto-load-video-panel h3 {
            font-size: 15px;
            font-weight: 600;
            margin: 0 0 10px;
        }
        .helto-load-video-controls {
            display: grid;
            gap: 8px;
            grid-template-columns: 150px minmax(0, 1fr) 110px 32px 32px 32px;
            margin-bottom: 8px;
        }
        .helto-load-video-controls.secondary {
            grid-template-columns: 32px 32px 1fr 180px;
        }
        .helto-load-video-controls input,
        .helto-load-video-controls select,
        .helto-load-video-controls button,
        .helto-load-video-actions button {
            background: #2a2a2a;
            border: 1px solid #444;
            border-radius: 4px;
            color: #ddd;
            font: 12px Arial, sans-serif;
            height: 28px;
            min-width: 0;
        }
        .helto-load-video-controls button,
        .helto-load-video-actions button {
            cursor: pointer;
            padding: 0 8px;
        }
        .helto-load-video-controls button:hover,
        .helto-load-video-actions button:hover {
            background: #333;
            border-color: #666;
            color: #fff;
        }
        .helto-load-video-icon-btn {
            align-items: center;
            display: flex;
            justify-content: center;
            padding: 0;
        }
        .helto-load-video-icon-btn svg {
            fill: none;
            height: 17px;
            stroke: currentColor;
            stroke-linecap: round;
            stroke-linejoin: round;
            stroke-width: 2;
            width: 17px;
        }
        .helto-load-video-columns {
            align-items: center;
            display: grid;
            gap: 6px;
            grid-template-columns: 18px 1fr 24px;
        }
        .helto-load-video-columns svg {
            fill: none;
            height: 16px;
            stroke: currentColor;
            stroke-width: 2;
            width: 16px;
        }
        .helto-load-video-meta {
            align-items: center;
            color: #aaa;
            display: flex;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
        }
        .helto-load-video-grid {
            --helto-load-video-columns: 4;
            display: grid;
            gap: 8px;
            grid-template-columns: repeat(var(--helto-load-video-columns), minmax(0, 1fr));
            min-height: 240px;
            overflow: auto;
            padding: 2px;
        }
        .helto-load-video-tile {
            background: #151515;
            border: 1px solid #3a3a3a;
            border-radius: 5px;
            color: #ddd;
            cursor: pointer;
            display: grid;
            gap: 5px;
            grid-template-rows: minmax(90px, 1fr) 34px;
            min-height: 132px;
            overflow: hidden;
            padding: 4px;
            text-align: left;
        }
        .helto-load-video-tile.selected {
            border-color: #7aa7ff;
            box-shadow: 0 0 0 1px #7aa7ff inset;
        }
        .helto-load-video-media {
            background: #050505;
            min-height: 0;
            overflow: hidden;
            position: relative;
        }
        .helto-load-video-tile img,
        .helto-load-video-tile video {
            background: #050505;
            height: 100%;
            object-fit: contain;
            pointer-events: none;
            width: 100%;
        }
        .helto-load-video-tile video {
            inset: 0;
            position: absolute;
        }
        .helto-load-video-tile video[hidden],
        .helto-load-video-tile img[hidden] {
            display: none;
        }
        .helto-load-video-name {
            font-size: 11px;
            line-height: 14px;
            overflow: hidden;
            overflow-wrap: anywhere;
        }
        .helto-load-video-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            margin-top: 10px;
        }
    `;
    document.head.appendChild(style);
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[char]));
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
    return (node?.constructor?.title ?? node?.title) === DISPLAY_NAME ? NODE_CLASS : null;
}

function isLoadVideoNode(node) {
    return getNodeClass(node) === NODE_CLASS;
}

function setCanvasDirty(node) {
    node?.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function routeUrl(path) {
    return api.apiURL(path);
}

async function fetchJson(path, options = {}) {
    const response = await api.fetchApi(path, options);
    const data = await response.json();
    if (!response.ok || data?.error) {
        throw new Error(data?.error || response.statusText);
    }
    return data;
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
}

function ensureHideModeWidget(node) {
    if (node[HIDE_WIDGET]) {
        return;
    }
    const existing = node.widgets?.find((widget) => widget.name === HIDE_PROPERTY);
    const widget = existing ?? node.addWidget?.(
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
    node[HIDE_WIDGET] = widget;
}

function isHideModeEnabled(node) {
    if (node[HIDE_WIDGET]) {
        node.properties[HIDE_PROPERTY] = Boolean(node[HIDE_WIDGET].value);
    }
    return Boolean(node.properties?.[HIDE_PROPERTY]);
}

function getVideoWidget(node) {
    return node.widgets?.find((widget) => widget.name === "video");
}

function getAliasWidget(node) {
    return node.widgets?.find((widget) => widget.name === "video_folder_alias");
}

function videoUrl(alias, filename, mtime = 0) {
    if (!filename) {
        return "";
    }
    const params = new URLSearchParams({ alias: alias || "input", filename, t: String(Math.floor(mtime || 0)) });
    return routeUrl(`${ROUTE_PREFIX}/video?${params.toString()}`);
}

function hideWidget(widget) {
    if (!widget) {
        return;
    }
    widget.hidden = true;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
}

class LoadVideoPreviewWidget {
    constructor(node) {
        injectStyles();
        this.name = "helto_load_video_preview";
        this.type = "custom";
        this.node = node;
        this.domWidget = null;
        this.lastAppliedHeight = null;
        this.lastAppliedWidth = null;
        this.layoutSyncQueued = false;
        this.element = document.createElement("div");
        this.element.className = "helto-load-video-preview";
        this.video = document.createElement("video");
        this.video.controls = true;
        this.video.loop = true;
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.preload = "metadata";
        this.placeholder = document.createElement("img");
        this.placeholder.src = PLACEHOLDER_SRC;
        this.placeholder.hidden = true;
        this.element.append(this.video, this.placeholder);
        this.element.addEventListener("mouseenter", () => this.setHover(true));
        this.element.addEventListener("mouseleave", () => this.setHover(false));
    }

    setHover(value) {
        this.node[HOVER_STATE] = Boolean(value);
        this.applyHideMode();
    }

    setSource(url) {
        if (!url) {
            this.video.pause();
            this.video.removeAttribute("src");
            this.video.load();
            this.element.hidden = true;
            this.applyFixedPreviewSize();
            return;
        }
        this.element.hidden = false;
        if (this.video.src !== url) {
            this.video.pause();
            this.video.src = url;
        }
        this.applyHideMode();
        this.syncPreviewLayout();
    }

    applyHideMode() {
        const hidden = isHideModeEnabled(this.node) && !this.node[HOVER_STATE];
        this.video.hidden = hidden;
        this.placeholder.hidden = !hidden;
        this.syncPreviewLayout();
    }

    syncPreviewLayout() {
        if (this.layoutSyncQueued) {
            return;
        }
        this.layoutSyncQueued = true;
        requestAnimationFrame(() => {
            this.layoutSyncQueued = false;
            if (this.applyFixedPreviewSize()) {
                setCanvasDirty(this.node);
            }
        });
    }

    getAvailablePreviewWidth(width) {
        const nodeWidth = Number.isFinite(width) ? width : this.node.size?.[0];
        const margin = Number.isFinite(this.domWidget?.margin) ? this.domWidget.margin : 0;
        if (!Number.isFinite(nodeWidth) || nodeWidth <= 0) {
            return 360;
        }
        return Math.max(120, nodeWidth - margin * 2);
    }

    getAvailablePreviewHeight() {
        return this.element.hidden ? 0 : PREVIEW_HEIGHT;
    }

    getLegacyPreviewHeight() {
        if (this.element.hidden) {
            return 0;
        }

        const nodeHeight = Array.isArray(this.node.size) ? this.node.size[1] : null;
        const widgetTop = Number.isFinite(this.domWidget?.last_y) ? this.domWidget.last_y : null;
        if (Number.isFinite(nodeHeight) && Number.isFinite(widgetTop)) {
            return Math.max(PREVIEW_HEIGHT, nodeHeight - widgetTop - 12);
        }

        return PREVIEW_HEIGHT;
    }

    applyFixedPreviewSize(width) {
        const allocatedWidth = this.getAvailablePreviewWidth(width);
        const allocatedHeight = this.getLegacyPreviewHeight();
        const nextWidth = Math.max(0, Math.round(allocatedWidth * 100) / 100);
        const nextHeight = Math.max(0, Math.round(allocatedHeight * 100) / 100);

        if (this.lastAppliedWidth === nextWidth && this.lastAppliedHeight === nextHeight) {
            return false;
        }

        this.lastAppliedWidth = nextWidth;
        this.lastAppliedHeight = nextHeight;
        this.element.style.width = `${nextWidth}px`;
        this.element.style.maxWidth = `${nextWidth}px`;
        this.element.style.height = `${nextHeight}px`;
        this.element.style.minHeight = "0px";
        return true;
    }

    computeSize(width) {
        const previewWidth = this.getAvailablePreviewWidth(width);
        const previewHeight = this.element.hidden ? -4 : this.getLegacyPreviewHeight();
        this.syncPreviewLayout();
        return [previewWidth, previewHeight];
    }

    computeLayoutSize(width) {
        if (this.element.hidden) {
            return { minHeight: 0, maxHeight: 0, minWidth: 0 };
        }
        return { minHeight: PREVIEW_HEIGHT, maxHeight: 1_000_000, minWidth: 0 };
    }

    getHeight() {
        return this.element.hidden ? 0 : PREVIEW_HEIGHT;
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
    const preview = new LoadVideoPreviewWidget(node);
    if (typeof node.addDOMWidget === "function") {
        const created = node.addDOMWidget(preview.name, "preview", preview.element, {
            serialize: false,
            hideOnZoom: false,
            getValue() {
                return undefined;
            },
            setValue() {},
        });
        const domWidget = created ?? node.widgets?.[node.widgets.length - 1];
        if (domWidget) {
            preview.domWidget = domWidget;
            domWidget.serialize = false;
            domWidget.value = undefined;
            domWidget.options ??= {};
            domWidget.options.serialize = false;
            domWidget.computeLayoutSize = preview.computeLayoutSize.bind(preview);
            domWidget.computeSize = preview.computeSize.bind(preview);
            domWidget.onDraw = () => preview.syncPreviewLayout();
            domWidget.getHeight = preview.getHeight.bind(preview);
            domWidget.getMinHeight = preview.getMinHeight.bind(preview);
            domWidget.getMaxHeight = preview.getMaxHeight.bind(preview);
            domWidget.serializeValue = preview.serializeValue.bind(preview);
        }
    } else if (typeof node.addWidget === "function") {
        const widget = node.addWidget("custom", preview.name, undefined, () => {});
        widget.draw = () => {};
        widget.computeSize = preview.computeSize.bind(preview);
    }
    node[PREVIEW_WIDGET] = preview;
}

function syncPreviewFromWidgets(node) {
    const video = getVideoWidget(node)?.value || "";
    const alias = getAliasWidget(node)?.value || "input";
    node[PREVIEW_WIDGET]?.setSource(videoUrl(alias, video));
}

async function showFolderDialog(onDone) {
    const alias = prompt("Folder alias");
    if (!alias) {
        return;
    }
    const path = prompt("Folder path");
    if (!path) {
        return;
    }
    await fetchJson(`${ROUTE_PREFIX}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias, path }),
    });
    await onDone(alias);
}

async function removeFolderDialog(onDone) {
    const data = await fetchJson(`${ROUTE_PREFIX}/folders`);
    const removable = (data.folders || []).filter((folder) => folder.alias !== "input");
    if (!removable.length) {
        alert("No custom folders to remove.");
        return;
    }
    const alias = prompt(`Folder alias to remove:\n${removable.map((folder) => folder.alias).join("\n")}`);
    if (!alias) {
        return;
    }
    await fetchJson(`${ROUTE_PREFIX}/folders?alias=${encodeURIComponent(alias)}`, { method: "DELETE" });
    await onDone("input");
}

function formatMeta(video) {
    const dims = video.width && video.height ? `${video.width}x${video.height}` : "?x?";
    const fps = Number(video.fps || 0) > 0 ? `${Number(video.fps).toFixed(2)} fps` : "? fps";
    const duration = Number(video.duration || 0) > 0 ? `${Number(video.duration).toFixed(2)}s` : "?s";
    return `${video.filename} (${dims}, ${fps}, ${duration})`;
}

async function openPicker(node) {
    injectStyles();
    document.querySelector(".helto-load-video-dialog")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "helto-load-video-dialog";
    overlay.innerHTML = `
        <div class="helto-load-video-panel">
            <h3>Select Video</h3>
            <div class="helto-load-video-controls">
                <select class="folder" title="Choose configured video folder"></select>
                <input class="search" type="search" placeholder="Search videos..." title="Search video filenames and relative paths">
                <select class="sort" title="Sort videos">
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                    <option value="name-asc">Name A-Z</option>
                    <option value="name-desc">Name Z-A</option>
                </select>
                <button class="scope helto-load-video-icon-btn" type="button" title="Recursive folder view" aria-label="Recursive folder view"></button>
                <button class="folder-add helto-load-video-icon-btn" type="button" title="Add configured video folder" aria-label="Add configured video folder">+</button>
                <button class="folder-remove helto-load-video-icon-btn" type="button" title="Remove configured video folder" aria-label="Remove configured video folder">-</button>
            </div>
            <div class="helto-load-video-controls secondary">
                <button class="refresh helto-load-video-icon-btn" type="button" title="Refresh video list" aria-label="Refresh video list">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
                </button>
                <button class="sound helto-load-video-icon-btn" type="button" title="Hover previews are muted" aria-label="Hover previews are muted">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>
                </button>
                <span class="helto-load-video-meta"></span>
                <label class="helto-load-video-columns" title="Video columns per row">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                    <input class="columns" type="range" min="2" max="8" step="1" value="4">
                    <span class="columns-value">4</span>
                </label>
            </div>
            <div class="helto-load-video-grid"></div>
            <div class="helto-load-video-actions">
                <button class="cancel" type="button">Cancel</button>
                <button class="ok" type="button">Select Video</button>
            </div>
        </div>`;

    const panel = overlay.querySelector(".helto-load-video-panel");
    const folderSelect = overlay.querySelector(".folder");
    const searchInput = overlay.querySelector(".search");
    const sortSelect = overlay.querySelector(".sort");
    const scopeButton = overlay.querySelector(".scope");
    const folderAddButton = overlay.querySelector(".folder-add");
    const folderRemoveButton = overlay.querySelector(".folder-remove");
    const refreshButton = overlay.querySelector(".refresh");
    const columnsInput = overlay.querySelector(".columns");
    const columnsValue = overlay.querySelector(".columns-value");
    const grid = overlay.querySelector(".helto-load-video-grid");
    const meta = overlay.querySelector(".helto-load-video-meta");

    let recursive = true;
    let availableVideos = [];
    let selectedVideo = null;

    const syncScopeButton = () => {
        scopeButton.title = recursive ? "Show videos recursively from subfolders" : "Show only videos directly in this folder";
        scopeButton.innerHTML = recursive
            ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h9a2 2 0 0 1 2 2v2"/><path d="M6 12v6a2 2 0 0 0 2 2h5"/><path d="M10 15h4l1.5 1.5H21v3.5H10z"/></svg>`
            : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
    };

    const syncColumns = () => {
        const columns = Number(columnsInput.value || 4);
        grid.style.setProperty("--helto-load-video-columns", String(columns));
        columnsValue.textContent = String(columns);
    };

    const compareNames = (a, b) => String(a.filename || "").localeCompare(String(b.filename || ""), undefined, { sensitivity: "base" });
    const sortedVideos = () => availableVideos
        .map((video, index) => ({ video, index }))
        .sort((a, b) => {
            let cmp = 0;
            if (sortSelect.value === "newest") cmp = Number(b.video.mtime || 0) - Number(a.video.mtime || 0);
            else if (sortSelect.value === "oldest") cmp = Number(a.video.mtime || 0) - Number(b.video.mtime || 0);
            else if (sortSelect.value === "name-desc") cmp = compareNames(b.video, a.video);
            else cmp = compareNames(a.video, b.video);
            return cmp || compareNames(a.video, b.video) || a.index - b.index;
        })
        .map((entry) => entry.video);

    const renderGrid = () => {
        grid.innerHTML = "";
        const query = searchInput.value.trim().toLowerCase();
        const videos = sortedVideos();
        const visibleVideos = query
            ? videos.filter((video) => String(video.filename || "").toLowerCase().includes(query))
            : videos;

        if (selectedVideo && !visibleVideos.some((video) => video.filename === selectedVideo.filename)) {
            selectedVideo = null;
        }

        for (const video of visibleVideos) {
            const tile = document.createElement("button");
            tile.type = "button";
            tile.className = `helto-load-video-tile${selectedVideo?.filename === video.filename ? " selected" : ""}`;
            tile.title = `${video.filename}\nHover to preview without sound.`;
            const media = document.createElement("div");
            media.className = "helto-load-video-media";
            const thumb = document.createElement("img");
            thumb.loading = "lazy";
            thumb.decoding = "async";
            thumb.alt = "";
            thumb.src = routeUrl(video.thumb_url);
            const preview = document.createElement("video");
            preview.hidden = true;
            preview.muted = true;
            preview.playsInline = true;
            preview.loop = true;
            preview.preload = "metadata";
            media.append(thumb, preview);
            const name = document.createElement("div");
            name.className = "helto-load-video-name";
            name.textContent = video.filename;
            tile.append(media, name);
            tile.addEventListener("mouseenter", () => {
                preview.muted = true;
                preview.hidden = false;
                thumb.hidden = true;
                preview.src = routeUrl(video.video_url);
                preview.play().catch(() => {});
            });
            tile.addEventListener("mouseleave", () => {
                preview.pause();
                preview.removeAttribute("src");
                preview.load();
                preview.hidden = true;
                thumb.hidden = false;
            });
            tile.addEventListener("click", () => {
                selectedVideo = video;
                for (const other of grid.querySelectorAll(".helto-load-video-tile")) other.classList.remove("selected");
                tile.classList.add("selected");
                meta.textContent = formatMeta(video);
            });
            grid.appendChild(tile);
        }

        if (!availableVideos.length) {
            meta.textContent = "No videos found.";
        } else if (!visibleVideos.length) {
            meta.textContent = `No videos match "${searchInput.value.trim()}".`;
        } else if (query) {
            meta.textContent = `${visibleVideos.length} of ${availableVideos.length} videos match. Select one to load.`;
        } else if (!selectedVideo) {
            meta.textContent = `${availableVideos.length} videos. Select one to load.`;
        }
    };

    const loadFolders = async (preferredAlias = null) => {
        const data = await fetchJson(`${ROUTE_PREFIX}/folders`);
        folderSelect.innerHTML = (data.folders || [])
            .map((folder) => `<option value="${escapeHtml(folder.alias)}">${escapeHtml(folder.alias)}${folder.exists ? "" : " (missing)"}</option>`)
            .join("");
        const currentAlias = preferredAlias || getAliasWidget(node)?.value || node.properties?.helto_load_video_last_folder_alias;
        if (currentAlias && (data.folders || []).some((folder) => folder.alias === currentAlias)) {
            folderSelect.value = currentAlias;
        }
    };

    const loadVideos = async () => {
        node.properties ??= {};
        node.properties.helto_load_video_last_folder_alias = folderSelect.value;
        const params = new URLSearchParams({
            alias: folderSelect.value,
            recursive: recursive ? "1" : "0",
        });
        const data = await fetchJson(`${ROUTE_PREFIX}/videos?${params.toString()}`);
        availableVideos = data.videos || [];
        selectedVideo = null;
        renderGrid();
    };

    folderSelect.addEventListener("change", loadVideos);
    searchInput.addEventListener("input", renderGrid);
    sortSelect.addEventListener("change", renderGrid);
    columnsInput.addEventListener("input", syncColumns);
    scopeButton.addEventListener("click", async () => {
        recursive = !recursive;
        syncScopeButton();
        await loadVideos();
    });
    folderAddButton.addEventListener("click", async () => {
        try {
            await showFolderDialog(async (alias) => {
                await loadFolders(alias);
                await loadVideos();
            });
        } catch (err) {
            alert(err.message);
        }
    });
    folderRemoveButton.addEventListener("click", async () => {
        try {
            await removeFolderDialog(async (alias) => {
                await loadFolders(alias);
                await loadVideos();
            });
        } catch (err) {
            alert(err.message);
        }
    });
    refreshButton.addEventListener("click", loadVideos);
    overlay.querySelector(".cancel").addEventListener("click", () => overlay.remove());
    overlay.querySelector(".ok").addEventListener("click", () => {
        if (!selectedVideo) {
            alert("Select a video first.");
            return;
        }
        const videoWidget = getVideoWidget(node);
        const aliasWidget = getAliasWidget(node);
        if (videoWidget) {
            videoWidget.value = selectedVideo.filename;
            videoWidget.callback?.(selectedVideo.filename);
        }
        if (aliasWidget) {
            aliasWidget.value = folderSelect.value;
            aliasWidget.callback?.(folderSelect.value);
        }
        node[PREVIEW_WIDGET]?.setSource(videoUrl(folderSelect.value, selectedVideo.filename, selectedVideo.mtime));
        setCanvasDirty(node);
        overlay.remove();
    });
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    syncScopeButton();
    syncColumns();
    await loadFolders();
    await loadVideos();
    searchInput.focus();
    panel.scrollTop = 0;
}

function ensurePickerButton(node) {
    if (node[PICKER_BUTTON]) {
        return;
    }
    const button = node.addWidget?.("button", "choose video", null, () => {
        openPicker(node).catch((err) => alert(err.message));
    });
    if (button) {
        button.serialize = false;
        button.options ??= {};
        button.options.serialize = false;
        node[PICKER_BUTTON] = button;
    }
}

app.registerExtension({
    name: "Helto.LoadVideo",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        const onConfigure = nodeType.prototype.onConfigure;
        const onResize = nodeType.prototype.onResize;

        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            if (!isLoadVideoNode(this)) {
                return result;
            }

            ensureProperties(this);
            ensureHideModeWidget(this);
            ensurePickerButton(this);
            ensurePreviewWidget(this);
            hideWidget(getAliasWidget(this));

            const videoWidget = getVideoWidget(this);
            if (videoWidget) {
                const originalCallback = videoWidget.callback;
                videoWidget.callback = (...args) => {
                    originalCallback?.apply(videoWidget, args);
                    syncPreviewFromWidgets(this);
                    setCanvasDirty(this);
                };
            }

            const aliasWidget = getAliasWidget(this);
            if (aliasWidget) {
                const originalCallback = aliasWidget.callback;
                aliasWidget.callback = (...args) => {
                    originalCallback?.apply(aliasWidget, args);
                    syncPreviewFromWidgets(this);
                    setCanvasDirty(this);
                };
            }

            syncPreviewFromWidgets(this);
            return result;
        };

        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            if (isLoadVideoNode(this)) {
                ensureProperties(this);
                ensureHideModeWidget(this);
                ensurePickerButton(this);
                ensurePreviewWidget(this);
                hideWidget(getAliasWidget(this));
                syncPreviewFromWidgets(this);
                this[PREVIEW_WIDGET]?.syncPreviewLayout();
            }
            return result;
        };

        nodeType.prototype.onResize = function () {
            const result = onResize?.apply(this, arguments);
            if (isLoadVideoNode(this)) {
                this[PREVIEW_WIDGET]?.syncPreviewLayout();
            }
            return result;
        };
    },
});
