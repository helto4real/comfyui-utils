import assert from "node:assert/strict";
import test from "node:test";

import {
    NODE_LAYOUT_ACTIONS,
    applyLayoutAction,
    canUseLayoutTools,
    menuItemsForMaster,
    nodeRect,
    positionForAction,
    selectedNodesFromCanvas,
    sizeForAction,
} from "../../web/node_layout_tools.js";

function createGraph() {
    return {
        beforeCount: 0,
        afterCount: 0,
        changeCount: 0,
        beforeChange() {
            this.beforeCount += 1;
        },
        afterChange() {
            this.afterCount += 1;
        },
        change() {
            this.changeCount += 1;
        },
    };
}

function createNode(id, pos, size, graph) {
    return {
        id,
        pos: [...pos],
        size: [...size],
        graph,
        setSizeCalls: [],
        setSize(nextSize) {
            this.setSizeCalls.push([...nextSize]);
            this.size = [...nextSize];
            this.onResize?.(nextSize);
        },
    };
}

function createCanvas(nodes, graph = nodes[0]?.graph ?? createGraph()) {
    return {
        graph,
        selected_nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
        state: {},
        dirtyCalls: [],
        setDirty(fgCanvas, bgCanvas) {
            this.dirtyCalls.push([fgCanvas, bgCanvas]);
        },
    };
}

test("selectedNodesFromCanvas returns layout-capable selected nodes only", () => {
    const graph = createGraph();
    const first = createNode(1, [10, 20], [100, 40], graph);
    const second = { id: 2, pos: [30, 40], size: ["bad", 20], graph };
    const third = createNode(3, new Float32Array([50, 60]), new Float32Array([120, 80]), graph);
    const canvas = {
        selected_nodes: {
            first,
            second,
            third,
        },
    };

    assert.deepEqual(selectedNodesFromCanvas(canvas), [first, third]);
});

test("layout tools require multiple selected nodes and the master in selection", () => {
    const graph = createGraph();
    const master = createNode(1, [10, 20], [100, 40], graph);
    const sibling = createNode(2, [200, 220], [90, 60], graph);
    const outside = createNode(3, [300, 320], [80, 50], graph);

    assert.equal(canUseLayoutTools(master, createCanvas([master])), false);
    assert.equal(canUseLayoutTools(outside, createCanvas([master, sibling])), false);
    assert.equal(canUseLayoutTools(master, createCanvas([master, sibling])), true);
});

test("positionForAction aligns target edges to the master node", () => {
    const graph = createGraph();
    const master = createNode(1, [10, 20], [120, 70], graph);
    const target = createNode(2, [300, 400], [80, 50], graph);

    assert.deepEqual(nodeRect(master), {
        left: 10,
        top: 20,
        width: 120,
        height: 70,
        right: 130,
        bottom: 90,
    });
    assert.deepEqual(positionForAction("align-left", master, target), [10, 400]);
    assert.deepEqual(positionForAction("align-top", master, target), [300, 20]);
    assert.deepEqual(positionForAction("align-bottom", master, target), [300, 40]);
    assert.deepEqual(positionForAction("align-right", master, target), [50, 400]);
});

test("sizeForAction copies the selected dimension from the master node", () => {
    const graph = createGraph();
    const master = createNode(1, [10, 20], [120, 70], graph);
    const target = createNode(2, [300, 400], [80, 50], graph);

    assert.deepEqual(sizeForAction("same-width", master, target), [120, 50]);
    assert.deepEqual(sizeForAction("same-height", master, target), [80, 70]);
    assert.deepEqual(sizeForAction("same-size", master, target), [120, 70]);
});

