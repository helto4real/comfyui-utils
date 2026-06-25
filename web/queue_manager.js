import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import { ICONS } from "./constants.js";
import {
    QUEUE_STATUS_COMPLETED,
    QUEUE_STATUS_ERROR,
    QUEUE_STATUS_PENDING,
    QUEUE_STATUS_RUNNING,
    QUEUE_STATUS_SUBMITTING,
    activeQueueRun,
    clearQueueHistory,
    cloneJson,
    createQueueRun,
    deleteHistoryRun,
    deleteQueueRun,
    enqueueRun,
    formatQueueTime,
    markRunRunning,
    markRunSubmitting,
    moveRunToHistory,
    nextPendingRun,
    normalizeQueueState,
    queueSummary,
    runCanBeLoaded,
} from "./queue_manager_helpers.js";

const STATE_ROUTE = "/helto_queue_manager/state";
const PATCHED_KEY = "__heltoQueueManagerPatched";
const STYLE_ID = "helto-queue-manager-styles";
const FALLBACK_PANEL_ID = "helto-queue-manager-fallback";

const QUEUE_ICONS = {
    play: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"/></svg>`,
    pause: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4v16"/><path d="M16 4v16"/></svg>`,
    load: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
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

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[char]));
}

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .HeltoQueueManagerIcon:before {
            content: "Q";
            font-weight: 800;
        }
        .helto-qm {
            box-sizing: border-box;
            color: var(--fg-color, #dfe4ee);
            display: flex;
            flex-direction: column;
            font: 12px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            height: 100%;
            min-height: 0;
            padding: 10px;
            width: 100%;
        }
        .helto-qm * {
            box-sizing: border-box;
        }
        .helto-qm-header {
            align-items: center;
            display: flex;
            gap: 8px;
            justify-content: space-between;
            margin-bottom: 10px;
        }
        .helto-qm-title {
            color: #f3f5f8;
            font-size: 14px;
            font-weight: 700;
        }
        .helto-qm-privacy {
            align-items: center;
            color: #bac3d2;
            display: flex;
            gap: 5px;
            white-space: nowrap;
        }
        .helto-qm-privacy input {
            accent-color: #5fa36b;
        }
        .helto-qm-toolbar {
            display: grid;
            gap: 6px;
            grid-template-columns: 1fr 1fr;
            margin-bottom: 8px;
        }
        .helto-qm-btn,
        .helto-qm-icon-btn {
            align-items: center;
            background: #222936;
            border: 1px solid #3a4456;
            border-radius: 5px;
            color: #e8edf5;
            cursor: pointer;
            display: inline-flex;
            font: inherit;
            gap: 6px;
            height: 28px;
            justify-content: center;
            min-width: 0;
            padding: 0 8px;
        }
        .helto-qm-btn:hover,
        .helto-qm-icon-btn:hover {
            background: #2c3545;
            border-color: #566278;
        }
        .helto-qm-btn:disabled,
        .helto-qm-icon-btn:disabled {
            cursor: default;
            opacity: 0.48;
        }
        .helto-qm-btn.primary {
            background: #244633;
            border-color: #3e7550;
        }
        .helto-qm-btn.warn {
            background: #4a3620;
            border-color: #806237;
        }
        .helto-qm-icon-btn {
            flex: 0 0 28px;
            padding: 0;
            width: 28px;
        }
        .helto-qm-status {
            border: 1px solid #344052;
            border-radius: 6px;
            color: #c9d2df;
            display: grid;
            gap: 4px;
            grid-template-columns: repeat(3, 1fr);
            margin-bottom: 10px;
            padding: 7px;
        }
        .helto-qm-status strong {
            color: #f3f5f8;
            display: block;
            font-size: 13px;
        }
        .helto-qm-banner {
            background: #3b2d1a;
            border: 1px solid #806237;
            border-radius: 6px;
            color: #f3d8a4;
            margin-bottom: 8px;
            padding: 7px;
        }
        .helto-qm-section {
            display: flex;
            flex-direction: column;
            min-height: 0;
        }
        .helto-qm-section.history {
            flex: 1;
        }
        .helto-qm-section-head {
            align-items: center;
            color: #aeb9c8;
            display: flex;
            font-size: 11px;
            font-weight: 700;
            justify-content: space-between;
            letter-spacing: 0.04em;
            margin: 7px 0 6px;
            text-transform: uppercase;
        }
        .helto-qm-list {
            display: grid;
            gap: 6px;
            min-height: 0;
            overflow: auto;
            padding-right: 2px;
        }
        .helto-qm-row {
            background: #151a23;
            border: 1px solid #2e3748;
            border-radius: 6px;
            display: grid;
            gap: 7px;
            padding: 8px;
        }
        .helto-qm-row.running {
            border-color: #3e7550;
        }
        .helto-qm-row.error {
            border-color: #8b4d4d;
        }
        .helto-qm-row-title {
            color: #f3f5f8;
            font-weight: 650;
            min-width: 0;
            overflow-wrap: anywhere;
        }
        .helto-qm-row-meta {
            color: #9ba7b8;
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
        }
        .helto-qm-pill {
            align-items: center;
            background: #242c39;
            border-radius: 4px;
            color: #c6cfdc;
            display: inline-flex;
            gap: 4px;
            min-height: 20px;
            padding: 2px 6px;
        }
        .helto-qm-pill.running {
            background: #1f3b2b;
            color: #a9e2b7;
        }
        .helto-qm-pill.error {
            background: #442626;
            color: #f0b0b0;
        }
        .helto-qm-actions {
            display: flex;
            gap: 5px;
            justify-content: flex-end;
        }
        .helto-qm-empty {
            border: 1px dashed #384456;
            border-radius: 6px;
            color: #8f9bad;
            padding: 10px;
            text-align: center;
        }
        #${FALLBACK_PANEL_ID} {
            background: #111721;
            border-right: 1px solid #313b4b;
            bottom: 0;
            box-shadow: 8px 0 24px rgba(0, 0, 0, 0.32);
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
        this.submitting = false;
        this.bypass = false;
        this.promptResults = new Map();
        this.historyPoll = null;
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
        if (!this.loaded || this.saving) return;
        this.saving = true;
        try {
            const payload = await jsonFetch(STATE_ROUTE, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    state: this.state,
                    privacy_enabled: !!this.state.privacy_enabled,
                }),
            });
            this.state = normalizeQueueState(payload.state);
        } catch (err) {
            console.error("[Helto Queue Manager] Failed to save state:", err);
        } finally {
            this.saving = false;
            this.render();
        }
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
        api?.addEventListener?.("executing", ({ detail }) => {
            if (detail?.node === null && detail?.prompt_id) {
                this.finishPrompt(detail.prompt_id);
            }
        });
    }

    startHistoryPoll() {
        if (this.historyPoll) return;
        this.historyPoll = setInterval(() => {
            const run = activeQueueRun(this.state);
            if (run?.prompt_id && (run.status === QUEUE_STATUS_RUNNING || run.status === QUEUE_STATUS_SUBMITTING)) {
                this.finishPromptIfHistoryExists(run.prompt_id);
            }
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

    async finishPromptIfHistoryExists(promptIdValue) {
        try {
            const history = await this.fetchPromptHistory(promptIdValue);
            if (history) {
                await this.finishPrompt(promptIdValue, history);
            }
        } catch (_err) {
            // Polling is opportunistic; websocket lifecycle events remain primary.
        }
    }

    async fetchPromptHistory(promptIdValue) {
        const response = await fetch(routeUrl(`/history/${encodeURIComponent(promptIdValue)}`));
        if (!response.ok) return null;
        const payload = await response.json();
        return payload?.[promptIdValue] || null;
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
        const status = result.status === QUEUE_STATUS_ERROR || historyStatus === "error"
            ? QUEUE_STATUS_ERROR
            : QUEUE_STATUS_COMPLETED;
        const error = result.error || history?.status?.messages?.join("\n") || null;

        this.promptResults.delete(promptIdValue);
        this.setState(moveRunToHistory(this.state, run.id, {
            status,
            error: status === QUEUE_STATUS_ERROR ? error : null,
            comfy_history: history,
        }));
        setTimeout(() => this.drainQueue(), 0);
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
        await app.loadGraphData(cloneJson(run.prompt.workflow));
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
        });
    }

    attach(root) {
        this.root = root;
        this.render();
    }

    rowHtml(run, source) {
        const statusClass = run.status === QUEUE_STATUS_ERROR ? "error" : (
            run.status === QUEUE_STATUS_RUNNING || run.status === QUEUE_STATUS_SUBMITTING ? "running" : ""
        );
        const time = source === "history" ? formatQueueTime(run.completed_at) : formatQueueTime(run.created_at);
        const statusText = run.status === QUEUE_STATUS_SUBMITTING ? "submitting" : run.status;
        const deleteButton = source === "history" || run.status === QUEUE_STATUS_PENDING
            ? `<button class="helto-qm-icon-btn" data-action="delete-${source}" data-run-id="${escapeHtml(run.id)}" title="Delete">${ICONS.trash}</button>`
            : "";
        return `
            <div class="helto-qm-row ${statusClass}">
                <div class="helto-qm-row-title">${escapeHtml(run.title)}</div>
                <div class="helto-qm-row-meta">
                    <span class="helto-qm-pill ${statusClass}">${escapeHtml(statusText)}</span>
                    ${time ? `<span class="helto-qm-pill">${escapeHtml(time)}</span>` : ""}
                    ${run.prompt_id ? `<span class="helto-qm-pill">${escapeHtml(run.prompt_id.slice(0, 8))}</span>` : ""}
                </div>
                ${run.error ? `<div class="helto-qm-row-meta">${escapeHtml(run.error)}</div>` : ""}
                <div class="helto-qm-actions">
                    <button class="helto-qm-icon-btn" data-action="load-${source}" data-run-id="${escapeHtml(run.id)}" title="Load workflow" ${runCanBeLoaded(run) ? "" : "disabled"}>${QUEUE_ICONS.load}</button>
                    ${deleteButton}
                </div>
            </div>
        `;
    }

    bindEvents() {
        if (!this.root) return;
        this.root.querySelector("[data-action='resume']")?.addEventListener("click", () => this.resumeQueue());
        this.root.querySelector("[data-action='pause']")?.addEventListener("click", () => this.pauseQueue());
        this.root.querySelector("[data-action='privacy']")?.addEventListener("change", (event) => this.setPrivacy(event.target.checked));
        this.root.querySelector("[data-action='clear-history']")?.addEventListener("click", () => this.clearHistory());
        this.root.querySelectorAll("[data-action='load-queue']").forEach((button) => {
            button.addEventListener("click", () => this.loadWorkflow(button.dataset.runId, "queue"));
        });
        this.root.querySelectorAll("[data-action='load-history']").forEach((button) => {
            button.addEventListener("click", () => this.loadWorkflow(button.dataset.runId, "history"));
        });
        this.root.querySelectorAll("[data-action='delete-queue']").forEach((button) => {
            button.addEventListener("click", () => this.deletePendingRun(button.dataset.runId));
        });
        this.root.querySelectorAll("[data-action='delete-history']").forEach((button) => {
            button.addEventListener("click", () => this.deleteHistoryRun(button.dataset.runId));
        });
    }

    render() {
        if (!this.root) return;
        const summary = queueSummary(this.state);
        const queueRows = this.state.queue.map((run) => this.rowHtml(run, "queue")).join("");
        const historyRows = this.state.history.map((run) => this.rowHtml(run, "history")).join("");
        const resumeDisabled = !this.state.queue.some((run) => run.status === QUEUE_STATUS_PENDING) || activeQueueRun(this.state);
        const pauseDisabled = this.state.paused;

        this.root.innerHTML = `
            <div class="helto-qm">
                <div class="helto-qm-header">
                    <div class="helto-qm-title">Queue Manager</div>
                    <label class="helto-qm-privacy" title="Encrypt persisted queue data">
                        ${QUEUE_ICONS.lock}
                        <input type="checkbox" data-action="privacy" ${this.state.privacy_enabled ? "checked" : ""}>
                    </label>
                </div>
                <div class="helto-qm-toolbar">
                    <button class="helto-qm-btn primary" data-action="resume" ${resumeDisabled ? "disabled" : ""}>${QUEUE_ICONS.play}<span>Resume</span></button>
                    <button class="helto-qm-btn warn" data-action="pause" ${pauseDisabled ? "disabled" : ""}>${QUEUE_ICONS.pause}<span>Pause</span></button>
                </div>
                ${this.state.resume_required ? `<div class="helto-qm-banner">Queue paused after restart.</div>` : ""}
                <div class="helto-qm-status">
                    <div><strong>${summary.running}</strong><span>Running</span></div>
                    <div><strong>${summary.pending}</strong><span>Pending</span></div>
                    <div><strong>${summary.history}</strong><span>History</span></div>
                </div>
                <div class="helto-qm-section">
                    <div class="helto-qm-section-head"><span>Current</span></div>
                    <div class="helto-qm-list">
                        ${queueRows || `<div class="helto-qm-empty">No queued runs</div>`}
                    </div>
                </div>
                <div class="helto-qm-section history">
                    <div class="helto-qm-section-head">
                        <span>History</span>
                        <button class="helto-qm-icon-btn" data-action="clear-history" title="Delete all history" ${this.state.history.length ? "" : "disabled"}>${ICONS.clear}</button>
                    </div>
                    <div class="helto-qm-list">
                        ${historyRows || `<div class="helto-qm-empty">No history</div>`}
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
            title: "Queue Manager",
            icon: "HeltoQueueManagerIcon",
            type: "custom",
            render: (element) => manager.attach(element),
        });
        return;
    }

    if (!document.getElementById(FALLBACK_PANEL_ID)) {
        const panel = document.createElement("div");
        panel.id = FALLBACK_PANEL_ID;
        document.body.appendChild(panel);
        manager.attach(panel);
    }
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
