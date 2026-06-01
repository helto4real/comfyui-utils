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
    acceptPromptAutocompleteSuggestion,
    addPromptVariable,
    autocompleteStateForPrompt,
    decryptPromptText,
    emptyAutocompleteState,
    insertVariableSuggestion,
    fetchSystemPrompt,
    hideSerializedSettingsWidgets,
    isEncryptedText,
    isEncryptedVariables,
    isPointInPromptWidget,
    isPromptHideModeEnabled,
    modelOptionsForProvider,
    modelOptionsWithCurrentValue,
    moveAutocompleteSelection,
    normalizeProviderCatalog,
    normalizePromptVariables,
    parsePromptVariablesJson,
    promptEditorLayout,
    promptWidgetBounds,
    readProviderModelHistory,
    readPromptEnhancerModelConfig,
    readPromptText,
    readPromptVariables,
    readPromptEnhancerSettings,
    resetSystemPrompt,
    saveSystemPrompt,
    serializedPromptVariablesValue,
    serializePromptVariables,
    setGenerateNewEachPrompt,
    setNewFixedPromptSeed,
    seedProviderModelHistory,
    shouldRefreshPromptVariables,
    shouldHidePromptWidget,
    promptAutocompleteShortcutAction,
    updatePromptVariable,
    updateModelOptions,
    updateProviderModelOptions,
    writeProviderModelHistory,
    writePromptEnhancerModelConfig,
    writePromptText,
    writePromptVariables,
    writePromptEnhancerSettings,
} from "../../web/prompt_enhancer_helpers.js";
import {
    PRIVACY_SHOW_ANY_STATE_WIDGET,
    configurePrivacyShowAnyTextarea,
    decryptTextState,
    encryptTextState,
    extractPrivacyShowAnyText,
    getPrivacyShowAnyTextAreaHeight,
    getPrivacyShowAnyWidgetHeight,
    getPrivacyShowAnyWidgetStartY,
    getVuePrivacyShowAnyLayoutHeight,
    getVuePrivacyShowAnyVisualHeight,
    hidePrivacyShowAnyStateWidget,
    isEncryptedText as isPrivacyEncryptedText,
    serializedEncryptedWidgetValue,
} from "../../web/privacy_show_any_helpers.js";

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

function jsonResponse(payload, ok = true) {
    return {
        ok,
        async json() {
            return payload;
        },
    };
}

test("renderer detection uses Vue enabled setting when renderer name is missing", () => {
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
        app: appWithSettings({
            "Comfy.Graph.Renderer": "LiteGraph Canvas",
            "Comfy.VueNodes.Enabled": true,
        }),
        document: documentWithVueNode(true),
        window: {},
    }), true);
    assert.equal(getCanvasRendererLayoutMode({
        app: appWithSettings({
            "Comfy.Graph.Renderer": "LiteGraph Canvas",
            "Comfy.VueNodes.Enabled": true,
        }),
        document: documentWithVueNode(true),
        window: {},
    }), "legacy");

    assert.equal(isLegacyCanvasRenderer({
        app: appWithSettings({
            "Comfy.Graph.Renderer": "Nodes 2.0",
            "Comfy.VueNodes.Enabled": false,
        }),
        document: documentWithVueNode(false),
        window: { LiteGraph: {} },
    }), false);
    assert.equal(getCanvasRendererLayoutMode({
        app: appWithSettings({
            "Comfy.Graph.Renderer": "Nodes 2.0",
            "Comfy.VueNodes.Enabled": false,
        }),
        document: documentWithVueNode(false),
        window: { LiteGraph: {} },
    }), "vue");
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
        keepAliveUnit: "seconds",
        timeout: 45,
    });

    assert.deepEqual(readPromptEnhancerSettings(node), {
        hideMode: true,
        privacyMode: false,
        ollamaUrl: "http://localhost:11434",
        keepAlive: 2,
        keepAliveUnit: "seconds",
        timeout: 45,
    });
});

