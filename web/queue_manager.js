import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    attachHeltoMediaPreviewHover,
    hideHeltoMediaPreviewThumbnail,
    openHeltoMediaPreview,
} from "./media_preview.js";

import {
    QUEUE_STATUS_ABORTED,
    QUEUE_STATUS_COMPLETED,
    QUEUE_STATUS_ERROR,
    QUEUE_STATUS_PENDING,
    QUEUE_STATUS_RUNNING,
    QUEUE_STATUS_SUBMITTING,
    activeQueueRun,
    applyQueueStateSaveResponse,
    clearQueueHistory,
    cloneJson,
    comfyQueueHasPromptId,
    createQueueRun,
    deleteHistoryRun,
    deleteQueueRun,
    enqueueRun,
    fixLiveSeedControls,
    formatQueueDuration,
    formatQueueTime,
    historyHasExecutionEvent,
    latestMediaPreviewFromHistory,
    markRunRunning,
    markRunSubmitting,
    mediaRecordToPreviewUrl,
    moveRunToHistory,
    nextPendingRun,
    normalizeQueueState,
    queueSummary,
    runCanBeLoaded,
    runCanBeRerun,
    workflowWithFixedSeedControls,
} from "./queue_manager_helpers.js";

const STATE_ROUTE = "/helto_queue_manager/state";
const PATCHED_KEY = "__heltoQueueManagerPatched";
const STYLE_ID = "helto-queue-manager-styles";
const FALLBACK_PANEL_ID = "helto-queue-manager-fallback";
const STALE_PROMPT_MISS_LIMIT = 2;

const QUEUE_ICONS = {
    play: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"/></svg>`,
    pause: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4v16"/><path d="M16 4v16"/></svg>`,
    load: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
    unlock: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-1.9"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>`,
    clear: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
    preview: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    rerun: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`,
    abort: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14"/><path d="M19 5 5 19"/></svg>`,
};

function routeUrl(route) {
    return api?.apiURL?.(route) ?? route;
}

async function jsonFetch(route, options = {}) {
    const response = await fetch(routeUrl(route), options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `Request failed: ${route}`);
    }
    return payload;
}

function messageFromPromptError(payload) {
    const error = payload?.error;
    if (typeof error === "string") return error;
    if (error?.message) return error.message;
    if (error?.details) return error.details;
    return "ComfyUI rejected the queued workflow.";
}

function promptDataFromQueueArgs(args) {
    return args.find((arg) => arg && typeof arg === "object" && arg.output && arg.workflow) || null;
}

function queueNumberFromArgs(args) {
    return args.find((arg) => (
        typeof arg === "number"
        || (typeof arg === "string" && arg.trim() !== "" && Number.isFinite(Number(arg)))
    ));
}

