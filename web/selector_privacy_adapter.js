// Product adapters for the shared selector workflow profile.

import {
    createUtilsExternalWorkflowTransition,
    isUtilsCurrentModeEnvelope,
    managedNodeType,
    parseUtilsModeTransitionStorage,
    serializedWidgetIndex,
} from "./managed_mode_transition.js";

export const SELECTOR_SELECTED_FIELD_ID = "selector-selected-images";
export const SELECTOR_MASKS_FIELD_ID = "selector-edited-masks";
export const SELECTOR_BBOXES_FIELD_ID = "selector-edited-bboxes";

const FIELD_FACTS = Object.freeze({
    [SELECTOR_SELECTED_FIELD_ID]: Object.freeze({
        widget: "selected_images",
        runtime: "selectedPaths",
        defaultValue: () => [],
    }),
    [SELECTOR_MASKS_FIELD_ID]: Object.freeze({
        widget: "edited_masks",
        runtime: "editedMasks",
        defaultValue: () => ({}),
    }),
    [SELECTOR_BBOXES_FIELD_ID]: Object.freeze({
        widget: "edited_bboxes",
        runtime: "editedBboxes",
        defaultValue: () => ({}),
    }),
});
const CURRENT_SCHEMA = "helto.comfyui-utils";
const NODE_TYPE = "HeltoImageSelector";

function failure() {
    throw new Error("PRIVACY_SELECTOR_STATE_INVALID");
}
function fieldFacts(context) {
    const facts = FIELD_FACTS[context?.field?.id ?? context?.fieldId ?? context?.id];
    if (!facts) failure();
    return facts;
}

function parseValue(value) {
    if (value && typeof value === "object" && Object.keys(value).length === 1 && "value" in value) {
        return value.value;
    }
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        failure();
    }
}

function uniqueStrings(value) {
    if (!Array.isArray(value)) failure();
    return [...new Set(value.filter((item) => typeof item === "string" && item))];
}

function maskMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) failure();
    return Object.fromEntries(
        Object.entries(value)
            .filter(([path, reference]) => typeof path === "string" && path && reference)
            .map(([path, reference]) => [path, structuredClone(reference)]),
    );
}

function bboxMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) failure();
    const result = {};
    for (const [path, boxes] of Object.entries(value)) {
        if (!path || !Array.isArray(boxes)) continue;
        const valid = boxes.flatMap((box) => {
            if (!box || typeof box !== "object" || Array.isArray(box)) return [];
            const candidate = Object.fromEntries(
                ["x", "y", "width", "height"].map((key) => [key, Number(box[key])]),
            );
            if (!Object.values(candidate).every(Number.isFinite)) return [];
            if (candidate.width <= 0 || candidate.height <= 0) return [];
            return [candidate];
        });
        if (valid.length) result[path] = valid;
    }
    return result;
}

function normalize(context, value) {
    const parsed = parseValue(value);
    const fieldId = context?.field?.id ?? context?.fieldId ?? context?.id;
    if (fieldId === SELECTOR_SELECTED_FIELD_ID) return { value: uniqueStrings(parsed) };
    if (fieldId === SELECTOR_MASKS_FIELD_ID) return { value: maskMap(parsed) };
    if (fieldId === SELECTOR_BBOXES_FIELD_ID) return { value: bboxMap(parsed) };
    return failure();
}

function widget(node, context) {
    const facts = fieldFacts(context);
    const found = node?.widgets?.find((item) => item?.name === facts.widget);
    if (!found) failure();
    return found;
}

function clearRuntime(node) {
    if (!node || (node.comfyClass !== "HeltoImageSelector" && node.type !== "HeltoImageSelector")) return;
    for (const facts of Object.values(FIELD_FACTS)) {
        node[facts.runtime] = facts.defaultValue();
    }
}

