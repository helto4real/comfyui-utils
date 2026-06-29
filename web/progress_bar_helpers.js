export const HELTO_PROGRESS_EVENT_LIMIT = 80;
export const HELTO_PROGRESS_TEXT_NODE_ID = "__helto_progress_text__";

const FINISHED_STATES = new Set(["finished", "success", "done", "completed"]);
const RUNNING_STATES = new Set(["running", "executing"]);
const ERROR_STATES = new Set(["error", "failed"]);

export function createProgressState(options = {}) {
    return {
        promptId: null,
        status: "idle",
        queueRemaining: 0,
        totalNodes: 0,
        current: null,
        error: null,
        knownPrompts: new Map(),
        executedNodeIds: new Set(),
        cachedNodeIds: new Set(),
        nodeLabels: new Map(),
        nodeStates: new Map(),
        recentEvents: [],
        eventLimit: options.eventLimit || HELTO_PROGRESS_EVENT_LIMIT,
    };
}

export function rememberPromptData(state, promptId, promptData) {
    const next = cloneProgressState(state);
    const id = normalizeId(promptId);
    if (!id) return next;
    next.knownPrompts.set(id, summarizePromptData(promptData));
    if (next.promptId === id) {
        applyKnownPrompt(next, id);
    }
    return next;
}

export function applyProgressEvent(state, eventType, detail = {}, options = {}) {
    const next = cloneProgressState(state);
    const now = options.now ?? Date.now();

    switch (eventType) {
        case "queue_prompt":
            return rememberPromptData(next, detail?.prompt_id, detail?.promptData || detail?.prompt);
        case "status":
            next.queueRemaining = queueRemainingFromStatus(detail);
            return next;
        case "execution_start":
            switchPrompt(next, detail?.prompt_id, { reset: true });
            next.status = "running";
            return next;
        case "execution_cached":
            switchPrompt(next, detail?.prompt_id);
            for (const nodeId of arrayValue(detail?.nodes)) {
                addNodeId(next.cachedNodeIds, nodeId);
                addNodeId(next.executedNodeIds, nodeId);
            }
            next.status = "running";
            return next;
        case "executing":
            switchPrompt(next, detail?.prompt_id);
            return applyExecuting(next, detail, options);
        case "progress":
            switchPrompt(next, detail?.prompt_id);
            return applyNodeProgress(next, {
                node_id: detail?.node,
                value: detail?.value,
                total: detail?.max,
                percent: percentFromValue(detail?.value, detail?.max),
            }, options);
        case "progress_state":
            switchPrompt(next, detail?.prompt_id);
            return applyProgressState(next, detail, options);
        case "progress_text":
            return applyProgressText(next, detail, options);
        case "executed":
            switchPrompt(next, detail?.prompt_id);
            addNodeId(next.executedNodeIds, detail?.node);
            if (normalizeId(next.current?.nodeId) === normalizeId(detail?.node)) {
                next.current = { ...next.current, percent: 100 };
            }
            next.status = "running";
            return next;
        case "execution_success":
            switchPrompt(next, detail?.prompt_id);
            next.status = "success";
            next.current = null;
            next.error = null;
            return next;
        case "execution_error":
            switchPrompt(next, detail?.prompt_id);
            next.status = "error";
            next.error = normalizeError(detail);
            next.current = {
                nodeId: normalizeId(detail?.node_id),
                displayNodeId: normalizeId(detail?.node_id),
                label: detail?.node_type || labelForNode(next, detail?.node_id, options),
                phase: null,
                message: detail?.exception_message || "Execution error",
                level: "error",
                value: null,
                total: null,
                percent: null,
            };
            appendRecentEvent(next, {
                event: "error",
                level: "error",
                node_id: detail?.node_id,
                message: detail?.exception_message || "Execution error",
                phase: null,
                timestamp: now / 1000,
            });
            return next;
        case "execution_interrupted":
            switchPrompt(next, detail?.prompt_id);
            next.status = "interrupted";
            next.current = null;
            appendRecentEvent(next, {
                event: "interrupted",
                level: "warning",
                node_id: detail?.node_id,
                message: "Execution interrupted",
                phase: null,
                timestamp: now / 1000,
            });
            return next;
        case "helto_progress":
            return applyHeltoProgress(next, detail, options, now);
        default:
            return next;
    }
}