function promptId() {
    return globalThis.crypto?.randomUUID?.() || `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
}

function activeWorkflowTitleContext() {
    return {
        activeWorkflow: [
            app?.extensionManager?.workflow?.activeWorkflow,
            app?.extensionManager?.workflowManager?.activeWorkflow,
            app?.workflowManager?.activeWorkflow,
            app?.workflowManager?.workflow,
            app?.workflow,
            app?.graph?.workflow,
        ],
    };
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[char]));
}

function normalizeFilterText(value) {
    return String(value ?? "").trim().toLocaleLowerCase();
}

function previewUrl(preview) {
    return mediaRecordToPreviewUrl(preview, {
        apiURL: routeUrl,
        getPreviewFormatParam: app?.getPreviewFormatParam?.bind(app),
        getRandParam: app?.getRandParam?.bind(app),
    });
}

function isActiveRunStatus(status) {
    return status === QUEUE_STATUS_RUNNING || status === QUEUE_STATUS_SUBMITTING;
}

function displayStatus(status) {
    return status === QUEUE_STATUS_ABORTED ? "Aborted" : status;
}

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        :root {
            --helto-bg: #0d1320;
            --helto-surface: #151c2a;
            --helto-surface-2: #1b2333;
            --helto-surface-3: #232d3f;
            --helto-surface-hover: #2c3850;
            --helto-border: #2a3346;
            --helto-border-strong: #3a465c;
            --helto-border-hover: #4c5970;
            --helto-text: #e7ebf3;
            --helto-text-dim: #9aa6bd;
            --helto-text-faint: #6f7c95;
            --helto-accent: #f1c75c;
            --helto-accent-strong: #ffd873;
            --helto-accent-bg: rgba(241, 199, 92, 0.16);
            --helto-accent-border: rgba(241, 199, 92, 0.55);
            --helto-focus: #5e9bff;
            --helto-focus-ring: 0 0 0 2px rgba(94, 155, 255, 0.5);
            --helto-danger: #ec5a6b;
            --helto-danger-bg: #3a1a22;
            --helto-danger-border: #8f3a44;
            --helto-ok: #baf0c8;
            --helto-warn: #ffe3a3;
            --helto-info: #b9dafc;
            --helto-radius-sm: 5px;
            --helto-radius: 6px;
            --helto-radius-lg: 10px;
            --helto-font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            --helto-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Roboto Mono", monospace;
            --helto-font-size: 12px;
            --helto-line: 1.4;
            --helto-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
            --helto-shadow-pop: 0 14px 36px rgba(0, 0, 0, 0.55);
            --helto-shadow-glow: 0 0 10px rgba(241, 199, 92, 0.35);
            --helto-transition: 0.12s ease;
            --helto-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        @keyframes heltoQmPulse {
            0% {
                box-shadow: var(--helto-shadow-glow);
                border-color: var(--helto-accent-border);
            }
            100% {
                box-shadow: 0 0 16px rgba(241, 199, 92, 0.55);
                border-color: var(--helto-accent-strong);
            }
        }
        @keyframes heltoQmShimmer {
            0%, 18% {
                transform: translateX(-120%);
            }
            100% {
                transform: translateX(220%);
            }
        }
        @keyframes heltoQmDot {
            0%, 100% {
                opacity: 1;
                transform: scale(1);
            }
            50% {
                opacity: 0.4;
                transform: scale(0.7);
            }
        }
        .HeltoQueueManagerIcon:before {
            content: "Q";
            color: var(--helto-accent);
            font-weight: 800;
        }
        .HeltoQueueManagerIcon {
            position: relative;
        }
        .HeltoQueueManagerIcon::after {
            align-items: center;
            background: var(--helto-danger);
            border: 1px solid rgba(255, 255, 255, 0.65);
            border-radius: 999px;
            box-shadow: 0 2px 7px rgba(0, 0, 0, 0.45);
            color: #fff;
            content: attr(data-queue-count);
            display: inline-flex;
            font: 700 9px / 1 var(--helto-font-sans);
            height: 16px;
            justify-content: center;
            min-width: 16px;
            padding: 0 4px;
            pointer-events: none;
            position: absolute;
            right: -8px;
            top: -6px;
            transform: translateZ(0);
            z-index: 2;
        }
        .HeltoQueueManagerIcon:not([data-queue-count])::after,
        .HeltoQueueManagerIcon[data-queue-count=""]::after {
            display: none;
        }
        .helto-qm {
            box-sizing: border-box;
            color: var(--helto-text);
            display: flex;
            flex-direction: column;
            font: var(--helto-font-size) / var(--helto-line) var(--helto-font-sans);
            height: 100%;
            min-height: 0;
            padding: 9px;
            position: relative;
            width: 100%;
            -webkit-font-smoothing: antialiased;
        }
        .helto-qm *,
        .helto-qm *::before,
        .helto-qm *::after {
            box-sizing: border-box;
        }
        .helto-qm-header {
            align-items: center;
            display: flex;
            gap: 8px;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        .helto-qm-title {
            color: var(--helto-text);
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 0.02em;
        }
        .helto-qm-toolbar {
            align-items: center;
            display: flex;
            gap: 6px;
            min-height: 34px;
            padding: 5px;
            border-radius: var(--helto-radius);
            background: linear-gradient(180deg, var(--helto-surface-2), var(--helto-surface));
            box-shadow: inset 0 0 0 1px var(--helto-border);
            margin-bottom: 9px;
        }
        .helto-qm-icon-btn {
            align-items: center;
            background: linear-gradient(180deg, var(--helto-surface-3), var(--helto-surface-2));
            border: 1px solid var(--helto-border-strong);
            border-radius: var(--helto-radius-sm);
            color: var(--helto-text);
            cursor: pointer;
            display: inline-flex;
            font: inherit;
            height: 28px;
            justify-content: center;
            min-width: 28px;
            padding: 0;
            transition: background var(--helto-transition), border-color var(--helto-transition), color var(--helto-transition), box-shadow var(--helto-transition), transform 0.03s ease;
            width: 28px;
        }
        .helto-qm-icon-btn:hover:not(:disabled) {
            background: linear-gradient(180deg, var(--helto-surface-hover), var(--helto-surface-3));
            border-color: var(--helto-border-hover);
            color: var(--helto-text);
        }
        .helto-qm-icon-btn:active:not(:disabled) {
            transform: translateY(1px);
        }
        .helto-qm-icon-btn:disabled {
            cursor: default;
            opacity: 0.4;
        }
        .helto-qm-icon-btn.is-active,
        .helto-qm-icon-btn.is-primary {
            background: linear-gradient(180deg, #4f4322, #3c3318);
            border-color: var(--helto-accent-border);
            color: var(--helto-accent-strong);
            box-shadow: inset 0 0 0 1px rgba(241, 199, 92, 0.18);
        }
        .helto-qm-icon-btn.is-active:hover:not(:disabled),
        .helto-qm-icon-btn.is-primary:hover:not(:disabled) {
            background: linear-gradient(180deg, #5b4d27, #46391b);
            color: var(--helto-accent-strong);
        }
        .helto-qm-icon-btn.is-danger {
            background: linear-gradient(180deg, #5a2330, #471b25);
            border-color: var(--helto-danger-border);
            color: var(--helto-text);
        }
        .helto-qm-icon-btn.is-danger:hover:not(:disabled) {
            background: linear-gradient(180deg, #6e2937, #57212c);
            border-color: var(--helto-danger);
        }
        .helto-qm-icon-btn:focus-visible,
        .helto-qm-tab:focus-visible,
        .helto-qm-filter-input:focus-visible,
        .helto-qm-filter-select:focus-visible {
            border-color: var(--helto-focus);
            box-shadow: var(--helto-focus-ring);
            outline: none;
        }
        .helto-qm-toolbar-spacer {
            background: var(--helto-border-strong);
            flex: 0 0 auto;
            height: 18px;
            margin: 0 2px;
            opacity: 0.7;
            width: 1px;
        }
        .helto-qm-status {
            background: var(--helto-surface);
            border: 1px solid var(--helto-border);
            border-radius: var(--helto-radius);
            box-shadow: var(--helto-shadow);
            color: var(--helto-text-dim);
            display: grid;
            gap: 4px;
            grid-template-columns: repeat(3, 1fr);
            margin-bottom: 9px;
            padding: 8px;
        }
        .helto-qm-status strong {
            color: var(--helto-text);
            display: block;
            font-size: 13px;
            font-variant-numeric: tabular-nums;
        }
        .helto-qm-banner {
            background: var(--helto-accent-bg);
            border: 1px solid var(--helto-accent-border);
            border-radius: var(--helto-radius);
            color: var(--helto-accent-strong);
            margin-bottom: 8px;
            padding: 7px;
        }
        .helto-qm-tabs {
            align-items: center;
            background: linear-gradient(180deg, var(--helto-surface-2), var(--helto-surface));
            border-radius: var(--helto-radius);
            box-shadow: inset 0 0 0 1px var(--helto-border);
            display: grid;
            gap: 5px;
            grid-template-columns: 1fr 1fr;
            margin-bottom: 8px;
            padding: 5px;
        }
        .helto-qm-tab {
            align-items: center;
            background: transparent;
            border: 1px solid transparent;
            border-radius: var(--helto-radius-sm);
            color: var(--helto-text-dim);
            cursor: pointer;
            display: flex;
            font: inherit;
            gap: 6px;
            height: 26px;
            justify-content: center;
            padding: 0 8px;
            transition: background var(--helto-transition), border-color var(--helto-transition), color var(--helto-transition), box-shadow var(--helto-transition);
        }
        .helto-qm-tab:hover {
            background: var(--helto-surface-hover);
            color: var(--helto-text);
        }
        .helto-qm-tab.is-active {
            background: linear-gradient(180deg, #4f4322, #3c3318);
            border-color: var(--helto-accent-border);
            color: var(--helto-accent-strong);
            box-shadow: inset 0 0 0 1px rgba(241, 199, 92, 0.18);
        }
        .helto-qm-tab-count {
            color: inherit;
            font-family: var(--helto-font-mono);
            font-variant-numeric: tabular-nums;
        }
        .helto-qm-section {
            display: flex;
            flex: 1;
            flex-direction: column;
            min-height: 0;
        }
        .helto-qm-section-head {
            align-items: center;
            color: var(--helto-text-faint);
            display: flex;
            font-size: 11px;
            font-weight: 600;
            justify-content: space-between;
            letter-spacing: 0.06em;
            margin: 0 0 6px;
            text-transform: uppercase;
        }
        .helto-qm-history-filters {
            display: grid;
            gap: 5px;
            grid-template-columns: minmax(0, 1fr) minmax(96px, 0.7fr);
            margin: 0 0 6px;
            min-width: 0;
        }
        .helto-qm-filter-input,
        .helto-qm-filter-select {
            background: var(--helto-surface);
            border: 1px solid var(--helto-border-strong);
            border-radius: var(--helto-radius-sm);
            color: var(--helto-text);
            font: inherit;
            height: 28px;
            min-width: 0;
            padding: 0 7px;
            transition: background var(--helto-transition), border-color var(--helto-transition), box-shadow var(--helto-transition);
            width: 100%;
        }
        .helto-qm-filter-input::placeholder {
            color: var(--helto-text-faint);
        }
        .helto-qm-filter-input:hover,
        .helto-qm-filter-select:hover {
            border-color: var(--helto-border-hover);
        }
        .helto-qm-filter-select {
            cursor: pointer;
            padding-right: 4px;
        }
        .helto-qm-list {
            display: grid;
            gap: 6px;
            min-height: 0;
            overflow: auto;
            padding-right: 2px;
        }
        .helto-qm-list::-webkit-scrollbar {
            height: 6px;
            width: 6px;
        }
        .helto-qm-list::-webkit-scrollbar-track {
            background: transparent;
        }
        .helto-qm-list::-webkit-scrollbar-thumb {
            background: var(--helto-border-strong);
            border-radius: 3px;
        }
        .helto-qm-list::-webkit-scrollbar-thumb:hover {
            background: var(--helto-text-faint);
        }
        .helto-qm-row {
            align-items: center;
            background: var(--helto-surface-2);
            border: 1px solid var(--helto-border);
            border-radius: var(--helto-radius);
            display: block;
            min-width: 0;
            padding: 4px 5px;
            transition: border-color var(--helto-transition), box-shadow var(--helto-transition);
        }
        .helto-qm-row-line {
            align-items: center;
            display: grid;
            gap: 5px;
            grid-template-columns: minmax(0, 1fr) auto auto;
            min-height: 28px;
            min-width: 0;
            position: relative;
            z-index: 1;
        }
        .helto-qm-row.running {
            border-color: var(--helto-accent-border);
            box-shadow: var(--helto-shadow-glow);
            overflow: hidden;
            position: relative;
            animation: heltoQmPulse 2s ease-in-out infinite alternate;
        }
        .helto-qm-row.running::after {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            background: linear-gradient(100deg, transparent 30%, rgba(241, 199, 92, 0.14) 50%, transparent 70%);
            transform: translateX(-120%);
            animation: heltoQmShimmer 2.8s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
            .helto-qm-row.running {
                animation: none;
            }
            .helto-qm-row.running::after {
                animation: none;
                display: none;
            }
            .helto-qm-pill.running::before {
                animation: none;
            }
        }
        .helto-qm-row.error {
            border-color: var(--helto-danger-border);
        }
        .helto-qm-row.aborted {
            border-color: var(--helto-border-hover);
        }
        .helto-qm-row-title {
            color: var(--helto-text);
            font-weight: 650;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .helto-qm-row-meta {
            align-items: center;
            color: var(--helto-text-dim);
            display: flex;
            flex: 0 1 auto;
            gap: 4px;
            justify-content: flex-end;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
        }
        .helto-qm-pill {
            align-items: center;
            background: var(--helto-surface);
            border: 1px solid var(--helto-border-strong);
            border-radius: 999px;
            color: var(--helto-text-dim);
            display: inline-flex;
            gap: 4px;
            min-height: 22px;
            max-width: 92px;
            overflow: hidden;
            padding: 0 7px;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .helto-qm-pill.running {
            background: var(--helto-accent-bg);
            border-color: var(--helto-accent-border);
            color: var(--helto-accent-strong);
        }
        .helto-qm-pill.running::before {
            content: "";
            width: 6px;
            height: 6px;
            border-radius: 999px;
            background: var(--helto-accent-strong);
            flex: 0 0 auto;
            animation: heltoQmDot 1.4s ease-in-out infinite;
        }
        .helto-qm-pill.error {
            background: var(--helto-danger-bg);
            border-color: var(--helto-danger-border);
            color: var(--helto-text);
        }
        .helto-qm-pill.aborted {
            background: var(--helto-surface-3);
            border-color: var(--helto-border-hover);
            color: var(--helto-warn);
        }
        .helto-qm-time-pill {
            max-width: 180px;
        }
        .helto-qm-duration-pill {
            max-width: 56px;
        }
        .helto-qm-error-pill {
            justify-content: center;
            max-width: 24px;
            min-width: 22px;
            padding: 0;
        }
        .helto-qm-actions {
            display: flex;
            flex: 0 0 auto;
            gap: 4px;
            justify-content: flex-end;
            white-space: nowrap;
        }
        .helto-qm-empty {
            background: var(--helto-bg);
            border: 1px dashed var(--helto-border-strong);
            border-radius: var(--helto-radius);
            color: var(--helto-text-faint);
            padding: 10px;
            text-align: center;
        }
        #${FALLBACK_PANEL_ID} {
            background: var(--helto-surface);
            border-right: 1px solid var(--helto-border-strong);
            bottom: 0;
            box-shadow: var(--helto-shadow-pop);
            left: 0;
            position: fixed;
            top: 0;
            width: 340px;
            z-index: 10000;
        }
    `;
    document.head.appendChild(style);
}

