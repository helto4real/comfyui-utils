import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import {
    applyProgressEvent,
    createProgressState,
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
            background: var(--helto-bg, #181825);
            border-bottom: 1px solid rgba(250, 179, 135, 0.24);
            box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.35), 0 1px 0 rgba(255, 255, 255, 0.08);
            box-sizing: border-box;
            color: var(--helto-text, #cdd6f4);
            cursor: default;
            display: block;
            font: 700 10px / 1 var(--helto-font-sans, system-ui, sans-serif);
            height: var(--helto-progress-height);
            left: 0;
            overflow: visible;
            position: relative;
            top: 0;
            transition: opacity 240ms cubic-bezier(0.34, 1.56, 0.64, 1);
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
            transition: width 90ms linear;
            width: 0%;
        }
        .helto-progress-track {
            background: linear-gradient(180deg, var(--helto-surface, #1e1e2e), var(--helto-bg, #181825));
            overflow: hidden;
            right: 0;
            width: 100%;
        }
        /* Overall workflow progress: dim gold, brighter toward the leading edge. */
        .helto-progress-workflow {
            background: linear-gradient(90deg, rgba(250, 179, 135, 0.14), rgba(250, 179, 135, 0.30));
            border-right: 1px solid var(--helto-accent-border, #93664a);
            height: 50%;
            overflow: hidden;
            transition: width 90ms linear, background 240ms ease, height 240ms ease;
        }
        /* Current node progress: translucent gold (keeps overlaid text legible),
           the "live" step is emphasised by its crisp leading edge, glow and sheen. */
        .helto-progress-node {
            background: linear-gradient(90deg, rgba(250, 179, 135, 0.32), rgba(250, 179, 135, 0.52));
            border-right: 1px solid var(--helto-accent-strong, #fddcc4);
            overflow: hidden;
            top: 50%;
        }
        /* Soft sheen that sweeps across the live node bar while running. */
        .helto-progress-node::after {
            content: "";
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.38), transparent);
            opacity: 0;
            transform: translateX(-120%);
            pointer-events: none;
        }
        /* Indeterminate shimmer when running with no known percentage. */
        .helto-progress-track::after {
            content: "";
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, transparent, rgba(250, 179, 135, 0.16), rgba(250, 179, 135, 0.36), rgba(250, 179, 135, 0.16), transparent);
            opacity: 0;
            transform: translateX(-70%);
            pointer-events: none;
        }
        .helto-progress-bar.is-running .helto-progress-node {
            box-shadow: var(--helto-shadow-glow, 0 0 10px rgba(250, 179, 135, 0.35));
        }
        .helto-progress-bar.is-idle {
            opacity: 0.7;
        }
        /* Completion flourish: translucent gold fills the strip, glow does the "pop". */
        .helto-progress-bar.is-complete .helto-progress-workflow {
            background: linear-gradient(90deg, rgba(250, 179, 135, 0.34), rgba(250, 179, 135, 0.5));
            height: 100%;
        }
        .helto-progress-bar.is-error .helto-progress-workflow,
        .helto-progress-bar.is-error .helto-progress-node {
            background: var(--helto-danger, #f38ba8);
            border-right-color: rgba(255, 255, 255, 0.45);
        }
        @media (prefers-reduced-motion: no-preference) {
            .helto-progress-bar.is-running .helto-progress-node::after {
                opacity: 1;
                animation: heltoProgressSheen 4s ease-in-out infinite;
            }
            .helto-progress-bar.is-indeterminate .helto-progress-track::after {
                opacity: 1;
                animation: heltoProgressIndeterminate 2.8s ease-in-out infinite;
            }
            .helto-progress-bar.is-complete {
                animation: heltoProgressComplete 0.9s ease-out;
            }
        }
        @keyframes heltoProgressSheen {
            0% { transform: translateX(-120%); }
            32%, 100% { transform: translateX(120%); }
        }
        @keyframes heltoProgressIndeterminate {
            0% { transform: translateX(-70%); }
            100% { transform: translateX(170%); }
        }
        @keyframes heltoProgressComplete {
            0% { box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.35), 0 1px 0 rgba(255, 255, 255, 0.06); }
            30% { box-shadow: inset 0 0 18px rgba(250, 179, 135, 0.55), 0 0 12px rgba(250, 179, 135, 0.4); }
            100% { box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.35), 0 1px 0 rgba(255, 255, 255, 0.06); }
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
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9), 0 0 2px rgba(0, 0, 0, 0.55);
            top: 0;
            white-space: nowrap;
            z-index: 2;
        }
    `;
    document.head.appendChild(style);
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
            root.title = "Helto progress";
            root.innerHTML = `
                <div class="helto-progress-track">
                    <div class="helto-progress-workflow"></div>
                    <div class="helto-progress-node"></div>
                </div>
                <div class="helto-progress-text">Idle</div>
            `;
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
        const status = snapshot.status;
        const indeterminate = status === "running"
            && snapshot.currentPercent == null
            && snapshot.workflowPercent == null;
        this.root.classList.toggle("is-error", status === "error");
        this.root.classList.toggle("is-running", status === "running");
        this.root.classList.toggle("is-indeterminate", indeterminate);
        this.root.classList.toggle("is-complete", status === "success");
        this.root.classList.toggle("is-idle", status === "idle" || status === "interrupted");
        this.workflowEl.style.width = `${snapshot.workflowWidth || 0}%`;
        this.nodeEl.style.width = `${snapshot.currentWidth || 0}%`;
        this.textEl.textContent = text;
    }
}

const progressBar = new HeltoProgressBar();

app.registerExtension({
    name: "Helto.ProgressBar",
    setup() {
        progressBar.setup();
    },
});