export function progressSnapshot(state) {
    const completedCount = completedNodeCount(state);
    const workflowPercent = state.totalNodes > 0
        ? clampPercent((completedCount / state.totalNodes) * 100)
        : null;
    const currentPercent = currentNodePercent(state.current);
    const status = state.status || "idle";
    const latestLogText = latestEventLogText(state.recentEvents, state.current);

    return {
        promptId: state.promptId,
        status,
        queueRemaining: state.queueRemaining,
        totalNodes: state.totalNodes,
        completedNodes: completedCount,
        workflowPercent,
        workflowWidth: workflowPercent == null
            ? 0
            : (status === "running" ? Math.max(2, workflowPercent) : workflowPercent),
        currentPercent,
        currentWidth: currentPercent == null ? 0 : currentPercent,
        current: state.current,
        currentNodeId: state.current?.displayNodeId || state.current?.nodeId || state.error?.nodeId || null,
        error: state.error,
        recentEvents: state.recentEvents,
        latestLogText,
    };
}

export function formatProgressText(snapshot) {
    const queuePrefix = snapshot.queueRemaining > 0 ? `(${snapshot.queueRemaining}) ` : "";
    if (snapshot.status === "error") {
        const label = snapshot.current?.label || snapshot.error?.nodeType || snapshot.error?.nodeId || "workflow";
        const message = snapshot.current?.message || snapshot.error?.message || "Execution error";
        return appendLatestLog(`${queuePrefix}Error - ${label}: ${message}`, snapshot);
    }
    if (snapshot.status === "interrupted") {
        return appendLatestLog(`${queuePrefix}Interrupted`, snapshot);
    }
    if (snapshot.current) {
        const workflow = snapshot.workflowPercent == null ? "Running" : `${Math.round(snapshot.workflowPercent)}%`;
        const node = snapshot.current.label || snapshot.current.nodeId || "node";
        const phase = snapshot.current.phase ? ` - ${humanize(snapshot.current.phase)}` : "";
        const message = snapshot.current.message ? `: ${snapshot.current.message}` : "";
        const currentPercent = snapshot.currentPercent == null ? "" : ` (${Math.round(snapshot.currentPercent)}%)`;
        return appendLatestLog(`${queuePrefix}${workflow} - ${node}${phase}${message}${currentPercent}`, snapshot);
    }
    if (snapshot.status === "success") {
        return appendLatestLog(`${queuePrefix}Complete`, snapshot);
    }
    if (snapshot.queueRemaining > 0) {
        return appendLatestLog(`${queuePrefix}Running...`, snapshot);
    }
    return appendLatestLog("Idle", snapshot);
}

export function eventDisplayText(event) {
    const phase = event.phase ? `${humanize(event.phase)}: ` : "";
    return `${phase}${event.message || event.event || "Progress update"}`;
}

function applyExecuting(state, detail, options) {
    const nodeId = normalizeId(detail?.node);
    if (!nodeId) {
        state.current = null;
        if (state.status === "running") {
            state.status = "idle";
        }
        return state;
    }

    state.status = "running";
    state.error = null;
    rememberNodeLabel(state, nodeId, detail, options);
    state.current = {
        ...(state.current?.nodeId === nodeId ? state.current : {}),
        nodeId,
        displayNodeId: normalizeId(detail?.display_node) || nodeId,
        label: labelForNode(state, nodeId, options, detail),
        phase: state.current?.nodeId === nodeId ? state.current.phase : null,
        message: state.current?.nodeId === nodeId ? state.current.message : null,
        level: "info",
        value: state.current?.nodeId === nodeId ? state.current.value : null,
        total: state.current?.nodeId === nodeId ? state.current.total : null,
        percent: state.current?.nodeId === nodeId ? state.current.percent : null,
    };
    return state;
}