export function createSelectorModeBrowserAdapter() {
    return {
        readDeclaredMode(node) {
            return node?.properties?.privacyMode === false ? "public" : "private";
        },
        writeDeclaredMode(node, mode) {
            if (!node || !["private", "public"].includes(mode)) failure();
            node.properties ??= {};
            node.properties.privacyMode = mode === "private";
        },
        reconcileNode(node) {
            node.properties ??= {};
            if (node.properties.privacyMode === undefined) node.properties.privacyMode = true;
        },
        reconcileNodeDefinition() {},
        onPrivacySessionChange() {},
    };
}

export function createSelectorWorkflowBrowserAdapter({ app = null } = {}) {
    let sessionLocked = false;
    const owners = new Set();

    function applyValue(node, value, context) {
        const facts = fieldFacts(context);
        node[facts.runtime] = structuredClone(normalize(context, value).value);
        if (
            (context?.field?.id ?? context?.fieldId ?? context?.id) === SELECTOR_MASKS_FIELD_ID
            && typeof node?.migrateLegacyMasks === "function"
            && Object.values(node.editedMasks || {}).some((reference) => (
                reference
                && typeof reference === "object"
                && !Array.isArray(reference)
                && Object.keys(reference).length === 1
                && typeof reference.key === "string"
            ))
        ) {
            queueMicrotask(() => {
                node.migrateLegacyMasks().catch((err) => {
                    console.warn("Failed to migrate legacy selector masks:", err);
                });
            });
        }
    }

    function clearValue(node, context) {
        const facts = fieldFacts(context);
        node[facts.runtime] = facts.defaultValue();
    }

    function reconcileOwner(node) {
        if (managedNodeType(node) !== NODE_TYPE) failure();
        owners.add(node);
        transition.synchronizeOwner(node);
        if (sessionLocked) clearRuntime(node);
    }

    function detachedWidgetValue(node, serializedNode, context) {
        if (!Array.isArray(serializedNode?.widgets_values)) failure();
        const target = widget(node, context);
        const index = serializedWidgetIndex(node, target);
        if (!Number.isInteger(index) || index < 0 || index >= serializedNode.widgets_values.length) {
            failure();
        }
        const value = serializedNode.widgets_values[index];
        if (typeof value !== "string") failure();
        return value;
    }

    const transition = createUtilsExternalWorkflowTransition({
        app,
        owners,
        registerNode: reconcileOwner,
        readStorage(node, context) {
            return String(widget(node, context).value || "");
        },
        writeStorage(node, value, context) {
            widget(node, context).value = value;
        },
        readDetachedStorage: detachedWidgetValue,
        reloadRuntime(node, value, context) {
            const payload = parseUtilsModeTransitionStorage(value, failure);
            if (isUtilsCurrentModeEnvelope(payload, CURRENT_SCHEMA)) clearValue(node, context);
            else applyValue(node, payload, context);
        },
        reconcileRuntime(node) {
            if (sessionLocked) clearRuntime(node);
        },
        fail: failure,
    });

    return {
        normalize(node, context) {
            const facts = fieldFacts(context);
            return normalize(context, node?.[facts.runtime]);
        },
        readProtected(node, context) {
            return String(widget(node, context).value || "");
        },
        writeProtected(node, protectedValue, context) {
            if (typeof protectedValue !== "string") failure();
            transition.withInternalMutation(() => {
                widget(node, context).value = protectedValue;
            });
        },
        writeWorkflowProjection(node, serializedNode, protectedValue, context) {
            if (typeof protectedValue !== "string" || !Array.isArray(serializedNode?.widgets_values)) {
                failure();
            }
            const target = widget(node, context);
            const index = serializedWidgetIndex(node, target);
            if (!Number.isInteger(index) || index < 0 || index >= serializedNode.widgets_values.length) {
                failure();
            }
            serializedNode.widgets_values[index] = protectedValue;
        },
        apply(node, value, context) {
            transition.requireMutable();
            applyValue(node, value, context);
        },
        clear(node, context) {
            transition.requireMutable();
            clearValue(node, context);
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
