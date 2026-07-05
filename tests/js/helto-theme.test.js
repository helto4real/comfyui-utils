import assert from "node:assert/strict";
import test from "node:test";

import {
    HELTO,
    HELTO_UTILS_THEME_NODE_TYPES,
    applyHeltoLiteGraphWidgetTheme,
    applyHeltoNodeTheme,
    applyHeltoUtilsNodeTheme,
    heltoNodeTypeCandidates,
    isHeltoThemedNode,
    isHeltoThemedNodeData,
    restoreHeltoLiteGraphWidgetTheme,
    withHeltoLiteGraphWidgetTheme,
} from "../../web/helto_theme.js";

test("the theme allowlist covers every comfyui-utils node class", () => {
    assert.deepEqual([...HELTO_UTILS_THEME_NODE_TYPES].sort(), [
        "AspectRatioCalculator",
        "HeltoImageComparer",
        "HeltoImageSelector",
        "HeltoLoadVideo",
        "HeltoPrivacyShowAny",
        "HeltoPromptEnhancer",
        "HeltoSaveImageAdvanced",
        "HeltoSaveVideoAdvanced",
        "HeltoVideoComparer",
        "HeltoVideoParams",
        "HeltoVideoParamsLTX",
        "ModelAutoRouter",
    ].sort());
});

test("themed node detection uses ComfyUI node data and node instances", () => {
    assert.equal(isHeltoThemedNodeData({ name: "HeltoSaveImageAdvanced" }), true);
    assert.equal(isHeltoThemedNodeData({ name: "OtherNode", display_name: "Helto Image Comparer" }), false);
    assert.equal(isHeltoThemedNodeData({ name: "KSampler" }), false);

    const node = {
        type: "unknown",
        comfyClass: "HeltoImageSelector",
        constructor: {
            nodeData: {
                name: "HeltoImageSelector",
            },
        },
    };
    assert.equal(isHeltoThemedNode(node), true);
    assert.deepEqual(heltoNodeTypeCandidates(node), [
        "unknown",
        "HeltoImageSelector",
        "HeltoImageSelector",
    ]);
    assert.equal(isHeltoThemedNode({ comfyClass: "KSampler" }), false);
});

test("node theme applies Helto canvas colors and dirties canvases", () => {
    const node = {
        comfyClass: "HeltoPromptEnhancer",
        dirtyCalls: [],
        graph: {
            dirtyCalls: [],
            setDirtyCanvas(...args) {
                this.dirtyCalls.push(args);
            },
        },
        setDirtyCanvas(...args) {
            this.dirtyCalls.push(args);
        },
    };

    assert.equal(applyHeltoUtilsNodeTheme(node), true);
    assert.equal(node.color, HELTO.surface3);
    assert.equal(node.bgcolor, HELTO.surface);
    assert.deepEqual(node.dirtyCalls, [[true, true]]);
    assert.deepEqual(node.graph.dirtyCalls, [[true, true]]);

    assert.equal(applyHeltoUtilsNodeTheme({ comfyClass: "KSampler" }), false);
    assert.equal(applyHeltoNodeTheme(null), false);
});

test("LiteGraph widget theme applies and restores only known keys", () => {
    const liteGraph = {
        WIDGET_BGCOLOR: "#222",
        WIDGET_OUTLINE_COLOR: "#666",
        WIDGET_PROMOTED_OUTLINE_COLOR: "#BF00FF",
        WIDGET_ADVANCED_OUTLINE_COLOR: "rgba(56, 139, 253, 0.8)",
        WIDGET_TEXT_COLOR: "#DDD",
        WIDGET_SECONDARY_TEXT_COLOR: "#999",
        WIDGET_DISABLED_TEXT_COLOR: "#777",
        unrelated: "keep",
    };
    const previous = { ...liteGraph };

    const result = withHeltoLiteGraphWidgetTheme(() => {
        assert.equal(liteGraph.WIDGET_BGCOLOR, HELTO.bg);
        assert.equal(liteGraph.WIDGET_OUTLINE_COLOR, HELTO.borderStrong);
        assert.equal(liteGraph.WIDGET_PROMOTED_OUTLINE_COLOR, HELTO.accent);
        assert.equal(liteGraph.WIDGET_ADVANCED_OUTLINE_COLOR, HELTO.focus);
        assert.equal(liteGraph.WIDGET_TEXT_COLOR, HELTO.text);
        assert.equal(liteGraph.WIDGET_SECONDARY_TEXT_COLOR, HELTO.textDim);
        assert.equal(liteGraph.WIDGET_DISABLED_TEXT_COLOR, HELTO.textFaint);
        assert.equal(liteGraph.unrelated, "keep");
        return "painted";
    }, liteGraph);

    assert.equal(result, "painted");
    assert.deepEqual(liteGraph, previous);
});

test("LiteGraph widget theme restores after errors and ignores missing keys", () => {
    const liteGraph = {
        WIDGET_BGCOLOR: "#222",
    };
    const previous = { ...liteGraph };

    assert.throws(() => {
        withHeltoLiteGraphWidgetTheme(() => {
            assert.equal(liteGraph.WIDGET_BGCOLOR, HELTO.bg);
            assert.equal("WIDGET_TEXT_COLOR" in liteGraph, false);
            throw new Error("draw failed");
        }, liteGraph);
    }, /draw failed/);

    assert.deepEqual(liteGraph, previous);

    const snapshot = applyHeltoLiteGraphWidgetTheme(null);
    assert.equal(snapshot, null);
    assert.equal(restoreHeltoLiteGraphWidgetTheme(snapshot), false);
});
