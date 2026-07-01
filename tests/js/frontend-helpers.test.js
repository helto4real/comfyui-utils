import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    selectorApi,
    selectorImageVersionToken,
} from "../../web/api.js";
import {
    renderSelectorEmptyState,
} from "../../web/dom.js";
import {
    createSelectorLayoutController,
    getCanvasRendererLayoutMode,
    getSelectorWidgetHeight,
    getVueSelectorWidgetHeight,
    getVueSelectorVisualHeight,
    isLegacyCanvasRenderer,
} from "../../web/layout.js";
import {
    AFFECTED_MASK_VALUE,
    bboxFromPoints,
    createOverlayScheduler,
    displayBrushSizeToMaskSize,
    displayBrushSizeToPreviewSize,
    displayPointToPreviewPoint,
    displaySizeForZoomMode,
    fitDisplaySize,
    maskImageDataIsUnaffected,
    maskOverlayPixel,
    normalizeBbox,
    nextZoomMode,
    parsePreviewColor,
    previewPointToMaskPoint,
    previewScaleForSize,
    UNAFFECTED_MASK_VALUE,
    ZOOM_MODE_ACTUAL,
    ZOOM_MODE_FIT,
} from "../../web/mask_editor.js";
import {
    getFolderLabel,
    getFolderPath,
    getRootFolderFilterLabel,
    getRootFolderOptions,
    getSubfolderFilterLabel,
    getSubfolderOptions,
    applyEditedBboxSaveResult,
    applyEditedMaskSaveResult,
    buildPastedImageFilename,
    coerceSelectorBoolean,
    filterSelectorImages,
    firstClipboardImageFile,
    initializeSelectorProperties,
    isSameOrChildPath,
    normalizeFilterPath,
    normalizeFolderPath,
    resolveSelectorPasteDestination,
    sortImagesInPlace,
    uniqueFolderPaths,
} from "../../web/state.js";
import {
    expandNodeToComputedSize,
    previewKeysForNode,
    restoreNodeSize,
    runWithPreviewPriming,
    scheduleNodeSizeRestore,
    storeOutputForPreviewKeys,
} from "../../web/hide_mode_helpers.js";
import {
    buildPauseResumePrompt,
    dependencyNodeIdsForPromptOutput,
    downstreamNodeIdsFromOutput,
    queueFilteredPrompt,
    restoreSerializedWidgetValues,
    sanitizeSerializedWidgetValues,
    serializedWidgetValueMap,
    serializedWidgetValues,
} from "../../web/pause_control_helpers.js";
import {
    acceptPromptAutocompleteSuggestion,
    addPromptVariable,
    autocompleteStateForPrompt,
    decryptPromptText,
    dismissPromptAutocompleteUntilInput,
    emptyAutocompleteState,
    insertVariableSuggestion,
    deleteSystemPromptPreset,
    fetchSystemPrompt,
    fetchSystemPromptPresets,
    hideSerializedSettingsWidgets,
    isEncryptedText,
    isEncryptedVariables,
    keepFixedPromptSeed,
    isPromptAutocompleteVisible,
    shouldSuppressPromptAutocompleteRefresh,
    isPointInPromptWidget,
    isPromptHideModeEnabled,
    modelOptionsForProvider,
    modelSupportsImages,
    modelOptionsWithCurrentValue,
    moveAutocompleteSelection,
    normalizeProviderCatalog,
    normalizePromptVariables,
    parsePromptVariablesJson,
    promptEditorLayout,
    promptEnhancerGraphNodes,
    promptSeedControlWidget,
    promptSuggestionPopupPosition,
    promptWidgetBounds,
    randomizePromptEnhancerSeedsBeforeQueue,
    readProviderModelHistory,
    readPromptEnhancerModelConfig,
    readPromptEnhancerVisionModelConfig,
    readPromptText,
    readPromptVariables,
    readPromptEnhancerSettings,
    resetDefaultSystemPrompt,
    resetSystemPrompt,
    restoreQueuedPromptEnhancerSeeds,
    saveDefaultSystemPrompt,
    saveSystemPrompt,
    saveSystemPromptPreset,
    serializedPromptVariablesValue,
    serializePromptVariables,
    setGenerateNewEachPrompt,
    setNewFixedPromptSeed,
    seedProviderModelHistory,
    shouldRefreshPromptVariables,
    shouldHidePromptWidget,
    syncPromptEnhancerSelectorsFromSerializedState,
    promptAutocompleteShortcutAction,
    promptAutocompleteShortcutGuardAction,
    updatePromptVariable,
    updateModelOptions,
    updateProviderModelOptions,
    updateVisionProviderModelOptions,
    writeProviderModelHistory,
    writePromptEnhancerModelConfig,
    writePromptEnhancerVisionModelConfig,
    writePromptText,
    writePromptVariables,
    writePromptEnhancerSettings,
} from "../../web/prompt_enhancer_helpers.js";
import {
    PRIVACY_SHOW_ANY_STATE_WIDGET,
    PRIVACY_SHOW_ANY_STATE_PROPERTY,
    collectPrivacyShowAnyNodes,
    decryptTextState,
    decryptTextStateForOwner,
    encryptedPrivacyShowAnyState,
    encryptTextState,
    encryptTextStateForOwner,
    extractPrivacyShowAnyText,
    flushPrivacyShowAnyEncryption,
    hidePrivacyShowAnyStateWidget,
    isEncryptedText as isPrivacyEncryptedText,
    privacyShowAnyDisplayState,
    sanitizePrivacyShowAnySerializedProperties,
    serializedEncryptedPropertyValue,
    serializedEncryptedWidgetValue,
    setEncryptedPrivacyShowAnyState,
} from "../../web/privacy_show_any_helpers.js";
import {
    canonicalPrivacyValue,
    encryptedOrReusePrivacyValue,
    isPrivacyEnvelope,
    rememberPrivacyEnvelope,
    stablePrivacyJsonStringify,
} from "../../web/privacy_envelope.js";

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

function countingPrivacyApi() {
    let encryptCount = 0;
    return {
        get encryptCount() {
            return encryptCount;
        },
        async encrypt(text) {
            encryptCount += 1;
            return { encrypted: `__HELTO_ENC__:${encryptCount}:${Buffer.from(text).toString("base64")}` };
        },
        async decrypt(encrypted) {
            const encoded = String(encrypted).split(":").pop() || "";
            return { data: Buffer.from(encoded, "base64").toString("utf8") };
        },
    };
}

function fakeDomElement(document, tagName = "div") {
    let ownText = "";
    let rawHtml = "";
    return {
        ownerDocument: document,
        tagName: tagName.toUpperCase(),
        children: [],
        style: {},
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        set textContent(value) {
            ownText = String(value);
            rawHtml = "";
            this.children = [];
        },
        get textContent() {
            return ownText + this.children.map((child) => child.textContent ?? "").join("");
        },
        set innerHTML(value) {
            rawHtml = String(value);
            ownText = "";
            this.children = [];
        },
        get innerHTML() {
            return rawHtml;
        },
    };
}

function fakeDomDocument() {
    const document = {
        createElement(tagName) {
            return fakeDomElement(document, tagName);
        },
        createTextNode(text) {
            return { textContent: String(text) };
        },
    };
    return document;
}

test("privacy envelope helper reuses unchanged private values and canonicalizes objects", async () => {
    const selectorApi = countingPrivacyApi();
    const owner = {};

    assert.equal(stablePrivacyJsonStringify({ b: 2, a: 1 }), "{\"a\":1,\"b\":2}");
    assert.equal(canonicalPrivacyValue("plain"), "plain");

    const first = await encryptedOrReusePrivacyValue(owner, "state", "{\"b\":2,\"a\":1}", {
        selectorApi,
        canonicalValue: { b: 2, a: 1 },
    });
    const second = await encryptedOrReusePrivacyValue(owner, "state", "{\"a\":1,\"b\":2}", {
        selectorApi,
        canonicalValue: { a: 1, b: 2 },
    });

    assert.equal(isPrivacyEnvelope(first), true);
    assert.equal(second, first);
    assert.equal(selectorApi.encryptCount, 1);

    const changed = await encryptedOrReusePrivacyValue(owner, "state", "{\"a\":1,\"b\":3}", {
        selectorApi,
        canonicalValue: { a: 1, b: 3 },
    });

    assert.notEqual(changed, first);
    assert.equal(selectorApi.encryptCount, 2);
});

test("privacy envelope helper leaves public and already encrypted values unchanged", async () => {
    const selectorApi = countingPrivacyApi();
    const owner = {};

    const publicValue = await encryptedOrReusePrivacyValue(owner, "field", "public text", {
        privacyMode: false,
        selectorApi,
    });
    const encrypted = "__HELTO_ENC__:loaded";
    const alreadyEncrypted = await encryptedOrReusePrivacyValue(owner, "field", encrypted, {
        privacyMode: true,
        selectorApi,
    });

    assert.equal(publicValue, "public text");
    assert.equal(alreadyEncrypted, encrypted);
    assert.equal(selectorApi.encryptCount, 0);
});