test("prompt enhancer model selector mirrors hidden serialized model", () => {
    const callbacks = [];
    const modelWidget = {
        value: "custom:latest",
        callback(value) {
            callbacks.push(value);
        },
    };
    const selectorWidget = { value: "", options: { values: [] } };

    assert.deepEqual(modelOptionsWithCurrentValue(modelWidget, ["b", "c"]), ["custom:latest", "b", "c"]);
    assert.equal(updateModelOptions(selectorWidget, modelWidget, ["b", "c"]), true);
    assert.equal(modelWidget.value, "custom:latest");
    assert.equal(selectorWidget.value, "custom:latest");
    assert.deepEqual(selectorWidget.options.values, ["custom:latest", "b", "c"]);
    assert.deepEqual(callbacks, []);

    modelWidget.value = "";
    assert.equal(updateModelOptions(selectorWidget, modelWidget, ["c", "d"]), true);
    assert.equal(modelWidget.value, "c");
    assert.equal(selectorWidget.value, "c");
    assert.deepEqual(callbacks, ["c"]);
});

test("prompt enhancer provider model selector writes hidden provider fields", () => {
    const node = {
        widgets: [
            { name: "provider", value: "ollama" },
            { name: "model_id", value: "llava:latest" },
            { name: "model_backend", value: "ollama" },
            { name: "provider_model_history", value: "{}" },
            { name: "model", value: "llava:latest" },
        ],
    };
    const catalog = normalizeProviderCatalog({
        providers: [
            { id: "ollama", label: "Ollama" },
            { id: "local_transformers_vlm", label: "Local Transformers VLM" },
        ],
        models: [
            { provider: "ollama", model_id: "llava:latest", backend: "ollama" },
            { provider: "local_transformers_vlm", model_id: "qwen3_vl_4b_fast", backend: "qwen" },
        ],
    });
    const providerSelector = { value: "local_transformers_vlm", options: { values: [] } };
    const modelSelector = { value: "", options: { values: [] } };

    assert.deepEqual(modelOptionsForProvider(catalog, "local_transformers_vlm"), ["qwen3_vl_4b_fast"]);
    assert.equal(updateProviderModelOptions(providerSelector, modelSelector, node, catalog), true);
    assert.deepEqual(readPromptEnhancerModelConfig(node), {
        provider: "local_transformers_vlm",
        modelId: "qwen3_vl_4b_fast",
        modelBackend: "qwen",
        legacyModel: "qwen3_vl_4b_fast",
    });
    assert.deepEqual(readProviderModelHistory(node), {
        ollama: { modelId: "llava:latest", modelBackend: "ollama" },
        local_transformers_vlm: { modelId: "qwen3_vl_4b_fast", modelBackend: "qwen" },
    });
    assert.deepEqual(providerSelector.options.values, ["ollama", "local_transformers_vlm"]);
    assert.deepEqual(modelSelector.options.values, ["qwen3_vl_4b_fast"]);
});

test("prompt enhancer provider model history reads writes and seeds current workflow model", () => {
    const node = {
        widgets: [
            { name: "provider", value: "ollama" },
            { name: "model_id", value: "llava:latest" },
            { name: "model_backend", value: "ollama" },
            { name: "provider_model_history", value: "{\"bad\":true}" },
            { name: "model", value: "llava:latest" },
        ],
    };

    assert.deepEqual(readProviderModelHistory(node), {});
    assert.deepEqual(seedProviderModelHistory(node), {
        ollama: { modelId: "llava:latest", modelBackend: "ollama" },
    });
    assert.deepEqual(writeProviderModelHistory(node, {
        ollama: { modelId: "mistral:latest", modelBackend: "ollama" },
        local_transformers_vlm: { model_id: "qwen3_vl_4b_fast", backend: "qwen" },
        empty: { modelId: "" },
    }), {
        ollama: { modelId: "mistral:latest", modelBackend: "ollama" },
        local_transformers_vlm: { modelId: "qwen3_vl_4b_fast", modelBackend: "qwen" },
    });
});