test("applyLayoutAction aligns every selected sibling and leaves the master untouched", () => {
    const graph = createGraph();
    const master = createNode(1, [10, 20], [120, 70], graph);
    const firstTarget = createNode(2, [300, 400], [80, 50], graph);
    const secondTarget = createNode(3, [500, 600], [90, 100], graph);
    const canvas = createCanvas([master, firstTarget, secondTarget], graph);

    const result = applyLayoutAction("align-right", master, { canvas });

    assert.deepEqual(result, { changed: 2, actionId: "align-right" });
    assert.deepEqual(master.pos, [10, 20]);
    assert.deepEqual(firstTarget.pos, [50, 400]);
    assert.deepEqual(secondTarget.pos, [40, 600]);
    assert.equal(graph.beforeCount, 1);
    assert.equal(graph.afterCount, 1);
    assert.equal(graph.changeCount, 1);
    assert.deepEqual(canvas.dirtyCalls, [[true, true]]);
    assert.equal(canvas.state.selectionChanged, true);
});

test("applyLayoutAction resizes every selected sibling through setSize", () => {
    const graph = createGraph();
    const master = createNode(1, [10, 20], [120, 70], graph);
    const firstTarget = createNode(2, [300, 400], [80, 50], graph);
    const secondTarget = createNode(3, [500, 600], [90, 100], graph);
    const canvas = createCanvas([master, firstTarget, secondTarget], graph);

    const result = applyLayoutAction("same-size", master, { canvas });

    assert.deepEqual(result, { changed: 2, actionId: "same-size" });
    assert.deepEqual(master.size, [120, 70]);
    assert.deepEqual(firstTarget.size, [120, 70]);
    assert.deepEqual(secondTarget.size, [120, 70]);
    assert.deepEqual(firstTarget.setSizeCalls, [[120, 70]]);
    assert.deepEqual(secondTarget.setSizeCalls, [[120, 70]]);
    assert.equal(graph.beforeCount, 1);
    assert.equal(graph.afterCount, 1);
    assert.equal(graph.changeCount, 1);
});

test("applyLayoutAction is a no-op for unknown actions or invalid selection", () => {
    const graph = createGraph();
    const master = createNode(1, [10, 20], [120, 70], graph);
    const canvas = createCanvas([master], graph);

    assert.deepEqual(applyLayoutAction("align-left", master, { canvas }), {
        changed: 0,
        actionId: "align-left",
        reason: "invalid-selection",
    });
    assert.deepEqual(applyLayoutAction("unknown", master, { canvas }), {
        changed: 0,
        actionId: "unknown",
        reason: "unknown-action",
    });
    assert.equal(graph.beforeCount, 0);
    assert.equal(graph.afterCount, 0);
    assert.equal(graph.changeCount, 0);
    assert.deepEqual(canvas.dirtyCalls, []);
});

test("menuItemsForMaster exposes the compact layout submenu only for valid masters", () => {
    const graph = createGraph();
    const master = createNode(1, [10, 20], [120, 70], graph);
    const sibling = createNode(2, [300, 400], [80, 50], graph);
    const outside = createNode(3, [500, 600], [90, 100], graph);
    const canvas = createCanvas([master, sibling], graph);

    assert.deepEqual(menuItemsForMaster(outside, { canvas }), []);

    const items = menuItemsForMaster(master, { canvas });
    assert.equal(items.length, 2);
    assert.equal(items[0], null);
    assert.equal(items[1].content, "Align / Size Selection");
    assert.equal(items[1].has_submenu, true);
    assert.equal(typeof items[1].callback, "function");

    const previousLiteGraph = globalThis.LiteGraph;
    let createdMenu = null;
    globalThis.LiteGraph = {
        ContextMenu: class {
            constructor(options, menuOptions) {
                createdMenu = { options, menuOptions };
            }
        },
    };
    try {
        const event = { type: "contextmenu" };
        const parentMenu = { id: "parent" };
        items[1].callback(null, null, event, parentMenu);
        assert.deepEqual(
            createdMenu.options.map((option) => option.content),
            NODE_LAYOUT_ACTIONS.map((action) => action.label),
        );
        assert.deepEqual(createdMenu.menuOptions, {
            event,
            parentMenu,
        });
    } finally {
        if (previousLiteGraph === undefined) {
            delete globalThis.LiteGraph;
        } else {
            globalThis.LiteGraph = previousLiteGraph;
        }
    }
});