test("privacy envelope helper reuses envelopes remembered from restore", async () => {
    const selectorApi = countingPrivacyApi();
    const owner = {};
    const loaded = "__HELTO_ENC__:loaded";

    rememberPrivacyEnvelope(owner, "field", { z: 1, a: 2 }, loaded);

    const serialized = await encryptedOrReusePrivacyValue(owner, "field", "{\"a\":2,\"z\":1}", {
        selectorApi,
        canonicalValue: { a: 2, z: 1 },
    });

    assert.equal(serialized, loaded);
    assert.equal(selectorApi.encryptCount, 0);
});

test("selector image urls include metadata version tokens and keep legacy calls working", () => {
    const image = { date_modified: 1712345678.123, size_bytes: 4096 };
    assert.equal(selectorImageVersionToken(image), "m1712345678.123-s4096");

    const thumbUrl = new URL(selectorApi.thumbnailUrl("/tmp/a b.png", true, image), "http://localhost");
    assert.equal(thumbUrl.pathname, "/helto_selector/thumbnail");
    assert.equal(thumbUrl.searchParams.get("path"), "/tmp/a b.png");
    assert.equal(thumbUrl.searchParams.get("privacy"), "true");
    assert.equal(thumbUrl.searchParams.get("v"), "m1712345678.123-s4096");

    const viewUrl = new URL(selectorApi.viewImageUrl("/tmp/a b.png", image), "http://localhost");
    assert.equal(viewUrl.pathname, "/helto_selector/view_image");
    assert.equal(viewUrl.searchParams.get("path"), "/tmp/a b.png");
    assert.equal(viewUrl.searchParams.get("v"), "m1712345678.123-s4096");

    const legacyThumbUrl = new URL(selectorApi.thumbnailUrl("/tmp/a.png", false), "http://localhost");
    assert.equal(legacyThumbUrl.searchParams.get("path"), "/tmp/a.png");
    assert.equal(legacyThumbUrl.searchParams.get("privacy"), "false");
    assert.equal(legacyThumbUrl.searchParams.has("v"), false);
    assert.equal(
        new URL(selectorApi.thumbnailUrl("/tmp/a.png", "false"), "http://localhost").searchParams.get("privacy"),
        "false",
    );

    const legacyViewUrl = new URL(selectorApi.viewImageUrl("/tmp/a.png"), "http://localhost");
    assert.equal(legacyViewUrl.searchParams.get("path"), "/tmp/a.png");
    assert.equal(legacyViewUrl.searchParams.has("v"), false);

    const configuredThumbUrl = new URL(
        selectorApi.thumbnailUrl("/external/a.png", true, { ...image, folder: "/external" }, ["/external"]),
        "http://localhost",
    );
    assert.deepEqual(JSON.parse(configuredThumbUrl.searchParams.get("folders")), ["/external"]);

    const configuredViewUrl = new URL(
        selectorApi.viewImageUrl("/external/a.png", { ...image, folder: "/fallback" }, ["/external"]),
        "http://localhost",
    );
    assert.deepEqual(JSON.parse(configuredViewUrl.searchParams.get("folders")), ["/external"]);

    const inferredViewUrl = new URL(
        selectorApi.viewImageUrl("/external/a.png", { ...image, folder: "/fallback" }),
        "http://localhost",
    );
    assert.deepEqual(JSON.parse(inferredViewUrl.searchParams.get("folders")), ["/fallback"]);

    const configuredMaskUrl = new URL(selectorApi.maskUrl("/external/a.png", ["/external"]), "http://localhost");
    assert.deepEqual(JSON.parse(configuredMaskUrl.searchParams.get("folders")), ["/external"]);
});

test("selector empty state renders folder paths as text nodes", () => {
    const document = fakeDomDocument();
    const empty = document.createElement("div");
    const maliciousFolder = "/tmp/<img src=x onerror=alert(1)>";

    empty.innerHTML = "<span>stale</span>";
    renderSelectorEmptyState(empty, [maliciousFolder, "/tmp/next"]);

    const pathContainer = empty.children[2];
    assert.equal(empty.innerHTML, "");
    assert.equal(pathContainer.children[0].textContent, maliciousFolder);
    assert.equal(pathContainer.children[1].tagName, "BR");
    assert.equal(pathContainer.children[2].textContent, "/tmp/next");
    assert.ok(empty.textContent.includes(maliciousFolder));
});

test("mask editor overlay treats unaffected masks as transparent", () => {
    assert.equal(UNAFFECTED_MASK_VALUE, 0);
    assert.deepEqual(maskOverlayPixel(UNAFFECTED_MASK_VALUE, "#336699", 60), [51, 102, 153, 0]);
});

test("mask editor overlay renders affected and gray mask pixels with selected color and opacity", () => {
    assert.equal(AFFECTED_MASK_VALUE, 255);
    assert.deepEqual(maskOverlayPixel(AFFECTED_MASK_VALUE, "#336699", 60), [51, 102, 153, 153]);
    assert.deepEqual(maskOverlayPixel(128, "#336699", 60), [51, 102, 153, 77]);
});

test("mask editor overlay opacity zero makes affected pixels transparent", () => {
    assert.deepEqual(maskOverlayPixel(AFFECTED_MASK_VALUE, "#336699", 0), [51, 102, 153, 0]);
});

test("mask editor empty-mask detection treats all unaffected pixels as clear", () => {
    assert.equal(maskImageDataIsUnaffected({
        data: new Uint8ClampedArray([
            UNAFFECTED_MASK_VALUE, UNAFFECTED_MASK_VALUE, UNAFFECTED_MASK_VALUE, 255,
            UNAFFECTED_MASK_VALUE, UNAFFECTED_MASK_VALUE, UNAFFECTED_MASK_VALUE, 255,
        ]),
    }), true);

    assert.equal(maskImageDataIsUnaffected({
        data: new Uint8ClampedArray([
            UNAFFECTED_MASK_VALUE, UNAFFECTED_MASK_VALUE, UNAFFECTED_MASK_VALUE, 255,
            AFFECTED_MASK_VALUE, AFFECTED_MASK_VALUE, AFFECTED_MASK_VALUE, 255,
        ]),
    }), false);
});

test("mask editor preview color parser supports hex colors and defaults safely", () => {
    assert.deepEqual(parsePreviewColor("#abc"), [170, 187, 204]);
    assert.deepEqual(parsePreviewColor("#123456"), [18, 52, 86]);
    assert.deepEqual(parsePreviewColor("not-a-color"), [0, 0, 0]);
    assert.deepEqual(parsePreviewColor(null), [0, 0, 0]);
});

test("mask editor preview scale preserves small images and bounds large images", () => {
    assert.equal(previewScaleForSize(1024, 768), 1);
    assert.equal(previewScaleForSize(4096, 2048), 0.5);
    assert.equal(previewScaleForSize(1000, 500, 500), 0.5);
});

test("mask editor fit display size preserves aspect ratio for constrained stages", () => {
    assert.deepEqual(fitDisplaySize(1600, 800, 800, 800), { width: 800, height: 400, scale: 0.5 });
    assert.deepEqual(fitDisplaySize(800, 1600, 800, 800), { width: 400, height: 800, scale: 0.5 });
    assert.deepEqual(fitDisplaySize(400, 200, 800, 800), { width: 800, height: 400, scale: 2 });
});

test("mask editor zoom display size defaults to fit and can use original image dimensions", () => {
    const dimensions = {
        imageWidth: 4096,
        imageHeight: 2048,
        previewWidth: 2048,
        previewHeight: 1024,
        stageWidth: 1024,
        stageHeight: 1024,
    };

    assert.deepEqual(displaySizeForZoomMode(ZOOM_MODE_FIT, dimensions), { width: 1024, height: 512, scale: 0.5 });
    assert.deepEqual(displaySizeForZoomMode(ZOOM_MODE_ACTUAL, dimensions), { width: 4096, height: 2048, scale: 1 });
});

test("mask editor maps preview points back to full-resolution mask points", () => {
    assert.deepEqual(previewPointToMaskPoint({ x: 512, y: 256 }, 0.5), { x: 1024, y: 512 });
    assert.deepEqual(previewPointToMaskPoint({ x: 12, y: 18 }, 1), { x: 12, y: 18 });
});

test("mask editor maps displayed points through CSS zoom to preview and mask points", () => {
    const previewPoint = displayPointToPreviewPoint(
        { x: 256, y: 128 },
        { width: 2048, height: 1024 },
        { width: 1024, height: 512 },
    );

    assert.deepEqual(previewPoint, { x: 512, y: 256 });
    assert.deepEqual(previewPointToMaskPoint(previewPoint, 0.5), { x: 1024, y: 512 });
});

test("mask editor brush size uses screen pixels at actual size", () => {
    const brushSize = 32;
    const canvasSize = { width: 2048, height: 1024 };
    const displaySize = { width: 4096, height: 2048 };

    assert.equal(displayBrushSizeToPreviewSize(brushSize, canvasSize, displaySize), 16);
    assert.equal(displayBrushSizeToMaskSize(brushSize, canvasSize, displaySize, 0.5), 32);
});

test("mask editor brush size expands mask footprint when zoomed to fit", () => {
    const brushSize = 32;
    const canvasSize = { width: 2048, height: 1024 };
    const displaySize = { width: 1024, height: 512 };

    assert.equal(displayBrushSizeToPreviewSize(brushSize, canvasSize, displaySize), 64);
    assert.equal(displayBrushSizeToMaskSize(brushSize, canvasSize, displaySize, 0.5), 128);
});