test("prompt enhancer provider switch restores remembered model and falls back when unavailable", () => {
    const node = {
        widgets: [
            { name: "provider", value: "ollama" },
            { name: "model_id", value: "llava:latest" },
            { name: "model_backend", value: "ollama" },
            {
                name: "provider_model_history",
                value: JSON.stringify({
                    ollama: { modelId: "llava:latest", modelBackend: "ollama" },
                    local_transformers_vlm: { modelId: "qwen3_vl_8b_quality", modelBackend: "qwen" },
                }),
            },
            { name: "model", value: "llava:latest" },
        ],
    };
    const catalog = normalizeProviderCatalog({
        providers: [
            { id: "ollama", label: "Ollama" },
            { id: "local_transformers_vlm", label: "Local Transformers VLM" },
        ],
        models: [
            { provider: "ollama", model_id: "llava:latest", backend: "ollama" },
            { provider: "local_transformers_vlm", model_id: "qwen3_vl_4b_fast", backend: "qwen" },
            { provider: "local_transformers_vlm", model_id: "qwen3_vl_8b_quality", backend: "qwen" },
        ],
    });
    const providerSelector = { value: "local_transformers_vlm", options: { values: [] } };
    const modelSelector = { value: "", options: { values: [] } };

    assert.equal(updateProviderModelOptions(providerSelector, modelSelector, node, catalog), true);
    assert.equal(modelSelector.value, "qwen3_vl_8b_quality");
    assert.deepEqual(readPromptEnhancerModelConfig(node), {
        provider: "local_transformers_vlm",
        modelId: "qwen3_vl_8b_quality",
        modelBackend: "qwen",
        legacyModel: "qwen3_vl_8b_quality",
    });

    writeProviderModelHistory(node, {
        ollama: { modelId: "llava:latest", modelBackend: "ollama" },
        local_transformers_vlm: { modelId: "missing_model", modelBackend: "qwen" },
    });
    assert.equal(updateProviderModelOptions(providerSelector, modelSelector, node, catalog), true);
    assert.equal(modelSelector.value, "qwen3_vl_4b_fast");
    assert.deepEqual(readProviderModelHistory(node).local_transformers_vlm, {
        modelId: "qwen3_vl_4b_fast",
        modelBackend: "qwen",
    });
});

test("prompt enhancer hide mode calculates prompt widget hover state", () => {
    const node = {
        size: [420, 500],
        widgets: [
            { name: "hide_mode", value: true },
            { name: "script", last_y: 120, computedHeight: 96 },
        ],
    };

    assert.equal(isPromptHideModeEnabled(node), true);
    assert.deepEqual(promptWidgetBounds(node), {
        x: 0,
        y: 120,
        width: 420,
        height: 96,
    });
    assert.equal(isPointInPromptWidget(node, [30, 140]), true);
    assert.equal(isPointInPromptWidget(node, [30, 230]), false);
    assert.equal(shouldHidePromptWidget(node, false), true);
    assert.equal(shouldHidePromptWidget(node, true), false);

    node.widgets[0].value = false;
    assert.equal(shouldHidePromptWidget(node, false), false);
});

test("prompt enhancer editor layout constrains textarea inside node width", () => {
    assert.deepEqual(promptEditorLayout({ size: [420, 500] }), {
        width: 396,
        height: 180,
        textareaWidth: 384,
        textareaHeight: 168,
    });
    assert.deepEqual(promptEditorLayout({ size: [120, 500] }), {
        width: 96,
        height: 180,
        textareaWidth: 84,
        textareaHeight: 168,
    });
});

test("prompt enhancer prompt bounds fall back to widget compute size", () => {
    const node = {
        size: [360, 400],
        widgets: [
            {
                name: "script",
                last_y: 64,
                computeSize(width) {
                    return [width, 144];
                },
            },
        ],
    };

    assert.deepEqual(promptWidgetBounds(node), {
        x: 0,
        y: 64,
        width: 360,
        height: 144,
    });
});

