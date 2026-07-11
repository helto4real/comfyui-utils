// Inactive product adapters for the shared selector workflow profile.

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

function failure() {
    throw new Error("PRIVACY_SELECTOR_STATE_INVALID");
}
function fieldFacts(declaration) {
    const facts = FIELD_FACTS[declaration?.id];
    if (!facts || declaration?.location?.name !== facts.widget) failure();
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

function normalize(declaration, value) {
    const parsed = parseValue(value);
    if (declaration.id === SELECTOR_SELECTED_FIELD_ID) return { value: uniqueStrings(parsed) };
    if (declaration.id === SELECTOR_MASKS_FIELD_ID) return { value: maskMap(parsed) };
    if (declaration.id === SELECTOR_BBOXES_FIELD_ID) return { value: bboxMap(parsed) };
    return failure();
}

function widget(node, declaration) {
    const facts = fieldFacts(declaration);
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

export function createSelectorWorkflowBrowserAdapter() {
    let sessionLocked = false;
    return {
        normalize(value, declaration) {
            fieldFacts(declaration);
            return normalize(declaration, value);
        },
        readProtected(node, declaration) {
            return widget(node, declaration).value;
        },
        writeProtected(node, declaration, protectedValue) {
            widget(node, declaration).value = protectedValue;
        },
        apply(node, value, declaration) {
            const facts = fieldFacts(declaration);
            node[facts.runtime] = structuredClone(normalize(declaration, value).value);
        },
        clear(node, declaration) {
            const facts = fieldFacts(declaration);
            node[facts.runtime] = facts.defaultValue();
        },
        reconcileNode(node) {
            if (sessionLocked) clearRuntime(node);
        },
        reconcileNodeDefinition() {},
        onPrivacySessionChange(snapshot) {
            sessionLocked = snapshot?.state !== "ready" && snapshot?.state !== "unlocked";
        },
    };
}
