import assert from "node:assert/strict";
import test from "node:test";

import {
    createSelectorLayoutController,
    getCanvasRendererLayoutMode,
    getSelectorWidgetHeight,
    getVueSelectorWidgetHeight,
    getVueSelectorVisualHeight,
    isLegacyCanvasRenderer,
} from "../../web/layout.js";
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
    sortImagesInPlace,
} from "../../web/state.js";
import {
    previewKeysForNode,
    runWithPreviewPriming,
    storeOutputForPreviewKeys,
} from "../../web/hide_mode_helpers.js";
import {
    hideSerializedSettingsWidgets,
    readPromptEnhancerSettings,
    setGenerateNewEachPrompt,
    setNewFixedPromptSeed,
    updateModelOptions,
    writePromptEnhancerSettings,
} from "../../web/prompt_enhancer_helpers.js";

function appWithSettings(settings) {
    return {
        extensionManager: {
            setting: {
                get(name) {
                    return settings[name];
                },
            },
        },
    };
}

function documentWithVueNode(found = false) {
    return {
        querySelector(selector) {
            return selector === ".lg-node" && found ? {} : null;
        },
    };
}

test("renderer detection honors explicit Vue and legacy settings first", () => {
    assert.equal(isLegacyCanvasRenderer({
        app: appWithSettings({ "Comfy.VueNodes.Enabled": true }),
        document: documentWithVueNode(false),
        window: { LiteGraph: {} },
    }), false);

    assert.equal(isLegacyCanvasRenderer({
        app: appWithSettings({ "Comfy.VueNodes.Enabled": false }),
        document: documentWithVueNode(true),
        window: {},
    }), true);
});

test("renderer detection follows renderer names before DOM and LiteGraph fallbacks", () => {
    assert.equal(isLegacyCanvasRenderer({
        app: appWithSettings({ "Comfy.Graph.Renderer": "LiteGraph Canvas" }),
        document: documentWithVueNode(true),
        window: {},
    }), true);

    assert.equal(isLegacyCanvasRenderer({
        app: appWithSettings({ "Comfy.Graph.Renderer": "Nodes 2.0" }),
        document: documentWithVueNode(false),
        window: { LiteGraph: {} },
    }), false);
});

test("renderer detection uses Vue DOM marker before LiteGraph fallback", () => {
    assert.equal(isLegacyCanvasRenderer({
        app: appWithSettings({}),
        document: documentWithVueNode(true),
        window: { LiteGraph: {} },
    }), false);

    assert.equal(isLegacyCanvasRenderer({
        app: appWithSettings({}),
        document: documentWithVueNode(false),
        window: { LiteGraph: {} },
    }), true);
});

test("renderer layout mode keeps LiteGraph-only detection ambiguous", () => {
    assert.equal(getCanvasRendererLayoutMode({
        app: appWithSettings({}),
        document: documentWithVueNode(false),
        window: { LiteGraph: {} },
    }), "ambiguous");

    assert.equal(getCanvasRendererLayoutMode({
        app: appWithSettings({ "Comfy.Graph.Renderer": "LiteGraph Canvas" }),
        document: documentWithVueNode(false),
        window: { LiteGraph: {} },
    }), "legacy");

    assert.equal(getCanvasRendererLayoutMode({
        app: appWithSettings({}),
        document: documentWithVueNode(true),
        window: { LiteGraph: {} },
    }), "vue");
});

test("selector property defaults and folder labels match existing behavior", () => {
    const properties = initializeSelectorProperties({ folders: "not-an-array", cols: 6 });
    assert.deepEqual(properties.folders, []);
    assert.equal(properties.cols, 6);
    assert.equal(properties.recursive, false);
    assert.equal(properties.privacyMode, true);
    assert.equal(properties.resizeMode, "zoom to fit");

    const savedProperties = initializeSelectorProperties({ privacyMode: false });
    assert.equal(savedProperties.privacyMode, false);

    const allFolders = [
        { path: "/root/a", root: "/root/a", relative: "", name: "a" },
        { path: "/root/a/child", root: "/root/a", relative: "child", name: "child" },
    ];

    assert.equal(getFolderPath(allFolders[0]), "/root/a");
    assert.equal(getFolderLabel(allFolders[1]), "child");
    assert.deepEqual(getRootFolderOptions(allFolders, ["/fallback"]), [allFolders[0]]);
    assert.equal(getRootFolderFilterLabel("/root/a", allFolders, []), "a");
    assert.equal(getSubfolderFilterLabel("/root/a/child", allFolders), "child");
    assert.deepEqual(getSubfolderOptions(allFolders, "/root/a"), allFolders);
});

test("path filter helpers normalize slash style and child matching", () => {
    assert.equal(normalizeFilterPath("C:\\images\\nested\\"), "C:/images/nested");
    assert.equal(isSameOrChildPath("/root/a/child/file.png", "/root/a"), true);
    assert.equal(isSameOrChildPath("/root/ab/file.png", "/root/a"), false);
});