test("prompt enhancer system prompt helpers fetch save and reset prompts", async () => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url, options });
        if (url.startsWith("/helto_prompt_enhancer/system_prompt?")) {
            return jsonResponse({
                kind: "image",
                prompt: "active",
                default_prompt: "default",
                is_default: false,
            });
        }
        if (url === "/helto_prompt_enhancer/system_prompt") {
            return jsonResponse({
                kind: "image",
                prompt: JSON.parse(options.body).prompt,
                default_prompt: "default",
                is_default: false,
            });
        }
        if (url === "/helto_prompt_enhancer/system_prompt/reset") {
            return jsonResponse({
                kind: "image",
                prompt: "default",
                default_prompt: "default",
                is_default: true,
            });
        }
        return jsonResponse({ error: "unexpected" }, false);
    };

    assert.deepEqual(await fetchSystemPrompt("image", fetchImpl), {
        kind: "image",
        prompt: "active",
        default_prompt: "default",
        is_default: false,
    });
    assert.deepEqual(await saveSystemPrompt("image", "edited", fetchImpl), {
        kind: "image",
        prompt: "edited",
        default_prompt: "default",
        is_default: false,
    });
    assert.deepEqual(await resetSystemPrompt("image", fetchImpl), {
        kind: "image",
        prompt: "default",
        default_prompt: "default",
        is_default: true,
    });

    assert.equal(calls[0].url, "/helto_prompt_enhancer/system_prompt?kind=image");
    assert.equal(calls[1].url, "/helto_prompt_enhancer/system_prompt");
    assert.equal(calls[1].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[1].options.body), { kind: "image", prompt: "edited" });
    assert.equal(calls[2].url, "/helto_prompt_enhancer/system_prompt/reset");
    assert.deepEqual(JSON.parse(calls[2].options.body), { kind: "image" });
});

test("prompt enhancer hides serialized model and settings widgets", () => {
    const node = {
        widgets: [
            { name: "provider" },
            { name: "model_id" },
            { name: "model_backend" },
            { name: "provider_model_history" },
            { name: "model" },
            { name: "hide_mode" },
            { name: "privacy_mode" },
            { name: "script" },
            { name: "variables" },
        ],
    };
    const collapsed = [];

    hideSerializedSettingsWidgets(node, (widget) => collapsed.push(widget.name));

    assert.equal(node.widgets[0].hidden, true);
    assert.equal(node.widgets[0].type, "hidden");
    assert.equal(node.widgets[1].hidden, true);
    assert.equal(node.widgets[2].hidden, true);
    assert.equal(node.widgets[3].hidden, true);
    assert.equal(node.widgets[4].hidden, true);
    assert.equal(node.widgets[5].hidden, true);
    assert.equal(node.widgets[6].hidden, true);
    assert.equal(node.widgets[7].hidden, true);
    assert.equal(node.widgets[8].hidden, true);
    assert.deepEqual(collapsed, [
        "provider",
        "model_id",
        "model_backend",
        "provider_model_history",
        "model",
        "script",
        "variables",
        "hide_mode",
        "privacy_mode",
    ]);
});

test("prompt enhancer variable helpers parse update and serialize configs", () => {
    const variables = normalizePromptVariables([
        { name: "style", mode: "fixed", values: ["cinematic", "documentary"], fixed_index: 8 },
        { name: "bad-name", values: ["ignored"] },
    ]);

    assert.deepEqual(variables, [
        { name: "style", mode: "fixed", values: ["cinematic", "documentary"], fixed_index: 1 },
    ]);
    assert.deepEqual(parsePromptVariablesJson(serializePromptVariables(variables)), variables);

    const added = addPromptVariable(variables, "style");
    assert.equal(added[1].name, "style_2");
    const updated = updatePromptVariable(added, 1, { name: "lighting", values: ["soft"] });
    assert.deepEqual(updated[1], { name: "lighting", mode: "random", values: ["soft"], fixed_index: 0 });
});

