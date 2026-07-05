import { app } from "/scripts/app.js";
import {
    applyHeltoLiteGraphWidgetTheme,
    applyHeltoUtilsNodeTheme,
    ensureHeltoTokens,
    isHeltoThemedNode,
    isHeltoThemedNodeData,
    restoreHeltoLiteGraphWidgetTheme,
    withHeltoLiteGraphWidgetTheme,
} from "./helto_theme.js";

const WIDGET_THEME_BRIDGE_KEY = "__heltoUtilsLiteGraphWidgetThemeBridgeInstalled";
const WIDGET_THEME_FALLBACK_KEY = "__heltoUtilsLiteGraphWidgetThemeFallbackInstalled";
const WIDGET_THEME_SNAPSHOT_KEY = "__heltoUtilsLiteGraphWidgetThemeSnapshot";
const NODE_THEME_PATCH_KEY = "__heltoUtilsNodeThemePatched";

function liteGraphCanvasPrototype() {
    return [
        globalThis.LGraphCanvas?.prototype,
        globalThis.LiteGraph?.LGraphCanvas?.prototype,
        app.canvas?.constructor?.prototype,
    ].find((prototype) => typeof prototype?.drawNodeWidgets === "function") || null;
}

function installHeltoWidgetThemeBridge() {
    const prototype = liteGraphCanvasPrototype();
    if (!prototype) {
        return false;
    }
    if (prototype[WIDGET_THEME_BRIDGE_KEY]) {
        return true;
    }
    const originalDrawNodeWidgets = prototype.drawNodeWidgets;
    prototype[WIDGET_THEME_BRIDGE_KEY] = true;
    prototype.drawNodeWidgets = function (node) {
        if (isHeltoThemedNode(node)) {
            return withHeltoLiteGraphWidgetTheme(() => originalDrawNodeWidgets.apply(this, arguments));
        }
        return originalDrawNodeWidgets.apply(this, arguments);
    };
    return true;
}

function ensureHeltoWidgetThemeFallback(node) {
    if (!node || node[WIDGET_THEME_FALLBACK_KEY]) {
        return;
    }
    node[WIDGET_THEME_FALLBACK_KEY] = true;

    const originalDrawBackground = node.onDrawBackground;
    node.onDrawBackground = function () {
        restoreHeltoLiteGraphWidgetTheme(this[WIDGET_THEME_SNAPSHOT_KEY]);
        this[WIDGET_THEME_SNAPSHOT_KEY] = applyHeltoLiteGraphWidgetTheme();
        try {
            return originalDrawBackground?.apply(this, arguments);
        } catch (error) {
            restoreHeltoLiteGraphWidgetTheme(this[WIDGET_THEME_SNAPSHOT_KEY]);
            this[WIDGET_THEME_SNAPSHOT_KEY] = null;
            throw error;
        }
    };

    const originalDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function () {
        try {
            return originalDrawForeground?.apply(this, arguments);
        } finally {
            restoreHeltoLiteGraphWidgetTheme(this[WIDGET_THEME_SNAPSHOT_KEY]);
            this[WIDGET_THEME_SNAPSHOT_KEY] = null;
        }
    };
}

function applyHeltoUtilsTheme(node) {
    if (!isHeltoThemedNode(node)) {
        return false;
    }
    ensureHeltoTokens();
    if (!installHeltoWidgetThemeBridge()) {
        ensureHeltoWidgetThemeFallback(node);
    }
    return applyHeltoUtilsNodeTheme(node);
}

function patchHeltoThemeNodeType(nodeType) {
    if (nodeType.prototype[NODE_THEME_PATCH_KEY]) {
        return;
    }
    nodeType.prototype[NODE_THEME_PATCH_KEY] = true;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const result = originalCreated?.apply(this, arguments);
        applyHeltoUtilsTheme(this);
        return result;
    };

    const originalConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
        const result = originalConfigure?.apply(this, arguments);
        applyHeltoUtilsTheme(this);
        return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
        const result = originalOnConfigure?.apply(this, arguments);
        applyHeltoUtilsTheme(this);
        return result;
    };
}

function applyExistingGraphTheme() {
    for (const node of app.graph?._nodes || []) {
        applyHeltoUtilsTheme(node);
    }
}

app.registerExtension({
    name: "Helto.Utils.NodeTheme",
    setup() {
        ensureHeltoTokens();
        installHeltoWidgetThemeBridge();
        requestAnimationFrame(() => applyExistingGraphTheme());
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (isHeltoThemedNodeData(nodeData)) {
            patchHeltoThemeNodeType(nodeType);
        }
    },
    nodeCreated(node) {
        applyHeltoUtilsTheme(node);
    },
    loadedGraphNode(node) {
        applyHeltoUtilsTheme(node);
    },
});