class HeltoQueueManager {
    constructor() {
        this.state = normalizeQueueState(null);
        this.root = null;
        this.loaded = false;
        this.saving = false;
        this.saveTimer = null;
        this.stateRevision = 0;
        this.submitting = false;
        this.bypass = false;
        this.promptResults = new Map();
        this.stalePromptMisses = new Map();
        this.historyPoll = null;
        this.reconcilingActiveRun = false;
        this.activeTab = "running";
        this.historySearch = "";
        this.historyWorkflowFilter = "";
    }

    async init() {
        await this.loadState();
        this.installQueuePatch();
        this.installEventHandlers();
        this.startHistoryPoll();
    }

    async loadState() {
        try {
            const payload = await jsonFetch(STATE_ROUTE);
            this.state = normalizeQueueState(payload.state, {
                serverSessionId: payload.server_session_id,
                storedServerSessionId: payload.stored_server_session_id,
            });
            this.loaded = true;
            if (this.state.resume_required) {
                await this.saveNow();
            }
        } catch (err) {
            console.error("[Helto Queue Manager] Failed to load state:", err);
            this.loaded = true;
        }
        this.render();
    }

    setState(nextState, { save = true } = {}) {
        this.state = normalizeQueueState(nextState);
        this.stateRevision += 1;
        this.render();
        if (save) {
            this.scheduleSave();
        }
    }

