import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "HeltoLoadVideo";
const DISPLAY_NAME = "Load Video";
const ROUTE_PREFIX = "/helto_load_video";
const PICKER_BUTTON = "__heltoLoadVideoPickerButton";
const PREVIEW_REQUEST = "__heltoLoadVideoPreviewRequest";
const EXECUTED_WRAPPED = "__heltoLoadVideoExecutedWrapped";

let stylesInjected = false;

function injectStyles() {
    if (stylesInjected) {
        return;
    }
    stylesInjected = true;
    const style = document.createElement("style");
    style.textContent = `
        .helto-load-video-dialog {
            align-items: center;
            background: rgba(6, 9, 15, 0.62);
            backdrop-filter: blur(3px);
            display: flex;
            inset: 0;
            justify-content: center;
            position: fixed;
            z-index: 10001;
        }
        .helto-load-video-panel {
            background: #151c2a;
            border: 1px solid #3a465c;
            border-radius: 10px;
            color: #e7ebf3;
            display: flex;
            flex-direction: column;
            font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            -webkit-font-smoothing: antialiased;
            box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55);
            max-height: 86vh;
            max-width: 92vw;
            padding: 14px;
            width: 760px;
        }
        .helto-load-video-panel h3 {
            font-size: 15px;
            font-weight: 700;
            letter-spacing: 0.02em;
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
        .helto-load-video-controls select {
            background: #0d1320;
            border: 1px solid #3a465c;
            border-radius: 5px;
            color: #e7ebf3;
            font: inherit;
            height: 28px;
            min-width: 0;
            padding: 0 8px;
            box-sizing: border-box;
        }
        .helto-load-video-controls input:focus,
        .helto-load-video-controls select:focus {
            outline: none;
            border-color: #5e9bff;
            box-shadow: 0 0 0 2px rgba(94, 155, 255, 0.5);
        }
        .helto-load-video-controls button,
        .helto-load-video-actions button {
            background: linear-gradient(180deg, #232d3f, #1b2333);
            border: 1px solid #3a465c;
            border-radius: 5px;
            color: #e7ebf3;
            font: inherit;
            height: 28px;
            min-width: 0;
            cursor: pointer;
            padding: 0 8px;
            transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
        }
        .helto-load-video-controls button:hover,
        .helto-load-video-actions button:hover {
            background: linear-gradient(180deg, #2c3850, #232d3f);
            border-color: #4c5970;
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
            color: #9aa6bd;
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
            background: #0a0e16;
            border: 1px solid #2a3346;
            border-radius: 6px;
            color: #e7ebf3;
            cursor: pointer;
            display: grid;
            gap: 5px;
            grid-template-rows: minmax(90px, 1fr) 34px;
            min-height: 132px;
            overflow: hidden;
            padding: 4px;
            text-align: left;
            transition: border-color 0.12s ease, box-shadow 0.12s ease;
        }
        .helto-load-video-tile:hover {
            border-color: #3a465c;
        }
        .helto-load-video-tile.selected {
            border-color: #f1c75c;
            box-shadow: 0 0 0 1px #f1c75c inset, 0 0 10px rgba(241, 199, 92, 0.35);
        }
        .helto-load-video-media {
            background: #070a11;
            min-height: 0;
            overflow: hidden;
            position: relative;
        }
        .helto-load-video-tile img,
        .helto-load-video-tile video {
            background: #070a11;
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

function ensureVideoPreviewMediaType(node) {
    node.previewMediaType = "video";
}

function routeUrl(path) {
    return api.apiURL(path);
}

function privateRecordToUrl(record) {
    if (!record?.private || !record?.token) {
        return null;
    }
    const params = new URLSearchParams({ token: record.token });
    return api.apiURL(`/helto_utils/private_media?${params.toString()}${app.getRandParam?.() ?? ""}`);
}

async function fetchJson(path, options = {}) {
    const response = await api.fetchApi(path, options);
    const data = await response.json();
    if (!response.ok || data?.error) {
        throw new Error(data?.error || response.statusText);
    }
    return data;
}

function getVideoWidget(node) {
    return node.widgets?.find((widget) => widget.name === "video");
}

function getAliasWidget(node) {
    return node.widgets?.find((widget) => widget.name === "video_folder_alias");
}

function getPrivacyWidget(node) {
    return node.widgets?.find((widget) => widget.name === "privacy_mode");
}

function isPrivacyModeEnabled(node) {
    return Boolean(getPrivacyWidget(node)?.value ?? node.properties?.privacy_mode ?? true);
}

function hideWidget(widget) {
    if (!widget) {
        return;
    }
    widget.hidden = true;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
}

function previewPayloadPath(alias, filename, privacyMode = true) {
    if (!filename) {
        return "";
    }
    const params = new URLSearchParams({ alias: alias || "input", filename, privacy: privacyMode ? "1" : "0" });
    return `${ROUTE_PREFIX}/preview?${params.toString()}`;
}

function privatePreviewUrls(output) {
    if (!Array.isArray(output?.images)) {
        return [];
    }
    return output.images.map(privateRecordToUrl).filter(Boolean);
}

function previewKeysForNode(node) {
    const keys = [String(node.id)];
    const graphId = node.graph?.id;
    if (graphId && !node.graph?.isRootGraph) {
        keys.push(`${graphId}:${node.id}`);
    }
    return keys;
}

function syncPrivatePreviewUrls(node, output) {
    const urls = privatePreviewUrls(output);
    app.nodePreviewImages ??= {};

    if (urls.length) {
        for (const key of previewKeysForNode(node)) {
            app.nodePreviewImages[key] = urls;
        }
        ensureVideoPreviewMediaType(node);
    } else {
        for (const key of previewKeysForNode(node)) {
            delete app.nodePreviewImages[key];
        }
    }
}

function applyNativePreview(node, payload) {
    const output = {
        images: payload?.images || [],
        animated: payload?.animated || [true],
    };
    const nodeId = String(node.id);
    syncPrivatePreviewUrls(node, output);

    app.nodeOutputs ??= {};
    app.nodeOutputs[nodeId] = output;

    if (typeof api.dispatchEvent === "function" && typeof CustomEvent !== "undefined") {
        api.dispatchEvent(new CustomEvent("executed", {
            detail: {
                node: nodeId,
                display_node: nodeId,
                output,
                prompt_id: "helto_load_video_preview",
            },
        }));
    } else if (typeof node.onExecuted === "function") {
        node.onExecuted(output);
    } else {
        node.images = output.images;
        node.animatedImages = output.animated?.find(Boolean);
    }
    setCanvasDirty(node);
}

async function refreshNativePreview(node) {
    const video = getVideoWidget(node)?.value || "";
    const alias = getAliasWidget(node)?.value || "input";
    const privacyMode = isPrivacyModeEnabled(node);
    if (!video) {
        return;
    }

    const requestId = Symbol("load-video-preview");
    node[PREVIEW_REQUEST] = requestId;
    const payload = await fetchJson(previewPayloadPath(alias, video, privacyMode));
    if (node[PREVIEW_REQUEST] !== requestId) {
        return;
    }
    applyNativePreview(node, payload);
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
            privacy: isPrivacyModeEnabled(node) ? "1" : "0",
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
        refreshNativePreview(node).catch((err) => console.warn("Failed to refresh Load Video preview:", err));
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

function wrapOnExecuted(node) {
    if (node[EXECUTED_WRAPPED]) {
        return;
    }
    node[EXECUTED_WRAPPED] = true;

    const originalOnExecuted = node.onExecuted;
    node.onExecuted = function (output, ...args) {
        syncPrivatePreviewUrls(this, output);
        return originalOnExecuted?.call(this, output, ...args);
    };
}

app.registerExtension({
    name: "Helto.LoadVideo",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        const onConfigure = nodeType.prototype.onConfigure;

        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            if (!isLoadVideoNode(this)) {
                return result;
            }

            ensurePickerButton(this);
            ensureVideoPreviewMediaType(this);
            wrapOnExecuted(this);
            hideWidget(getAliasWidget(this));

            const videoWidget = getVideoWidget(this);
            if (videoWidget) {
                const originalCallback = videoWidget.callback;
                videoWidget.callback = (...args) => {
                    originalCallback?.apply(videoWidget, args);
                    refreshNativePreview(this).catch((err) => console.warn("Failed to refresh Load Video preview:", err));
                    setCanvasDirty(this);
                };
            }

            const aliasWidget = getAliasWidget(this);
            if (aliasWidget) {
                const originalCallback = aliasWidget.callback;
                aliasWidget.callback = (...args) => {
                    originalCallback?.apply(aliasWidget, args);
                    refreshNativePreview(this).catch((err) => console.warn("Failed to refresh Load Video preview:", err));
                    setCanvasDirty(this);
                };
            }

            refreshNativePreview(this).catch((err) => console.warn("Failed to refresh Load Video preview:", err));
            return result;
        };

        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            if (isLoadVideoNode(this)) {
                ensurePickerButton(this);
                ensureVideoPreviewMediaType(this);
                wrapOnExecuted(this);
                hideWidget(getAliasWidget(this));
                refreshNativePreview(this).catch((err) => console.warn("Failed to refresh Load Video preview:", err));
            }
            return result;
        };
    },
});