test("prompt enhancer variable config encrypts only when privacy mode is enabled", async () => {
    const selectorApi = {
        async encrypt(text) {
            return { encrypted: `__HELTO_ENC__:${Buffer.from(text).toString("base64")}` };
        },
        async decrypt(encrypted) {
            return { data: Buffer.from(encrypted.slice("__HELTO_ENC__:".length), "base64").toString("utf8") };
        },
    };
    const node = {
        widgets: [
            { name: "variables", value: "[]" },
        ],
    };
    const variables = [{ name: "style", mode: "fixed", values: ["cinematic"], fixed_index: 0 }];

    const encrypted = await writePromptVariables(node, variables, true, selectorApi);

    assert.equal(isEncryptedVariables(encrypted), true);
    assert.deepEqual(await readPromptVariables(node, selectorApi), variables);

    const plain = await writePromptVariables(node, variables, false, selectorApi);

    assert.equal(isEncryptedVariables(plain), false);
    assert.deepEqual(JSON.parse(plain), variables);
});

test("prompt enhancer prompt config encrypts only when privacy mode is enabled", async () => {
    let resolveEncryption;
    const selectorApi = {
        async encrypt(text) {
            if (text === "pending secret") {
                await new Promise((resolve) => {
                    resolveEncryption = resolve;
                });
            }
            return { encrypted: `__HELTO_ENC__:${Buffer.from(text).toString("base64")}` };
        },
        async decrypt(encrypted) {
            return { data: Buffer.from(encrypted.slice("__HELTO_ENC__:".length), "base64").toString("utf8") };
        },
    };
    const node = {
        widgets: [
            { name: "script", value: "" },
        ],
    };
    const secret = "secret phrase for workflow search";

    const encrypted = await writePromptText(node, secret, true, selectorApi);

    assert.equal(isEncryptedText(encrypted), true);
    assert.equal(node.widgets[0].value.includes(secret), false);
    assert.equal(JSON.stringify([node.widgets[0].value]).includes(secret), false);
    assert.equal(await readPromptText(node, selectorApi), secret);
    assert.equal(await decryptPromptText("__HELTO_ENC__:bad", { decrypt: async () => ({ data: "[]" }) }), "");

    const plain = await writePromptText(node, secret, false, selectorApi);

    assert.equal(plain, secret);
    assert.equal(node.widgets[0].value, secret);

    node.widgets[0].value = "pending secret";
    const pending = writePromptText(node, "pending secret", true, selectorApi);

    assert.equal(node.widgets[0].value, "");
    resolveEncryption();
    assert.equal(isEncryptedText(await pending), true);
});

test("prompt enhancer detects serialized variable widget changes for autocomplete refresh", () => {
    const node = {
        widgets: [
            { name: "variables", value: "[]" },
        ],
    };

    assert.equal(serializedPromptVariablesValue(node), "[]");
    assert.equal(shouldRefreshPromptVariables(node, null), true);
    assert.equal(shouldRefreshPromptVariables(node, "[]"), false);

    node.widgets[0].value = serializePromptVariables([{ name: "style", values: ["cinematic"] }]);

    assert.equal(shouldRefreshPromptVariables(node, "[]"), true);
    assert.deepEqual(
        autocompleteStateForPrompt("{{", 2, parsePromptVariablesJson(serializedPromptVariablesValue(node))).options,
        ["style"],
    );
});

test("prompt enhancer autocomplete filters navigates and inserts variables", () => {
    const variables = [
        { name: "style", values: ["cinematic"] },
        { name: "subject", values: ["forest"] },
        { name: "lighting", values: ["soft"] },
    ];

    let state = autocompleteStateForPrompt("A {{s", 5, variables);

    assert.equal(state.active, true);
    assert.deepEqual(state.options, ["style", "subject"]);
    assert.equal(moveAutocompleteSelection(state, 1), 1);

    state = { ...state, selectedIndex: 1 };
    assert.deepEqual(insertVariableSuggestion("A {{s", state), {
        text: "A {{subject}}",
        cursor: 13,
    });
    assert.equal(autocompleteStateForPrompt("A {{style}}", 11, variables).active, false);
});