test("sortImagesInPlace preserves current sort modes", () => {
    const newest = [
        { name: "b.png", date_modified: 2 },
        { name: "a.png", date_modified: 3 },
        { name: "c.png", date_modified: 1 },
    ];
    assert.deepEqual(sortImagesInPlace(newest, "newest").map((item) => item.name), ["a.png", "b.png", "c.png"]);
    assert.deepEqual(sortImagesInPlace(newest, "oldest").map((item) => item.name), ["c.png", "b.png", "a.png"]);
    assert.deepEqual(sortImagesInPlace(newest, "name A-Z").map((item) => item.name), ["a.png", "b.png", "c.png"]);
    assert.deepEqual(sortImagesInPlace(newest, "name Z-A").map((item) => item.name), ["c.png", "b.png", "a.png"]);
});

test("legacy and Vue sizing helpers keep current height floors", () => {
    const node = { size: [460, 480] };
    assert.equal(getSelectorWidgetHeight(node, 46), 434);
    assert.equal(getSelectorWidgetHeight({ size: [460, 100] }, 46), 420);

    const nodeEl = {
        style: {
            getPropertyValue(name) {
                return name === "--node-height" ? "600px" : "";
            },
        },
    };
    const domWidget = { element: { closest: () => nodeEl } };
    assert.equal(getVueSelectorWidgetHeight({
        node,
        domWidget,
        window: { LiteGraph: { NODE_TITLE_HEIGHT: 30 } },
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
    }), 404);
    assert.equal(getVueSelectorVisualHeight({
        node,
        domWidget,
        window: { LiteGraph: { NODE_TITLE_HEIGHT: 30 } },
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
    }), 494);

    assert.equal(getVueSelectorWidgetHeight({
        node,
        domWidget: { element: { closest: () => null } },
        window: {},
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
    }), 404);
});

test("hide mode helpers store outputs for node and graph preview keys", () => {
    const app = {};
    const output = { images: [{ filename: "preview.mp4" }], animated: [true] };
    const node = { id: 12, graph: { id: "subgraph", isRootGraph: false } };

    assert.deepEqual(previewKeysForNode(node), ["12", "subgraph:12"]);

    storeOutputForPreviewKeys(app, node, output);

    assert.equal(app.nodeOutputs["12"], output);
    assert.equal(app.nodeOutputs["subgraph:12"], output);
});

test("hide mode helpers prime native preview execution then restore hidden state", () => {
    const node = { hideOutputImages: true };
    let observedDuringExecution = null;

    const result = runWithPreviewPriming(node, () => {
        observedDuringExecution = node.hideOutputImages;
        return "created";
    });

    assert.equal(result, "created");
    assert.equal(observedDuringExecution, false);
    assert.equal(node.hideOutputImages, true);
});

test("hide mode helpers remove temporary hidden state when none existed", () => {
    const node = {};

    runWithPreviewPriming(node, () => {
        assert.equal(node.hideOutputImages, false);
    });

    assert.equal(Object.hasOwn(node, "hideOutputImages"), false);
});

test("layout controller does not expose size callbacks during ambiguous Vue mount", () => {
    let mountedNodeEl = null;
    let cssNodeHeight = 720;
    const containerEl = { style: {} };
    const parentEl = {
        style: {},
        getBoundingClientRect() {
            return { width: 300 };
        },
    };
    const element = {
        style: {},
        parentElement: parentEl,
        closest(selector) {
            return selector === ".lg-node" ? mountedNodeEl : null;
        },
        querySelector(selector) {
            if (selector !== ".helto-selector-container") return null;
            return containerEl;
        },
    };
    const domWidget = {
        element,
        computeLayoutSize: () => ({ minHeight: 420 }),
        computeSize: () => [460, 420],
    };
    const node = {
        size: [460, 480],
        widgets: [domWidget],
        setDirtyCanvas() {},
    };
    const frames = [];
    const controller = createSelectorLayoutController({
        app: appWithSettings({}),
        node,
        domWidget,
        scheduleVisibleThumbnailLoad() {},
        document: documentWithVueNode(false),
        window: { LiteGraph: { NODE_TITLE_HEIGHT: 30 } },
        requestAnimationFrame(callback) {
            frames.push(callback);
        },
        ResizeObserver: class {
            observe() {}
            disconnect() {}
        },
        setTimeout(callback) {
            callback();
        },
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
    });

    controller.initializeDomWidgetLayout();
    assert.equal(domWidget.computeLayoutSize, undefined);
    assert.equal(domWidget.computeSize, undefined);

    mountedNodeEl = {
        style: {
            getPropertyValue(name) {
                return name === "--node-height" ? `${cssNodeHeight}px` : "";
            },
        },
    };

    frames.shift()?.();
    controller.syncVueSelectorWidgetHeight();

    assert.equal(domWidget.computeLayoutSize, undefined);
    assert.equal(domWidget.computeSize, undefined);
    assert.equal(element.style.height, "404px");
    assert.equal(element.style.minHeight, "404px");
    assert.equal(element.style.maxHeight, "404px");
    assert.equal(element.style.overflow, "visible");
    assert.equal(parentEl.style.overflow, "visible");
    assert.equal(containerEl.style.position, "absolute");
    assert.equal(containerEl.style.height, "598px");

    cssNodeHeight = 900;
    controller.syncVueSelectorWidgetHeight();

    assert.equal(element.style.height, "404px");
    assert.equal(containerEl.style.height, "778px");
});

