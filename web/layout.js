import {
    applySelectorElementInset,
    setWidgetHeight,
} from "./ui.js";

export const SELECTOR_LAYOUT = Object.freeze({
    minWidth: 460,
    minHeight: 420,
    widgetHeight: 404,
    vueChromeHeight: 76,
    bottomGutter: 0,
});

export function getComfySetting(app, name) {
    const setting = app.extensionManager?.setting?.get?.(name)
        ?? app.ui?.settings?.getSettingValue?.(name);
    if (typeof setting === "object" && setting !== null) {
        return setting.value ?? setting.id ?? setting.name ?? setting.text;
    }
    return setting;
}

export function getGraphRendererMode(app) {
    const setting = getComfySetting(app, "Comfy.Graph.Renderer");
    const value = typeof setting === "object"
        ? (setting?.value ?? setting?.id ?? setting?.name ?? setting?.text)
        : setting;
    return String(value ?? "").toLowerCase();
}

export function isLegacyCanvasRenderer({
    app,
    document = globalThis.document,
    window = globalThis.window,
}) {
    return getCanvasRendererLayoutMode({ app, document, window }) !== "vue";
}

export function getCanvasRendererLayoutMode({
    app,
    document = globalThis.document,
    window = globalThis.window,
}) {
    const vueNodesEnabled = getComfySetting(app, "Comfy.VueNodes.Enabled");
    const vueNodesValue = String(vueNodesEnabled ?? "").toLowerCase();
    if (vueNodesEnabled === true || vueNodesValue === "true" || vueNodesValue === "enabled") return "vue";
    if (vueNodesEnabled === false || vueNodesValue === "false" || vueNodesValue === "disabled") return "legacy";

    const mode = getGraphRendererMode(app);
    if (mode) {
        if (mode.includes("litegraph") || mode.includes("canvas") || mode.includes("classic")) return "legacy";
        if (mode.includes("vue") || mode.includes("dom") || mode.includes("modern") || /nodes?\s*2|2\.0/.test(mode)) return "vue";
    }
    if (document.querySelector(".lg-node")) return "vue";
    if (window.LiteGraph) return "ambiguous";
    return "vue";
}

export function normalizeHeltoSelectorSize(node) {
    const currentSize = (node.size && node.size.length >= 2) ? node.size : [];
    node.size = [
        Math.max(SELECTOR_LAYOUT.minWidth, currentSize[0] || 0),
        Math.max(480, currentSize[1] || 0),
    ];
}

export function getSelectorWidgetStartY(node, domWidget) {
    let startY = 46;
    if (domWidget && node.widgets) {
        const idx = node.widgets.indexOf(domWidget);
        for (let i = idx - 1; i >= 0; i--) {
            const w = node.widgets[i];
            if (w && w.type !== "hidden" && w.y !== undefined) {
                startY = w.y + (w.height || 24) + 6;
                break;
            }
        }
    }
    return startY;
}

export function getSelectorWidgetHeight(node, startY, layout = SELECTOR_LAYOUT) {
    const height = (node.size && node.size.length >= 2 && Number.isFinite(node.size[1])) ? node.size[1] : 480;
    return Math.max(layout.minHeight, height - startY - layout.bottomGutter);
}

export function getVueSelectorWidgetHeight({
    layout = SELECTOR_LAYOUT,
}) {
    // Keep Vue DOM height independent from the observed node height; feeding it back causes growth loops.
    return layout.widgetHeight;
}

export function getVueSelectorVisualHeight({
    node,
    domWidget,
    window = globalThis.window,
    getComputedStyle = globalThis.getComputedStyle,
    layout = SELECTOR_LAYOUT,
}) {
    const nodeEl = domWidget?.element?.closest(".lg-node");
    if (nodeEl) {
        const inlineHeight = nodeEl.style.getPropertyValue("--node-height");
        const computedHeight = getComputedStyle(nodeEl).getPropertyValue("--node-height");
        const cssNodeHeight = parseFloat(inlineHeight || computedHeight);
        if (Number.isFinite(cssNodeHeight)) {
            const titleHeight = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
            return Math.max(layout.widgetHeight, cssNodeHeight - titleHeight - layout.vueChromeHeight);
        }
    }
    const height = (node.size && node.size.length >= 2 && Number.isFinite(node.size[1])) ? node.size[1] : 480;
    return Math.max(layout.widgetHeight, height - layout.vueChromeHeight);
}