test("prompt enhancer video script autocomplete suggests metadata images and roles", () => {
    const context = { promptType: "video", imageCount: 3 };

    let state = autocompleteStateForPrompt("[ref", 4, [], 0, context);
    assert.equal(state.active, true);
    assert.deepEqual(state.options, ["reference_mode="]);
    assert.deepEqual(insertVariableSuggestion("[ref", state), {
        text: "[reference_mode=",
        cursor: 16,
    });

    state = autocompleteStateForPrompt("[reference_mode=st", 18, [], 0, context);
    assert.deepEqual(state.options, ["start_frame", "start_and_end_transition", "style_reference"]);
    assert.deepEqual(insertVariableSuggestion("[reference_mode=st", state), {
        text: "[reference_mode=start_frame]",
        cursor: 28,
    });

    state = autocompleteStateForPrompt("Look @", 6, [], 0, context);
    assert.deepEqual(state.options, ["@image1", "@image2", "@image3"]);
    assert.deepEqual(insertVariableSuggestion("Look @", state, "@image2"), {
        text: "Look @image2",
        cursor: 12,
    });

    state = autocompleteStateForPrompt("@image1:ch", 10, [], 0, context);
    assert.deepEqual(state.options, ["character"]);
    assert.deepEqual(insertVariableSuggestion("@image1:ch", state), {
        text: "@image1:character",
        cursor: 17,
    });

    state = autocompleteStateForPrompt(">>", 2, [], 0, context);
    assert.equal(state.active, true);
    assert.deepEqual(insertVariableSuggestion(">>", state), {
        text: ">> ",
        cursor: 3,
    });
});

test("prompt enhancer autocomplete shortcuts consume only active intellisense keys", () => {
    const active = autocompleteStateForPrompt("[", 1, [], 0, { promptType: "video" });
    const consumed = [];
    const event = {
        key: "Escape",
        preventDefault: () => consumed.push("prevent"),
        stopPropagation: () => consumed.push("stop"),
        stopImmediatePropagation: () => consumed.push("stop-immediate"),
    };

    assert.equal(promptAutocompleteShortcutAction(event, active), "close");
    assert.deepEqual(consumed, ["prevent", "stop", "stop-immediate"]);
    assert.equal(promptAutocompleteShortcutAction({ key: "Escape" }, emptyAutocompleteState(1)), "");
    assert.equal(promptAutocompleteShortcutAction({ key: "c", ctrlKey: true }, active), "");
});

test("prompt enhancer autocomplete shortcuts accept navigate and preserve browser text shortcuts", () => {
    const state = autocompleteStateForPrompt("{{", 2, [{ name: "style", values: ["cinematic"] }]);
    const calls = [];
    const ctrlY = {
        key: "y",
        ctrlKey: true,
        preventDefault: () => calls.push("prevent"),
        stopPropagation: () => calls.push("stop"),
    };

    assert.equal(promptAutocompleteShortcutAction(ctrlY, state), "accept");
    assert.deepEqual(calls, ["prevent", "stop"]);
    assert.equal(promptAutocompleteShortcutAction({ key: "n", ctrlKey: true }, state), "next");
    assert.equal(promptAutocompleteShortcutAction({ key: "p", ctrlKey: true }, state), "previous");
    assert.equal(promptAutocompleteShortcutAction({ key: "a", ctrlKey: true }, state), "");
    assert.equal(promptAutocompleteShortcutAction({ key: "v", ctrlKey: true }, state), "");
    assert.equal(promptAutocompleteShortcutAction({ key: "z", ctrlKey: true }, state), "");
});

test("prompt enhancer autocomplete accept closes or continues to immediate follow-up suggestions", () => {
    const variables = [{ name: "style", values: ["cinematic"] }];
    let state = autocompleteStateForPrompt("{{st", 4, variables, 0, { promptType: "video" });
    let accepted = acceptPromptAutocompleteSuggestion("{{st", state, variables, { promptType: "video" });

    assert.equal(accepted.text, "{{style}}");
    assert.equal(accepted.cursor, 9);
    assert.equal(accepted.autocomplete.active, false);

    state = autocompleteStateForPrompt("[ref", 4, [], 0, { promptType: "video" });
    accepted = acceptPromptAutocompleteSuggestion("[ref", state, [], { promptType: "video" });

    assert.equal(accepted.text, "[reference_mode=");
    assert.equal(accepted.cursor, 16);
    assert.equal(accepted.autocomplete.active, true);
    assert.equal(accepted.autocomplete.kind, "metadata_value");
    assert.deepEqual(accepted.autocomplete.options, [
        "none",
        "start_frame",
        "end_guidance",
        "start_and_end_transition",
        "character_reference",
        "style_reference",
        "mixed",
    ]);

    state = autocompleteStateForPrompt("[reference_mode=st", 18, [], 0, { promptType: "video" });
    accepted = acceptPromptAutocompleteSuggestion("[reference_mode=st", state, [], { promptType: "video" });

    assert.equal(accepted.text, "[reference_mode=start_frame]");
    assert.equal(accepted.autocomplete.active, false);
});