test("prompt enhancer seed buttons update seed widget", () => {
    const callbacks = [];
    const node = {
        widgets: [
            {
                name: "seed",
                value: 5,
                callback(value) {
                    callbacks.push(value);
                },
            },
        ],
    };

    assert.equal(setGenerateNewEachPrompt(node), -1);
    assert.equal(node.widgets[0].value, -1);

    assert.equal(setNewFixedPromptSeed(node, () => 0.5), 1073741823);
    assert.equal(node.widgets[0].value, 1073741823);
    assert.deepEqual(callbacks, [-1, 1073741823]);
});

test("prompt enhancer settings read and write serialized widgets", () => {
    const node = {
        widgets: [
            { name: "hide_mode", value: false },
            { name: "privacy_mode", value: true },
            { name: "ollama_url", value: "http://127.0.0.1:11434" },
            { name: "ollama_keep_alive", value: 5 },
            { name: "ollama_keep_alive_unit", value: "minutes" },
            { name: "ollama_timeout", value: 120 },
        ],
    };

    writePromptEnhancerSettings(node, {
        hideMode: true,
        privacyMode: false,
        ollamaUrl: "http://localhost:11434",
        keepAlive: 2,
        keepAliveUnit: "hours",
        timeout: 45,
    });

    assert.deepEqual(readPromptEnhancerSettings(node), {
        hideMode: true,
        privacyMode: false,
        ollamaUrl: "http://localhost:11434",
        keepAlive: 2,
        keepAliveUnit: "hours",
        timeout: 45,
    });
});

test("prompt enhancer model options update keeps existing value when possible", () => {
    const modelWidget = { value: "b", options: { values: ["a"] } };

    assert.equal(updateModelOptions(modelWidget, ["b", "c"]), true);
    assert.equal(modelWidget.value, "b");
    assert.deepEqual(modelWidget.options.values, ["b", "c"]);

    assert.equal(updateModelOptions(modelWidget, ["c", "d"]), true);
    assert.equal(modelWidget.value, "c");
});

test("prompt enhancer hides serialized settings widgets", () => {
    const node = {
        widgets: [
            { name: "hide_mode" },
            { name: "privacy_mode" },
            { name: "prompt" },
        ],
    };
    const collapsed = [];

    hideSerializedSettingsWidgets(node, (widget) => collapsed.push(widget.name));

    assert.equal(node.widgets[0].hidden, true);
    assert.equal(node.widgets[0].type, "hidden");
    assert.equal(node.widgets[1].hidden, true);
    assert.equal(node.widgets[2].hidden, undefined);
    assert.deepEqual(collapsed, ["hide_mode", "privacy_mode"]);
});

test("legacy sizing stays static instead of deriving from current node height", () => {
    const nativeWidgetProto = {
        computeLayoutSize() {
            return { minHeight: 404, maxHeight: 404, minWidth: 0 };
        },
    };
    const element = {
        style: {},
        parentElement: {
            style: {},
            getBoundingClientRect() {
                return { width: 300 };
            },
        },
        closest() {
            return null;
        },
        querySelector(selector) {
            if (selector !== ".helto-selector-container") return null;
            return { style: {} };
        },
    };
    const domWidget = Object.assign(Object.create(nativeWidgetProto), { element });
    domWidget.computeLayoutSize = undefined;
    domWidget.computeSize = undefined;
    const node = {
        size: [460, 480],
        widgets: [domWidget],
        setDirtyCanvas() {},
    };
    const controller = createSelectorLayoutController({
        app: appWithSettings({ "Comfy.Graph.Renderer": "LiteGraph Canvas" }),
        node,
        domWidget,
        scheduleVisibleThumbnailLoad() {},
        document: documentWithVueNode(false),
        window: { LiteGraph: { NODE_TITLE_HEIGHT: 30 } },
        requestAnimationFrame() {},
        ResizeObserver: class {
            observe() {}
            disconnect() {}
        },
        setTimeout(callback) {
            callback();
        },
    });

    controller.initializeDomWidgetLayout();
    controller.installNodeResizeHooks();

    assert.equal(domWidget.computeLayoutSize, nativeWidgetProto.computeLayoutSize);
    assert.equal(domWidget.computeSize, undefined);
    assert.deepEqual(node.computeSize(), [460, 480]);

    node.size = [460, 1200];
    assert.deepEqual(node.computeSize(), [460, 480]);
});
