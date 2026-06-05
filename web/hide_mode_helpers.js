export function previewKeysForNode(node) {
    const keys = [String(node.id)];
    const graphId = node.graph?.id;
    if (graphId && !node.graph?.isRootGraph) {
        keys.push(`${graphId}:${node.id}`);
    }
    return keys;
}

export function storeOutputForPreviewKeys(app, node, output) {
    app.nodeOutputs ??= {};

    for (const key of previewKeysForNode(node)) {
        app.nodeOutputs[key] = output;
    }
}

function finiteSize(value) {
    if (!Array.isArray(value) || value.length < 2) {
        return null;
    }

    const width = Number(value[0]);
    const height = Number(value[1]);
    return Number.isFinite(width) && Number.isFinite(height) ? [width, height] : null;
}

export function expandNodeToComputedSize(node) {
    const computedSize = finiteSize(node?.computeSize?.());
    const currentSize = finiteSize(node?.size);
    const nextSize = computedSize
        ? [
            Math.max(currentSize?.[0] ?? computedSize[0], computedSize[0]),
            Math.max(currentSize?.[1] ?? computedSize[1], computedSize[1]),
        ]
        : currentSize;

    if (!nextSize || typeof node?.setSize !== "function") {
        return nextSize;
    }

    if (!currentSize || nextSize[0] !== currentSize[0] || nextSize[1] !== currentSize[1]) {
        node.setSize(nextSize);
    }

    return nextSize;
}

export function restoreNodeSize(node, size) {
    const targetSize = finiteSize(size);
    if (!targetSize || typeof node?.setSize !== "function") {
        return targetSize;
    }

    node.setSize([...targetSize]);
    node.graph?.setDirtyCanvas?.(true, true);
    return targetSize;
}

function hydratedRestoreSize(node, targetSize) {
    const currentSize = finiteSize(node?.size);
    if (!currentSize) {
        return targetSize;
    }

    return [
        Math.max(currentSize[0], targetSize[0]),
        Math.max(currentSize[1], targetSize[1]),
    ];
}

export function scheduleNodeSizeRestore(node, size) {
    const targetSize = finiteSize(size);
    if (!targetSize || typeof node?.setSize !== "function") {
        return null;
    }

    const tokenKey = "__heltoNodeSizeRestoreToken";
    node[tokenKey] = (node[tokenKey] ?? 0) + 1;
    const token = node[tokenKey];
    const restore = () => {
        if (node[tokenKey] !== token) {
            return;
        }

        restoreNodeSize(node, hydratedRestoreSize(node, targetSize));
    };

    restore();
    globalThis.requestAnimationFrame?.(restore);
    for (const delay of [50, 150, 300, 600, 1000, 1600, 2400]) {
        globalThis.setTimeout?.(restore, delay);
    }

    return targetSize;
}

export function runWithPreviewPriming(node, callback) {
    const hadHideOutputImages = Object.prototype.hasOwnProperty.call(node, "hideOutputImages");
    const previousHideOutputImages = node.hideOutputImages;
    node.hideOutputImages = false;

    try {
        return callback();
    } finally {
        if (hadHideOutputImages) {
            node.hideOutputImages = previousHideOutputImages;
        } else {
            delete node.hideOutputImages;
        }
    }
}
