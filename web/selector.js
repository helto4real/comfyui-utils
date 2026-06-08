import { app } from "../../scripts/app.js";
import { selectorApi } from "./api.js";
import { ICONS, STOP_EVENTS } from "./constants.js";
import { createSelectorDom, getSelectorElements } from "./dom.js";
import {
    createSelectorLayoutController,
    isLegacyCanvasRenderer,
    normalizeHeltoSelectorSize,
    SELECTOR_LAYOUT,
} from "./layout.js";
import {
    getFolderLabel,
    getFolderPath,
    getRootFolderFilterLabel,
    getRootFolderOptions,
    getSubfolderFilterLabel,
    getSubfolderOptions,
    initializeSelectorProperties,
    isSameOrChildPath,
    normalizeFilterPath,
    normalizeFolderPath,
    SORT_OPTIONS,
    sortImagesInPlace,
} from "./state.js";
import {
    collapseHiddenWidgetLayout,
    containPointerEvents,
    createModal,
} from "./ui.js";
import { openMaskEditor } from "./mask_editor.js";

// Load Stylesheet dynamically using modern ES modules URL resolving
if (!document.getElementById("helto-utils-styles")) {
    const link = document.createElement("link");
    link.id = "helto-utils-styles";
    link.rel = "stylesheet";
    link.href = new URL("./styles.css", import.meta.url).href;
    document.head.appendChild(link);
}

const HELTO_SELECTOR_NODE_CLASS = "HeltoImageSelector";
const GRAPH_TO_PROMPT_PATCHED = "__heltoImageSelectorGraphToPromptPatched";

function getSelectorNodes(graph) {
    const nodes = graph?.computeExecutionOrder?.(false) || graph?._nodes || [];
    return nodes.filter((node) => node?.comfyClass === HELTO_SELECTOR_NODE_CLASS);
}

async function serializeSelectedImagesForPrompt(node) {
    const plainString = JSON.stringify(Array.isArray(node.selectedPaths) ? node.selectedPaths : []);

    if (node.properties?.privacyMode) {
        try {
            const res = await selectorApi.encrypt(plainString);
            return res.encrypted || plainString;
        } catch (e) {
            console.error("Encryption API failed:", e);
        }
    }

    return plainString;
}

async function serializeEditedMasksForPrompt(node) {
    const plainString = JSON.stringify(node.editedMasks && typeof node.editedMasks === "object" ? node.editedMasks : {});

    if (node.properties?.privacyMode) {
        try {
            const res = await selectorApi.encrypt(plainString);
            return res.encrypted || plainString;
        } catch (e) {
            console.error("Encryption API failed:", e);
        }
    }

    return plainString;
}

function installGraphToPromptPatch() {
    if (app[GRAPH_TO_PROMPT_PATCHED] || typeof app.graphToPrompt !== "function") {
        return;
    }

    const originalGraphToPrompt = app.graphToPrompt;
    app.graphToPrompt = async function(...args) {
        const result = await originalGraphToPrompt.apply(this, args);
        const graph = args[0] || app.graph;

        for (const node of getSelectorNodes(graph)) {
            const outputNode = result?.output?.[String(node.id)];
            if (!outputNode) continue;

            outputNode.inputs ??= {};
            outputNode.inputs.selected_images = await serializeSelectedImagesForPrompt(node);
            outputNode.inputs.resize_mode = node.properties?.resizeMode || "zoom to fit";
            outputNode.inputs.edited_masks = await serializeEditedMasksForPrompt(node);
        }

        return result;
    };

    app[GRAPH_TO_PROMPT_PATCHED] = true;
}

installGraphToPromptPatch();

