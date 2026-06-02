export const PRIVACY_SHOW_ANY_NODE_CLASS = "HeltoPrivacyShowAny";
export const PRIVACY_SHOW_ANY_STATE_WIDGET = "encrypted_text_state";
export const PRIVACY_SHOW_ANY_STATE_PROPERTY = "helto_privacy_show_any_encrypted_text_state";
export const PRIVACY_SHOW_ANY_UI_KEY = "helto_privacy_show_any";
export const ENCRYPTED_PREFIX = "__HELTO_ENC__:";
export const PRIVACY_SHOW_ANY_LAYOUT = Object.freeze({
    minWidth: 360,
    minNodeHeight: 300,
    minWidgetHeight: 160,
    minTextHeight: 80,
    defaultWidgetHeight: 220,
    bottomGutter: 12,
    framePaddingY: 16,
    toolbarGap: 8,
    toolbarHeight: 30,
    vueChromeHeight: 76,
});

export function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget?.name === name) ?? null;
}

export function isEncryptedText(value) {
    return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}

export function extractPrivacyShowAnyText(output) {
    const records = output?.[PRIVACY_SHOW_ANY_UI_KEY];
    const first = Array.isArray(records) ? records[0] : records;
    return typeof first?.text === "string" ? first.text : "";
}

export function hidePrivacyShowAnyStateWidget(node, collapseWidgetLayout) {
    const widget = getWidget(node, PRIVACY_SHOW_ANY_STATE_WIDGET);
    if (!widget) return null;
    widget.hidden = true;
    widget.type = "hidden";
    collapseWidgetLayout?.(widget);
    return widget;
}

export async function encryptTextState(text, selectorApi) {
    const plain = String(text ?? "");
    if (!plain) return "";
    const result = await selectorApi.encrypt(plain);
    return isEncryptedText(result?.encrypted) ? result.encrypted : "";
}

export async function decryptTextState(encrypted, selectorApi) {
    if (!isEncryptedText(encrypted)) return "";
    const result = await selectorApi.decrypt(encrypted);
    return typeof result?.data === "string" ? result.data : "";
}

export function serializedEncryptedWidgetValue(widget) {
    return serializedEncryptedValue(widget?.value);
}

export function serializedEncryptedValue(value) {
    return isEncryptedText(value) ? value : "";
}

export function serializedEncryptedPropertyValue(node) {
    return serializedEncryptedValue(node?.properties?.[PRIVACY_SHOW_ANY_STATE_PROPERTY]);
}

export function encryptedPrivacyShowAnyState(node, stateWidget = getWidget(node, PRIVACY_SHOW_ANY_STATE_WIDGET)) {
    return serializedEncryptedWidgetValue(stateWidget) || serializedEncryptedPropertyValue(node);
}

export function setEncryptedPrivacyShowAnyState(node, stateWidget, encrypted) {
    const safe = serializedEncryptedValue(encrypted);
    if (stateWidget) {
        stateWidget.value = safe;
    }
    if (node) {
        node.properties ??= {};
        if (safe) {
            node.properties[PRIVACY_SHOW_ANY_STATE_PROPERTY] = safe;
        } else {
            delete node.properties[PRIVACY_SHOW_ANY_STATE_PROPERTY];
        }
    }
    return safe;
}

export function sanitizePrivacyShowAnySerializedProperties(info, encrypted) {
    if (!info) return "";
    const safe = serializedEncryptedValue(encrypted);
    info.properties ??= {};
    if (safe) {
        info.properties[PRIVACY_SHOW_ANY_STATE_PROPERTY] = safe;
    } else {
        delete info.properties[PRIVACY_SHOW_ANY_STATE_PROPERTY];
    }
    return safe;
}

export function isPrivacyShowAnyNode(node) {
    return node?.comfyClass === PRIVACY_SHOW_ANY_NODE_CLASS || node?.type === PRIVACY_SHOW_ANY_NODE_CLASS;
}

function iterableValues(value) {
    if (!value) return [];
    if (value instanceof Map) return value.values();
    if (typeof value[Symbol.iterator] === "function") return value;
    if (typeof value === "object") return Object.values(value);
    return [];
}

