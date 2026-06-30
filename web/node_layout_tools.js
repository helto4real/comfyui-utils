const ALIGN_LEFT = "align-left";
const ALIGN_TOP = "align-top";
const ALIGN_BOTTOM = "align-bottom";
const ALIGN_RIGHT = "align-right";
const SAME_WIDTH = "same-width";
const SAME_HEIGHT = "same-height";
const SAME_SIZE = "same-size";

export const NODE_LAYOUT_ACTIONS = [
    {
        id: ALIGN_LEFT,
        label: "Align left",
        icon: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4v16"/><path d="M9 7h10"/><path d="M9 17h7"/><path d="M9 7v4h10V7"/><path d="M9 13v4h7v-4"/></svg>`,
    },
    {
        id: ALIGN_TOP,
        label: "Align top",
        icon: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"/><path d="M7 9v10"/><path d="M17 9v7"/><path d="M7 9h4v10H7"/><path d="M13 9h4v7h-4"/></svg>`,
    },
    {
        id: ALIGN_BOTTOM,
        label: "Align bottom",
        icon: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M7 5v10"/><path d="M17 8v7"/><path d="M7 5h4v10H7"/><path d="M13 8h4v7h-4"/></svg>`,
    },
    {
        id: ALIGN_RIGHT,
        label: "Align right",
        icon: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 4v16"/><path d="M5 7h10"/><path d="M8 17h7"/><path d="M5 7v4h10V7"/><path d="M8 13v4h7v-4"/></svg>`,
    },
    {
        id: SAME_WIDTH,
        label: "Same width",
        icon: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="7" width="14" height="4" rx="1"/><rect x="5" y="15" width="14" height="4" rx="1"/><path d="M3 9h2"/><path d="M19 9h2"/><path d="M3 17h2"/><path d="M19 17h2"/></svg>`,
    },
    {
        id: SAME_HEIGHT,
        label: "Same height",
        icon: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="5" width="4" height="14" rx="1"/><rect x="15" y="5" width="4" height="14" rx="1"/><path d="M9 3v2"/><path d="M9 19v2"/><path d="M17 3v2"/><path d="M17 19v2"/></svg>`,
    },
    {
        id: SAME_SIZE,
        label: "Same size",
        icon: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="6" height="6" rx="1"/><rect x="13" y="5" width="6" height="6" rx="1"/><rect x="5" y="13" width="6" height="6" rx="1"/><rect x="13" y="13" width="6" height="6" rx="1"/></svg>`,
    },
];

const ACTION_BY_ID = new Map(NODE_LAYOUT_ACTIONS.map((action) => [action.id, action]));
const SIZE_ACTIONS = new Set([SAME_WIDTH, SAME_HEIGHT, SAME_SIZE]);
const ALIGN_ACTIONS = new Set([ALIGN_LEFT, ALIGN_TOP, ALIGN_BOTTOM, ALIGN_RIGHT]);

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function nodeId(node) {
    return node?.id ?? node?._id ?? node?.uuid ?? null;
}

function sameNode(left, right) {
    if (left === right) return true;
    const leftId = nodeId(left);
    const rightId = nodeId(right);
    return leftId !== null && rightId !== null && leftId === rightId;
}

function pointLike(value) {
    return value && typeof value === "object" && 0 in value && 1 in value;
}

export function isLayoutActionId(actionId) {
    return ACTION_BY_ID.has(actionId);
}

export function isLayoutNode(node) {
    if (!node || !pointLike(node.pos) || !pointLike(node.size)) return false;
    return finiteNumber(node.pos[0]) !== null
        && finiteNumber(node.pos[1]) !== null
        && finiteNumber(node.size[0]) !== null
        && finiteNumber(node.size[1]) !== null;
}

export function selectedNodesFromCanvas(canvas) {
    const selected = canvas?.selected_nodes;
    if (!selected || typeof selected !== "object") return [];

    const seen = new Set();
    const nodes = [];
    for (const node of Object.values(selected)) {
        if (!isLayoutNode(node)) continue;
        const key = nodeId(node) ?? node;
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push(node);
    }
    return nodes;
}

export function selectionContainsMaster(nodes, master) {
    if (!isLayoutNode(master)) return false;
    return nodes.some((node) => sameNode(node, master));
}

export function canUseLayoutTools(master, canvas) {
    const nodes = selectedNodesFromCanvas(canvas);
    return nodes.length > 1 && selectionContainsMaster(nodes, master);
}

export function nodeRect(node) {
    const left = finiteNumber(node?.pos?.[0]) ?? 0;
    const top = finiteNumber(node?.pos?.[1]) ?? 0;
    const width = Math.max(1, finiteNumber(node?.size?.[0]) ?? 1);
    const height = Math.max(1, finiteNumber(node?.size?.[1]) ?? 1);

    return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
    };
}

export function positionForAction(actionId, master, node) {
    const masterRect = nodeRect(master);
    const nodeBounds = nodeRect(node);

    switch (actionId) {
        case ALIGN_LEFT:
            return [masterRect.left, nodeBounds.top];
        case ALIGN_TOP:
            return [nodeBounds.left, masterRect.top];
        case ALIGN_BOTTOM:
            return [nodeBounds.left, masterRect.bottom - nodeBounds.height];
        case ALIGN_RIGHT:
            return [masterRect.right - nodeBounds.width, nodeBounds.top];
        default:
            return [nodeBounds.left, nodeBounds.top];
    }
}

export function sizeForAction(actionId, master, node) {
    const masterRect = nodeRect(master);
    const nodeBounds = nodeRect(node);

    switch (actionId) {
        case SAME_WIDTH:
            return [masterRect.width, nodeBounds.height];
        case SAME_HEIGHT:
            return [nodeBounds.width, masterRect.height];
        case SAME_SIZE:
            return [masterRect.width, masterRect.height];
        default:
            return [nodeBounds.width, nodeBounds.height];
    }
}

function setNodePosition(node, position) {
    const nextPosition = [position[0], position[1]];
    node.pos = nextPosition;
}

function setNodeSize(node, size) {
    const nextSize = [Math.max(1, size[0]), Math.max(1, size[1])];
    if (typeof node.setSize === "function") {
        node.setSize(nextSize);
    } else {
        node.size = nextSize;
        node.onResize?.(nextSize);
    }
}

function graphForSelection(master, canvas) {
    return master?.graph ?? canvas?.graph ?? null;
}

function markCanvasChanged(canvas) {
    if (!canvas) return;
    if (canvas.state && typeof canvas.state === "object") {
        canvas.state.selectionChanged = true;
    }
    canvas.setDirty?.(true, true);
}

export function applyLayoutAction(actionId, master, { canvas } = {}) {
    if (!isLayoutActionId(actionId)) return { changed: 0, actionId, reason: "unknown-action" };
    if (!canUseLayoutTools(master, canvas)) return { changed: 0, actionId, reason: "invalid-selection" };

    const nodes = selectedNodesFromCanvas(canvas);
    const targets = nodes.filter((node) => !sameNode(node, master));
    const graph = graphForSelection(master, canvas);
    let changed = 0;

    graph?.beforeChange?.();
    try {
        for (const node of targets) {
            if (ALIGN_ACTIONS.has(actionId)) {
                setNodePosition(node, positionForAction(actionId, master, node));
                changed += 1;
            } else if (SIZE_ACTIONS.has(actionId)) {
                setNodeSize(node, sizeForAction(actionId, master, node));
                changed += 1;
            }
        }
    } finally {
        graph?.afterChange?.();
    }

    if (changed > 0) {
        graph?.change?.();
        markCanvasChanged(canvas);
    }

    return { changed, actionId };
}

export function menuItemsForMaster(master, { canvas } = {}) {
    if (!canUseLayoutTools(master, canvas)) return [];

    return [
        null,
        {
            content: "Align / Size Selection",
            has_submenu: true,
            callback: (_value, _options, event, prevMenu) => {
                const options = NODE_LAYOUT_ACTIONS.map((action) => ({
                    content: action.label,
                    callback: () => applyLayoutAction(action.id, master, { canvas }),
                }));
                const ContextMenu = globalThis.LiteGraph?.ContextMenu;
                if (typeof ContextMenu === "function") {
                    new ContextMenu(options, {
                        event,
                        parentMenu: prevMenu,
                    });
                }
            },
        },
    ];
}