export function createSelectorLayoutController({
    app,
    node,
    domWidget,
    scheduleVisibleThumbnailLoad,
    document = globalThis.document,
    window = globalThis.window,
    requestAnimationFrame = globalThis.requestAnimationFrame,
    ResizeObserver = globalThis.ResizeObserver,
    setTimeout = globalThis.setTimeout,
    getComputedStyle = globalThis.getComputedStyle,
    layout = SELECTOR_LAYOUT,
}) {
    let vueResizeObserver = null;
    let vueMountCheckCount = 0;
    let vueLayoutApplied = false;
    let ambiguousLegacyConfirmed = false;
    let legacyNodeComputeSizeApplied = false;

    const getRendererMode = () => getCanvasRendererLayoutMode({ app, document, window });
    const isDefinitelyLegacyRenderer = () => getRendererMode() === "legacy" || ambiguousLegacyConfirmed;
    const getVueNodeElement = () => domWidget?.element?.closest(".lg-node");
    const isVueDomMounted = () => !!getVueNodeElement();
    const shouldUseVuePath = () => getRendererMode() === "vue" || (!isDefinitelyLegacyRenderer() && isVueDomMounted());

    function getWidgetStartY() {
        return getSelectorWidgetStartY(node, domWidget);
    }

    function getWidgetHeight(startY = getWidgetStartY()) {
        return getSelectorWidgetHeight(node, startY, layout);
    }

    function syncVueSelectorWidgetHeight() {
        if (!shouldUseVuePath() || !domWidget?.element) return;
        applyVueStaticLayoutStyles();
        const widgetHeight = getVueSelectorWidgetHeight({
            layout,
        });
        if (parseFloat(domWidget.element.style.height) !== widgetHeight) {
            domWidget.element.style.height = `${widgetHeight}px`;
            domWidget.element.style.minHeight = `${widgetHeight}px`;
            domWidget.element.style.maxHeight = `${widgetHeight}px`;
        }
        syncVueSelectorVisualHeight();
    }

    function syncVueSelectorVisualHeight() {
        applyVueVisibleOverflowStyles();
        const containerEl = domWidget?.element?.querySelector(".helto-selector-container");
        if (!containerEl) return;
        const visualHeight = getVueSelectorVisualHeight({
            node,
            domWidget,
            window,
            getComputedStyle,
            layout,
        });
        containerEl.style.height = `${Math.max(0, visualHeight - 16)}px`;
    }

    function applyVueVisibleOverflowStyles() {
        const element = domWidget?.element;
        if (!element) return;
        element.style.overflow = "visible";
        element.style.position = "relative";
        element.style.zIndex = "1";

        const parent = element.parentElement;
        if (parent) {
            parent.style.overflow = "visible";
            parent.style.position = "relative";
            parent.style.zIndex = "1";
        }

        const widgetRow = element.closest(".lg-node-widget");
        if (widgetRow) {
            widgetRow.style.overflow = "visible";
            widgetRow.style.position = "relative";
            widgetRow.style.zIndex = "1";
        }

        const widgetsGrid = element.closest(".lg-node-widgets");
        if (widgetsGrid) {
            widgetsGrid.style.overflow = "visible";
            widgetsGrid.style.position = "relative";
            widgetsGrid.style.zIndex = "1";
        }
    }

    function setupVueSelectorResizeObserver() {
        if (vueResizeObserver || !domWidget?.element) return;
        if (!shouldUseVuePath()) {
            if (isDefinitelyLegacyRenderer()) return;
            if (vueMountCheckCount > 120) {
                ambiguousLegacyConfirmed = true;
                restoreNativeWidgetLayoutSize();
                applyLegacyNodeComputeSize();
                syncSelectorWidgetBounds();
                return;
            }
        }
        const nodeEl = getVueNodeElement();
        if (!nodeEl) {
            vueMountCheckCount += 1;
            requestAnimationFrame(setupVueSelectorResizeObserver);
            return;
        }
        applyVueStaticLayoutStyles();
        vueResizeObserver = new ResizeObserver((entries) => {
            if (entries.length === 0) return;
            syncVueSelectorWidgetHeight();
            scheduleVisibleThumbnailLoad();
        });
        vueResizeObserver.observe(nodeEl);
    }

    function syncSelectorWidgetBounds() {
        if (shouldUseVuePath() || !isDefinitelyLegacyRenderer()) return;
        if (!domWidget || !node.size || node.size.length < 2) return;

        // ComfyUI legacy canvas path: DOM widget bounds are driven by LiteGraph widget coordinates.
        applySelectorElementInset(domWidget.element);

        const nodeWidth = (node.size && node.size.length >= 2 && Number.isFinite(node.size[0]))
            ? Math.max(0, node.size[0])
            : (Number.isFinite(node.width) ? Math.max(0, node.width) : layout.minWidth);
        const nodeHeight = (node.size && node.size.length >= 2 && Number.isFinite(node.size[1])) ? node.size[1] : 480;
        const startY = domWidget.last_y ?? domWidget.y ?? getWidgetStartY();
        const widgetHeight = getWidgetHeight(startY);

        domWidget.x = 0;
        domWidget.width = Math.max(150, nodeWidth);
        domWidget.computedHeight = widgetHeight;
        try {
            setWidgetHeight(domWidget, Math.max(50, widgetHeight - 16));
        } catch (e) {
            console.error("[Selector Debug] setWidgetHeight crashed:", e);
        }
        domWidget.element.style.height = `${widgetHeight}px`;

        let wrapperLeft = 15;
        let wrapperTop = startY;

        const parent = domWidget.element.parentElement;
        if (parent) {
            parent.style.overflow = "visible";
            const zoom = (app.canvas && app.canvas.ds) ? (app.canvas.ds.scale || 1.0) : 1.0;
            const parentRect = parent.getBoundingClientRect();
            const parentWidth = parentRect.width / zoom;
            if (Number.isFinite(parentWidth) && parentWidth > nodeWidth - 10) {
                wrapperLeft = 0;
            } else {
                wrapperLeft = 15;
            }
        }

        const containerEl = domWidget.element.querySelector(".helto-selector-container");
        if (containerEl) {
            const marginLeft = 8 - wrapperLeft;
            const marginTop = (startY + 8) - wrapperTop;

            containerEl.style.marginLeft = `${marginLeft}px`;
            containerEl.style.marginRight = "0px";
            containerEl.style.width = `${nodeWidth - 16}px`;

            containerEl.style.marginTop = `${marginTop}px`;
            containerEl.style.marginBottom = "0px";
            containerEl.style.height = `${nodeHeight - startY - 16}px`;
        }
    }

    function requestSelectorLayoutSync() {
        if (shouldUseVuePath()) return;

        syncSelectorWidgetBounds();
        requestAnimationFrame(() => {
            syncSelectorWidgetBounds();
            node.setDirtyCanvas(true, true);
        });
    }

    function syncSelectorAfterSizeChange() {
        requestSelectorLayoutSync();
        if (!shouldUseVuePath()) {
            requestAnimationFrame(() => {
                if (node.onResize) node.onResize(node.size);
            });
        }
    }

    function preserveSelectorSizeOnNextResize() {
        if (!shouldUseVuePath()) syncSelectorWidgetBounds();
    }

    function applyVueStaticLayoutStyles() {
        if (vueLayoutApplied || !domWidget?.element) return;
        clearWidgetLayoutSize();
        domWidget.element.style.boxSizing = "border-box";
        domWidget.element.style.margin = "0";
        domWidget.element.style.width = "100%";
        applyVueVisibleOverflowStyles();

        const containerEl = domWidget.element.querySelector(".helto-selector-container");
        if (containerEl) {
            containerEl.style.position = "absolute";
            containerEl.style.left = "8px";
            containerEl.style.top = "8px";
            containerEl.style.marginLeft = "0";
            containerEl.style.marginRight = "0";
            containerEl.style.marginTop = "0";
            containerEl.style.marginBottom = "0";
            containerEl.style.width = "calc(100% - 16px)";
        }

        const setupParentOverflow = () => {
            const parent = domWidget.element.parentElement;
            if (parent) {
                parent.style.overflow = "visible";
            } else {
                setTimeout(setupParentOverflow, 50);
            }
        };
        setupParentOverflow();
        syncVueSelectorVisualHeight();
        vueLayoutApplied = true;
    }

    function clearWidgetLayoutSize() {
        if (!domWidget) return;
        // Shadow Comfy's DOMWidget prototype callbacks so Vue does not classify this as a layout-sized widget.
        domWidget.computeLayoutSize = undefined;
        domWidget.computeSize = undefined;
    }

    function restoreNativeWidgetLayoutSize() {
        if (!domWidget) return;
        // Legacy canvas needs the native DOMWidget layout callbacks from Comfy's prototype.
        delete domWidget.computeLayoutSize;
        delete domWidget.computeSize;
    }

    function applyLegacyNodeComputeSize() {
        if (legacyNodeComputeSizeApplied || shouldUseVuePath()) return;
        node.computeSize = function() {
            return [layout.minWidth, 480];
        };
        legacyNodeComputeSizeApplied = true;
    }

    function initializeDomWidgetLayout() {
        if (shouldUseVuePath()) {
            clearWidgetLayoutSize();
            applyVueStaticLayoutStyles();
            syncVueSelectorWidgetHeight();
            setupVueSelectorResizeObserver();
        } else {
            if (isDefinitelyLegacyRenderer()) {
                restoreNativeWidgetLayoutSize();
            } else {
                clearWidgetLayoutSize();
            }
            syncSelectorWidgetBounds();
            setupVueSelectorResizeObserver();
        }
    }

    function installNodeResizeHooks() {
        if (isDefinitelyLegacyRenderer()) applyLegacyNodeComputeSize();

        const originalOnResize = node.onResize;
        node.onResize = function() {
            if (originalOnResize) originalOnResize.apply(this, arguments);
            if (!shouldUseVuePath()) {
                requestSelectorLayoutSync();
                this.setDirtyCanvas(true, true);
            } else {
                setupVueSelectorResizeObserver();
                syncVueSelectorWidgetHeight();
                scheduleVisibleThumbnailLoad();
            }
        };

        const originalSetSize = node.setSize;
        node.setSize = function(size) {
            const result = originalSetSize ? originalSetSize.apply(this, arguments) : undefined;
            if (!shouldUseVuePath()) {
                syncSelectorAfterSizeChange();
            } else {
                setupVueSelectorResizeObserver();
                syncVueSelectorWidgetHeight();
                scheduleVisibleThumbnailLoad();
            }
            return result;
        };

        const originalOnDrawForeground = node.onDrawForeground;
        node.onDrawForeground = function(ctx) {
            if (originalOnDrawForeground) originalOnDrawForeground.apply(this, arguments);
            if (!shouldUseVuePath()) syncSelectorWidgetBounds();
        };

        const originalMove = node.move;
        node.move = function() {
            const result = originalMove ? originalMove.apply(this, arguments) : undefined;
            if (!shouldUseVuePath()) requestSelectorLayoutSync();
            return result;
        };

        const originalOnRemoved = node.onRemoved;
        node.onRemoved = function() {
            disconnectVueResizeObserver();
            if (originalOnRemoved) originalOnRemoved.apply(this, arguments);
        };
    }

    function disconnectVueResizeObserver() {
        if (vueResizeObserver) {
            vueResizeObserver.disconnect();
            vueResizeObserver = null;
        }
    }

    return {
        initializeDomWidgetLayout,
        installNodeResizeHooks,
        preserveSelectorSizeOnNextResize,
        requestSelectorLayoutSync,
        syncSelectorWidgetBounds,
        syncVueSelectorWidgetHeight,
        disconnectVueResizeObserver,
    };
}