function applyNodeProgress(state, progress, options) {
    const nodeId = normalizeId(progress.node_id);
    if (!nodeId) return state;
    state.status = "running";
    rememberNodeLabel(state, nodeId, progress, options);
    state.current = {
        ...(state.current?.nodeId === nodeId ? state.current : {}),
        nodeId,
        displayNodeId: normalizeId(progress.display_node_id) || normalizeId(progress.display_node) || nodeId,
        label: labelForNode(state, nodeId, options, progress),
        phase: progress.phase ?? state.current?.phase ?? null,
        message: progress.message ?? state.current?.message ?? null,
        level: progress.level || state.current?.level || "info",
        value: numberOrNull(progress.value),
        total: numberOrNull(progress.total),
        percent: clampPercent(progress.percent),
    };
    return state;
}

function applyProgressState(state, detail, options) {
    const nodes = detail?.nodes && typeof detail.nodes === "object" ? detail.nodes : {};
    let running = null;

    for (const [nodeId, nodeState] of Object.entries(nodes)) {
        const id = normalizeId(nodeState?.node_id ?? nodeId);
        if (!id) continue;
        const normalizedState = String(nodeState?.state || "").toLowerCase();
        state.nodeStates.set(id, { ...nodeState, state: normalizedState });
        rememberNodeLabel(state, id, nodeState, options);

        if (FINISHED_STATES.has(normalizedState)) {
            state.executedNodeIds.add(id);
        } else if (ERROR_STATES.has(normalizedState)) {
            state.status = "error";
        } else if (RUNNING_STATES.has(normalizedState)) {
            running = {
                node_id: id,
                display_node_id: nodeState.display_node_id,
                value: nodeState.value,
                total: nodeState.max,
                percent: percentFromValue(nodeState.value, nodeState.max),
            };
        }
    }

    if (running) {
        applyNodeProgress(state, running, options);
    }
    return state;
}

function applyHeltoProgress(state, detail, options, now) {
    switchPrompt(state, detail?.prompt_id);
    const nodeId = normalizeId(detail?.node_id);
    const event = String(detail?.event || "report");
    const level = String(detail?.level || (event === "error" ? "error" : "info")).toLowerCase();

    appendRecentEvent(state, {
        event,
        level,
        node_id: nodeId,
        display_node_id: normalizeId(detail?.display_node_id),
        phase: detail?.phase || null,
        message: detail?.message || null,
        detail: detail?.detail ?? null,
        value: numberOrNull(detail?.value),
        total: numberOrNull(detail?.total),
        percent: clampPercent(detail?.percent),
        timestamp: numberOrNull(detail?.timestamp) ?? now / 1000,
    });

    if (event === "error" || level === "error") {
        state.status = "error";
    } else if (event !== "done") {
        state.status = "running";
        state.error = null;
    }

    if (!nodeId) return state;
    rememberNodeLabel(state, nodeId, detail, options);
    state.current = {
        ...(state.current?.nodeId === nodeId ? state.current : {}),
        nodeId,
        displayNodeId: normalizeId(detail?.display_node_id) || nodeId,
        label: labelForNode(state, nodeId, options, detail),
        phase: detail?.phase || state.current?.phase || null,
        message: detail?.message || state.current?.message || null,
        level,
        value: numberOrNull(detail?.value),
        total: numberOrNull(detail?.total),
        percent: clampPercent(detail?.percent),
    };
    return state;
}

