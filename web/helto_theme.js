// Helto Design System - shared node/theme helpers for comfyui-utils.
// Token values mirror web/styles.css and the Helto design-system reference.
// Canvas drawing cannot use CSS variables, so HELTO keeps the same literal
// token values for LiteGraph node/widget painting.

export const HELTO_UTILS_THEME_NODE_TYPES = new Set([
    "HeltoVideoParams",
    "HeltoVideoParamsLTX",
    "AspectRatioCalculator",
    "ModelAutoRouter",
    "HeltoPromptEnhancer",
    "HeltoPrivacyShowAny",
    "HeltoImageComparer",
    "HeltoVideoComparer",
    "HeltoLoadVideo",
    "HeltoImageSelector",
    "HeltoSaveImageAdvanced",
    "HeltoSaveVideoAdvanced",
]);

export const HELTO_TOKENS_CSS = `
:root {
  --helto-bg: #181825;
  --helto-surface: #1e1e2e;
  --helto-surface-2: #313244;
  --helto-surface-3: #45475a;
  --helto-surface-hover: #585b70;
  --helto-border: #313244;
  --helto-border-strong: #45475a;
  --helto-border-hover: #6c7086;
  --helto-text: #cdd6f4;
  --helto-text-dim: #a6adc8;
  --helto-text-faint: #7f849c;
  --helto-accent: #fab387;
  --helto-accent-strong: #fddcc4;
  --helto-accent-border: #93664a;
  --helto-accent-bg: #46301f;
  --helto-focus: #89b4fa;
  --helto-focus-ring: 0 0 0 3px rgba(137, 180, 250, 0.28);
  --helto-danger: #f38ba8;
  --helto-danger-border: #96526a;
  --helto-ok: #a6e3a1;
  --helto-warn: #f9e2af;
  --helto-info: #74c7ec;
  --helto-radius-sm: 5px;
  --helto-radius: 6px;
  --helto-radius-lg: 10px;
  --helto-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  --helto-shadow-pop: 0 12px 32px rgba(0, 0, 0, 0.5);
  --helto-shadow-glow: 0 0 0 1px rgba(250, 179, 135, 0.35),
                       0 0 12px rgba(250, 179, 135, 0.22);
  --helto-transition: 0.12s ease;
  --helto-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --helto-font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --helto-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --helto-font-size: 12px;
  --helto-line: 1.4;
}
`;

export const HELTO = {
    bg: "#181825",
    surface: "#1e1e2e",
    surface2: "#313244",
    surface3: "#45475a",
    surfaceHover: "#585b70",
    border: "#313244",
    borderStrong: "#45475a",
    borderHover: "#6c7086",
    text: "#cdd6f4",
    textDim: "#a6adc8",
    textFaint: "#7f849c",
    accent: "#fab387",
    accentStrong: "#fddcc4",
    accentBorder: "#93664a",
    accentBg: "#46301f",
    focus: "#89b4fa",
    danger: "#f38ba8",
    dangerBorder: "#96526a",
    warn: "#f9e2af",
    ok: "#a6e3a1",
    info: "#74c7ec",
};

const HELTO_LITEGRAPH_WIDGET_THEME = {
    WIDGET_BGCOLOR: HELTO.bg,
    WIDGET_OUTLINE_COLOR: HELTO.borderStrong,
    WIDGET_PROMOTED_OUTLINE_COLOR: HELTO.accent,
    WIDGET_ADVANCED_OUTLINE_COLOR: HELTO.focus,
    WIDGET_TEXT_COLOR: HELTO.text,
    WIDGET_SECONDARY_TEXT_COLOR: HELTO.textDim,
    WIDGET_DISABLED_TEXT_COLOR: HELTO.textFaint,
};

export function heltoNodeTypeCandidates(node) {
    return [
        node?.type,
        node?.comfyClass,
        node?.class_type,
        node?.constructor?.type,
        node?.constructor?.comfyClass,
        node?.constructor?.nodeData?.name,
    ].map((value) => String(value || "")).filter(Boolean);
}

export function isHeltoThemedNodeData(nodeData) {
    const name = String(nodeData?.name || "");
    return HELTO_UTILS_THEME_NODE_TYPES.has(name);
}

export function isHeltoThemedNode(node) {
    return heltoNodeTypeCandidates(node).some((candidate) => HELTO_UTILS_THEME_NODE_TYPES.has(candidate));
}

export function applyHeltoNodeTheme(node) {
    if (!node || typeof node !== "object") {
        return false;
    }
    node.color = HELTO.surface3;
    node.bgcolor = HELTO.surface;
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    return true;
}

export function applyHeltoUtilsNodeTheme(node) {
    if (!isHeltoThemedNode(node)) {
        return false;
    }
    return applyHeltoNodeTheme(node);
}

export function applyHeltoLiteGraphWidgetTheme(liteGraph = globalThis.LiteGraph) {
    if (!liteGraph || typeof liteGraph !== "object") {
        return null;
    }
    const previous = {};
    for (const [key, value] of Object.entries(HELTO_LITEGRAPH_WIDGET_THEME)) {
        if (key in liteGraph) {
            previous[key] = liteGraph[key];
            liteGraph[key] = value;
        }
    }
    return Object.keys(previous).length ? { liteGraph, previous } : null;
}

export function restoreHeltoLiteGraphWidgetTheme(snapshot) {
    const { liteGraph, previous } = snapshot || {};
    if (!liteGraph || !previous) {
        return false;
    }
    for (const [key, value] of Object.entries(previous)) {
        liteGraph[key] = value;
    }
    return true;
}

export function withHeltoLiteGraphWidgetTheme(callback, liteGraph = globalThis.LiteGraph) {
    const snapshot = applyHeltoLiteGraphWidgetTheme(liteGraph);
    try {
        return callback?.();
    } finally {
        restoreHeltoLiteGraphWidgetTheme(snapshot);
    }
}

export function ensureHeltoTokens(styleId = "helto-utils-tokens") {
    if (typeof document === "undefined" || document.getElementById(styleId)) {
        return false;
    }
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = HELTO_TOKENS_CSS;
    document.head.prepend(style);
    return true;
}