app.registerExtension({
    name: "HeltoImageSelectorExtension",
    
    async nodeCreated(node) {
        installGraphToPromptPatch();
        if (node.comfyClass !== HELTO_SELECTOR_NODE_CLASS) return;
        
        // --- 1. State Initialization ---
        node.selectedPaths = []; // Plain absolute paths
        node.editedMasks = {};   // Plain absolute path -> saved mask ref
        node.allImages = [];     // Scanned images metadata
        node.allFolders = [];    // Scanned folder metadata
        let domWidget = null;
        
        node.properties = node.properties || {};
        initializeSelectorProperties(node.properties);

        const getRootFolderOptionsForNode = () => getRootFolderOptions(node.allFolders, node.properties.folders || []);
        const getSubfolderOptionsForNode = () => getSubfolderOptions(node.allFolders, node.properties.folderFilter || "all");
        const getRootFolderFilterLabelForNode = (path) => getRootFolderFilterLabel(path, node.allFolders, node.properties.folders || []);
        const getSubfolderFilterLabelForNode = (path) => getSubfolderFilterLabel(path, node.allFolders);
        const isLegacyRenderer = () => isLegacyCanvasRenderer({ app, document, window });
        
        // Remove input socket ports so they are completely hidden
        if (node.inputs) {
            node.inputs = node.inputs.filter(input => (
                input.name !== "selected_images" &&
                input.name !== "resize_mode" &&
                input.name !== "edited_masks"
            ));
        }
        
        function ensureHiddenWidget(name, defaultValue) {
            let widget = node.widgets ? node.widgets.find(w => w.name === name) : null;
            if (!widget) {
                widget = node.addCustomWidget({
                    name,
                    type: "hidden",
                    value: defaultValue,
                });
            }
            if (widget.value === undefined || widget.value === null || widget.value === "") {
                widget.value = defaultValue;
            }
            widget.serialize = true;
            widget.options ??= {};
            widget.options.serialize = true;
            widget.serializeValue = () => widget.value || defaultValue;
            return widget;
        }

        const selectedImagesWidget = ensureHiddenWidget("selected_images", "[]");
        const resizeModeWidget = ensureHiddenWidget("resize_mode", "zoom to fit");
        const editedMasksWidget = ensureHiddenWidget("edited_masks", "{}");
        collapseHiddenWidgetLayout(selectedImagesWidget);
        collapseHiddenWidgetLayout(resizeModeWidget);
        collapseHiddenWidgetLayout(editedMasksWidget);
        
        node.normalizeHeltoSelectorSize = function() {
            normalizeHeltoSelectorSize(node);
        };
        node.normalizeHeltoSelectorSize();
        
        // --- 2. Build DOM Layout ---
        const { widgetFrame, container } = createSelectorDom({
            document,
            icons: ICONS,
            cols: node.properties.cols,
            rootFolderLabel: getRootFolderFilterLabelForNode(node.properties.folderFilter),
            subfolderLabel: getSubfolderFilterLabelForNode(node.properties.subfolderFilter),
            sortBy: node.properties.sortBy,
            containPointerEvents,
        });
        
        // Attach DOM Widget
        let layoutController = null;
        domWidget = node.addDOMWidget("helto_selector_ui", "custom_canvas", widgetFrame, {
            margin: 0,
            hideOnZoom: false,
            getMinHeight: () => SELECTOR_LAYOUT.widgetHeight,
            getMaxHeight: () => SELECTOR_LAYOUT.widgetHeight,
            getHeight: () => SELECTOR_LAYOUT.widgetHeight,
            onDraw: () => {
                if (isLegacyRenderer()) layoutController?.syncSelectorWidgetBounds();
            },
        });

        layoutController = createSelectorLayoutController({
            app,
            node,
            domWidget,
            scheduleVisibleThumbnailLoad,
            document,
            window,
        });
        layoutController.initializeDomWidgetLayout();

        function preserveSelectorSizeOnNextResize() {
            layoutController.preserveSelectorSizeOnNextResize();
        }

        function containEvent(e) {
            e.preventDefault();
            e.stopPropagation();
        }

        function stopEvent(e) {
            e.stopPropagation();
        }

        function containFloatingMenu(menu) {
            for (const eventName of STOP_EVENTS) {
                menu.addEventListener(eventName, (e) => e.stopPropagation());
            }
        }

        function removeFloatingMenus() {
            document.querySelectorAll(".helto-dropdown").forEach((menu) => menu.remove());
        }

        function closeMenuOnOutsideClick(menu, anchor) {
            setTimeout(() => {
                window.addEventListener("click", function dismiss(event) {
                    if (!menu.contains(event.target) && event.target !== anchor) {
                        menu.remove();
                        window.removeEventListener("click", dismiss, true);
                    }
                }, true);
            }, 100);
        }

        function fitDropdownToViewport(dropdown, anchor, offsetX = -40) {
            const viewportPadding = 12;
            const minMenuHeight = 120;
            const rect = anchor.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
            const spaceAbove = rect.top - viewportPadding;
            const openAbove = spaceBelow < minMenuHeight && spaceAbove > spaceBelow;
            const maxHeight = Math.max(80, Math.floor(openAbove ? spaceAbove : spaceBelow));
            const menuHeight = Math.min(dropdown.scrollHeight, maxHeight);
            const viewportLeft = window.scrollX + viewportPadding;
            const viewportRight = window.scrollX + window.innerWidth - viewportPadding;

            dropdown.style.maxHeight = `${maxHeight}px`;
            dropdown.style.overflowY = "auto";
            dropdown.style.top = openAbove
                ? `${window.scrollY + rect.top - menuHeight}px`
                : `${window.scrollY + rect.bottom}px`;

            let left = window.scrollX + rect.left + offsetX;
            const maxLeft = viewportRight - dropdown.offsetWidth;
            if (left > maxLeft) left = maxLeft;
            if (left < viewportLeft) left = viewportLeft;
            dropdown.style.left = `${left}px`;
        }
        
        // Cache UI element references
        const {
            gridEl,
            recursiveBtn,
            aspectBtn,
            folderBtn,
            refreshBtn,
            gearBtn,
            searchInput,
            colSlider,
            sliderVal,
            sortLink,
            folderFilterLink,
            subfolderFilterLink,
            footerText,
            selectedPreviewBtn,
            deleteSelectedBtn,
            clearBtn,
        } = getSelectorElements(container);

        function loadThumbnail(thumb) {
            if (!thumb?.dataset?.src) return;
            thumb.src = thumb.dataset.src;
            thumb.classList.remove("lazy-load");
            delete thumb.dataset.src;
        }

        function isElementInGridViewport(element) {
            if (!element || gridEl.classList.contains("hidden-collapsed")) return false;
            const gridRect = gridEl.getBoundingClientRect();
            const elementRect = element.getBoundingClientRect();
            return (
                elementRect.bottom > gridRect.top &&
                elementRect.top < gridRect.bottom &&
                elementRect.right > gridRect.left &&
                elementRect.left < gridRect.right
            );
        }

        function loadVisibleThumbnails() {
            gridEl.querySelectorAll(".helto-thumb.lazy-load").forEach((thumb) => {
                if (isElementInGridViewport(thumb)) {
                    loadThumbnail(thumb);
                }
            });
        }

        let thumbnailLoadFrame = null;
        function scheduleVisibleThumbnailLoad() {
            if (thumbnailLoadFrame !== null) return;
            thumbnailLoadFrame = requestAnimationFrame(() => {
                thumbnailLoadFrame = null;
                loadVisibleThumbnails();
            });
        }

        gridEl.addEventListener("scroll", scheduleVisibleThumbnailLoad, { passive: true });
        
        // --- 3. Hide Mode Pointer Listeners ---
        function applyHideModeListeners() {
            // Remove existing listener to prevent duplicates
            container.removeEventListener("mouseenter", onMouseEnterNode);
            container.removeEventListener("mouseleave", onMouseLeaveNode);
            
            if (node.properties.hideMode) {
                gridEl.classList.add("hidden-mode");
                if (!container.matches(':hover')) {
                    gridEl.classList.add("hidden-collapsed");
                }
                container.addEventListener("mouseenter", onMouseEnterNode);
                container.addEventListener("mouseleave", onMouseLeaveNode);
            } else {
                gridEl.classList.remove("hidden-mode", "hidden-collapsed");
            }
        }
        
        function onMouseEnterNode() {
            gridEl.classList.remove("hidden-collapsed");
            scheduleVisibleThumbnailLoad();
        }
        
        function onMouseLeaveNode() {
            gridEl.classList.add("hidden-collapsed");
        }
        
        node.syncUIWithProperties = function() {
            updateButtonActiveState(recursiveBtn, node.properties.recursive);
            updateButtonActiveState(aspectBtn, node.properties.aspectRatioMode === "original");
            gridEl.style.setProperty("--cols", node.properties.cols);
            if (colSlider) colSlider.value = node.properties.cols;
            if (sliderVal) sliderVal.innerText = node.properties.cols;
            
            applyHideModeListeners();
            
            // Sync folder filter link state
            if (folderFilterLink) {
                const opt = node.properties.folderFilter || "all";
                folderFilterLink.innerText = getRootFolderFilterLabelForNode(opt);
                folderFilterLink.title = opt === "all" ? "All folders" : opt;
            }

            if (subfolderFilterLink) {
                const opt = node.properties.subfolderFilter || "all";
                subfolderFilterLink.innerText = getSubfolderFilterLabelForNode(opt);
                subfolderFilterLink.title = opt === "all" ? "All folders" : opt;
            }
            
            // Sync current resizeMode from properties to the hidden widget
            resizeModeWidget.value = node.properties.resizeMode || "zoom to fit";
        };
        
        node.onConfigure = function(config) {
            node.syncUIWithProperties();
        };
        
        node.syncUIWithProperties();
        
        // --- 4. Selection Sync Helpers ---
        let selectionSerializationPromise = null;
        let maskSerializationPromise = null;

        async function serializeHiddenJsonWidget(widget, plainValue, defaultValue) {
            if (!widget) return defaultValue;
            const plainString = JSON.stringify(plainValue);

            if (node.properties.privacyMode) {
                try {
                    const res = await selectorApi.encrypt(plainString);
                    widget.value = res.encrypted;
                } catch (e) {
                    console.error("Encryption API failed:", e);
                    widget.value = plainString;
                }
            } else {
                widget.value = plainString;
            }
            return widget.value || defaultValue;
        }

        async function updateWidgetValue() {
            preserveSelectorSizeOnNextResize();

            const valWidget = node.widgets ? node.widgets.find(w => w.name === "selected_images") : null;
            selectionSerializationPromise = (async () => {
                return serializeHiddenJsonWidget(valWidget, node.selectedPaths, "[]");
            })();

            return selectionSerializationPromise;
        }

        async function updateMaskWidgetValue() {
            preserveSelectorSizeOnNextResize();

            const maskWidget = node.widgets ? node.widgets.find(w => w.name === "edited_masks") : null;
            maskSerializationPromise = (async () => {
                return serializeHiddenJsonWidget(maskWidget, node.editedMasks || {}, "{}");
            })();

            return maskSerializationPromise;
        }

        selectedImagesWidget.serializeValue = async () => {
            if (selectionSerializationPromise) {
                await selectionSerializationPromise;
            }
            return updateWidgetValue();
        };

        resizeModeWidget.serializeValue = () => {
            resizeModeWidget.value = node.properties.resizeMode || "zoom to fit";
            return resizeModeWidget.value;
        };

        editedMasksWidget.serializeValue = async () => {
            if (maskSerializationPromise) {
                await maskSerializationPromise;
            }
            return updateMaskWidgetValue();
        };

        async function parseSerializedJson(value, fallback) {
            if (!value) return fallback;
            if (value.startsWith("__HELTO_ENC__:")) {
                try {
                    const res = await selectorApi.decrypt(value);
                    return JSON.parse(res.data);
                } catch (e) {
                    console.error("Decryption API failed:", e);
                    return fallback;
                }
            }
            try {
                return JSON.parse(value);
            } catch (e) {
                return fallback;
            }
        }

        node.restoreSelection = async function() {
            const valWidget = node.widgets ? node.widgets.find(w => w.name === "selected_images") : null;
            if (!valWidget || !valWidget.value) return;
            const parsed = await parseSerializedJson(valWidget.value, []);
            node.selectedPaths = Array.isArray(parsed) ? parsed : [];

            updateFooter();
            renderGrid();
        };

        node.restoreEditedMasks = async function() {
            const maskWidget = node.widgets ? node.widgets.find(w => w.name === "edited_masks") : null;
            if (!maskWidget || !maskWidget.value) return;
            const parsed = await parseSerializedJson(maskWidget.value, {});
            node.editedMasks = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};

            renderGrid();
            refreshSelectedPreviewPopover();
        };
        
        // --- 5. Scanning and Rendering Logic ---
        node.scanFolders = async function(options = {}) {
            try {
                const previousImagePaths = options.pruneMissingCache
                    ? node.allImages.map((img) => img.path)
                    : [];

                // If folders array is empty, fetch default input folder
                if (!node.properties.folders || node.properties.folders.length === 0) {
                    const data = await selectorApi.getInputDir();
                    if (data.input_dir) {
                        node.properties.folders = [data.input_dir];
                    }
                }
                
                // Scan images
                const scanData = await selectorApi.scanFolders(node.properties.folders, node.properties.recursive, previousImagePaths);
                node.allImages = scanData.images || [];
                node.allFolders = scanData.folders || [];
                const currentImagePaths = new Set(node.allImages.map((img) => img.path));
                let selectionChanged = false;
                if (options.pruneMissingCache) {
                    const selectedBefore = node.selectedPaths.length;
                    node.selectedPaths = node.selectedPaths.filter((path) => currentImagePaths.has(path));
                    selectionChanged = node.selectedPaths.length !== selectedBefore;
                    const editedBefore = Object.keys(node.editedMasks || {}).length;
                    node.editedMasks = Object.fromEntries(
                        Object.entries(node.editedMasks || {}).filter(([path]) => currentImagePaths.has(path))
                    );
                    if (Object.keys(node.editedMasks).length !== editedBefore) {
                        await updateMaskWidgetValue();
                    }
                }
                const rootPaths = new Set(getRootFolderOptionsForNode().map((folder) => getFolderPath(folder)));
                if ((node.properties.folderFilter || "all") !== "all" && !rootPaths.has(node.properties.folderFilter)) {
                    node.properties.folderFilter = "all";
                    node.properties.subfolderFilter = "all";
                }
                const subfolderPaths = new Set(getSubfolderOptionsForNode().map((folder) => getFolderPath(folder)));
                if ((node.properties.subfolderFilter || "all") !== "all" && !subfolderPaths.has(node.properties.subfolderFilter)) {
                    node.properties.subfolderFilter = "all";
                }
                
                // Sort initially
                sortImages();
                node.syncUIWithProperties();
                renderGrid();
                updateFooter();
                if (selectionChanged) {
                    await updateWidgetValue();
                }
            } catch (e) {
                console.error("Scanning folders failed:", e);
                if (gridEl) {
                    gridEl.innerHTML = `<div class="helto-grid-empty" style="color: #ff6b6b; padding: 20px; font-style: normal; text-align: center; width: 100%;">
                        <strong>Scan Error:</strong><br>
                        ${e.message || e}<br>
                        <span style="font-size: 11px; opacity: 0.7;">Check browser console.</span>
                    </div>`;
                }
            }
        };
        
        function sortImages() {
            sortImagesInPlace(node.allImages, node.properties.sortBy);
        }
        
        function showPreviewPopup(img) {
            const existing = document.querySelector(".helto-preview-overlay");
            if (existing) existing.remove();

            const overlay = document.createElement("div");
            overlay.className = "helto-preview-overlay";
            containPointerEvents(overlay);

            const windowEl = document.createElement("div");
            windowEl.className = "helto-preview-window";

            const closeBtn = document.createElement("div");
            closeBtn.className = "helto-preview-close";
            closeBtn.innerHTML = "&times;";

            const imgEl = document.createElement("img");
            imgEl.className = "helto-preview-img";
            imgEl.src = selectorApi.viewImageUrl(img.path);

            const titleEl = document.createElement("div");
            titleEl.className = "helto-preview-title";
            titleEl.innerText = img.name;

            windowEl.appendChild(closeBtn);
            windowEl.appendChild(imgEl);
            windowEl.appendChild(titleEl);
            overlay.appendChild(windowEl);
            document.body.appendChild(overlay);

            requestAnimationFrame(() => {
                overlay.classList.add("active");
            });

            function dismissPreview() {
                overlay.classList.remove("active");
                setTimeout(() => {
                    if (document.body.contains(overlay)) {
                        overlay.remove();
                    }
                }, 250);
            }

            closeBtn.onclick = (e) => {
                e.stopPropagation();
                dismissPreview();
            };

            overlay.onclick = (e) => {
                e.stopPropagation();
                if (e.target === overlay) {
                    dismissPreview();
                }
            };
        }

        function saveOriginalImage(img) {
            const link = document.createElement("a");
            link.href = selectorApi.viewImageUrl(img.path);
            link.download = img.name || "image";
            document.body.appendChild(link);
            link.click();
            link.remove();
        }

        async function openMaskEditorForImage(img) {
            await openMaskEditor({
                document,
                window,
                img,
                imageUrl: selectorApi.viewImageUrl(img.path),
                maskUrl: selectorApi.maskUrl(img.path),
                privacyMode: node.properties.privacyMode,
                hideMode: node.properties.hideMode,
                hasEditedMask: Boolean(node.editedMasks?.[img.path]),
                containPointerEvents,
                saveMask: (path, maskData, privacyMode) => selectorApi.saveMask(path, maskData, privacyMode),
                onSaved: async (savedImg, ref) => {
                    node.editedMasks ??= {};
                    node.editedMasks[savedImg.path] = ref || { edited: true };
                    await updateMaskWidgetValue();
                    renderGrid();
                    refreshSelectedPreviewPopover();
                },
            });
        }

        function showImageContextMenu(event, img) {
            containEvent(event);
            removeFloatingMenus();

            const menu = document.createElement("div");
            menu.className = "helto-dropdown";
            containFloatingMenu(menu);

            const options = [
                ["Save image", () => saveOriginalImage(img)],
                ["Preview image", () => showPreviewPopup(img)],
                ["Edit mask", () => openMaskEditorForImage(img)],
            ];

            options.forEach(([label, action]) => {
                const item = document.createElement("div");
                item.className = "helto-dropdown-item";
                item.innerText = label;
                item.onclick = async (e) => {
                    containEvent(e);
                    menu.remove();
                    try {
                        await action();
                    } catch (err) {
                        console.error(`Selector image menu action failed: ${label}`, err);
                        alert(err.message || `${label} failed.`);
                    }
                };
                menu.appendChild(item);
            });

            document.body.appendChild(menu);
            const viewportPadding = 12;
            const maxLeft = window.scrollX + window.innerWidth - menu.offsetWidth - viewportPadding;
            const maxTop = window.scrollY + window.innerHeight - menu.offsetHeight - viewportPadding;
            menu.style.left = `${Math.max(window.scrollX + viewportPadding, Math.min(event.pageX, maxLeft))}px`;
            menu.style.top = `${Math.max(window.scrollY + viewportPadding, Math.min(event.pageY, maxTop))}px`;
            closeMenuOnOutsideClick(menu, null);
        }

        let selectedPreviewPopover = null;
        let selectedPreviewOutsideClickHandler = null;
        let selectedPreviewAnchor = null;

        function getSelectedImages() {
            return node.selectedPaths
                .map((path) => node.allImages.find((img) => img.path === path))
                .filter(Boolean);
        }

        function removeSelectedPreviewPopover() {
            if (selectedPreviewPopover) {
                selectedPreviewPopover.remove();
                selectedPreviewPopover = null;
            }
            selectedPreviewAnchor = null;
            if (selectedPreviewOutsideClickHandler) {
                window.removeEventListener("click", selectedPreviewOutsideClickHandler, true);
                selectedPreviewOutsideClickHandler = null;
            }
        }

        function positionSelectedPreviewPopover(anchor) {
            if (!selectedPreviewPopover || !anchor) return;

            const viewportPadding = 12;
            const anchorGap = 8;
            const anchorRect = anchor.getBoundingClientRect();
            const rect = selectedPreviewPopover.getBoundingClientRect();
            let left = anchorRect.right - rect.width;
            let top = anchorRect.top - rect.height - anchorGap;

            left = Math.max(viewportPadding, Math.min(left, window.innerWidth - rect.width - viewportPadding));
            if (top < viewportPadding) {
                top = anchorRect.bottom + anchorGap;
            }
            top = Math.max(viewportPadding, Math.min(top, window.innerHeight - rect.height - viewportPadding));

            selectedPreviewPopover.style.left = `${left + window.scrollX}px`;
            selectedPreviewPopover.style.top = `${top + window.scrollY}px`;
        }

        function updateVisibleGridSelection(path, selected) {
            gridEl.querySelectorAll(".helto-grid-item").forEach((item) => {
                if (item.dataset.path === path) {
                    item.classList.toggle("selected", selected);
                }
            });
        }

        function removeSelectedPath(path) {
            const index = node.selectedPaths.indexOf(path);
            if (index === -1) return;
            preserveSelectorSizeOnNextResize();
            node.selectedPaths.splice(index, 1);
            updateVisibleGridSelection(path, false);
            updateFooter();
            updateWidgetValue();
            renderSelectedPreviewPopoverContents();
        }

        function renderSelectedPreviewPopoverContents() {
            if (!selectedPreviewPopover) return;
            const selectedImages = getSelectedImages();
            if (selectedImages.length === 0) {
                removeSelectedPreviewPopover();
                return;
            }

            selectedPreviewPopover.innerHTML = "";

            const header = document.createElement("div");
            header.className = "helto-selected-preview-header";

            const title = document.createElement("div");
            title.className = "helto-selected-preview-title";
            title.innerText = `${selectedImages.length} Selected`;

            const closeBtn = document.createElement("button");
            closeBtn.className = "helto-selected-preview-close";
            closeBtn.title = "Close";
            closeBtn.innerHTML = ICONS.clear;
            closeBtn.onclick = (e) => {
                containEvent(e);
                removeSelectedPreviewPopover();
            };

            header.appendChild(title);
            header.appendChild(closeBtn);

            const grid = document.createElement("div");
            grid.className = "helto-selected-preview-grid";

            const aspectClass = node.properties.aspectRatioMode === "original" ? "aspect-original" : "aspect-zoom";
            const isPrivacy = node.properties.privacyMode;

            selectedImages.forEach((img) => {
                const item = document.createElement("div");
                item.className = "helto-selected-preview-item";
                if (node.editedMasks?.[img.path]) {
                    item.classList.add("has-mask");
                }

                const thumbWrap = document.createElement("div");
                thumbWrap.className = "helto-selected-preview-thumb-wrap";
                thumbWrap.title = "Ctrl/Cmd-click to preview";
                thumbWrap.onclick = (e) => {
                    if (e.ctrlKey || e.metaKey) {
                        containEvent(e);
                        showPreviewPopup(img);
                    }
                };

                const thumb = document.createElement("img");
                thumb.className = `helto-selected-preview-thumb ${aspectClass}`;
                thumb.src = selectorApi.thumbnailUrl(img.path, isPrivacy);
                thumb.alt = img.name;
                thumbWrap.appendChild(thumb);

                const removeBtn = document.createElement("button");
                removeBtn.className = "helto-selected-preview-remove";
                removeBtn.title = "Remove from selection";
                removeBtn.innerHTML = ICONS.clear;
                removeBtn.onclick = (e) => {
                    containEvent(e);
                    removeSelectedPath(img.path);
                };
                thumbWrap.appendChild(removeBtn);

                const label = document.createElement("div");
                label.className = "helto-selected-preview-label";
                label.innerText = img.name;
                label.title = img.path;

                item.appendChild(thumbWrap);
                item.appendChild(label);
                grid.appendChild(item);
            });

            selectedPreviewPopover.appendChild(header);
            selectedPreviewPopover.appendChild(grid);
        }

        function showSelectedPreviewPopover(anchor) {
            if (getSelectedImages().length === 0) {
                removeSelectedPreviewPopover();
                return;
            }

            removeSelectedPreviewPopover();
            selectedPreviewAnchor = anchor;

            const popover = document.createElement("div");
            popover.className = "helto-selected-preview-popover";
            containPointerEvents(popover);
            document.body.appendChild(popover);
            selectedPreviewPopover = popover;
            renderSelectedPreviewPopoverContents();

            requestAnimationFrame(() => positionSelectedPreviewPopover(anchor));
            setTimeout(() => {
                selectedPreviewOutsideClickHandler = (event) => {
                    const largePreview = document.querySelector(".helto-preview-overlay");
                    if (
                        !popover.contains(event.target) &&
                        !selectedPreviewBtn.contains(event.target) &&
                        !largePreview?.contains(event.target)
                    ) {
                        removeSelectedPreviewPopover();
                    }
                };
                window.addEventListener("click", selectedPreviewOutsideClickHandler, true);
            }, 100);
        }

        function refreshSelectedPreviewPopover() {
            if (!selectedPreviewPopover) return;
            renderSelectedPreviewPopoverContents();
            requestAnimationFrame(() => positionSelectedPreviewPopover(selectedPreviewAnchor || selectedPreviewBtn));
        }

        function renderGrid() {
            gridEl.innerHTML = "";
            const query = searchInput.value.toLowerCase().trim();
            
            const selectedFolder = node.properties.folderFilter || "all";
            const selectedSubfolder = node.properties.subfolderFilter || "all";
            const filtered = node.allImages.filter(img => {
                // 1. Filter by folder
                if (selectedFolder !== "all" && img.folder !== selectedFolder) {
                    return false;
                }
                if (selectedSubfolder !== "all") {
                    const imageFolder = img.image_folder || img.folder;
                    const matchesSubfolder = node.properties.recursive
                        ? isSameOrChildPath(imageFolder, selectedSubfolder)
                        : normalizeFilterPath(imageFolder) === normalizeFilterPath(selectedSubfolder);
                    if (!matchesSubfolder) {
                        return false;
                    }
                }
                // 2. Filter by search query
                if (query && !img.name.toLowerCase().includes(query) && !img.path.toLowerCase().includes(query)) {
                    return false;
                }
                return true;
            });
            
            if (filtered.length === 0) {
                const empty = document.createElement("div");
                empty.className = "helto-grid-empty";
                let folderPathsStr = "None";
                if (selectedSubfolder !== "all") {
                    folderPathsStr = selectedSubfolder;
                } else if (selectedFolder !== "all") {
                    folderPathsStr = selectedFolder;
                } else if (node.properties.folders && node.properties.folders.length > 0) {
                    folderPathsStr = node.properties.folders.join("<br>");
                }
                empty.innerHTML = `No images found in:<br><span style="font-family: monospace; font-size: 11px; opacity: 0.8; word-break: break-all;">${folderPathsStr}</span>`;
                gridEl.appendChild(empty);
                return;
            }
            
            filtered.forEach(img => {
                const isSelected = node.selectedPaths.includes(img.path);
                
                const item = document.createElement("div");
                item.className = `helto-grid-item ${isSelected ? "selected" : ""}`;
                if (node.editedMasks?.[img.path]) {
                    item.classList.add("has-mask");
                }
                item.dataset.path = img.path;
                item.title = `${img.name}\nSize: ${(img.size_bytes / (1024 * 1024)).toFixed(2)} MB\nPath: ${img.path}`;
                
                const aspectClass = node.properties.aspectRatioMode === "original" ? "aspect-original" : "aspect-zoom";
                
                const thumb = document.createElement("img");
                thumb.className = `helto-thumb lazy-load ${aspectClass}`;
                thumb.alt = img.name;
                
                // Thumb url targeting our backend endpoint
                const isPrivacy = node.properties.privacyMode;
                thumb.dataset.src = selectorApi.thumbnailUrl(img.path, isPrivacy);
                
                const checkmark = document.createElement("div");
                checkmark.className = "helto-item-checkmark";
                checkmark.innerHTML = ICONS.check;
                
                item.appendChild(thumb);
                item.appendChild(checkmark);
                gridEl.appendChild(item);
                
                // Click to Select/Deselect
                item.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.ctrlKey || e.metaKey) {
                        showPreviewPopup(img);
                        return;
                    }
                    const path = img.path;
                    const index = node.selectedPaths.indexOf(path);
                    if (index > -1) {
                        node.selectedPaths.splice(index, 1);
                        item.classList.remove("selected");
                    } else {
                        node.selectedPaths.push(path);
                        item.classList.add("selected");
                    }
                    updateFooter();
                    updateWidgetValue();
                };

                item.oncontextmenu = (e) => {
                    showImageContextMenu(e, img);
                };
            });

            scheduleVisibleThumbnailLoad();
        }
        
        function updateFooter() {
            // Calculate size of selected images
            let totalBytes = 0;
            node.selectedPaths.forEach(path => {
                const found = node.allImages.find(img => img.path === path);
                if (found) totalBytes += found.size_bytes;
            });
            const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
            footerText.innerText = `${node.selectedPaths.length} Images Selected • ${sizeMB} MB`;
            selectedPreviewBtn.disabled = node.selectedPaths.length === 0;
            deleteSelectedBtn.disabled = node.selectedPaths.length === 0;
            if (node.selectedPaths.length === 0) {
                removeSelectedPreviewPopover();
            } else {
                refreshSelectedPreviewPopover();
            }
        }
        
        function updateButtonActiveState(btn, active) {
            if (active) {
                btn.classList.add("active");
            } else {
                btn.classList.remove("active");
            }
        }
        
        // --- 6. Toolbar & Control Interactions ---
        
        // Recursive Toggle
        recursiveBtn.onclick = (e) => {
            containEvent(e);
            preserveSelectorSizeOnNextResize();
            node.properties.recursive = !node.properties.recursive;
            updateButtonActiveState(recursiveBtn, node.properties.recursive);
            node.scanFolders();
        };
        
        // Aspect Ratio Toggle
        aspectBtn.onclick = (e) => {
            containEvent(e);
            preserveSelectorSizeOnNextResize();
            node.properties.aspectRatioMode = node.properties.aspectRatioMode === "zoom" ? "original" : "zoom";
            updateButtonActiveState(aspectBtn, node.properties.aspectRatioMode === "original");
            renderGrid();
            refreshSelectedPreviewPopover();
        };

        // Refresh images and prune stale thumbnail cache entries
        refreshBtn.onclick = async (e) => {
            containEvent(e);
            preserveSelectorSizeOnNextResize();
            if (refreshBtn.disabled) return;

            refreshBtn.disabled = true;
            refreshBtn.classList.add("is-refreshing");
            try {
                await node.scanFolders({ pruneMissingCache: true });
            } finally {
                refreshBtn.classList.remove("is-refreshing");
                refreshBtn.disabled = false;
            }
        };
        
        // Search Filter input
        searchInput.oninput = (e) => {
            stopEvent(e);
            preserveSelectorSizeOnNextResize();
            renderGrid();
        };
        
        // Column Slider
        colSlider.oninput = (e) => {
            stopEvent(e);
            preserveSelectorSizeOnNextResize();
            const val = parseInt(e.target.value);
            node.properties.cols = val;
            sliderVal.innerText = val;
            gridEl.style.setProperty("--cols", val);
            scheduleVisibleThumbnailLoad();
        };
        
        // Sorting dropdown list
        sortLink.onclick = (e) => {
            containEvent(e);
            removeFloatingMenus();
            const dropdown = document.createElement("div");
            dropdown.className = "helto-dropdown";
            containFloatingMenu(dropdown);
            
            SORT_OPTIONS.forEach(opt => {
                const item = document.createElement("div");
                item.className = "helto-dropdown-item";
                item.innerText = opt;
                if (opt === node.properties.sortBy) {
                    item.classList.add("active");
                }
                
                item.onclick = (e) => {
                    containEvent(e);
                    preserveSelectorSizeOnNextResize();
                    node.properties.sortBy = opt;
                    sortLink.innerText = opt;
                    sortImages();
                    renderGrid();
                    dropdown.remove();
                };
                dropdown.appendChild(item);
            });
            
            // Positioning of dropdown
            const rect = sortLink.getBoundingClientRect();
            dropdown.style.top = `${rect.bottom + window.scrollY}px`;
            dropdown.style.left = `${rect.left + window.scrollX - 40}px`;
            
            document.body.appendChild(dropdown);
            closeMenuOnOutsideClick(dropdown, sortLink);
        };
        
        // Folder selection filter dropdown list
        folderFilterLink.onclick = (e) => {
            containEvent(e);
            removeFloatingMenus();
            const dropdown = document.createElement("div");
            dropdown.className = "helto-dropdown";
            containFloatingMenu(dropdown);
            
            const options = ["all", ...getRootFolderOptionsForNode()];
            
            options.forEach(opt => {
                const item = document.createElement("div");
                item.className = "helto-dropdown-item";
                const folderPath = opt === "all" ? "all" : getFolderPath(opt);
                item.style.textTransform = "none";
                
                if (opt === "all") {
                    item.innerText = "All folders";
                } else {
                    item.innerText = getFolderLabel(opt);
                    item.title = folderPath;
                    item.style.whiteSpace = "nowrap";
                    item.style.overflow = "hidden";
                    item.style.textOverflow = "ellipsis";
                    item.style.maxWidth = "260px";
                }
                
                if (folderPath === (node.properties.folderFilter || "all")) {
                    item.classList.add("active");
                }
                
                item.onclick = (e) => {
                    containEvent(e);
                    preserveSelectorSizeOnNextResize();
                    node.properties.folderFilter = folderPath;
                    node.properties.subfolderFilter = "all";
                    node.syncUIWithProperties();
                    dropdown.remove();
                    renderGrid();
                };
                dropdown.appendChild(item);
            });
            
            const rect = folderFilterLink.getBoundingClientRect();
            dropdown.style.top = `${rect.bottom + window.scrollY}px`;
            dropdown.style.left = `${rect.left + window.scrollX - 40}px`;
            dropdown.style.maxWidth = "280px";
            
            document.body.appendChild(dropdown);
            closeMenuOnOutsideClick(dropdown, folderFilterLink);
        };

        // Subfolder selection filter dropdown list
        subfolderFilterLink.onclick = (e) => {
            containEvent(e);
            removeFloatingMenus();
            const dropdown = document.createElement("div");
            dropdown.className = "helto-dropdown";
            containFloatingMenu(dropdown);

            const options = ["all", ...getSubfolderOptionsForNode()];

            options.forEach(opt => {
                const item = document.createElement("div");
                item.className = "helto-dropdown-item";
                const folderPath = opt === "all" ? "all" : getFolderPath(opt);
                item.style.textTransform = "none";

                if (opt === "all") {
                    item.innerText = "All folders";
                } else {
                    item.innerText = getFolderLabel(opt);
                    item.title = folderPath;
                    item.style.whiteSpace = "nowrap";
                    item.style.overflow = "hidden";
                    item.style.textOverflow = "ellipsis";
                    item.style.maxWidth = "260px";
                }

                if (folderPath === (node.properties.subfolderFilter || "all")) {
                    item.classList.add("active");
                }

                item.onclick = (e) => {
                    containEvent(e);
                    preserveSelectorSizeOnNextResize();
                    node.properties.subfolderFilter = folderPath;
                    node.syncUIWithProperties();
                    dropdown.remove();
                    renderGrid();
                };
                dropdown.appendChild(item);
            });

            dropdown.classList.add("helto-dropdown-scrollable");
            dropdown.style.maxWidth = "280px";

            document.body.appendChild(dropdown);
            fitDropdownToViewport(dropdown, subfolderFilterLink);
            closeMenuOnOutsideClick(dropdown, subfolderFilterLink);
        };
        
        // Clear selection button
        clearBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            preserveSelectorSizeOnNextResize();
            node.selectedPaths = [];
            const items = gridEl.querySelectorAll(".helto-grid-item");
            items.forEach(item => item.classList.remove("selected"));
            updateFooter();
            updateWidgetValue();
        };

        // Delete selected images from disk
        deleteSelectedBtn.onclick = (e) => {
            containEvent(e);
            preserveSelectorSizeOnNextResize();
            const pathsToDelete = [...node.selectedPaths];
            if (pathsToDelete.length === 0) return;

            const content = `
                <div class="delete-confirm-message">Delete ${pathsToDelete.length} images?</div>
            `;
            createModal("Delete Selected Images", content, async () => {
                deleteSelectedBtn.disabled = true;
                deleteSelectedBtn.classList.add("is-deleting");
                try {
                    const result = await selectorApi.deleteSelectedImages(
                        pathsToDelete,
                        node.properties.folders || [],
                        node.properties.recursive
                    );
                    const removedPaths = new Set([...(result.deleted || []), ...(result.missing || [])]);
                    if (removedPaths.size > 0) {
                        node.selectedPaths = node.selectedPaths.filter((path) => !removedPaths.has(path));
                        node.allImages = node.allImages.filter((img) => !removedPaths.has(img.path));
                        node.editedMasks = Object.fromEntries(
                            Object.entries(node.editedMasks || {}).filter(([path]) => !removedPaths.has(path))
                        );
                    }
                    removeSelectedPreviewPopover();
                    document.querySelectorAll(".helto-preview-overlay").forEach((overlay) => overlay.remove());
                    renderGrid();
                    updateFooter();
                    await updateWidgetValue();
                    await updateMaskWidgetValue();
                    if ((result.skipped || []).length > 0) {
                        console.warn("Some selected images were not deleted:", result.skipped);
                    }
                    return true;
                } finally {
                    deleteSelectedBtn.classList.remove("is-deleting");
                    deleteSelectedBtn.disabled = node.selectedPaths.length === 0;
                }
            }, {
                actionText: "OK",
                actionClass: "btn-danger",
            });
        };

        selectedPreviewBtn.onclick = (e) => {
            containEvent(e);
            if (selectedPreviewPopover) {
                removeSelectedPreviewPopover();
                return;
            }
            showSelectedPreviewPopover(selectedPreviewBtn);
        };
        
        // --- 7. Modals: Manage Folders ---
        folderBtn.onclick = (e) => {
            containEvent(e);
            preserveSelectorSizeOnNextResize();
            let foldersList = [...node.properties.folders];
            
            const updateModalList = (body) => {
                const listContainer = body.querySelector(".helto-modal-folder-list");
                listContainer.innerHTML = "";
                
                body.querySelector(".helto-modal-folder-count").innerText = `${foldersList.length} Total`;
                
                if (foldersList.length === 0) {
                    listContainer.innerHTML = `<div class="folder-list-empty">No active folders configured</div>`;
                    return;
                }
                
                foldersList.forEach((folder, idx) => {
                    const item = document.createElement("div");
                    item.className = "folder-list-item";
                    item.innerHTML = `
                        <span class="folder-item-icon">${ICONS.folder}</span>
                        <span class="folder-item-path" title="${folder}">${folder}</span>
                        <button class="folder-item-del-btn" data-index="${idx}">${ICONS.clear}</button>
                    `;
                    
                    item.querySelector(".folder-item-del-btn").onclick = (e) => {
                        containEvent(e);
                        foldersList.splice(idx, 1);
                        updateModalList(body);
                    };
                    listContainer.appendChild(item);
                });
            };
            
            const content = `
                <div class="folder-modal-section">
                    <label class="modal-label">ADD FOLDER PATH</label>
                    <div class="folder-add-input-group">
                        <input type="text" class="folder-add-input" placeholder="/volumes/work/new_assets">
                        <button class="folder-add-btn">+</button>
                    </div>
                </div>
                <div class="folder-modal-section">
                    <div class="folder-modal-list-header">
                        <label class="modal-label">ACTIVE FOLDERS</label>
                        <span class="helto-modal-folder-count">0 Total</span>
                    </div>
                    <div class="helto-modal-folder-list"></div>
                </div>
            `;
            
            const { body } = createModal("Manage Folders", content, (bodyEl) => {
                preserveSelectorSizeOnNextResize();
                node.properties.folders = foldersList;
                if (node.properties.folderFilter !== "all" && !foldersList.includes(node.properties.folderFilter)) {
                    node.properties.folderFilter = "all";
                    node.properties.subfolderFilter = "all";
                }
                node.syncUIWithProperties();
                node.scanFolders();
                return true; // Close modal
            });
            
            const addInput = body.querySelector(".folder-add-input");
            const addBtn = body.querySelector(".folder-add-btn");
            
            addBtn.onclick = (e) => {
                if (e) containEvent(e);
                const path = normalizeFolderPath(addInput.value);
                if (path && !foldersList.includes(path)) {
                    foldersList.push(path);
                    addInput.value = "";
                    updateModalList(body);
                }
            };
            
            addInput.onkeydown = (e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                    e.preventDefault();
                    addBtn.onclick(e);
                }
            };
            
            updateModalList(body);
        };
        
        // --- 8. Modals: Settings / Properties ---
        const rightClickMenu = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function(canvas, options) {
            if (rightClickMenu) rightClickMenu.apply(this, arguments);
            
            // Add custom gear click action in title bar or menu
            options.push({
                content: "Selector Properties...",
                callback: () => openSettingsModal()
            });
        };
        
        // Hook toolbar gear button to properties
        gearBtn.onclick = (e) => {
            containEvent(e);
            preserveSelectorSizeOnNextResize();
            openSettingsModal();
        };
        
        function openSettingsModal() {
            const hideChecked = node.properties.hideMode ? "checked" : "";
            const privacyChecked = node.properties.privacyMode ? "checked" : "";
            
            const content = `
                <div class="settings-modal-row">
                    <div class="settings-modal-text">
                        <div class="settings-title">Hide Mode</div>
                        <div class="settings-desc">Fades out thumbnails when the mouse cursor is outside of the node.</div>
                    </div>
                    <label class="helto-switch">
                        <input type="checkbox" id="hide-mode-toggle" ${hideChecked}>
                        <span class="helto-switch-slider"></span>
                    </label>
                </div>
                <div class="settings-modal-row">
                    <div class="settings-modal-text">
                        <div class="settings-title">Privacy Mode</div>
                        <div class="settings-desc">Encrypts the saved workflow states and cached thumbnails on disk.</div>
                    </div>
                    <label class="helto-switch">
                        <input type="checkbox" id="privacy-mode-toggle" ${privacyChecked}>
                        <span class="helto-switch-slider"></span>
                    </label>
                </div>
                <div class="settings-modal-row">
                    <div class="settings-modal-text">
                        <div class="settings-title">Resize Mode</div>
                        <div class="settings-desc">How selected images are sized when outputted.</div>
                    </div>
                    <select id="resize-mode-select" class="helto-select">
                        <option value="No resize" ${node.properties.resizeMode === "No resize" ? "selected" : ""}>No resize</option>
                        <option value="pad" ${node.properties.resizeMode === "pad" ? "selected" : ""}>pad</option>
                        <option value="zoom to fit" ${node.properties.resizeMode === "zoom to fit" ? "selected" : ""}>zoom to fit</option>
                    </select>
                </div>
                <div class="settings-modal-action-row">
                    <button class="helto-modal-btn btn-danger btn-full" id="clear-cache-btn">Clear Cached Thumbnails</button>
                </div>
            `;
            
            const { body } = createModal("Selector Properties", content, async (bodyEl) => {
                preserveSelectorSizeOnNextResize();
                const newHideMode = bodyEl.querySelector("#hide-mode-toggle").checked;
                const newPrivacyMode = bodyEl.querySelector("#privacy-mode-toggle").checked;
                const newResizeMode = bodyEl.querySelector("#resize-mode-select").value;
                
                const privacyChanged = newPrivacyMode !== node.properties.privacyMode;

                if (privacyChanged && newPrivacyMode) {
                    await clearThumbnailCache();
                }
                if (privacyChanged) {
                    await selectorApi.migrateMasks(Object.keys(node.editedMasks || {}), newPrivacyMode);
                }
                
                node.properties.hideMode = newHideMode;
                node.properties.privacyMode = newPrivacyMode;
                node.properties.resizeMode = newResizeMode;
                
                const resizeModeWidget = node.widgets.find(w => w.name === "resize_mode");
                if (resizeModeWidget) {
                    resizeModeWidget.value = newResizeMode;
                }
                
                applyHideModeListeners();
                
                if (privacyChanged) {
                    // Update the saved value to match new encryption state
                    await updateWidgetValue();
                    await updateMaskWidgetValue();
                    // Force refresh grid to get new encrypted/decrypted URLs
                    renderGrid();
                }
                
                return true; // Close modal
            });
            
            // Clear Cache button logic
            body.querySelector("#clear-cache-btn").onclick = async (e) => {
                containEvent(e);
                preserveSelectorSizeOnNextResize();
                const btn = e.target;
                btn.innerText = "Clearing...";
                btn.disabled = true;
                try {
                    await clearThumbnailCache();
                    btn.innerText = "Cache Cleared!";
                    setTimeout(() => {
                        btn.innerText = "Clear Cached Thumbnails";
                        btn.disabled = false;
                    }, 1500);
                    node.scanFolders(); // reload
                } catch (err) {
                    btn.innerText = "Error!";
                    btn.disabled = false;
                }
            };
        }

        async function clearThumbnailCache() {
            await selectorApi.clearCache();
        }
        
        // --- 9. Resizing & Sizing Implementation ---
        layoutController.installNodeResizeHooks();
        
        // --- 10. Initial load trigger ---
        setTimeout(() => {
            node.scanFolders().then(async () => {
                await node.restoreSelection();
                await node.restoreEditedMasks();
                if (node.onResize) node.onResize();
            });
        }, 100);

        requestAnimationFrame(() => {
            if (node.onResize) node.onResize();
        });
    },
    
    loadedGraphNode(node) {
        installGraphToPromptPatch();
        if (node.comfyClass === HELTO_SELECTOR_NODE_CLASS) {
            if (node.normalizeHeltoSelectorSize) node.normalizeHeltoSelectorSize();
            if (node.syncUIWithProperties) node.syncUIWithProperties();
            if (node.onResize) node.onResize();

            // Trigger restore on workflow load to make sure variables align
            setTimeout(() => {
                if (node.normalizeHeltoSelectorSize) node.normalizeHeltoSelectorSize();
                if (node.syncUIWithProperties) node.syncUIWithProperties();
                if (node.restoreSelection) node.restoreSelection();
                if (node.onResize) node.onResize();
            }, 200);
        }
    }
});