test("mask editor brush cursor stays equal to selected screen size", () => {
    const brushSize = 32;
    const canvasSize = { width: 2048, height: 1024 };
    const displaySize = { width: 1024, height: 512 };
    const previewBrushSize = displayBrushSizeToPreviewSize(brushSize, canvasSize, displaySize);

    assert.equal(previewBrushSize * (displaySize.width / canvasSize.width), brushSize);
});

test("mask editor zoom mode starts as fit and toggles to actual size", () => {
    assert.equal(nextZoomMode(ZOOM_MODE_FIT), ZOOM_MODE_ACTUAL);
    assert.equal(nextZoomMode(ZOOM_MODE_ACTUAL), ZOOM_MODE_FIT);
});

test("mask editor overlay scheduler coalesces redraw requests into one frame", () => {
    const callbacks = [];
    let renderCount = 0;
    const schedule = createOverlayScheduler((callback) => callbacks.push(callback), () => {
        renderCount += 1;
    });

    schedule();
    schedule();
    schedule();

    assert.equal(callbacks.length, 1);
    assert.equal(renderCount, 0);

    callbacks.shift()();
    assert.equal(renderCount, 1);

    schedule();
    assert.equal(callbacks.length, 1);
});

test("selector mask save result removes edited mask entry when cleared", () => {
    const existing = {
        "/tmp/a.png": { key: "a" },
        "/tmp/b.png": { key: "b" },
    };

    assert.deepEqual(
        applyEditedMaskSaveResult(existing, "/tmp/a.png", null, { cleared: true }),
        { "/tmp/b.png": { key: "b" } },
    );
    assert.deepEqual(
        applyEditedMaskSaveResult(existing, "/tmp/a.png", { key: "next" }, { status: "success" }),
        {
            "/tmp/a.png": { key: "next" },
            "/tmp/b.png": { key: "b" },
        },
    );
});

test("selector bbox save result stores valid boxes and removes empty entries", () => {
    const existing = {
        "/tmp/a.png": [{ x: 1, y: 2, width: 3, height: 4 }],
        "/tmp/b.png": [{ x: 5, y: 6, width: 7, height: 8 }],
    };

    assert.deepEqual(
        applyEditedBboxSaveResult(existing, "/tmp/a.png", []),
        { "/tmp/b.png": [{ x: 5, y: 6, width: 7, height: 8 }] },
    );
    assert.deepEqual(
        applyEditedBboxSaveResult(existing, "/tmp/a.png", [
            { x: "10", y: 20, width: 30, height: 40 },
            { x: 0, y: 0, width: -1, height: 4 },
        ]),
        {
            "/tmp/a.png": [{ x: 10, y: 20, width: 30, height: 40 }],
            "/tmp/b.png": [{ x: 5, y: 6, width: 7, height: 8 }],
        },
    );
});

test("bbox editor normalizes reversed drags and clamps to image bounds", () => {
    assert.deepEqual(
        bboxFromPoints({ x: 90, y: 80 }, { x: 10, y: 20 }, 100, 100),
        { x: 10, y: 20, width: 80, height: 60 },
    );
    assert.deepEqual(
        normalizeBbox({ x: -10, y: 5, width: 40, height: 110 }, 100, 100),
        { x: 0, y: 5, width: 30, height: 95 },
    );
    assert.equal(normalizeBbox({ x: 5, y: 5, width: 0, height: 10 }, 100, 100), null);
});

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
    assert.equal(properties.batchingMode, false);
    assert.equal(properties.resizeMode, "zoom to fit");

    const savedProperties = initializeSelectorProperties({
        folders: ["/root/a/", "/root/a"],
        folderFilter: "/root/a/",
        subfolderFilter: "/root/a/child/",
        privacyMode: false,
        batchingMode: "true",
    });
    assert.deepEqual(savedProperties.folders, ["/root/a"]);
    assert.equal(savedProperties.folderFilter, "/root/a");
    assert.equal(savedProperties.subfolderFilter, "/root/a/child");
    assert.equal(savedProperties.privacyMode, false);
    assert.equal(savedProperties.batchingMode, true);
    assert.equal(coerceSelectorBoolean("false", true), false);
    assert.equal(coerceSelectorBoolean("", true), true);

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

test("selector paste destination uses the most specific concrete folder", () => {
    assert.deepEqual(resolveSelectorPasteDestination({
        folderFilter: "all",
        subfolderFilter: "/root/a/child",
    }), {
        type: "selector",
        destination: "/root/a/child",
    });
    assert.deepEqual(resolveSelectorPasteDestination({
        folderFilter: "/root/a",
        subfolderFilter: "all",
    }), {
        type: "selector",
        destination: "/root/a",
    });
    assert.deepEqual(resolveSelectorPasteDestination({
        folderFilter: "all",
        subfolderFilter: "all",
    }), {
        type: "comfy-input",
        destination: "",
    });
});

test("selector paste helpers choose image clipboard data and stable fallback names", () => {
    const imageFile = { name: "", type: "image/png" };
    const items = [
        { type: "text/plain", getAsFile: () => ({ name: "notes.txt", type: "text/plain" }) },
        { type: "image/png", getAsFile: () => imageFile },
    ];

    assert.equal(firstClipboardImageFile(items), imageFile);
    assert.equal(firstClipboardImageFile([{ type: "text/plain", getAsFile: () => null }]), null);
    assert.equal(
        buildPastedImageFilename(imageFile, new Date("2026-06-18T07:45:12.000Z")),
        "pasted-image-20260618-074512.png",
    );
    assert.equal(buildPastedImageFilename({ name: "clip.webp", type: "image/webp" }), "clip.webp");
});

test("path filter helpers normalize slash style and child matching", () => {
    assert.equal(normalizeFilterPath("C:\\images\\nested\\"), "C:/images/nested");
    assert.equal(isSameOrChildPath("/root/a/child/file.png", "/root/a"), true);
    assert.equal(isSameOrChildPath("/root/ab/file.png", "/root/a"), false);
});

test("selector image filter searches filename and relative subfolder paths only", () => {
    const images = [
        {
            path: "/scan-root/project/cats/portrait-alpha.png",
            folder: "/scan-root/project",
            image_folder: "/scan-root/project/cats",
            name: "portrait-alpha.png",
        },
        {
            path: "/scan-root/project/dogs/wide-beta.png",
            folder: "/scan-root/project",
            image_folder: "/scan-root/project/dogs",
            name: "wide-beta.png",
        },
        {
            path: "/scan-root/other/project-gamma.png",
            folder: "/scan-root/other",
            image_folder: "/scan-root/other",
            name: "project-gamma.png",
        },
    ];

    assert.deepEqual(
        filterSelectorImages(images, { searchQuery: "alpha" }).map((image) => image.name),
        ["portrait-alpha.png"],
    );
    assert.deepEqual(
        filterSelectorImages(images, { searchQuery: "cats" }).map((image) => image.name),
        ["portrait-alpha.png"],
    );
    assert.deepEqual(
        filterSelectorImages(images, { folderFilter: "/scan-root/project", searchQuery: "project" }).map((image) => image.name),
        [],
    );
});

test("selector image filter combines folder subfolder and empty query filters", () => {
    const images = [
        {
            path: "/root/a/one.png",
            folder: "/root/a",
            image_folder: "/root/a",
            name: "one.png",
        },
        {
            path: "/root/a/nested/two.png",
            folder: "/root/a",
            image_folder: "/root/a/nested",
            name: "two.png",
        },
        {
            path: "/root/b/nested/two.png",
            folder: "/root/b",
            image_folder: "/root/b/nested",
            name: "two.png",
        },
    ];

    assert.deepEqual(
        filterSelectorImages(images, {
            folderFilter: "/root/a",
            subfolderFilter: "/root/a/nested",
            recursive: true,
            searchQuery: "two",
        }).map((image) => image.path),
        ["/root/a/nested/two.png"],
    );
    assert.deepEqual(
        filterSelectorImages(images, {
            folderFilter: "/root/a",
            subfolderFilter: "/root/a/nested",
            recursive: true,
            searchQuery: "",
        }).map((image) => image.path),
        ["/root/a/nested/two.png"],
    );
});

