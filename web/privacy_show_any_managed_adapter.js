// Browser adapter for the shared Privacy Show Any workflow profile.

import {
    createUtilsExternalWorkflowTransition,
    isUtilsCurrentModeEnvelope,
    managedNodeType,
    parseUtilsModeTransitionStorage,
} from "./managed_mode_transition.js";

export const PRIVACY_SHOW_ANY_FIELD_ID = "privacy-show-any-text";

const NODE_TYPE = "HeltoPrivacyShowAny";
const STATE_WIDGET = "encrypted_text_state";
const STATE_PROPERTY = "helto_privacy_show_any_encrypted_text_state";
const MODE_PROPERTY = "helto_privacy_show_any_privacy_mode";
const DISPLAY_TEXT = "__heltoPrivacyShowAnyText";
const DISPLAY_WIDGET = "__heltoPrivacyShowAnyWidget";
const PRIVACY_BLOCKED = "__heltoPrivacyShowAnyBlocked";
const MAX_TEXT_CHARS = 200_000;
const CURRENT_SCHEMA = "helto.comfyui-utils";

function failure(code = "PRIVACY_SHOW_ANY_STATE_INVALID") {
    throw new Error(code);
}

function requireContext(context) {
    if ((context?.field?.id ?? context?.fieldId ?? context?.id) !== PRIVACY_SHOW_ANY_FIELD_ID) {
        failure();
    }
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

export function createPrivacyShowAnyWorkflowBrowserAdapter({ app = null } = {}) {
    let sessionLocked = false;
    const owners = new Set();

    function writeProtectedExact(node, protectedValue, context) {
        requireContext(context);
        requireActive(node);
        if (typeof protectedValue !== "string") failure();
        const target = stateWidget(node);
        node.properties ??= {};
        const oldWidget = target.value;
        const hadProperty = Object.hasOwn(node.properties, STATE_PROPERTY);
        const oldProperty = node.properties[STATE_PROPERTY];
        try {
            target.value = protectedValue;
            node.properties[STATE_PROPERTY] = protectedValue;
        } catch {
            target.value = oldWidget;
            try {
                if (hadProperty) node.properties[STATE_PROPERTY] = oldProperty;
                else delete node.properties[STATE_PROPERTY];
            } catch {
                // The original property remains authoritative when its owner rejects writes.
            }
            failure("PRIVACY_SHOW_ANY_MIRROR_WRITE_FAILED");
        }
    }

    function applyValue(node, value, context) {
        requireContext(context);
        requireActive(node);
        const plain = value && typeof value === "object" && "value" in value
            ? value.value
            : value;
        node[DISPLAY_TEXT] = boundedText(plain);
        syncDisplay(node);
    }

    function reconcileOwner(node) {
        if (managedNodeType(node) !== NODE_TYPE) failure();
        owners.add(node);
        transition.synchronizeOwner(node);
        if (sessionLocked) clearPlaintext(node);
    }

    function detachedStorage(node, serializedNode, context) {
        requireContext(context);
        const propertyValue = serializedNode?.properties?.[STATE_PROPERTY];
        const widgetValue = Array.isArray(serializedNode?.widgets_values)
            ? serializedNode.widgets_values[0]
            : undefined;
        if (
            typeof propertyValue === "string"
            && typeof widgetValue === "string"
            && propertyValue
            && widgetValue
            && propertyValue !== widgetValue
        ) failure();
        const value = widgetValue || propertyValue;
        if (typeof value !== "string") failure();
        return value;
    }

    const transition = createUtilsExternalWorkflowTransition({
        app,
        owners,
        registerNode: reconcileOwner,
        readStorage(node, context) {
            requireContext(context);
            const widgetValue = String(stateWidget(node).value || "");
            const propertyValue = String(node?.properties?.[STATE_PROPERTY] || "");
            if (widgetValue && propertyValue && widgetValue !== propertyValue) failure();
            return widgetValue || propertyValue;
        },
        writeStorage: writeProtectedExact,
        readDetachedStorage: detachedStorage,
        reloadRuntime(node, value, context) {
            const payload = parseUtilsModeTransitionStorage(value, failure);
            if (isUtilsCurrentModeEnvelope(payload, CURRENT_SCHEMA)) clearPlaintext(node);
            else applyValue(node, payload, context);
        },
        reconcileRuntime(node) {
            if (sessionLocked) clearPlaintext(node);
        },
        fail: failure,
    });

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
            transition.withInternalMutation(() => {
                writeProtectedExact(node, protectedValue, context);
            });
        },
        writeWorkflowProjection(node, serializedNode, protectedValue, context) {
            requireContext(context);
            if (typeof protectedValue !== "string" || !serializedNode || typeof serializedNode !== "object") {
                failure();
            }
            serializedNode.properties ??= {};
            serializedNode.properties[STATE_PROPERTY] = protectedValue;
            if (!Array.isArray(serializedNode.widgets_values) || !serializedNode.widgets_values.length) {
                failure();
            }
            serializedNode.widgets_values[0] = protectedValue;
        },
        apply(node, value, context) {
            transition.requireMutable();
            applyValue(node, value, context);
        },
        clear(node, context) {
            transition.requireMutable();
            requireContext(context);
            clearPlaintext(node);
        },
        block(node, context) {
            requireContext(context);
            node[PRIVACY_BLOCKED] = true;
            clearPlaintext(node);
        },
        reconcileNode(node) {
            reconcileOwner(node);
        },
        reconcileNodeDefinition() {},
        onPrivacySessionChange(snapshot) {
            sessionLocked = snapshot?.state !== "ready" && snapshot?.state !== "unlocked";
        },
        ...transition,
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