function applyProgressText(state, detail, options) {
    const bridge = parseProgressTextBridge(detail);
    if (!bridge) return state;
    switchPrompt(state, bridge.prompt_id);
    const nodeId = normalizeId(bridge.node_id);
    const message = cleanLogText(bridge.text ?? bridge.message);
    if (!nodeId || !message) return state;

    state.status = "running";
    state.error = null;
    rememberNodeLabel(state, nodeId, bridge, options);
    const currentMatches = currentMatchesNode(state.current, nodeId);
    state.current = {
        ...(currentMatches ? state.current : {}),
        nodeId: currentMatches ? state.current.nodeId : nodeId,
        displayNodeId: currentMatches ? state.current.displayNodeId : normalizeId(bridge.display_node_id) || nodeId,
        label: labelForNode(state, nodeId, options, bridge),
        phase: bridge.phase || (currentMatches ? state.current.phase : null),
        message,
        level: currentMatches ? state.current.level : "info",
        value: currentMatches ? state.current.value : null,
        total: currentMatches ? state.current.total : null,
        percent: currentMatches ? state.current.percent : null,
    };
    return state;
}

function parseProgressTextBridge(detail) {
    const bridgeNodeId = normalizeId(detail?.nodeId ?? detail?.node_id ?? detail?.node);
    if (bridgeNodeId !== HELTO_PROGRESS_TEXT_NODE_ID) return null;

    const text = detail?.text ?? detail?.message;
    if (typeof text !== "string") return null;

    try {
        const payload = JSON.parse(text);
        return payload && typeof payload === "object" ? payload : null;
    } catch (_error) {
        return null;
    }
}

function switchPrompt(state, promptId, options = {}) {
    const id = normalizeId(promptId);
    if (!id) return;
    if (!options.reset && state.promptId === id) {
        applyKnownPrompt(state, id);
        return;
    }

    state.promptId = id;
    state.status = "running";
    state.totalNodes = 0;
    state.current = null;
    state.error = null;
    state.executedNodeIds = new Set();
    state.cachedNodeIds = new Set();
    state.nodeStates = new Map();
    state.recentEvents = [];
    applyKnownPrompt(state, id);
}

function applyKnownPrompt(state, promptId) {
    const known = state.knownPrompts.get(promptId);
    if (!known) return;
    state.totalNodes = known.totalNodes;
    state.nodeLabels = new Map([...state.nodeLabels, ...known.nodeLabels]);
}

function summarizePromptData(promptData) {
    const output = promptOutput(promptData);
    const nodeLabels = new Map();
    for (const [nodeId, node] of Object.entries(output)) {
        const label = node?._meta?.title || node?.class_type || null;
        if (label) {
            nodeLabels.set(normalizeId(nodeId), String(label));
        }
    }
    return {
        totalNodes: Object.keys(output).length,
        nodeLabels,
    };
}

function promptOutput(promptData) {
    if (!promptData || typeof promptData !== "object") return {};
    const output = promptData.output || promptData.prompt || {};
    return output && typeof output === "object" ? output : {};
}

function cloneProgressState(state) {
    return {
        ...state,
        knownPrompts: new Map(state.knownPrompts),
        executedNodeIds: new Set(state.executedNodeIds),
        cachedNodeIds: new Set(state.cachedNodeIds),
        nodeLabels: new Map(state.nodeLabels),
        nodeStates: new Map(state.nodeStates),
        recentEvents: [...state.recentEvents],
    };
}

function queueRemainingFromStatus(detail) {
    const candidates = [
        detail?.exec_info?.queue_remaining,
        detail?.status?.exec_info?.queue_remaining,
        detail?.status?.queue_remaining,
    ];
    for (const candidate of candidates) {
        const number = numberOrNull(candidate);
        if (number !== null) return Math.max(0, Math.floor(number));
    }
    return 0;
}

function rememberNodeLabel(state, nodeId, detail, options) {
    const id = normalizeId(nodeId);
    if (!id || state.nodeLabels.has(id)) return;
    const label = detail?._meta?.title
        || detail?.node_label
        || detail?.label
        || detail?.node_type
        || options.resolveNodeLabel?.(id, detail)
        || null;
    if (label) {
        state.nodeLabels.set(id, String(label));
    }
}