test("folder path helpers normalize and dedupe folder entries", () => {
    assert.equal(normalizeFolderPath("/home/thhel/comfy/input/"), "/home/thhel/comfy/input");
    assert.equal(normalizeFolderPath("/home/thhel/comfy//input/./"), "/home/thhel/comfy/input");
    assert.equal(normalizeFolderPath("C:\\images\\nested\\"), "C:/images/nested");
    assert.deepEqual(
        uniqueFolderPaths([
            "/home/thhel/comfy/input/",
            "/home/thhel/comfy/input",
            "/home/thhel/comfy//output",
            "",
        ]),
        ["/home/thhel/comfy/input", "/home/thhel/comfy/output"],
    );
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

test("hide mode helpers preserve restored node size when computed size is smaller", () => {
    const setSizeCalls = [];
    const node = {
        size: [600, 500],
        computeSize: () => [300, 200],
        setSize: (size) => setSizeCalls.push(size),
    };

    assert.deepEqual(expandNodeToComputedSize(node), [600, 500]);
    assert.deepEqual(setSizeCalls, []);
});

test("hide mode helpers expand node size when computed size is larger", () => {
    const node = {
        size: [200, 100],
        computeSize: () => [300, 200],
        setSize(size) {
            this.size = size;
        },
    };

    assert.deepEqual(expandNodeToComputedSize(node), [300, 200]);
    assert.deepEqual(node.size, [300, 200]);
});

test("hide mode helpers fall back to computed size when current size is invalid", () => {
    const node = {
        size: [Number.NaN, undefined],
        computeSize: () => [300, 200],
        setSize(size) {
            this.size = size;
        },
    };

    assert.deepEqual(expandNodeToComputedSize(node), [300, 200]);
    assert.deepEqual(node.size, [300, 200]);
});

test("hide mode helpers reassert restored node size through setSize", () => {
    const setSizeCalls = [];
    const node = {
        size: [600, 500],
        setSize: (size) => setSizeCalls.push(size),
    };

    assert.deepEqual(restoreNodeSize(node, [600, 500]), [600, 500]);
    assert.deepEqual(setSizeCalls, [[600, 500]]);
});

test("hide mode helpers restore hydration size without shrinking larger dimensions", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const callbacks = [];
    globalThis.setTimeout = (callback) => {
        callbacks.push(callback);
        return 0;
    };
    globalThis.requestAnimationFrame = (callback) => {
        callbacks.push(callback);
        return 0;
    };

    try {
        const setSizeCalls = [];
        const node = {
            size: [700, 400],
            setSize(size) {
                setSizeCalls.push(size);
                this.size = size;
            },
        };

        assert.deepEqual(scheduleNodeSizeRestore(node, [600, 500]), [600, 500]);
        for (const callback of callbacks) callback();
        assert.equal(setSizeCalls.length, 9);
        for (const size of setSizeCalls) {
            assert.deepEqual(size, [700, 500]);
        }
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
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

test("pause control finds downstream nodes from the save image output only", () => {
    const prompt = {
        workflow: {
            nodes: [
                { id: 1, outputs: [{ name: "images" }] },
                { id: 2, outputs: [{ name: "images" }, { name: "mask" }] },
                { id: 3, outputs: [{ name: "images" }] },
                { id: 4, outputs: [] },
                { id: 5, outputs: [] },
            ],
            links: [
                [10, 1, 0, 2, 0, "IMAGE"],
                [11, 2, 0, 3, 0, "IMAGE"],
                [12, 3, 0, 4, 0, "IMAGE"],
                [13, 2, 1, 5, 0, "MASK"],
            ],
        },
    };

    assert.deepEqual([...downstreamNodeIdsFromOutput(prompt, 2, "images")], [3, 4]);
});

test("pause control keeps downstream dependencies but removes save node input links", () => {
    const prompt = {
        output: {
            "1": { class_type: "Generator", inputs: { seed: 123 } },
            "2": { class_type: "HeltoSaveImageAdvanced", inputs: { images: [1, 0], folder: "/tmp/out" } },
            "3": { class_type: "UpscaleModelLoader", inputs: { model_name: "model.pth" } },
            "4": { class_type: "UpscaleImage", inputs: { image: [2, 0], upscale_model: [3, 0] } },
            "5": { class_type: "PreviewImage", inputs: { images: [4, 0] } },
            "6": { class_type: "OtherOutput", inputs: { images: [1, 0] } },
        },
        workflow: {
            nodes: [
                { id: 1, outputs: [{ name: "images" }] },
                { id: 2, outputs: [{ name: "images" }] },
                { id: 3, outputs: [{ name: "upscale_model" }] },
                { id: 4, outputs: [{ name: "IMAGE" }] },
                { id: 5, outputs: [] },
                { id: 6, outputs: [] },
            ],
            links: [
                [10, 1, 0, 2, 0, "IMAGE"],
                [11, 2, 0, 4, 0, "IMAGE"],
                [12, 3, 0, 4, 1, "UPSCALE_MODEL"],
                [13, 4, 0, 5, 0, "IMAGE"],
                [14, 1, 0, 6, 0, "IMAGE"],
            ],
        },
    };

    assert.deepEqual(
        [...dependencyNodeIdsForPromptOutput(prompt.output, new Set([5]), new Set([2]))].sort((a, b) => a - b),
        [2, 3, 4, 5],
    );

    const { prompt: resumePrompt, downstreamNodeIds, keptNodeIds } = buildPauseResumePrompt(prompt, 2, "images");

    assert.deepEqual(downstreamNodeIds, [4, 5]);
    assert.deepEqual(keptNodeIds.sort((a, b) => a - b), [2, 3, 4, 5]);
    assert.deepEqual(resumePrompt.output["2"].inputs, { folder: "/tmp/out" });
    assert.equal(resumePrompt.output["1"], undefined);
    assert.equal(resumePrompt.output["6"], undefined);
    assert.deepEqual(resumePrompt.workflow.nodes.map((node) => node.id).sort((a, b) => a - b), [2, 3, 4, 5]);
    assert.deepEqual(resumePrompt.workflow.links.map((link) => link[0]).sort((a, b) => a - b), [11, 12, 13]);
});

test("pause control queues filtered prompt through Comfy API only", async () => {
    const filteredPrompt = {
        output: {
            "2": { class_type: "HeltoSaveImageAdvanced", inputs: { folder: "/tmp/out" } },
            "4": { class_type: "UpscaleImage", inputs: { image: [2, 0] } },
        },
        workflow: {
            nodes: [{ id: 2 }, { id: 4 }],
            links: [[11, 2, 0, 4, 0, "IMAGE"]],
        },
    };
    const calls = [];
    const apiClient = {
        queuePrompt(...args) {
            calls.push(args);
            return { prompt_id: "resume-prompt" };
        },
    };

    const result = await queueFilteredPrompt(apiClient, filteredPrompt);

    assert.deepEqual(calls, [[-1, filteredPrompt]]);
    assert.deepEqual(result, { prompt_id: "resume-prompt" });
});

test("pause control refuses to queue without Comfy API queuePrompt", async () => {
    let fullGraphQueued = false;
    const appFallback = {
        queuePrompt() {
            fullGraphQueued = true;
        },
    };
    assert.equal(typeof appFallback.queuePrompt, "function");

    await assert.rejects(
        queueFilteredPrompt(null, { output: {}, workflow: { nodes: [], links: [] } }),
        /ComfyUI API queuePrompt is unavailable/,
    );
    assert.equal(fullGraphQueued, false);
});

test("pause control button handler uses filtered queue path only", () => {
    const source = readFileSync(new URL("../../web/save_image_advanced_hide_mode.js", import.meta.url), "utf8");
    const handlerStart = source.indexOf("async function queuePauseResumePrompt(node)");
    const handlerEnd = source.indexOf("async function handlePauseControlButton(node)");
    assert.ok(handlerStart >= 0);
    assert.ok(handlerEnd > handlerStart);

    const handlerSource = source.slice(handlerStart, handlerEnd);
    assert.match(handlerSource, /return queueFilteredPrompt\(api, nextPrompt\);/);
    assert.doesNotMatch(handlerSource, /app\.queuePrompt/);
});

test("pause control builds resume prompt from the save video images output", () => {
    const prompt = {
        output: {
            "1": { class_type: "VideoGenerator", inputs: { seed: 123 } },
            "2": {
                class_type: "HeltoSaveVideoAdvanced",
                inputs: { images: [1, 0], audio: [1, 1], filename_prefix: "clip" },
            },
            "3": { class_type: "UpscaleModelLoader", inputs: { model_name: "model.pth" } },
            "4": { class_type: "UpscaleImage", inputs: { image: [2, 0], upscale_model: [3, 0] } },
            "5": { class_type: "PreviewImage", inputs: { images: [4, 0] } },
            "6": { class_type: "SaveAudio", inputs: { audio: [2, 1] } },
        },
        workflow: {
            nodes: [
                { id: 1, outputs: [{ name: "images" }, { name: "audio" }] },
                { id: 2, outputs: [{ name: "images" }, { name: "audio" }, { name: "filenames" }] },
                { id: 3, outputs: [{ name: "upscale_model" }] },
                { id: 4, outputs: [{ name: "IMAGE" }] },
                { id: 5, outputs: [] },
                { id: 6, outputs: [] },
            ],
            links: [
                [10, 1, 0, 2, 0, "IMAGE"],
                [11, 1, 1, 2, 1, "AUDIO"],
                [12, 2, 0, 4, 0, "IMAGE"],
                [13, 3, 0, 4, 1, "UPSCALE_MODEL"],
                [14, 4, 0, 5, 0, "IMAGE"],
                [15, 2, 1, 6, 0, "AUDIO"],
            ],
        },
    };

    const { prompt: resumePrompt, downstreamNodeIds, keptNodeIds } = buildPauseResumePrompt(prompt, 2, "images");

    assert.deepEqual(downstreamNodeIds, [4, 5]);
    assert.deepEqual(keptNodeIds.sort((a, b) => a - b), [2, 3, 4, 5]);
    assert.deepEqual(resumePrompt.output["2"].inputs, { filename_prefix: "clip" });
    assert.equal(resumePrompt.output["1"], undefined);
    assert.equal(resumePrompt.output["6"], undefined);
    assert.deepEqual(resumePrompt.workflow.nodes.map((node) => node.id).sort((a, b) => a - b), [2, 3, 4, 5]);
    assert.deepEqual(resumePrompt.workflow.links.map((link) => link[0]).sort((a, b) => a - b), [12, 13, 14]);
});

test("pause control serialization skips runtime widgets at the top", () => {
    const node = {
        widgets: [
            { name: "run again", value: null, serialize: false, options: { serialize: false } },
            { name: "hide mode", value: true, serialize: false, options: { serialize: false } },
            { name: "folder", value: "/tmp/out" },
            { name: "filename_prefix", value: "clip" },
            { name: "pause_mode", value: true },
            { name: "privacy_mode", value: false },
        ],
    };
    const info = {};

    sanitizeSerializedWidgetValues(node, info);

    assert.deepEqual(serializedWidgetValues(node), ["/tmp/out", "clip", true, false]);
    assert.deepEqual(serializedWidgetValueMap(node), {
        folder: "/tmp/out",
        filename_prefix: "clip",
        pause_mode: true,
        privacy_mode: false,
    });
    assert.deepEqual(info.widgets_values, {
        folder: "/tmp/out",
        filename_prefix: "clip",
        pause_mode: true,
        privacy_mode: false,
    });
});

test("pause control restore maps saved values onto serializable widgets only", () => {
    const node = {
        widgets: [
            { name: "continue", value: null, serialize: false, options: { serialize: false } },
            { name: "folder", value: "" },
            { name: "filename_prefix", value: "video" },
            { name: "pause_mode", value: false },
            { name: "privacy_mode", value: true },
        ],
    };

    restoreSerializedWidgetValues(node, ["/tmp/restored", "upscale", true, false]);

    assert.equal(node.widgets[0].value, null);
    assert.equal(node.widgets[1].value, "/tmp/restored");
    assert.equal(node.widgets[2].value, "upscale");
    assert.equal(node.widgets[3].value, true);
    assert.equal(node.widgets[4].value, false);
});

test("pause control restore maps saved name values onto serializable widgets", () => {
    const node = {
        widgets: [
            { name: "run again", value: null, serialize: false, options: { serialize: false } },
            { name: "folder", value: "" },
            { name: "filename_prefix", value: "video" },
            { name: "pause_mode", value: false },
            { name: "privacy_mode", value: true },
        ],
    };

    restoreSerializedWidgetValues(node, {
        filename_prefix: "upscale",
        privacy_mode: false,
        folder: "/tmp/restored",
        pause_mode: true,
    });

    assert.equal(node.widgets[0].value, null);
    assert.equal(node.widgets[1].value, "/tmp/restored");
    assert.equal(node.widgets[2].value, "upscale");
    assert.equal(node.widgets[3].value, true);
    assert.equal(node.widgets[4].value, false);
});

test("pause control restore ignores runtime slots in old full widget arrays", () => {
    const node = {
        widgets: [
            { name: "run again", value: null, serialize: false, options: { serialize: false } },
            { name: "folder", value: "" },
            { name: "filename_prefix", value: "video" },
            { name: "pause_mode", value: false },
        ],
    };

    restoreSerializedWidgetValues(node, [null, "/tmp/restored", "clip", true]);

    assert.equal(node.widgets[0].value, null);
    assert.equal(node.widgets[1].value, "/tmp/restored");
    assert.equal(node.widgets[2].value, "clip");
    assert.equal(node.widgets[3].value, true);
});

test("pause control restore survives video format widget refresh between passes", () => {
    const node = {
        widgets: [
            { name: "run again", value: null, serialize: false, options: { serialize: false } },
            { name: "folder", value: "" },
            { name: "format", value: "video/h264-mp4" },
            { name: "pause_mode", value: false },
        ],
    };
    const savedValues = {
        folder: "/tmp/video",
        format: "video/webm",
        crf: 21,
        pause_mode: true,
    };

    restoreSerializedWidgetValues(node, savedValues);
    const formatIndex = node.widgets.findIndex((widget) => widget.name === "format");
    node.widgets.splice(formatIndex + 1, 0, { name: "crf", value: 30 });
    restoreSerializedWidgetValues(node, savedValues);

    assert.equal(node.widgets[1].value, "/tmp/video");
    assert.equal(node.widgets[2].value, "video/webm");
    assert.equal(node.widgets[3].value, 21);
    assert.equal(node.widgets[4].value, true);
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

test("prompt enhancer seed buttons update seed widget and control mode", () => {
    const seedCallbacks = [];
    const controlCallbacks = [];
    const controlWidget = {
        name: "control_after_generate",
        value: "fixed",
        options: { values: ["fixed", "increment", "decrement", "randomize"] },
        callback(value) {
            controlCallbacks.push(value);
        },
    };
    const seedWidget = {
        name: "seed",
        value: 5,
        linkedWidgets: [controlWidget],
        callback(value) {
            seedCallbacks.push(value);
        },
    };
    const node = {
        widgets: [seedWidget, controlWidget],
        widgets_values: [5, "fixed"],
        last_serialization: { widgets_values: [5, "fixed"] },
    };

    assert.equal(setGenerateNewEachPrompt(node), "randomize");
    assert.equal(seedWidget.value, 5);
    assert.equal(controlWidget.value, "randomize");
    assert.deepEqual(node.widgets_values, [5, "randomize"]);

    assert.equal(setNewFixedPromptSeed(node, () => 0.5), 1073741823);
    assert.equal(seedWidget.value, 1073741823);
    assert.equal(controlWidget.value, "fixed");
    assert.deepEqual(node.widgets_values, [1073741823, "fixed"]);
    assert.deepEqual(node.last_serialization.widgets_values, [1073741823, "fixed"]);

    assert.equal(keepFixedPromptSeed(node), 1073741823);
    assert.equal(controlWidget.value, "fixed");
    assert.deepEqual(seedCallbacks, [1073741823]);
    assert.deepEqual(controlCallbacks, ["randomize", "fixed", "fixed"]);
});

test("prompt enhancer detects linked adjacent seed controls and graph subgraphs", () => {
    const linkedControl = {
        name: "custom",
        value: "randomize",
        options: { values: ["fixed", "increment", "decrement", "randomize"] },
    };
    const adjacentControl = {
        name: "control_after_generate",
        value: "randomize",
    };
    const seedWidget = { name: "seed", linkedWidgets: [linkedControl] };
    const rootNode = { comfyClass: "HeltoPromptEnhancer", widgets: [seedWidget, adjacentControl] };
    const subgraphNode = { comfyClass: "HeltoPromptEnhancer", widgets: [] };
    const graph = {
        nodes: [{
            subgraph: {
                nodes: [subgraphNode],
            },
        }],
        subgraphs: new Map([["extra", { nodes: [rootNode] }]]),
    };

    assert.equal(promptSeedControlWidget(rootNode, seedWidget), linkedControl);
    assert.deepEqual(promptEnhancerGraphNodes(graph), [graph.nodes[0], subgraphNode, rootNode]);
});

test("prompt enhancer queue randomization writes seed and suspends control callbacks", () => {
    const calls = [];
    const originalBeforeQueued = () => calls.push("before");
    const originalAfterQueued = () => calls.push("after");
    const controlWidget = {
        name: "control_after_generate",
        value: "randomize",
        options: { values: ["fixed", "increment", "decrement", "randomize"] },
        beforeQueued: originalBeforeQueued,
        afterQueued: originalAfterQueued,
    };
    const seedWidget = {
        name: "seed",
        value: 5,
        linkedWidgets: [controlWidget],
        callback(value) {
            calls.push(["seed-callback", value]);
        },
    };
    const node = {
        comfyClass: "HeltoPromptEnhancer",
        widgets: [seedWidget, controlWidget],
        widgets_values: [5],
        last_serialization: { widgets_values: [5] },
        onWidgetChanged(name, value, previousValue, widget) {
            calls.push(["changed", name, value, previousValue, widget === seedWidget]);
        },
        graph: {
            version: 0,
            dirty: 0,
            incrementVersion() {
                this.version += 1;
            },
            setDirtyCanvas() {
                this.dirty += 1;
            },
        },
    };
    const graph = { nodes: [node] };

    const queuedSeeds = randomizePromptEnhancerSeedsBeforeQueue(graph, {
        random: () => 0.25,
        now: () => 1000,
    });

    assert.equal(queuedSeeds.length, 1);
    assert.equal(seedWidget.value, 536870911);
    assert.deepEqual(node.widgets_values, [536870911]);
    assert.deepEqual(node.last_serialization.widgets_values, [536870911]);
    assert.notEqual(controlWidget.beforeQueued, originalBeforeQueued);
    assert.notEqual(controlWidget.afterQueued, originalAfterQueued);
    controlWidget.beforeQueued();
    controlWidget.afterQueued();
    assert.equal(calls.includes("before"), false);
    assert.equal(calls.includes("after"), false);

    seedWidget.value = -1;
    node.widgets_values[0] = -1;
    restoreQueuedPromptEnhancerSeeds(queuedSeeds, { now: () => 1005 });

    assert.equal(controlWidget.beforeQueued, originalBeforeQueued);
    assert.equal(controlWidget.afterQueued, originalAfterQueued);
    assert.equal(seedWidget.value, 536870911);
    assert.deepEqual(node.widgets_values, [536870911]);
    assert.deepEqual(calls, [
        ["seed-callback", 536870911],
        ["changed", "seed", 536870911, 5, true],
        ["seed-callback", 536870911],
        ["changed", "seed", 536870911, -1, true],
    ]);
    assert.equal(node.graph.version, 2);
    assert.equal(node.graph.dirty, 2);
});

test("prompt enhancer queue randomization skips fixed seed controls", () => {
    const seedWidget = { name: "seed", value: 5 };
    const node = {
        comfyClass: "HeltoPromptEnhancer",
        widgets: [
            seedWidget,
            {
                name: "control_after_generate",
                value: "fixed",
                options: { values: ["fixed", "increment", "decrement", "randomize"] },
            },
        ],
        widgets_values: [5],
    };

    assert.deepEqual(randomizePromptEnhancerSeedsBeforeQueue({ nodes: [node] }, { random: () => 0.25 }), []);
    assert.equal(seedWidget.value, 5);
    assert.deepEqual(node.widgets_values, [5]);
});

test("prompt enhancer settings read and write serialized widgets", () => {
    const node = {
        widgets: [
            { name: "hide_mode", value: false },
            { name: "privacy_mode", value: true },
            { name: "image_system_prompt_preset", value: "default" },
            { name: "video_system_prompt_preset", value: "default" },
            { name: "ollama_url", value: "http://127.0.0.1:11434" },
            { name: "ollama_keep_alive", value: 5 },
            { name: "ollama_keep_alive_unit", value: "minutes" },
            { name: "ollama_timeout", value: 120 },
            { name: "generation_max_tokens", value: 0 },
        ],
    };

    writePromptEnhancerSettings(node, {
        hideMode: true,
        privacyMode: false,
        ollamaUrl: "http://localhost:11434",
        keepAlive: 2,
        keepAliveUnit: "seconds",
        timeout: 45,
        maxTokens: 256,
        imageSystemPromptPreset: "flux image",
        videoSystemPromptPreset: "wan video",
    });

    assert.deepEqual(readPromptEnhancerSettings(node), {
        hideMode: true,
        privacyMode: false,
        ollamaUrl: "http://localhost:11434",
        keepAlive: 2,
        keepAliveUnit: "seconds",
        timeout: 45,
        maxTokens: 256,
        imageSystemPromptPreset: "flux image",
        videoSystemPromptPreset: "wan video",
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

test("prompt enhancer vision model selector uses only image-capable models", () => {
    const node = {
        widgets: [
            { name: "vision_provider", value: "local_transformers_vlm" },
            { name: "vision_model_id", value: "" },
            { name: "vision_model_backend", value: "" },
        ],
    };
    const catalog = normalizeProviderCatalog({
        providers: [
            { id: "ollama", label: "Ollama" },
            { id: "local_transformers_vlm", label: "Local Transformers VLM" },
            { id: "fallback", label: "Fallback" },
        ],
        models: [
            { provider: "ollama", model_id: "llava:latest", backend: "ollama", supports_images: true },
            { provider: "ollama", model_id: "mistral:latest", backend: "ollama", supports_images: false },
            { provider: "local_transformers_vlm", model_id: "qwen3_vl_4b_fast", backend: "qwen", supports_images: true },
            { provider: "fallback", model_id: "fallback_text_backend", backend: "fallback", supports_images: false },
        ],
    });
    const providerSelector = { value: "ollama", options: { values: [] } };
    const modelSelector = { value: "", options: { values: [] } };

    assert.equal(modelSupportsImages(catalog, "ollama", "llava:latest"), true);
    assert.equal(modelSupportsImages(catalog, "ollama", "mistral:latest"), false);
    assert.equal(updateVisionProviderModelOptions(providerSelector, modelSelector, node, catalog), true);
    assert.deepEqual(providerSelector.options.values, ["ollama", "local_transformers_vlm"]);
    assert.deepEqual(modelSelector.options.values, ["llava:latest"]);
    assert.deepEqual(readPromptEnhancerVisionModelConfig(node), {
        provider: "ollama",
        modelId: "llava:latest",
        modelBackend: "ollama",
    });

    assert.deepEqual(writePromptEnhancerVisionModelConfig(node, {
        provider: "local_transformers_vlm",
        modelId: "qwen3_vl_4b_fast",
        modelBackend: "qwen",
    }), {
        provider: "local_transformers_vlm",
        modelId: "qwen3_vl_4b_fast",
        modelBackend: "qwen",
    });
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

test("prompt enhancer provider reload sync keeps serialized provider over stale visible selector", () => {
    const node = {
        widgets: [
            { name: "provider", value: "local_transformers_vlm" },
            { name: "model_id", value: "qwen3_vl_8b_quality" },
            { name: "model_backend", value: "qwen" },
            {
                name: "provider_model_history",
                value: JSON.stringify({
                    ollama: { modelId: "llava:latest", modelBackend: "ollama" },
                    local_transformers_vlm: { modelId: "qwen3_vl_8b_quality", modelBackend: "qwen" },
                }),
            },
            { name: "vision_provider", value: "local_transformers_vlm" },
            { name: "vision_model_id", value: "qwen3_vl_4b_fast" },
            { name: "vision_model_backend", value: "qwen" },
            { name: "model", value: "qwen3_vl_8b_quality" },
        ],
    };
    const catalog = normalizeProviderCatalog({
        providers: [
            { id: "ollama", label: "Ollama" },
            { id: "local_transformers_vlm", label: "Local Transformers VLM" },
        ],
        models: [
            { provider: "ollama", model_id: "llava:latest", backend: "ollama", supports_images: true },
            { provider: "local_transformers_vlm", model_id: "qwen3_vl_4b_fast", backend: "qwen", supports_images: true },
            { provider: "local_transformers_vlm", model_id: "qwen3_vl_8b_quality", backend: "qwen", supports_images: true },
        ],
    });
    const providerSelector = { value: "ollama", options: { values: ["ollama"] } };
    const modelSelector = { value: "llava:latest", options: { values: ["llava:latest"] } };
    const visionProviderSelector = { value: "ollama", options: { values: ["ollama"] } };
    const visionModelSelector = { value: "llava:latest", options: { values: ["llava:latest"] } };

    const synced = syncPromptEnhancerSelectorsFromSerializedState(
        node,
        providerSelector,
        modelSelector,
        visionProviderSelector,
        visionModelSelector,
    );

    assert.equal(synced.model.provider, "local_transformers_vlm");
    assert.equal(providerSelector.value, "local_transformers_vlm");
    assert.equal(modelSelector.value, "qwen3_vl_8b_quality");
    assert.equal(visionProviderSelector.value, "local_transformers_vlm");
    assert.equal(visionModelSelector.value, "qwen3_vl_4b_fast");
    assert.equal(updateProviderModelOptions(providerSelector, modelSelector, node, catalog), true);
    assert.equal(updateVisionProviderModelOptions(visionProviderSelector, visionModelSelector, node, catalog), true);
    assert.deepEqual(readPromptEnhancerModelConfig(node), {
        provider: "local_transformers_vlm",
        modelId: "qwen3_vl_8b_quality",
        modelBackend: "qwen",
        legacyModel: "qwen3_vl_8b_quality",
    });
    assert.deepEqual(readPromptEnhancerVisionModelConfig(node), {
        provider: "local_transformers_vlm",
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
    assert.equal(shouldHidePromptWidget(node, false, true), false);

    node.widgets[0].value = false;
    assert.equal(shouldHidePromptWidget(node, false), false);
});

test("prompt enhancer suggestion popup positions below flips and clamps", () => {
    let position = promptSuggestionPopupPosition({
        text: "[rating=",
        cursor: 8,
        lineHeight: 20,
        paddingTop: 8,
        paddingLeft: 10,
        scrollTop: 0,
        textareaHeight: 120,
        textareaWidth: 280,
        textareaOffsetTop: 6,
        textareaOffsetLeft: 6,
        containerHeight: 180,
        containerWidth: 320,
        popupHeight: 60,
        popupWidth: 160,
    });

    assert.equal(position.placement, "below");
    assert.equal(position.top, 38);
    assert.equal(position.left, 16);

    position = promptSuggestionPopupPosition({
        text: "logical line only",
        cursor: 16,
        lineHeight: 20,
        paddingTop: 8,
        paddingLeft: 10,
        scrollTop: 0,
        visualLineTop: 72,
        textareaHeight: 160,
        textareaWidth: 280,
        textareaOffsetTop: 6,
        textareaOffsetLeft: 6,
        containerHeight: 180,
        containerWidth: 320,
        popupHeight: 60,
        popupWidth: 160,
    });

    assert.equal(position.placement, "below");
    assert.equal(position.top, 96);

    position = promptSuggestionPopupPosition({
        text: "one\ntwo\nthree\nfour\nfive\nsix",
        cursor: 27,
        lineHeight: 20,
        paddingTop: 8,
        paddingLeft: 10,
        scrollTop: 0,
        textareaHeight: 120,
        textareaWidth: 280,
        textareaOffsetTop: 6,
        textareaOffsetLeft: 6,
        containerHeight: 150,
        containerWidth: 320,
        popupHeight: 60,
        popupWidth: 160,
    });

    assert.equal(position.placement, "above");
    assert.equal(position.top, 50);

    position = promptSuggestionPopupPosition({
        text: "one\ntwo\nthree\nfour\nfive\nsix",
        cursor: 27,
        lineHeight: 20,
        paddingTop: 8,
        paddingLeft: 10,
        scrollTop: 0,
        textareaHeight: 120,
        textareaWidth: 280,
        textareaOffsetTop: 6,
        textareaOffsetLeft: 6,
        containerHeight: 150,
        containerWidth: 320,
        popupHeight: 60,
        popupWidth: 160,
        preferBelow: true,
    });

    assert.equal(position.placement, "below");
    assert.equal(position.top, 138);

    position = promptSuggestionPopupPosition({
        text: "one\ntwo\nthree",
        cursor: 13,
        lineHeight: 20,
        paddingTop: 8,
        paddingLeft: 300,
        scrollTop: 0,
        textareaHeight: 80,
        textareaWidth: 280,
        textareaOffsetTop: 0,
        textareaOffsetLeft: 20,
        containerHeight: 80,
        containerWidth: 180,
        popupHeight: 120,
        popupWidth: 160,
    });

    assert.equal(position.top, 0);
    assert.equal(position.left, 20);
    assert.equal(position.maxWidth, 160);
});

test("prompt enhancer autocomplete visibility only reveals for active shown suggestions", () => {
    const active = autocompleteStateForPrompt("[", 1, [], 0, { promptType: "video" });
    const inactive = emptyAutocompleteState(1);

    assert.equal(isPromptAutocompleteVisible(active, false), true);
    assert.equal(isPromptAutocompleteVisible(active, true), false);
    assert.equal(isPromptAutocompleteVisible(inactive, false), false);
});

test("prompt enhancer image reference autocomplete does not reopen completed tokens", () => {
    const context = { promptType: "video", imageCount: 2 };

    let state = autocompleteStateForPrompt("@image1:character", 17, [], 0, context);
    assert.equal(state.active, false);

    state = autocompleteStateForPrompt("@image1:cha", 11, [], 0, context);
    assert.equal(state.active, true);
    assert.deepEqual(state.options, ["character"]);

    state = autocompleteStateForPrompt("@image1:character:", 18, [], 0, context);
    assert.equal(state.active, true);
    assert.deepEqual(state.options, ["describe"]);

    state = autocompleteStateForPrompt("@image1:character:describe", 26, [], 0, context);
    assert.equal(state.active, false);

    state = autocompleteStateForPrompt("@image1:character:d", 19, [], 0, context);
    const accepted = acceptPromptAutocompleteSuggestion("@image1:character:d", state, [], context);
    assert.equal(accepted.text, "@image1:character:describe");
    assert.equal(accepted.autocomplete.active, false);
});

test("prompt enhancer autocomplete dismissal suppresses refresh until text changes", () => {
    const dismissal = dismissPromptAutocompleteUntilInput("@image1:character:", 18);

    assert.equal(shouldSuppressPromptAutocompleteRefresh(dismissal, "@image1:character:", 18), true);
    assert.equal(shouldSuppressPromptAutocompleteRefresh(dismissal, "@image1:character:", 17), true);
    assert.equal(shouldSuppressPromptAutocompleteRefresh(dismissal, "@image1:character:d", 19), false);

    const metadata = acceptPromptAutocompleteSuggestion(
        "[ref",
        autocompleteStateForPrompt("[ref", 4, [], 0, { promptType: "video" }),
        [],
        { promptType: "video" },
    );
    assert.equal(metadata.autocomplete.active, true);
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
        if (url.startsWith("/helto_prompt_enhancer/system_prompts?")) {
            return jsonResponse({
                kind: "image",
                presets: [
                    { kind: "image", id: "default", name: "Default image", prompt: "default", is_builtin: true },
                    { kind: "image", id: "flux", name: "Flux", prompt: "flux prompt", is_builtin: false },
                ],
            });
        }
        if (url === "/helto_prompt_enhancer/system_prompts") {
            const body = JSON.parse(options.body);
            return jsonResponse({
                kind: body.kind,
                id: body.id || "new-preset",
                name: body.name,
                prompt: body.prompt,
                is_builtin: false,
            });
        }
        if (url === "/helto_prompt_enhancer/system_prompts/default") {
            const body = JSON.parse(options.body);
            return jsonResponse({
                kind: body.kind,
                id: "default",
                name: "Default image",
                prompt: body.prompt,
                is_builtin: true,
                is_default: false,
            });
        }
        if (url === "/helto_prompt_enhancer/system_prompts/reset_default") {
            return jsonResponse({
                kind: "image",
                id: "default",
                name: "Default image",
                prompt: "packaged",
                is_builtin: true,
                is_default: true,
            });
        }
        if (url === "/helto_prompt_enhancer/system_prompts/delete") {
            return jsonResponse({ kind: "image", presets: [] });
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
    assert.deepEqual(await fetchSystemPromptPresets("image", fetchImpl), {
        kind: "image",
        presets: [
            { kind: "image", id: "default", name: "Default image", prompt: "default", is_builtin: true },
            { kind: "image", id: "flux", name: "Flux", prompt: "flux prompt", is_builtin: false },
        ],
    });
    assert.deepEqual(await saveSystemPromptPreset("image", { name: "New", prompt: "new prompt" }, fetchImpl), {
        kind: "image",
        id: "new-preset",
        name: "New",
        prompt: "new prompt",
        is_builtin: false,
    });
    assert.deepEqual(await saveDefaultSystemPrompt("image", "configured", fetchImpl), {
        kind: "image",
        id: "default",
        name: "Default image",
        prompt: "configured",
        is_builtin: true,
        is_default: false,
    });
    assert.deepEqual(await resetDefaultSystemPrompt("image", fetchImpl), {
        kind: "image",
        id: "default",
        name: "Default image",
        prompt: "packaged",
        is_builtin: true,
        is_default: true,
    });
    assert.deepEqual(await deleteSystemPromptPreset("image", "flux", fetchImpl), {
        kind: "image",
        presets: [],
    });

    assert.equal(calls[0].url, "/helto_prompt_enhancer/system_prompt?kind=image");
    assert.equal(calls[1].url, "/helto_prompt_enhancer/system_prompt");
    assert.equal(calls[1].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[1].options.body), { kind: "image", prompt: "edited" });
    assert.equal(calls[2].url, "/helto_prompt_enhancer/system_prompt/reset");
    assert.deepEqual(JSON.parse(calls[2].options.body), { kind: "image" });
    assert.equal(calls[3].url, "/helto_prompt_enhancer/system_prompts?kind=image");
    assert.equal(calls[4].url, "/helto_prompt_enhancer/system_prompts");
    assert.deepEqual(JSON.parse(calls[4].options.body), {
        kind: "image",
        name: "New",
        prompt: "new prompt",
    });
    assert.equal(calls[5].url, "/helto_prompt_enhancer/system_prompts/default");
    assert.deepEqual(JSON.parse(calls[5].options.body), { kind: "image", prompt: "configured" });
    assert.equal(calls[6].url, "/helto_prompt_enhancer/system_prompts/reset_default");
    assert.deepEqual(JSON.parse(calls[6].options.body), { kind: "image" });
    assert.equal(calls[7].url, "/helto_prompt_enhancer/system_prompts/delete");
    assert.deepEqual(JSON.parse(calls[7].options.body), { kind: "image", id: "flux" });
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
            { name: "image_system_prompt_preset" },
            { name: "video_system_prompt_preset" },
            { name: "script" },
            { name: "external_prompt" },
            { name: "variables" },
            { name: "generation_max_tokens" },
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
    assert.equal(node.widgets[9].hidden, true);
    assert.equal(Boolean(node.widgets[10].hidden), false);
    assert.notEqual(node.widgets[10].type, "hidden");
    assert.equal(node.widgets[11].hidden, true);
    assert.equal(node.widgets[12].hidden, true);
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
        "image_system_prompt_preset",
        "video_system_prompt_preset",
        "generation_max_tokens",
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
    const selectorApi = countingPrivacyApi();
    const node = {
        widgets: [
            { name: "variables", value: "[]" },
        ],
    };
    const variables = [{ name: "style", mode: "fixed", values: ["cinematic"], fixed_index: 0 }];

    const encrypted = await writePromptVariables(node, variables, true, selectorApi);
    const repeated = await writePromptVariables(node, [{ fixed_index: 0, values: ["cinematic"], mode: "fixed", name: "style" }], true, selectorApi);

    assert.equal(isEncryptedVariables(encrypted), true);
    assert.equal(repeated, encrypted);
    assert.equal(selectorApi.encryptCount, 1);
    assert.deepEqual(await readPromptVariables(node, selectorApi), variables);

    const changed = await writePromptVariables(node, [{ name: "style", mode: "fixed", values: ["documentary"], fixed_index: 0 }], true, selectorApi);
    assert.notEqual(changed, encrypted);
    assert.equal(selectorApi.encryptCount, 2);

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

test("prompt enhancer prompt config reuses restored envelopes until text changes", async () => {
    const selectorApi = countingPrivacyApi();
    const node = {
        widgets: [
            { name: "script", value: "" },
        ],
    };

    const first = await writePromptText(node, "stable prompt", true, selectorApi);
    const repeated = await writePromptText(node, "stable prompt", true, selectorApi);

    assert.equal(repeated, first);
    assert.equal(selectorApi.encryptCount, 1);

    const changed = await writePromptText(node, "edited prompt", true, selectorApi);

    assert.notEqual(changed, first);
    assert.equal(selectorApi.encryptCount, 2);

    node.widgets[0].value = first;
    assert.equal(await readPromptText(node, selectorApi), "stable prompt");
    const restored = await writePromptText(node, "stable prompt", true, selectorApi);

    assert.equal(restored, first);
    assert.equal(selectorApi.encryptCount, 2);
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

    state = autocompleteStateForPrompt("@image1:character:d", 19, [], 0, context);
    assert.deepEqual(state.options, ["describe"]);
    assert.deepEqual(insertVariableSuggestion("@image1:character:d", state), {
        text: "@image1:character:describe",
        cursor: 26,
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
    assert.equal(promptAutocompleteShortcutAction({ key: "Enter" }, state), "accept");
    assert.equal(promptAutocompleteShortcutAction({ key: "Tab" }, state), "accept");
    assert.equal(promptAutocompleteShortcutAction({ key: "ArrowDown" }, state), "next");
    assert.equal(promptAutocompleteShortcutAction({ key: "ArrowUp" }, state), "previous");
    assert.equal(promptAutocompleteShortcutAction({ key: "n", ctrlKey: true }, state), "");
    assert.equal(promptAutocompleteShortcutAction({ key: "p", ctrlKey: true }, state), "");
    assert.equal(promptAutocompleteShortcutAction({ key: "a", ctrlKey: true }, state), "");
    assert.equal(promptAutocompleteShortcutAction({ key: "v", ctrlKey: true }, state), "");
    assert.equal(promptAutocompleteShortcutAction({ key: "z", ctrlKey: true }, state), "");
});

test("prompt enhancer autocomplete guard consumes arrow navigation only for focused active editors", () => {
    const state = autocompleteStateForPrompt("[", 1, [], 0, { promptType: "video" });
    const calls = [];
    const event = {
        key: "ArrowDown",
        preventDefault: () => calls.push("prevent"),
        stopPropagation: () => calls.push("stop"),
        stopImmediatePropagation: () => calls.push("stop-immediate"),
    };

    assert.equal(promptAutocompleteShortcutGuardAction(event, state, true), "next");
    assert.deepEqual(calls, ["prevent", "stop", "stop-immediate"]);
    assert.equal(promptAutocompleteShortcutGuardAction({ key: "ArrowDown" }, state, false), "");
    assert.equal(promptAutocompleteShortcutGuardAction({ key: "ArrowDown" }, emptyAutocompleteState(1), true), "");
});

test("prompt enhancer autocomplete guard preserves unrelated focused editor shortcuts", () => {
    const state = autocompleteStateForPrompt("[", 1, [], 0, { promptType: "video" });
    const shortcuts = ["a", "c", "v", "x", "z", "n", "p"];
    for (const key of shortcuts) {
        const calls = [];
        const event = {
            key,
            ctrlKey: true,
            preventDefault: () => calls.push("prevent"),
            stopPropagation: () => calls.push("stop"),
            stopImmediatePropagation: () => calls.push("stop-immediate"),
        };
        assert.equal(promptAutocompleteShortcutGuardAction(event, state, true), "");
        assert.deepEqual(calls, []);
    }
});

test("prompt enhancer autocomplete guard consumes all intellisense control shortcuts", () => {
    const state = autocompleteStateForPrompt("[", 1, [], 0, { promptType: "video" });
    const cases = [
        [{ key: "Escape" }, "close"],
        [{ key: "y", ctrlKey: true }, "accept"],
        [{ key: "Enter" }, "accept"],
        [{ key: "Tab" }, "accept"],
        [{ key: "ArrowDown" }, "next"],
        [{ key: "ArrowUp" }, "previous"],
    ];

    for (const [baseEvent, action] of cases) {
        const calls = [];
        const event = {
            ...baseEvent,
            preventDefault: () => calls.push("prevent"),
            stopPropagation: () => calls.push("stop"),
            stopImmediatePropagation: () => calls.push("stop-immediate"),
        };
        assert.equal(promptAutocompleteShortcutGuardAction(event, state, true), action);
        assert.deepEqual(calls, ["prevent", "stop", "stop-immediate"]);
    }
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

test("privacy show any owner-aware state reuses envelopes until text changes", async () => {
    const selectorApi = countingPrivacyApi();
    const node = {};

    const first = await encryptTextStateForOwner(node, "private", selectorApi);
    const repeated = await encryptTextStateForOwner(node, "private", selectorApi);

    assert.equal(repeated, first);
    assert.equal(selectorApi.encryptCount, 1);

    const changed = await encryptTextStateForOwner(node, "edited", selectorApi);

    assert.notEqual(changed, first);
    assert.equal(selectorApi.encryptCount, 2);

    assert.equal(await decryptTextStateForOwner(node, first, selectorApi), "private");
    const restored = await encryptTextStateForOwner(node, "private", selectorApi);

    assert.equal(restored, first);
    assert.equal(selectorApi.encryptCount, 2);
});

test("privacy show any writes encrypted state to widget and property only", () => {
    const node = { properties: {} };
    const widget = { name: PRIVACY_SHOW_ANY_STATE_WIDGET, value: "" };

    assert.equal(setEncryptedPrivacyShowAnyState(node, widget, "__HELTO_ENC__:abc"), "__HELTO_ENC__:abc");
    assert.equal(widget.value, "__HELTO_ENC__:abc");
    assert.equal(node.properties[PRIVACY_SHOW_ANY_STATE_PROPERTY], "__HELTO_ENC__:abc");
    assert.equal(serializedEncryptedPropertyValue(node), "__HELTO_ENC__:abc");

    assert.equal(setEncryptedPrivacyShowAnyState(node, widget, "plain text"), "");
    assert.equal(widget.value, "");
    assert.equal(PRIVACY_SHOW_ANY_STATE_PROPERTY in node.properties, false);
});

test("privacy show any restore state prefers encrypted widget then encrypted property", () => {
    const node = {
        properties: { [PRIVACY_SHOW_ANY_STATE_PROPERTY]: "__HELTO_ENC__:property" },
        widgets: [{ name: PRIVACY_SHOW_ANY_STATE_WIDGET, value: "__HELTO_ENC__:widget" }],
    };

    assert.equal(encryptedPrivacyShowAnyState(node), "__HELTO_ENC__:widget");
    node.widgets[0].value = "";
    assert.equal(encryptedPrivacyShowAnyState(node), "__HELTO_ENC__:property");
    node.properties[PRIVACY_SHOW_ANY_STATE_PROPERTY] = "plain text";
    assert.equal(encryptedPrivacyShowAnyState(node), "");
});

test("privacy show any serialized properties keep only encrypted state", () => {
    const info = {
        properties: { [PRIVACY_SHOW_ANY_STATE_PROPERTY]: "plain text", other: "kept" },
    };

    assert.equal(sanitizePrivacyShowAnySerializedProperties(info, "__HELTO_ENC__:abc"), "__HELTO_ENC__:abc");
    assert.deepEqual(info.properties, {
        [PRIVACY_SHOW_ANY_STATE_PROPERTY]: "__HELTO_ENC__:abc",
        other: "kept",
    });

    assert.equal(sanitizePrivacyShowAnySerializedProperties(info, "plain text"), "");
    assert.deepEqual(info.properties, { other: "kept" });
});

test("privacy show any collects nodes from graph, inner nodes, and subgraphs", () => {
    const rootPrivacyNode = { comfyClass: "HeltoPrivacyShowAny" };
    const innerPrivacyNode = { type: "HeltoPrivacyShowAny" };
    const subgraphPrivacyNode = { comfyClass: "HeltoPrivacyShowAny" };
    const containerNode = {
        comfyClass: "Container",
        getInnerNodes() {
            return [innerPrivacyNode, rootPrivacyNode];
        },
    };
    const graph = {
        computeExecutionOrder() {
            return [rootPrivacyNode, containerNode, { comfyClass: "Other" }];
        },
        subgraphs: new Map([
            ["subgraph", { _nodes: [subgraphPrivacyNode, innerPrivacyNode] }],
        ]),
    };

    assert.deepEqual(
        collectPrivacyShowAnyNodes(graph),
        [rootPrivacyNode, innerPrivacyNode, subgraphPrivacyNode],
    );
});

test("privacy show any waits for pending encryption and fails closed on rejection", async () => {
    const pendingKey = "__pendingEncryption";
    const events = [];
    const encryptedNode = {
        comfyClass: "HeltoPrivacyShowAny",
        [pendingKey]: new Promise((resolve) => setTimeout(() => {
            events.push("encrypted");
            resolve("__HELTO_ENC__:ok");
        }, 0)),
    };
    const failedNode = {
        comfyClass: "HeltoPrivacyShowAny",
        [pendingKey]: Promise.reject(new Error("offline")),
        stateWidget: { value: "plain text" },
    };
    const graph = { _nodes: [encryptedNode, failedNode] };

    const nodes = await flushPrivacyShowAnyEncryption(graph, pendingKey, (node) => {
        node.stateWidget.value = "";
        events.push("failed");
    });

    assert.deepEqual(nodes, [encryptedNode, failedNode]);
    assert.deepEqual(events.sort(), ["encrypted", "failed"]);
    assert.equal(failedNode.stateWidget.value, "");
});

test("privacy show any display reveals only when hover state is active", () => {
    assert.deepEqual(
        privacyShowAnyDisplayState("secret text", false),
        { value: "", placeholder: "" },
    );
    assert.deepEqual(
        privacyShowAnyDisplayState("secret text", true),
        { value: "secret text", placeholder: "" },
    );
    assert.deepEqual(
        privacyShowAnyDisplayState("", true),
        { value: "", placeholder: "Run the node to display text." },
    );
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
