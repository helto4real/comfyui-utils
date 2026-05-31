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