export function collectPrivacyShowAnyNodes(graph) {
    const found = [];
    const seen = new Set();

    const visitNode = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        if (isPrivacyShowAnyNode(node)) {
            found.push(node);
        }
        const innerNodes = typeof node.getInnerNodes === "function" ? node.getInnerNodes(new Map()) : [];
        for (const innerNode of iterableValues(innerNodes)) {
            visitNode(innerNode);
        }
        const subgraphNodes = node.subgraph?._nodes ?? node.subgraph?.nodes ?? [];
        for (const subgraphNode of iterableValues(subgraphNodes)) {
            visitNode(subgraphNode);
        }
    };

    const graphNodes = typeof graph?.computeExecutionOrder === "function"
        ? graph.computeExecutionOrder(false)
        : graph?._nodes ?? graph?.nodes ?? [];
    for (const node of iterableValues(graphNodes)) {
        visitNode(node);
    }

    for (const subgraph of iterableValues(graph?.subgraphs)) {
        const nodes = subgraph?._nodes ?? subgraph?.nodes ?? [];
        for (const node of iterableValues(nodes)) {
            visitNode(node);
        }
    }

    return found;
}

export async function flushPrivacyShowAnyEncryption(graph, pendingPromiseKey, onRejected = null) {
    const nodes = collectPrivacyShowAnyNodes(graph);
    await Promise.all(nodes.map(async (node) => {
        const promise = pendingPromiseKey ? node?.[pendingPromiseKey] : null;
        if (!promise) return;
        try {
            await promise;
        } catch (err) {
            onRejected?.(node, err);
        }
    }));
    return nodes;
}

export function configurePrivacyShowAnyTextarea(textarea) {
    if (!textarea) return textarea;
    textarea.readOnly = true;
    textarea.wrap = "soft";
    textarea.spellcheck = false;
    return textarea;
}

export function privacyShowAnyTextareaState(text, revealed, emptyPlaceholder = "Run the node to display text.") {
    const plain = String(text ?? "");
    return {
        value: revealed ? plain : "",
        placeholder: plain ? "" : emptyPlaceholder,
    };
}

export function getPrivacyShowAnyWidgetStartY(node, domWidget, fallback = 92) {
    if (Number.isFinite(domWidget?.last_y)) return domWidget.last_y;
    if (Number.isFinite(domWidget?.y)) return domWidget.y;

    if (domWidget && Array.isArray(node?.widgets)) {
        const index = node.widgets.indexOf(domWidget);
        for (let i = index - 1; i >= 0; i--) {
            const widget = node.widgets[i];
            if (!widget || widget.type === "hidden" || widget.hidden) continue;
            if (Number.isFinite(widget.y)) {
                return widget.y + (Number.isFinite(widget.height) ? widget.height : 24) + 6;
            }
        }
    }

    return fallback;
}

export function getPrivacyShowAnyWidgetHeight(node, startY, layout = PRIVACY_SHOW_ANY_LAYOUT) {
    const nodeHeight = Array.isArray(node?.size) && Number.isFinite(node.size[1])
        ? node.size[1]
        : layout.minNodeHeight;
    return Math.max(layout.minWidgetHeight, nodeHeight - startY - layout.bottomGutter);
}

export function getPrivacyShowAnyTextAreaHeight(totalHeight, toolbarHeight = PRIVACY_SHOW_ANY_LAYOUT.toolbarHeight, layout = PRIVACY_SHOW_ANY_LAYOUT) {
    const widgetHeight = Number.isFinite(totalHeight) ? totalHeight : layout.defaultWidgetHeight;
    const chromeHeight = (Number.isFinite(toolbarHeight) ? toolbarHeight : layout.toolbarHeight)
        + layout.framePaddingY
        + layout.toolbarGap;
    return Math.max(layout.minTextHeight, widgetHeight - chromeHeight);
}

export function getVuePrivacyShowAnyVisualHeight(node, domWidget, layout = PRIVACY_SHOW_ANY_LAYOUT) {
    const nodeEl = domWidget?.element?.closest?.(".lg-node");
    if (nodeEl) {
        const cssNodeHeight = parseFloat(nodeEl.style?.getPropertyValue?.("--node-height") || "");
        if (Number.isFinite(cssNodeHeight)) {
            return Math.max(layout.minWidgetHeight, cssNodeHeight - layout.vueChromeHeight);
        }
    }

    const startY = getPrivacyShowAnyWidgetStartY(node, domWidget);
    return getPrivacyShowAnyWidgetHeight(node, startY, layout);
}

export function getVuePrivacyShowAnyLayoutHeight(layout = PRIVACY_SHOW_ANY_LAYOUT) {
    return layout.defaultWidgetHeight;
}
