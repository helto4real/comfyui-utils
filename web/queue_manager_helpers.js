export const QUEUE_STATUS_PENDING = "pending";
export const QUEUE_STATUS_SUBMITTING = "submitting";
export const QUEUE_STATUS_RUNNING = "running";
export const QUEUE_STATUS_COMPLETED = "completed";
export const QUEUE_STATUS_ERROR = "error";

const RUNTIME_QUEUE_STATUSES = new Set([QUEUE_STATUS_SUBMITTING, QUEUE_STATUS_RUNNING]);

function coerceQueueNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return null;
}

export function createDefaultQueueState() {
    return {
        version: 1,
        privacy_enabled: true,
        paused: true,
        resume_required: false,
        active_run_id: null,
        queue: [],
        history: [],
        updated_at: null,
    };
}

export function cloneJson(value) {
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

export function promptWorkflowTitle(promptData, fallback = "Workflow") {
    const workflow = promptData?.workflow;
    const candidates = [
        workflow?.name,
        workflow?.title,
        workflow?.extra?.name,
        workflow?.extra?.title,
        workflow?.extra?.workflow_name,
        workflow?.metadata?.name,
        workflow?.metadata?.title,
    ];
    const found = candidates.find((value) => typeof value === "string" && value.trim());
    return found ? found.trim() : fallback;
}

export function formatQueueTime(timestamp) {
    if (!Number.isFinite(Number(timestamp))) {
        return "";
    }
    try {
        return new Date(Number(timestamp)).toLocaleString();
    } catch (_err) {
        return "";
    }
}

export function createQueueRun(promptData, options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const id = options.id || globalThis.crypto?.randomUUID?.() || `helto-run-${now}-${Math.random().toString(36).slice(2)}`;
    return {
        id,
        prompt_id: options.promptId || null,
        title: options.title || promptWorkflowTitle(promptData, `Workflow ${new Date(now).toLocaleString()}`),
        status: QUEUE_STATUS_PENDING,
        created_at: now,
        started_at: null,
        completed_at: null,
        number: coerceQueueNumber(options.number),
        front: !!options.front,
        node_errors: null,
        error: null,
        prompt: cloneJson(promptData),
    };
}

export function normalizeQueueRun(run) {
    const normalized = {
        id: "",
        prompt_id: null,
        title: "Workflow",
        status: QUEUE_STATUS_PENDING,
        created_at: Date.now(),
        started_at: null,
        completed_at: null,
        number: null,
        front: false,
        node_errors: null,
        error: null,
        prompt: null,
        ...run,
    };
    normalized.id = String(normalized.id || globalThis.crypto?.randomUUID?.() || `helto-run-${Date.now()}`);
    normalized.prompt_id = typeof normalized.prompt_id === "string" && normalized.prompt_id ? normalized.prompt_id : null;
    normalized.title = typeof normalized.title === "string" && normalized.title.trim() ? normalized.title.trim() : "Workflow";
    normalized.status = typeof normalized.status === "string" && normalized.status ? normalized.status : QUEUE_STATUS_PENDING;
    normalized.front = !!normalized.front;
    normalized.number = coerceQueueNumber(normalized.number);
    return normalized;
}

export function normalizeQueueState(rawState, options = {}) {
    const state = {
        ...createDefaultQueueState(),
        ...(rawState && typeof rawState === "object" ? rawState : {}),
    };
    const currentSessionId = options.serverSessionId || null;
    const storedSessionId = options.storedServerSessionId || null;
    const sessionChanged = !!storedSessionId && !!currentSessionId && storedSessionId !== currentSessionId;

    state.version = 1;
    state.privacy_enabled = !!state.privacy_enabled;
    state.paused = !!state.paused;
    state.resume_required = !!state.resume_required;
    state.queue = Array.isArray(state.queue) ? state.queue.map(normalizeQueueRun) : [];
    state.history = Array.isArray(state.history) ? state.history.map(normalizeQueueRun) : [];

    if (sessionChanged && state.queue.length > 0) {
        state.queue = state.queue.map((run) => {
            if (!RUNTIME_QUEUE_STATUSES.has(run.status)) {
                return run;
            }
            return {
                ...run,
                status: QUEUE_STATUS_PENDING,
                prompt_id: null,
                started_at: null,
                error: null,
            };
        });
        state.active_run_id = null;
        state.paused = true;
        state.resume_required = true;
    } else if (!state.queue.some((run) => run.id === state.active_run_id)) {
        state.active_run_id = null;
    }
    if (!state.active_run_id) {
        const activeRun = state.queue.find((run) => RUNTIME_QUEUE_STATUSES.has(run.status));
        state.active_run_id = activeRun?.id || null;
    }

    return state;
}

export function nextPendingRun(state) {
    return (state.queue || []).find((run) => run.status === QUEUE_STATUS_PENDING) || null;
}

export function activeQueueRun(state) {
    return (state.queue || []).find((run) => run.id === state.active_run_id) || null;
}

export function enqueueRun(state, run) {
    return {
        ...state,
        queue: [...(state.queue || []), normalizeQueueRun(run)],
    };
}

export function markRunSubmitting(state, runId, promptId, now = Date.now()) {
    return {
        ...state,
        active_run_id: runId,
        queue: (state.queue || []).map((run) => run.id === runId ? {
            ...run,
            prompt_id: promptId || run.prompt_id,
            status: QUEUE_STATUS_SUBMITTING,
            started_at: run.started_at || now,
            error: null,
        } : run),
    };
}

export function markRunRunning(state, runId, promptId, nodeErrors = null) {
    return {
        ...state,
        active_run_id: runId,
        queue: (state.queue || []).map((run) => run.id === runId ? {
            ...run,
            prompt_id: promptId || run.prompt_id,
            status: QUEUE_STATUS_RUNNING,
            node_errors: nodeErrors,
            error: null,
        } : run),
    };
}

export function moveRunToHistory(state, runId, updates = {}, now = Date.now()) {
    const queue = [];
    let completedRun = null;
    for (const run of state.queue || []) {
        if (run.id === runId) {
            completedRun = {
                ...run,
                ...updates,
                completed_at: updates.completed_at || now,
            };
        } else {
            queue.push(run);
        }
    }
    if (!completedRun) {
        return state;
    }
    return {
        ...state,
        queue,
        active_run_id: state.active_run_id === runId ? null : state.active_run_id,
        history: [completedRun, ...(state.history || [])],
    };
}

export function deleteQueueRun(state, runId) {
    return {
        ...state,
        queue: (state.queue || []).filter((run) => run.id !== runId),
        active_run_id: state.active_run_id === runId ? null : state.active_run_id,
    };
}

export function deleteHistoryRun(state, runId) {
    return {
        ...state,
        history: (state.history || []).filter((run) => run.id !== runId),
    };
}

export function clearQueueHistory(state) {
    return {
        ...state,
        history: [],
    };
}

export function runCanBeLoaded(run) {
    return !!run?.prompt?.workflow;
}

export function queueSummary(state) {
    const queue = state.queue || [];
    return {
        pending: queue.filter((run) => run.status === QUEUE_STATUS_PENDING).length,
        running: queue.filter((run) => run.status === QUEUE_STATUS_RUNNING || run.status === QUEUE_STATUS_SUBMITTING).length,
        history: (state.history || []).length,
    };
}
