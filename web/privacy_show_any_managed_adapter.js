// Inactive browser adapter for the shared Privacy Show Any workflow profile.

export const PRIVACY_SHOW_ANY_FIELD_ID = "privacy-show-any-text";

const NODE_TYPE = "HeltoPrivacyShowAny";
const STATE_WIDGET = "encrypted_text_state";
const STATE_PROPERTY = "helto_privacy_show_any_encrypted_text_state";
const MODE_PROPERTY = "helto_privacy_show_any_privacy_mode";
const DISPLAY_TEXT = "__heltoPrivacyShowAnyText";
const DISPLAY_WIDGET = "__heltoPrivacyShowAnyWidget";
const PRIVACY_BLOCKED = "__heltoPrivacyShowAnyBlocked";
const MAX_TEXT_CHARS = 200_000;

function failure(code = "PRIVACY_SHOW_ANY_STATE_INVALID") {
    throw new Error(code);
}

function requireContext(context) {
    if ((context?.fieldId ?? context?.id) !== PRIVACY_SHOW_ANY_FIELD_ID) failure();
}

function stateWidget(node) {
    const widget = node?.widgets?.find((item) => item?.name === STATE_WIDGET)
        ?? node?.__heltoPrivacyShowAnyStateWidget
        ?? null;
    if (!widget) failure();
    return widget;
}

function boundedText(value) {
    const text = String(value ?? "");
    if (text.length <= MAX_TEXT_CHARS) return text;
    if (/^\n<truncated [1-9]\d* character\(s\)>$/.test(text.slice(MAX_TEXT_CHARS))) {
        return text;
    }
    return `${text.slice(0, MAX_TEXT_CHARS)}\n<truncated ${text.length - MAX_TEXT_CHARS} character(s)>`;
}

function syncDisplay(node) {
    const display = node?.[DISPLAY_WIDGET];
    if (!display) return;
    const text = display.textRevealed ? String(node?.[DISPLAY_TEXT] ?? "") : "";
    if (display.textWidget) display.textWidget.value = text;
    if (display.inputEl) display.inputEl.value = text;
    else if (display.textarea) display.textarea.value = text;
}

function clearPlaintext(node) {
    if (!node || (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE)) return;
    node[DISPLAY_TEXT] = "";
    syncDisplay(node);
}

function requireActive(node) {
    if (node?.[PRIVACY_BLOCKED]) failure("PRIVACY_SHOW_ANY_PRIVACY_BLOCKED");
}

export function createPrivacyShowAnyModeBrowserAdapter() {
    return {
        readDeclaredMode(node) {
            return node?.properties?.[MODE_PROPERTY] === false ? "public" : "private";
        },
        writeDeclaredMode(node, mode) {
            if (!node || !["private", "public"].includes(mode)) failure();
            node.properties ??= {};
            node.properties[MODE_PROPERTY] = mode === "private";
        },
        reconcileNode(node) {
            node.properties ??= {};
            if (node.properties[MODE_PROPERTY] === undefined) {
                node.properties[MODE_PROPERTY] = true;
            }
        },
        reconcileNodeDefinition() {},
        onPrivacySessionChange() {},
    };
}

export function createPrivacyShowAnyWorkflowBrowserAdapter() {
    let sessionLocked = false;
    return {
        normalize(node, context) {
            requireContext(context);
            requireActive(node);
            return { value: boundedText(node?.[DISPLAY_TEXT]) };
        },
        readProtected(node, context) {
            requireContext(context);
            requireActive(node);
            const widgetValue = String(stateWidget(node).value || "");
            const propertyValue = String(node?.properties?.[STATE_PROPERTY] || "");
            if (widgetValue && propertyValue && widgetValue !== propertyValue) failure();
            return widgetValue || propertyValue;
        },
        writeProtected(node, protectedValue, context) {
            requireContext(context);
            requireActive(node);
            if (typeof protectedValue !== "string") failure();
            const widget = stateWidget(node);
            node.properties ??= {};
            const oldWidget = widget.value;
            const hadProperty = Object.hasOwn(node.properties, STATE_PROPERTY);
            const oldProperty = node.properties[STATE_PROPERTY];
            try {
                widget.value = protectedValue;
                node.properties[STATE_PROPERTY] = protectedValue;
            } catch {
                widget.value = oldWidget;
                try {
                    if (hadProperty) node.properties[STATE_PROPERTY] = oldProperty;
                    else delete node.properties[STATE_PROPERTY];
                } catch {
                    // The original property remains authoritative when its owner rejects writes.
                }
                failure("PRIVACY_SHOW_ANY_MIRROR_WRITE_FAILED");
            }
        },
        apply(node, value, context) {
            requireContext(context);
            requireActive(node);
            const plain = value && typeof value === "object" && "value" in value
                ? value.value
                : value;
            node[DISPLAY_TEXT] = boundedText(plain);
            syncDisplay(node);
        },
        clear(node, context) {
            requireContext(context);
            clearPlaintext(node);
        },
        block(node, context) {
            requireContext(context);
            node[PRIVACY_BLOCKED] = true;
            clearPlaintext(node);
        },
        reconcileNode(node) {
            if (sessionLocked) clearPlaintext(node);
        },
        reconcileNodeDefinition() {},
        onPrivacySessionChange(snapshot) {
            sessionLocked = snapshot?.state !== "ready" && snapshot?.state !== "unlocked";
        },
    };
}

export function createPrivacyShowAnyDisplayController(
    createProtectedDisplayController,
    adapter,
    transport,
) {
    if (
        typeof createProtectedDisplayController !== "function"
        || !adapter
        || typeof transport?.displayResult !== "function"
    ) failure();
    const lifecycle = createProtectedDisplayController({
        adapter,
        invoke: (protectedValue) => transport.displayResult(protectedValue),
        project(result) {
            if (!result || typeof result.text !== "string") failure();
            return result.text;
        },
        failureCode: "PRIVACY_SHOW_ANY_REVEAL_BLOCKED",
    });
    return Object.freeze({
        display(node, payload, context) {
            const protectedValue = (
                !payload
                || typeof payload !== "object"
                || Object.keys(payload).length !== 1
                || typeof payload.protected !== "string"
            ) ? undefined : payload.protected;
            return lifecycle.display(node, protectedValue, context);
        },
    });
}