    scheduleSave() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveNow(), 140);
    }

    async saveNow() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        if (!this.loaded) return;
        if (this.saving) {
            this.scheduleSave();
            return;
        }
        const saveRevision = this.stateRevision;
        const stateSnapshot = cloneJson(this.state);
        let needsFollowUpSave = false;
        this.saving = true;
        try {
            const payload = await jsonFetch(STATE_ROUTE, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    state: stateSnapshot,
                    privacy_enabled: !!stateSnapshot.privacy_enabled,
                }),
            });
            const saved = applyQueueStateSaveResponse(
                this.state,
                payload.state,
                this.stateRevision,
                saveRevision,
            );
            this.state = saved.state;
            needsFollowUpSave = saved.needsFollowUpSave;
        } catch (err) {
            console.error("[Helto Queue Manager] Failed to save state:", err);
        } finally {
            this.saving = false;
            if (needsFollowUpSave) {
                this.scheduleSave();
            }
            this.render();
        }
    }

    updateSidebarBadge(summary = queueSummary(this.state)) {
        const count = summary.running + summary.pending;
        const label = count > 99 ? "99+" : String(count);
        document.querySelectorAll(".HeltoQueueManagerIcon").forEach((icon) => {
            if (count > 0) {
                icon.dataset.queueCount = label;
            } else {
                delete icon.dataset.queueCount;
            }
        });
    }

    scheduleSidebarBadgeUpdate() {
        this.updateSidebarBadge();
        globalThis.requestAnimationFrame?.(() => this.updateSidebarBadge());
        setTimeout(() => this.updateSidebarBadge(), 250);
    }

    installQueuePatch() {
        if (app[PATCHED_KEY]) return;

        const manager = this;
        const originalAppQueuePrompt = app.queuePrompt;
        if (typeof originalAppQueuePrompt === "function") {
            app.queuePrompt = async function (...args) {
                if (manager.bypass) {
                    return originalAppQueuePrompt.apply(this, args);
                }
                return manager.captureAppQueuePrompt(args);
            };
        }

        const originalApiQueuePrompt = api.queuePrompt;
        if (typeof originalApiQueuePrompt === "function") {
            api.queuePrompt = async function (...args) {
                if (manager.bypass) {
                    return originalApiQueuePrompt.apply(this, args);
                }
                const promptData = promptDataFromQueueArgs(args);
                if (!promptData) {
                    return originalApiQueuePrompt.apply(this, args);
                }
                return manager.enqueuePromptData(promptData, {
                    number: args[0],
                    front: Number(args[0]) < 0,
                });
            };
        }

        app[PATCHED_KEY] = true;
    }

    installEventHandlers() {
        api?.addEventListener?.("execution_success", ({ detail }) => {
            if (detail?.prompt_id) {
                this.promptResults.set(detail.prompt_id, { status: QUEUE_STATUS_COMPLETED, detail });
            }
        });
        api?.addEventListener?.("execution_error", ({ detail }) => {
            if (detail?.prompt_id) {
                this.promptResults.set(detail.prompt_id, {
                    status: QUEUE_STATUS_ERROR,
                    detail,
                    error: detail?.exception_message || detail?.exception_type || "Execution failed.",
                });
            }
        });
        api?.addEventListener?.("execution_interrupted", ({ detail }) => {
            if (detail?.prompt_id) {
                this.promptResults.set(detail.prompt_id, { status: QUEUE_STATUS_ABORTED, detail });
            }
        });
        api?.addEventListener?.("executing", ({ detail }) => {
            if (detail?.node === null && detail?.prompt_id) {
                this.finishPrompt(detail.prompt_id);
            }
        });
    }

    startHistoryPoll() {
        if (this.historyPoll) return;
        this.historyPoll = setInterval(() => {
            this.reconcileActiveRun().catch((err) => {
                console.error("[Helto Queue Manager] Failed to reconcile active run:", err);
            });
        }, 2500);
    }

    async captureAppQueuePrompt(args) {
        const promptData = promptDataFromQueueArgs(args) || await app.graphToPrompt();
        const number = queueNumberFromArgs(args);
        return this.enqueuePromptData(promptData, {
            number,
            front: Number(number) < 0,
        });
    }

    async enqueuePromptData(promptData, options = {}) {
        const run = createQueueRun(promptData, {
            ...options,
            titleContext: options.titleContext || activeWorkflowTitleContext(),
            promptId: options.promptId || promptId(),
        });
        const nextState = enqueueRun(this.state, run);
        const canStartFromUserAction = !nextState.resume_required;
        this.setState({
            ...nextState,
            paused: canStartFromUserAction ? false : nextState.paused,
        });
        if (canStartFromUserAction) {
            await this.drainQueue();
        }
        return {
            prompt_id: run.prompt_id,
            helto_queue_manager: true,
            queued_run_id: run.id,
            node_errors: {},
        };
    }

    async drainQueue() {
        if (this.submitting || this.state.paused || activeQueueRun(this.state)) {
            return;
        }
        const run = nextPendingRun(this.state);
        if (!run) {
            return;
        }
        this.submitting = true;
        const nextPromptId = run.prompt_id || promptId();
        this.setState(markRunSubmitting(this.state, run.id, nextPromptId));

        try {
            const result = await this.postPrompt({ ...run, prompt_id: nextPromptId });
            this.setState(markRunRunning(this.state, run.id, result.prompt_id || nextPromptId, result.node_errors || null));
        } catch (err) {
            this.setState(moveRunToHistory(this.state, run.id, {
                status: QUEUE_STATUS_ERROR,
                error: err?.message || "Failed to submit workflow.",
            }));
            setTimeout(() => this.drainQueue(), 0);
        } finally {
            this.submitting = false;
        }
    }

    async postPrompt(run) {
        const promptData = run.prompt || {};
        const extraData = cloneJson(promptData.extra_data || {});
        extraData.extra_pnginfo = {
            ...(extraData.extra_pnginfo || {}),
            workflow: cloneJson(promptData.workflow || {}),
        };

        const body = {
            client_id: api.clientId,
            prompt: cloneJson(promptData.output || promptData.prompt || {}),
            extra_data: extraData,
            prompt_id: run.prompt_id,
        };
        if (Number.isFinite(Number(run.number))) {
            body.number = Number(run.number);
        }
        if (run.front) {
            body.front = true;
        }

        const response = await fetch(routeUrl("/prompt"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.error) {
            throw new Error(messageFromPromptError(payload));
        }
        return payload;
    }

    async cancelComfyPrompt(promptIdValue) {
        const cancelRoute = `/api/jobs/${encodeURIComponent(promptIdValue)}/cancel`;
        const response = await fetch(routeUrl(cancelRoute), { method: "POST" });
        if (response.status !== 404 && response.status !== 405) {
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload?.error) {
                throw new Error(payload?.error || `Request failed: ${cancelRoute}`);
            }
            return payload?.cancelled !== false;
        }

        const fallback = await fetch(routeUrl("/interrupt"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt_id: promptIdValue }),
        });
        if (!fallback.ok) {
            throw new Error("Failed to abort workflow.");
        }
        return true;
    }

    async finishPromptIfHistoryExists(promptIdValue) {
        try {
            const history = await this.fetchPromptHistory(promptIdValue);
            if (history) {
                await this.finishPrompt(promptIdValue, history);
                return true;
            }
        } catch (_err) {
            // Polling is opportunistic; websocket lifecycle events remain primary.
        }
        return false;
    }

    async fetchPromptHistory(promptIdValue) {
        const response = await fetch(routeUrl(`/history/${encodeURIComponent(promptIdValue)}`));
        if (!response.ok) return null;
        const payload = await response.json();
        return payload?.[promptIdValue] || null;
    }

    async fetchComfyQueue() {
        const response = await fetch(routeUrl("/queue"));
        if (!response.ok) return null;
        return response.json().catch(() => null);
    }

    async reconcileActiveRun() {
        if (this.reconcilingActiveRun) return;
        const run = activeQueueRun(this.state);
        if (!run?.prompt_id || !isActiveRunStatus(run.status)) return;

        this.reconcilingActiveRun = true;
        try {
            const finished = await this.finishPromptIfHistoryExists(run.prompt_id);
            if (finished) {
                this.stalePromptMisses.delete(run.prompt_id);
                return;
            }

            const queueInfo = await this.fetchComfyQueue();
            if (!queueInfo) return;
            if (comfyQueueHasPromptId(queueInfo, run.prompt_id)) {
                this.stalePromptMisses.delete(run.prompt_id);
                return;
            }

            const misses = (this.stalePromptMisses.get(run.prompt_id) || 0) + 1;
            this.stalePromptMisses.set(run.prompt_id, misses);
            if (misses < STALE_PROMPT_MISS_LIMIT) return;

            const currentRun = activeQueueRun(this.state);
            if (!currentRun || currentRun.prompt_id !== run.prompt_id || !isActiveRunStatus(currentRun.status)) {
                return;
            }

            this.stalePromptMisses.delete(run.prompt_id);
            this.promptResults.delete(run.prompt_id);
            this.setState(moveRunToHistory(this.state, currentRun.id, {
                status: QUEUE_STATUS_ERROR,
                error: "ComfyUI stopped before this run completed.",
            }));
            setTimeout(() => this.drainQueue(), 0);
        } finally {
            this.reconcilingActiveRun = false;
        }
    }

    async finishPrompt(promptIdValue, historyRecord = null) {
        const run = this.state.queue.find((item) => item.prompt_id === promptIdValue);
        if (!run) return;

        const result = this.promptResults.get(promptIdValue) || {};
        let history = historyRecord;
        if (!history) {
            history = await this.fetchPromptHistory(promptIdValue).catch(() => null);
        }
        const historyStatus = history?.status?.status_str;
        const wasAborted = result.status === QUEUE_STATUS_ABORTED || historyHasExecutionEvent(history, "execution_interrupted");
        const status = wasAborted
            ? QUEUE_STATUS_ABORTED
            : (result.status === QUEUE_STATUS_ERROR || historyStatus === "error"
                ? QUEUE_STATUS_ERROR
                : QUEUE_STATUS_COMPLETED);
        const error = result.error || history?.status?.messages?.join("\n") || null;

        this.promptResults.delete(promptIdValue);
        this.stalePromptMisses.delete(promptIdValue);
        this.setState(moveRunToHistory(this.state, run.id, {
            status,
            error: status === QUEUE_STATUS_ERROR ? error : null,
            comfy_history: history,
        }));
        setTimeout(() => this.drainQueue(), 0);
    }

    async abortRun(runId) {
        const run = this.state.queue.find((item) => item.id === runId);
        if (!run?.prompt_id || !isActiveRunStatus(run.status)) return;

        try {
            const aborted = await this.cancelComfyPrompt(run.prompt_id);
            if (!aborted) {
                await this.finishPromptIfHistoryExists(run.prompt_id);
                return;
            }
            this.promptResults.set(run.prompt_id, { status: QUEUE_STATUS_ABORTED });
            this.setState(moveRunToHistory(this.state, run.id, {
                status: QUEUE_STATUS_ABORTED,
                error: null,
            }));
            this.stalePromptMisses.delete(run.prompt_id);
            this.promptResults.delete(run.prompt_id);
            setTimeout(() => this.drainQueue(), 0);
        } catch (err) {
            console.error("[Helto Queue Manager] Failed to abort workflow:", err);
        }
    }

    resumeQueue() {
        this.setState({
            ...this.state,
            paused: false,
            resume_required: false,
        });
        this.drainQueue();
    }

    pauseQueue() {
        this.setState({
            ...this.state,
            paused: true,
        });
    }

    async loadWorkflow(runId, source) {
        const run = (source === "history" ? this.state.history : this.state.queue).find((item) => item.id === runId);
        if (!runCanBeLoaded(run)) return;
        await app.loadGraphData(workflowWithFixedSeedControls(run.prompt.workflow));
        if (fixLiveSeedControls(app.rootGraph ?? app.graph) > 0) {
            app.graph?.setDirtyCanvas?.(true, true);
            app.canvas?.setDirty?.(true, true);
        }
    }

    async rerunHistoryRun(runId) {
        const run = this.findRun(runId, "history");
        if (!runCanBeRerun(run)) return;
        this.activeTab = "running";
        await this.enqueuePromptData(cloneJson(run.prompt), {
            title: run.title,
        });
    }

    deletePendingRun(runId) {
        const run = this.state.queue.find((item) => item.id === runId);
        if (!run || run.status !== QUEUE_STATUS_PENDING) return;
        this.setState(deleteQueueRun(this.state, runId));
    }

    deleteHistoryRun(runId) {
        this.setState(deleteHistoryRun(this.state, runId));
    }

    clearHistory() {
        if (!this.state.history.length) return;
        this.setState(clearQueueHistory(this.state));
    }

    setPrivacy(enabled) {
        this.setState({
            ...this.state,
            privacy_enabled: !!enabled,
        }, { save: false });
        this.saveNow();
    }

    setActiveTab(tab) {
        this.activeTab = tab === "history" ? "history" : "running";
        this.render();
    }

    setHistorySearch(value) {
        this.historySearch = String(value ?? "");
        this.refreshHistoryResults();
    }

    setHistoryWorkflowFilter(value) {
        this.historyWorkflowFilter = String(value ?? "");
        this.refreshHistoryResults();
    }

    attach(root) {
        this.root = root;
        this.render();
    }

    findRun(runId, source) {
        return (source === "history" ? this.state.history : this.state.queue).find((item) => item.id === runId);
    }

    previewRun(runId, source) {
        const run = this.findRun(runId, source);
        const preview = latestMediaPreviewFromHistory(run?.comfy_history);
        const url = previewUrl(preview);
        if (!run || !preview || !url) return;
        hideHeltoMediaPreviewThumbnail();
        openHeltoMediaPreview({
            url,
            kind: preview.kind,
            title: run.title,
            label: preview.label,
        });
    }

    rowHtml(run, source) {
        const statusClass = run.status === QUEUE_STATUS_ERROR ? "error" : (
            run.status === QUEUE_STATUS_ABORTED ? "aborted" : (isActiveRunStatus(run.status) ? "running" : "")
        );
        const time = source === "history" ? formatQueueTime(run.completed_at) : formatQueueTime(run.created_at);
        const duration = source === "history" ? formatQueueDuration(run.started_at, run.completed_at) : "";
        const statusText = displayStatus(run.status === QUEUE_STATUS_SUBMITTING ? "submitting" : run.status);
        const preview = latestMediaPreviewFromHistory(run.comfy_history);
        const previewHref = previewUrl(preview);
        const title = escapeHtml(run.title);
        const error = run.error ? escapeHtml(run.error) : "";
        const canPreview = !!preview && !!previewHref;
        const previewTitle = canPreview ? `Preview latest ${preview.kind}` : "No image or video output available";
        const previewAttrs = canPreview
            ? `data-preview-url="${escapeHtml(previewHref)}" data-preview-kind="${escapeHtml(preview.kind)}" data-preview-title="${title}" data-preview-label="${escapeHtml(preview.label || preview.kind)}"`
            : "";
        const previewButton = `<button class="helto-qm-icon-btn" data-action="preview-${source}" data-run-id="${escapeHtml(run.id)}" ${previewAttrs} title="${escapeHtml(previewTitle)}" aria-label="${escapeHtml(previewTitle)}" ${canPreview ? "" : "disabled"}>${QUEUE_ICONS.preview}</button>`;
        const rerunTitle = runCanBeRerun(run) ? "Rerun workflow" : "Cannot rerun this history item";
        const rerunButton = source === "history"
            ? `<button class="helto-qm-icon-btn" data-action="rerun-history" data-run-id="${escapeHtml(run.id)}" title="${rerunTitle}" aria-label="${rerunTitle}" ${runCanBeRerun(run) ? "" : "disabled"}>${QUEUE_ICONS.rerun}</button>`
            : "";
        const abortButton = source === "queue" && isActiveRunStatus(run.status)
            ? `<button class="helto-qm-icon-btn is-danger" data-action="abort-queue" data-run-id="${escapeHtml(run.id)}" title="Abort workflow" aria-label="Abort workflow" ${run.prompt_id ? "" : "disabled"}>${QUEUE_ICONS.abort}</button>`
            : "";
        const deleteButton = source === "history" || run.status === QUEUE_STATUS_PENDING
            ? `<button class="helto-qm-icon-btn is-danger" data-action="delete-${source}" data-run-id="${escapeHtml(run.id)}" title="Delete ${source === "history" ? "history run" : "queued run"}" aria-label="Delete ${source === "history" ? "history run" : "queued run"}">${QUEUE_ICONS.trash}</button>`
            : "";
        return `
            <div class="helto-qm-row ${statusClass}">
                <div class="helto-qm-row-line">
                    <div class="helto-qm-row-title" title="${title}">${title}</div>
                    <div class="helto-qm-row-meta">
                        <span class="helto-qm-pill ${statusClass}" title="${error || escapeHtml(statusText)}">${escapeHtml(statusText)}</span>
                        ${error ? `<span class="helto-qm-pill helto-qm-error-pill error" title="${error}">!</span>` : ""}
                        ${time ? `<span class="helto-qm-pill helto-qm-time-pill" title="${escapeHtml(time)}">${escapeHtml(time)}</span>` : ""}
                        ${duration ? `<span class="helto-qm-pill helto-qm-duration-pill" title="${escapeHtml(duration)}">${escapeHtml(duration)}</span>` : ""}
                    </div>
                    <div class="helto-qm-actions">
                        ${previewButton}
                        ${rerunButton}
                        ${abortButton}
                        <button class="helto-qm-icon-btn" data-action="load-${source}" data-run-id="${escapeHtml(run.id)}" title="Load workflow" aria-label="Load workflow" ${runCanBeLoaded(run) ? "" : "disabled"}>${QUEUE_ICONS.load}</button>
                        ${deleteButton}
                    </div>
                </div>
            </div>
        `;
    }

    historyWorkflowNames() {
        return [...new Set((this.state.history || []).map((run) => run.title).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    }

    filteredHistoryRuns() {
        const query = normalizeFilterText(this.historySearch);
        const workflowNames = this.historyWorkflowNames();
        const workflow = workflowNames.includes(this.historyWorkflowFilter) ? this.historyWorkflowFilter : "";
        return (this.state.history || []).filter((run) => {
            if (workflow && run.title !== workflow) {
                return false;
            }
            if (!query) {
                return true;
            }
            return [
                run.title,
                run.status,
                run.error,
                formatQueueTime(run.completed_at),
                formatQueueDuration(run.started_at, run.completed_at),
            ].some((value) => normalizeFilterText(value).includes(query));
        });
    }

    historyFilterHtml() {
        const workflowNames = this.historyWorkflowNames();
        const selectedWorkflow = workflowNames.includes(this.historyWorkflowFilter) ? this.historyWorkflowFilter : "";
        const options = [
            `<option value="">All workflows</option>`,
            ...workflowNames.map((name) => (
                `<option value="${escapeHtml(name)}" ${name === selectedWorkflow ? "selected" : ""}>${escapeHtml(name)}</option>`
            )),
        ].join("");
        return `
            <div class="helto-qm-history-filters">
                <input class="helto-qm-filter-input" data-action="history-search" type="search" value="${escapeHtml(this.historySearch)}" placeholder="Search history" aria-label="Search history">
                <select class="helto-qm-filter-select" data-action="history-workflow-filter" aria-label="Filter history by workflow">
                    ${options}
                </select>
            </div>
        `;
    }

    historyListHtml() {
        const rows = this.filteredHistoryRuns().map((run) => this.rowHtml(run, "history")).join("");
        const empty = this.state.history.length ? "No matching history" : "No history";
        return rows || `<div class="helto-qm-empty">${empty}</div>`;
    }

    bindEvents() {
        if (!this.root) return;
        this.root.querySelector("[data-action='resume']")?.addEventListener("click", () => this.resumeQueue());
        this.root.querySelector("[data-action='pause']")?.addEventListener("click", () => this.pauseQueue());
        this.root.querySelector("[data-action='privacy']")?.addEventListener("click", () => this.setPrivacy(!this.state.privacy_enabled));
        this.root.querySelector("[data-action='clear-history']")?.addEventListener("click", () => this.clearHistory());
        this.root.querySelectorAll("[data-tab]").forEach((button) => {
            button.addEventListener("click", () => this.setActiveTab(button.dataset.tab));
        });
        this.root.querySelector("[data-action='history-search']")?.addEventListener("input", (event) => {
            this.setHistorySearch(event.target.value);
        });
        this.root.querySelector("[data-action='history-workflow-filter']")?.addEventListener("change", (event) => {
            this.setHistoryWorkflowFilter(event.target.value);
        });
        this.bindRunRowEvents(this.root);
    }

    bindRunRowEvents(root) {
        if (!root) return;
        root.querySelectorAll("[data-action='load-queue']").forEach((button) => {
            button.addEventListener("click", () => this.loadWorkflow(button.dataset.runId, "queue"));
        });
        root.querySelectorAll("[data-action='load-history']").forEach((button) => {
            button.addEventListener("click", () => this.loadWorkflow(button.dataset.runId, "history"));
        });
        root.querySelectorAll("[data-action='preview-queue']").forEach((button) => {
            button.addEventListener("click", () => this.previewRun(button.dataset.runId, "queue"));
            this.attachPreviewHover(button);
        });
        root.querySelectorAll("[data-action='preview-history']").forEach((button) => {
            button.addEventListener("click", () => this.previewRun(button.dataset.runId, "history"));
            this.attachPreviewHover(button);
        });
        root.querySelectorAll("[data-action='rerun-history']").forEach((button) => {
            button.addEventListener("click", () => this.rerunHistoryRun(button.dataset.runId));
        });
        root.querySelectorAll("[data-action='abort-queue']").forEach((button) => {
            button.addEventListener("click", () => this.abortRun(button.dataset.runId));
        });
        root.querySelectorAll("[data-action='delete-queue']").forEach((button) => {
            button.addEventListener("click", () => this.deletePendingRun(button.dataset.runId));
        });
        root.querySelectorAll("[data-action='delete-history']").forEach((button) => {
            button.addEventListener("click", () => this.deleteHistoryRun(button.dataset.runId));
        });
    }

    refreshHistoryResults() {
        if (!this.root || this.activeTab !== "history") return;
        const list = this.root.querySelector("[data-history-list]");
        if (!list) return;
        list.innerHTML = this.historyListHtml();
        this.bindRunRowEvents(list);
    }

    attachPreviewHover(button) {
        if (button.disabled || !button.dataset.previewUrl) return;
        attachHeltoMediaPreviewHover(button, () => ({
            url: button.dataset.previewUrl,
            kind: button.dataset.previewKind,
            title: button.dataset.previewTitle,
            label: button.dataset.previewLabel,
        }));
    }

    render() {
        const summary = queueSummary(this.state);
        this.updateSidebarBadge(summary);
        if (!this.root) return;
        hideHeltoMediaPreviewThumbnail();
        const queueRows = this.state.queue.map((run) => this.rowHtml(run, "queue")).join("");
        const historyRows = this.historyListHtml();
        const resumeDisabled = !this.state.queue.some((run) => run.status === QUEUE_STATUS_PENDING) || activeQueueRun(this.state);
        const pauseDisabled = this.state.paused;
        const currentRows = this.activeTab === "history" ? historyRows : queueRows;
        const currentEmpty = this.activeTab === "history" ? "No history" : "No queued runs";
        const currentTitle = this.activeTab === "history" ? "History" : "Running";

        this.root.innerHTML = `
            <div class="helto-qm">
                <div class="helto-qm-header">
                    <div class="helto-qm-title">QManager</div>
                </div>
                <div class="helto-qm-toolbar">
                    <button class="helto-qm-icon-btn is-primary" data-action="resume" title="Resume queue" aria-label="Resume queue" ${resumeDisabled ? "disabled" : ""}>${QUEUE_ICONS.play}</button>
                    <button class="helto-qm-icon-btn" data-action="pause" title="Pause queue" aria-label="Pause queue" ${pauseDisabled ? "disabled" : ""}>${QUEUE_ICONS.pause}</button>
                    <span class="helto-qm-toolbar-spacer"></span>
                    <button class="helto-qm-icon-btn ${this.state.privacy_enabled ? "is-active" : ""}" data-action="privacy" title="${this.state.privacy_enabled ? "Disable encrypted persistence" : "Enable encrypted persistence"}" aria-label="${this.state.privacy_enabled ? "Disable encrypted persistence" : "Enable encrypted persistence"}" aria-pressed="${this.state.privacy_enabled ? "true" : "false"}">${this.state.privacy_enabled ? QUEUE_ICONS.lock : QUEUE_ICONS.unlock}</button>
                </div>
                ${this.state.resume_required ? `<div class="helto-qm-banner">Queue paused after restart.</div>` : ""}
                <div class="helto-qm-status">
                    <div><strong>${summary.running}</strong><span>Running</span></div>
                    <div><strong>${summary.pending}</strong><span>Pending</span></div>
                    <div><strong>${summary.history}</strong><span>History</span></div>
                </div>
                <div class="helto-qm-tabs" role="tablist" aria-label="Queue views">
                    <button class="helto-qm-tab ${this.activeTab === "running" ? "is-active" : ""}" data-tab="running" role="tab" aria-selected="${this.activeTab === "running" ? "true" : "false"}">
                        <span>Running</span>
                        <span class="helto-qm-tab-count">${summary.running + summary.pending}</span>
                    </button>
                    <button class="helto-qm-tab ${this.activeTab === "history" ? "is-active" : ""}" data-tab="history" role="tab" aria-selected="${this.activeTab === "history" ? "true" : "false"}">
                        <span>History</span>
                        <span class="helto-qm-tab-count">${summary.history}</span>
                    </button>
                </div>
                <div class="helto-qm-section">
                    <div class="helto-qm-section-head">
                        <span>${currentTitle}</span>
                        ${this.activeTab === "history" ? `<button class="helto-qm-icon-btn is-danger" data-action="clear-history" title="Delete all history" aria-label="Delete all history" ${this.state.history.length ? "" : "disabled"}>${QUEUE_ICONS.clear}</button>` : ""}
                    </div>
                    ${this.activeTab === "history" ? this.historyFilterHtml() : ""}
                    <div class="helto-qm-list" ${this.activeTab === "history" ? "data-history-list" : ""}>
                        ${currentRows || `<div class="helto-qm-empty">${currentEmpty}</div>`}
                    </div>
                </div>
            </div>
        `;
        this.bindEvents();
    }
}

function registerSidebar(manager) {
    if (typeof app.extensionManager?.registerSidebarTab === "function") {
        app.extensionManager.registerSidebarTab({
            id: "helto-queue-manager",
            title: "QManager",
            icon: "HeltoQueueManagerIcon",
            type: "custom",
            render: (element) => manager.attach(element),
        });
        manager.scheduleSidebarBadgeUpdate();
        return;
    }

    if (!document.getElementById(FALLBACK_PANEL_ID)) {
        const panel = document.createElement("div");
        panel.id = FALLBACK_PANEL_ID;
        document.body.appendChild(panel);
        manager.attach(panel);
    }
    manager.scheduleSidebarBadgeUpdate();
}

injectStyles();
const queueManager = new HeltoQueueManager();

app.registerExtension({
    name: "Helto.QueueManager",
    async setup() {
        registerSidebar(queueManager);
        await queueManager.init();
    },
});