test("privacy show any extracts output text and hides encrypted state widget", () => {
    const output = { helto_privacy_show_any: [{ text: "secret text" }] };
    const node = {
        widgets: [
            { name: PRIVACY_SHOW_ANY_STATE_WIDGET, value: "__HELTO_ENC__:abc" },
            { name: "other" },
        ],
    };
    const collapsed = [];

    const widget = hidePrivacyShowAnyStateWidget(node, (item) => collapsed.push(item.name));

    assert.equal(extractPrivacyShowAnyText(output), "secret text");
    assert.equal(widget.hidden, true);
    assert.equal(widget.type, "hidden");
    assert.deepEqual(collapsed, [PRIVACY_SHOW_ANY_STATE_WIDGET]);
});

test("privacy show any serializes only encrypted text state", async () => {
    const selectorApi = {
        async encrypt(text) {
            return { encrypted: `__HELTO_ENC__:${Buffer.from(text).toString("base64")}` };
        },
        async decrypt(encrypted) {
            return { data: Buffer.from(encrypted.slice("__HELTO_ENC__:".length), "base64").toString("utf8") };
        },
    };

    const encrypted = await encryptTextState("private", selectorApi);

    assert.equal(isPrivacyEncryptedText(encrypted), true);
    assert.equal(await decryptTextState(encrypted, selectorApi), "private");
    assert.equal(serializedEncryptedWidgetValue({ value: encrypted }), encrypted);
    assert.equal(serializedEncryptedWidgetValue({ value: "private" }), "");
    assert.equal(await encryptTextState("private", { encrypt: async () => ({ encrypted: "private" }) }), "");
});

test("privacy show any textarea defaults to read-only multiline wrapping", () => {
    const textarea = {};

    configurePrivacyShowAnyTextarea(textarea);

    assert.equal(textarea.readOnly, true);
    assert.equal(textarea.wrap, "soft");
    assert.equal(textarea.spellcheck, false);
});

test("privacy show any sizing fills remaining node body with a floor", () => {
    const domWidget = { y: 84 };
    const node = {
        size: [740, 680],
        widgets: [
            { name: "seed", y: 42, height: 24 },
            domWidget,
        ],
    };

    assert.equal(getPrivacyShowAnyWidgetStartY(node, domWidget), 84);
    assert.equal(getPrivacyShowAnyWidgetHeight(node, 84), 584);
    assert.equal(getPrivacyShowAnyWidgetHeight({ size: [360, 140] }, 84), 160);
});

test("privacy show any textarea height fills widget body with a floor", () => {
    assert.equal(getPrivacyShowAnyTextAreaHeight(584, 30), 530);
    assert.equal(getPrivacyShowAnyTextAreaHeight(96, 30), 80);
});

test("privacy show any vue visual height follows explicit node height", () => {
    let cssNodeHeight = 620;
    const nodeEl = {
        style: {
            getPropertyValue(name) {
                return name === "--node-height" ? `${cssNodeHeight}px` : "";
            },
        },
    };
    const domWidget = { element: { closest: () => nodeEl } };

    assert.equal(getVuePrivacyShowAnyVisualHeight({ size: [360, 300] }, domWidget), 544);
    assert.equal(getVuePrivacyShowAnyLayoutHeight(), 220);

    cssNodeHeight = 360;
    assert.equal(getVuePrivacyShowAnyVisualHeight({ size: [360, 300] }, domWidget), 284);
    assert.equal(getVuePrivacyShowAnyLayoutHeight(), 220);
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
