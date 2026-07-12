export const PRIVACY_SHOW_ANY_NODE_CLASS = "HeltoPrivacyShowAny";
export const PRIVACY_SHOW_ANY_STATE_WIDGET = "encrypted_text_state";
export const PRIVACY_SHOW_ANY_STATE_PROPERTY = "helto_privacy_show_any_encrypted_text_state";
const PRIVACY_SHOW_ANY_PROTECTION_PROMISE = "__heltoPrivacyShowAnyProtectionPromise";
export const PRIVACY_SHOW_ANY_LAYOUT = Object.freeze({
    minWidth: 360,
    minNodeHeight: 300,
});

export function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget?.name === name) ?? null;
}

export function setPrivacyShowAnyProtectionPromise(node, promise) {
    if (!node || !promise || typeof promise.then !== "function") {
        throw new TypeError("Privacy Show Any protection promise is invalid.");
    }
    node[PRIVACY_SHOW_ANY_PROTECTION_PROMISE] = Promise.resolve(promise);
    return node[PRIVACY_SHOW_ANY_PROTECTION_PROMISE];
}

export function privacyShowAnyProtectionPromise(node) {
    return node?.[PRIVACY_SHOW_ANY_PROTECTION_PROMISE] ?? null;
}

export function hidePrivacyShowAnyStateWidget(node, collapseWidgetLayout) {
    const widget = getWidget(node, PRIVACY_SHOW_ANY_STATE_WIDGET);
    if (!widget) return null;
    widget.hidden = true;
    widget.type = "hidden";
    collapseWidgetLayout?.(widget);
    return widget;
}

export function serializedProtectedWidgetValue(widget) {
    return serializedProtectedValue(widget?.value);
}

export function serializedProtectedValue(value) {
    return typeof value === "string" ? value : "";
}

export function serializedProtectedPropertyValue(node) {
    return serializedProtectedValue(node?.properties?.[PRIVACY_SHOW_ANY_STATE_PROPERTY]);
}

export function protectedPrivacyShowAnyState(node, stateWidget = getWidget(node, PRIVACY_SHOW_ANY_STATE_WIDGET)) {
    return serializedProtectedWidgetValue(stateWidget) || serializedProtectedPropertyValue(node);
}

export function setProtectedPrivacyShowAnyState(node, stateWidget, protectedValue) {
    const safe = serializedProtectedValue(protectedValue);
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

export function preservePrivacyShowAnySerializedProperties(info, protectedValue) {
    if (!info) return "";
    const safe = serializedProtectedValue(protectedValue);
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

export function privacyShowAnyDisplayState(text, revealed, emptyPlaceholder = "Run the node to display text.") {
    const plain = String(text ?? "");
    return {
        value: revealed ? plain : "",
        placeholder: plain ? "" : emptyPlaceholder,
    };
}