function labelForNode(state, nodeId, options, detail = {}) {
    const id = normalizeId(nodeId);
    if (!id) return null;
    return state.nodeLabels.get(id)
        || detail?._meta?.title
        || detail?.node_label
        || detail?.label
        || detail?.node_type
        || options.resolveNodeLabel?.(id, detail)
        || id;
}

function appendRecentEvent(state, detail) {
    const event = {
        event: String(detail.event || "report"),
        level: String(detail.level || "info").toLowerCase(),
        nodeId: normalizeId(detail.node_id),
        displayNodeId: normalizeId(detail.display_node_id) || normalizeId(detail.node_id),
        phase: detail.phase || null,
        message: detail.message || null,
        detail: detail.detail ?? null,
        value: numberOrNull(detail.value),
        total: numberOrNull(detail.total),
        percent: clampPercent(detail.percent),
        timestamp: numberOrNull(detail.timestamp) || Date.now() / 1000,
    };
    state.recentEvents = [event, ...state.recentEvents].slice(0, state.eventLimit);
}

function normalizeError(detail) {
    return {
        nodeId: normalizeId(detail?.node_id),
        nodeType: detail?.node_type || null,
        message: detail?.exception_message || detail?.message || "Execution error",
    };
}

function completedNodeCount(state) {
    const completed = new Set([...state.executedNodeIds, ...state.cachedNodeIds]);
    for (const [nodeId, nodeState] of state.nodeStates.entries()) {
        if (FINISHED_STATES.has(String(nodeState?.state || "").toLowerCase())) {
            completed.add(nodeId);
        }
    }
    return state.totalNodes > 0 ? Math.min(state.totalNodes, completed.size) : completed.size;
}

function currentNodePercent(current) {
    if (!current) return null;
    const explicit = clampPercent(current.percent);
    if (explicit !== null) return explicit;
    return percentFromValue(current.value, current.total);
}

function currentMatchesNode(current, nodeId) {
    if (!current || !nodeId) return false;
    return normalizeId(current.nodeId) === nodeId || normalizeId(current.displayNodeId) === nodeId;
}

function appendLatestLog(text, snapshot) {
    const logText = cleanLogText(snapshot.latestLogText);
    if (!logText) return text;
    const normalizedText = normalizedLogText(text);
    const normalizedLog = normalizedLogText(logText);
    if (normalizedLog && normalizedText.includes(normalizedLog)) return text;
    return `${text} | ${logText}`;
}

function latestEventLogText(events, current) {
    const currentMessage = normalizedLogText(current?.message);
    for (const event of events || []) {
        const text = eventLogText(event);
        if (!text) continue;
        if (currentMessage && normalizedLogText(text) === currentMessage) continue;
        return text;
    }
    return null;
}

function eventLogText(event) {
    return detailLogText(event?.detail) || cleanLogText(event?.message);
}

function detailLogText(detail) {
    if (typeof detail === "string") {
        return cleanLogText(detail);
    }
    if (!detail || typeof detail !== "object") {
        return null;
    }
    for (const key of ["log", "text", "message", "status"]) {
        const text = cleanLogText(detail[key]);
        if (text) return text;
    }
    return null;
}

function cleanLogText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/\s+/g, " ").trim();
    return text || null;
}

function normalizedLogText(value) {
    return cleanLogText(value)?.toLowerCase() || "";
}

function percentFromValue(value, total) {
    const safeValue = numberOrNull(value);
    const safeTotal = numberOrNull(total);
    if (safeValue === null || safeTotal === null || safeTotal <= 0) return null;
    return clampPercent((safeValue / safeTotal) * 100);
}

function clampPercent(value) {
    const number = numberOrNull(value);
    if (number === null) return null;
    return Math.max(0, Math.min(100, number));
}

function addNodeId(set, nodeId) {
    const id = normalizeId(nodeId);
    if (id) set.add(id);
}

function arrayValue(value) {
    return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeId(value) {
    if (value === null || value === undefined || value === "") return null;
    return String(value);
}

function humanize(value) {
    return String(value || "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^./, (char) => char.toUpperCase());
}
