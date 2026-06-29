import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import {
    applyProgressEvent,
    createProgressState,
    eventDisplayText,
    formatProgressText,
    progressSnapshot,
    rememberPromptData,
} from "./progress_bar_helpers.js";

const STYLE_LINK_ID = "helto-utils-styles";
const PROGRESS_STYLE_ID = "helto-progress-bar-styles";
const ROOT_ID = "helto-progress-bar";
const CAPTURE_KEY = "__heltoProgressQueueCapture";

function ensureSharedStylesheet() {
    if (document.getElementById(STYLE_LINK_ID)) return;
    const link = document.createElement("link");
    link.id = STYLE_LINK_ID;
    link.rel = "stylesheet";
    link.href = new URL("./styles.css", import.meta.url).href;
    document.head.appendChild(link);
}

function injectStyles() {
    if (document.getElementById(PROGRESS_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PROGRESS_STYLE_ID;
    style.textContent = `
        .helto-progress-bar {
            --helto-progress-height: 14px;
            align-items: stretch;
            background: var(--bg-tertiary, #0d1320);
            border-bottom: 1px solid rgba(241, 199, 92, 0.24);
            box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.35), 0 1px 0 rgba(255, 255, 255, 0.08);
            box-sizing: border-box;
            color: var(--text-primary, #e7ebf3);
            cursor: default;
            display: block;
            font: 700 10px / 1 var(--font-sans, system-ui, sans-serif);
            height: var(--helto-progress-height);
            left: 0;
            overflow: visible;
            position: relative;
            top: 0;
            user-select: none;
            width: 100%;
            z-index: 999;
        }
        .helto-progress-bar.helto-progress-body-fallback {
            position: fixed;
        }
        .helto-progress-track,
        .helto-progress-workflow,
        .helto-progress-node {
            border-radius: 0;
            bottom: 0;
            box-sizing: border-box;
            left: 0;
            position: absolute;
            top: 0;
            transition: width 80ms ease;
            width: 0%;
        }
        .helto-progress-track {
            background: linear-gradient(180deg, var(--bg-primary, #151c2a), var(--bg-tertiary, #0d1320));
            overflow: hidden;
            right: 0;
            width: 100%;
        }
        .helto-progress-workflow {
            background: linear-gradient(90deg, rgba(241, 199, 92, 0.34), rgba(241, 199, 92, 0.22));
            border-right: 1px solid var(--accent-border, rgba(241, 199, 92, 0.55));
            height: 50%;
        }
        .helto-progress-node {
            background: linear-gradient(90deg, rgba(94, 155, 255, 0.48), rgba(94, 155, 255, 0.28));
            border-right: 1px solid rgba(94, 155, 255, 0.65);
            top: 50%;
        }
        .helto-progress-bar.is-error .helto-progress-workflow,
        .helto-progress-bar.is-error .helto-progress-node {
            background: var(--danger, #ec5a6b);
            border-right-color: rgba(255, 255, 255, 0.45);
        }
        .helto-progress-text {
            align-items: center;
            bottom: 0;
            box-sizing: border-box;
            display: flex;
            left: 0;
            min-width: 0;
            overflow: hidden;
            padding: 0 8px;
            pointer-events: none;
            position: absolute;
            right: 0;
            text-overflow: ellipsis;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
            top: 0;
            white-space: nowrap;
            z-index: 2;
        }
        .helto-progress-popover {
            background: var(--bg-primary, #151c2a);
            border: 1px solid var(--border-strong, #3a465c);
            border-radius: 8px;
            box-shadow: var(--shadow-main, 0 14px 36px rgba(0, 0, 0, 0.55));
            box-sizing: border-box;
            color: var(--text-primary, #e7ebf3);
            display: none;
            font: 12px / 1.4 var(--font-sans, system-ui, sans-serif);
            max-height: min(360px, calc(100vh - 42px));
            overflow: hidden;
            position: fixed;
            right: 12px;
            top: 20px;
            width: min(520px, calc(100vw - 24px));
            z-index: 10000;
        }
        .helto-progress-popover.is-visible {
            display: flex;
            flex-direction: column;
        }
        .helto-progress-popover-header {
            align-items: center;
            border-bottom: 1px solid var(--border-subtle, #2a3346);
            display: flex;
            gap: 8px;
            justify-content: space-between;
            min-height: 34px;
            padding: 8px 10px;
        }
        .helto-progress-popover-title {
            color: var(--accent-primary, #f1c75c);
            font-size: 12px;
            font-weight: 800;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .helto-progress-popover-status {
            color: var(--text-secondary, #9aa6bd);
            flex: 0 0 auto;
            font-size: 11px;
        }
        .helto-progress-events {
            display: flex;
            flex-direction: column;
            gap: 0;
            overflow: auto;
            padding: 4px 0;
        }
        .helto-progress-event {
            border-left: 3px solid transparent;
            display: grid;
            gap: 2px 8px;
            grid-template-columns: 70px minmax(0, 1fr);
            padding: 7px 10px;
        }
        .helto-progress-event + .helto-progress-event {
            border-top: 1px solid rgba(42, 51, 70, 0.72);
        }
        .helto-progress-event.is-error {
            border-left-color: var(--danger, #ec5a6b);
        }
        .helto-progress-event.is-warning {
            border-left-color: var(--accent-primary, #f1c75c);
        }
        .helto-progress-event.is-success {
            border-left-color: #7bd88f;
        }
        .helto-progress-event-time {
            color: var(--text-dim, #6f7c95);
            font-family: var(--font-mono, ui-monospace, monospace);
            font-size: 11px;
        }
        .helto-progress-event-message {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .helto-progress-event-meta {
            color: var(--text-secondary, #9aa6bd);
            font-size: 11px;
            grid-column: 2;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .helto-progress-empty {
            color: var(--text-secondary, #9aa6bd);
            padding: 14px 10px;
        }
    `;
    document.head.appendChild(style);
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

function promptDataFromArgs(args) {
    return args.find((arg) => arg && typeof arg === "object" && (arg.output || arg.prompt)) || null;
}

class HeltoProgressBar {
    constructor() {
        this.state = createProgressState();
        this.root = null;
        this.workflowEl = null;
        this.nodeEl = null;
        this.textEl = null;
        this.popoverEl = null;
        this.pinned = false;
        this.hovering = false;
    }

    setup() {
        ensureSharedStylesheet();
        injectStyles();
        this.mount();
        this.installEventHandlers();
        this.installQueuePromptCapture(app, "queuePrompt");
        this.installQueuePromptCapture(api, "queuePrompt");
        this.render();
    }

    mount() {
        let root = document.getElementById(ROOT_ID);
        if (!root) {
            root = document.createElement("div");
            root.id = ROOT_ID;
            root.className = "helto-progress-bar";
            root.setAttribute("role", "status");
            root.setAttribute("aria-live", "polite");
            root.innerHTML = `
                <div class="helto-progress-track">
                    <div class="helto-progress-workflow"></div>
                    <div class="helto-progress-node"></div>
                </div>
                <div class="helto-progress-text">Idle</div>
                <div class="helto-progress-popover" role="dialog" aria-label="Helto progress details"></div>
            `;
            root.addEventListener("mouseenter", () => {
                this.hovering = true;
                this.showPopover();
            });
            root.addEventListener("mouseleave", () => {
                this.hovering = false;
                if (!this.pinned) this.hidePopoverSoon();
            });
            root.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.pinned = !this.pinned;
                this.centerCurrentNode();
                this.updatePopoverVisibility();
            });
        }

        const target = document.querySelector(".comfyui-body-top") || document.body;
        root.classList.toggle("helto-progress-body-fallback", target === document.body);
        if (root.parentElement !== target) {
            target.appendChild(root);
        }

        this.root = root;
        this.workflowEl = root.querySelector(".helto-progress-workflow");
        this.nodeEl = root.querySelector(".helto-progress-node");
        this.textEl = root.querySelector(".helto-progress-text");
        this.popoverEl = root.querySelector(".helto-progress-popover");
    }

    installEventHandlers() {
        const events = [
            "status",
            "execution_start",
            "execution_cached",
            "executing",
            "progress",
            "progress_state",
            "executed",
            "execution_success",
            "execution_error",
            "execution_interrupted",
            "helto_progress",
            "progress_text",
        ];
        for (const eventName of events) {
            api?.addEventListener?.(eventName, ({ detail }) => {
                this.applyEvent(eventName, detail);
            });
        }
    }

    installQueuePromptCapture(target, methodName) {
        if (!target || typeof target[methodName] !== "function" || target[methodName][CAPTURE_KEY]) {
            return;
        }

        const manager = this;
        const original = target[methodName];
        async function wrappedQueuePrompt(...args) {
            const promptData = promptDataFromArgs(args);
            const response = await original.apply(this, args);
            if (response?.prompt_id && promptData) {
                manager.state = rememberPromptData(manager.state, response.prompt_id, promptData);
                manager.render();
            }
            return response;
        }
        Object.defineProperty(wrappedQueuePrompt, CAPTURE_KEY, {
            value: true,
            configurable: true,
        });
        target[methodName] = wrappedQueuePrompt;
    }

    applyEvent(eventName, detail) {
        this.state = applyProgressEvent(this.state, eventName, detail, {
            now: Date.now(),
            resolveNodeLabel: (nodeId, eventDetail) => this.resolveNodeLabel(nodeId, eventDetail),
        });
        this.render();
    }

    resolveNodeLabel(nodeId, detail = {}) {
        const graph = app?.rootGraph || app?.graph;
        const candidates = [
            detail?.display_node_id,
            detail?.display_node,
            nodeId,
        ];
        for (const candidate of candidates) {
            const numericId = Number(candidate);
            if (!Number.isFinite(numericId)) continue;
            const node = graph?.getNodeById?.(numericId);
            const label = node?.title || node?.type || node?.comfyClass;
            if (label) return label;
        }
        return detail?.node_type || null;
    }

    render() {
        if (!this.root) return;
        const snapshot = progressSnapshot(this.state);
        const text = formatProgressText(snapshot);
        this.root.classList.toggle("is-error", snapshot.status === "error");
        this.workflowEl.style.width = `${snapshot.workflowWidth || 0}%`;
        this.nodeEl.style.width = `${snapshot.currentWidth || 0}%`;
        this.textEl.textContent = text;
        this.root.title = snapshot.currentNodeId
            ? "Helto progress. Click to focus the current node and pin details."
            : "Helto progress. Click to pin details.";
        this.renderPopover(snapshot);
        this.updatePopoverVisibility();
    }

    renderPopover(snapshot) {
        const title = snapshot.current?.label || snapshot.error?.nodeType || "Helto progress";
        const status = snapshot.workflowPercent == null
            ? snapshot.status
            : `${Math.round(snapshot.workflowPercent)}% workflow`;
        const events = snapshot.recentEvents;
        const body = events.length
            ? events.map((event) => this.renderEvent(event)).join("")
            : `<div class="helto-progress-empty">No detailed node events yet.</div>`;
        this.popoverEl.innerHTML = `
            <div class="helto-progress-popover-header">
                <div class="helto-progress-popover-title">${escapeHtml(title)}</div>
                <div class="helto-progress-popover-status">${escapeHtml(status)}</div>
            </div>
            <div class="helto-progress-events">${body}</div>
        `;
    }

    renderEvent(event) {
        const classes = ["helto-progress-event"];
        if (event.level === "error") classes.push("is-error");
        if (event.level === "warning") classes.push("is-warning");
        if (event.level === "success") classes.push("is-success");
        const percent = event.percent == null ? "" : ` ${Math.round(event.percent)}%`;
        const node = event.displayNodeId || event.nodeId || "";
        const meta = [node ? `Node ${node}` : "", event.event || "", percent.trim()].filter(Boolean).join(" - ");
        return `
            <div class="${classes.join(" ")}">
                <div class="helto-progress-event-time">${escapeHtml(formatEventTime(event.timestamp))}</div>
                <div class="helto-progress-event-message">${escapeHtml(eventDisplayText(event))}</div>
                <div class="helto-progress-event-meta">${escapeHtml(meta)}</div>
            </div>
        `;
    }

    showPopover() {
        this.popoverEl?.classList.add("is-visible");
    }

    hidePopoverSoon() {
        setTimeout(() => {
            if (!this.hovering && !this.pinned) {
                this.popoverEl?.classList.remove("is-visible");
            }
        }, 120);
    }

    updatePopoverVisibility() {
        if (this.pinned || this.hovering) {
            this.showPopover();
        } else {
            this.popoverEl?.classList.remove("is-visible");
        }
    }

    centerCurrentNode() {
        const nodeId = progressSnapshot(this.state).currentNodeId;
        const numericId = Number(nodeId);
        if (!Number.isFinite(numericId)) return;
        const graph = app?.rootGraph || app?.graph;
        const node = graph?.getNodeById?.(numericId);
        if (!node) return;
        app?.canvas?.centerOnNode?.(node);
        app?.canvas?.selectNode?.(node);
    }
}

function formatEventTime(timestamp) {
    const date = new Date(Number(timestamp || 0) * 1000);
    if (!Number.isFinite(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const progressBar = new HeltoProgressBar();

app.registerExtension({
    name: "Helto.ProgressBar",
    setup() {
        progressBar.setup();
    },
});
