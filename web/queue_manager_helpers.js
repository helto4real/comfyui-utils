export const QUEUE_STATUS_PENDING = "pending";
export const QUEUE_STATUS_SUBMITTING = "submitting";
export const QUEUE_STATUS_RUNNING = "running";
export const QUEUE_STATUS_COMPLETED = "completed";
export const QUEUE_STATUS_ERROR = "error";
export const QUEUE_STATUS_ABORTED = "aborted";

const RUNTIME_QUEUE_STATUSES = new Set([QUEUE_STATUS_SUBMITTING, QUEUE_STATUS_RUNNING]);
const DEFAULT_RUN_TITLE = "Untitled run";
const WORKFLOW_FILE_RE = /\.json$/i;
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "increment-wrap", "randomize"]);
const MEDIA_OUTPUT_KEYS = [
    "helto_private_images",
    "images",
    "videos",
    "gifs",
    "b_images",
    "a_images",
];

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

function isSeedWidgetName(value) {
    const name = String(value ?? "").toLocaleLowerCase();
    return name === "seed" || name.endsWith("_seed");
}

function isControlWidgetName(value) {
    const name = String(value ?? "").trim().toLocaleLowerCase();
    return name === "control_after_generate" || name === "control after generate";
}

function serializedWidgetName(input) {
    if (!input || typeof input !== "object") {
        return null;
    }
    if (input.widget && typeof input.widget === "object") {
        return input.widget.name || input.name || null;
    }
    return null;
}

function fixSeedControlsForNode(node) {
    if (!node || typeof node !== "object" || !Array.isArray(node.inputs) || !Array.isArray(node.widgets_values)) {
        return;
    }

    let widgetValueIndex = 0;
    for (const input of node.inputs) {
        const widgetName = serializedWidgetName(input);
        if (!widgetName) {
            continue;
        }

        const controlIndex = widgetValueIndex + 1;
        if (isSeedWidgetName(widgetName) && SEED_CONTROL_VALUES.has(node.widgets_values[controlIndex])) {
            node.widgets_values[controlIndex] = "fixed";
            widgetValueIndex += 2;
        } else {
            widgetValueIndex += 1;
        }
    }
}

function fixSeedControlsForGraph(graph, visited = new WeakSet()) {
    if (!graph || typeof graph !== "object" || visited.has(graph)) {
        return;
    }
    visited.add(graph);

    if (Array.isArray(graph.nodes)) {
        for (const node of graph.nodes) {
            fixSeedControlsForNode(node);
        }
    }

    const subgraphs = graph.definitions?.subgraphs;
    if (Array.isArray(subgraphs)) {
        for (const subgraph of subgraphs) {
            fixSeedControlsForGraph(subgraph, visited);
        }
    }
}

export function workflowWithFixedSeedControls(workflow) {
    if (!workflow || typeof workflow !== "object") {
        return workflow;
    }
    const nextWorkflow = cloneJson(workflow);
    fixSeedControlsForGraph(nextWorkflow);
    return nextWorkflow;
}

function controlWidgetValues(widget) {
    const values = widget?.options?.values;
    if (Array.isArray(values)) {
        return values;
    }
    if (values && typeof values === "object") {
        return [...Object.keys(values), ...Object.values(values)];
    }
    return [];
}

function hasSeedControlOptions(widget) {
    return controlWidgetValues(widget).filter((value) => SEED_CONTROL_VALUES.has(value)).length >= 3;
}

function isLiveSeedControlWidget(widget) {
    return !!(
        widget
        && typeof widget === "object"
        && SEED_CONTROL_VALUES.has(widget.value)
        && (
            isControlWidgetName(widget.name)
            || isControlWidgetName(widget.label)
            || hasSeedControlOptions(widget)
        )
    );
}

function setLiveControlFixed(widget) {
    if (!isLiveSeedControlWidget(widget) || widget.value === "fixed") {
        return 0;
    }
    widget.value = "fixed";
    if (typeof widget.callback === "function") {
        widget.callback("fixed");
    }
    return 1;
}

function fixLiveSeedControlsForNode(node) {
    if (!node || typeof node !== "object" || !Array.isArray(node.widgets)) {
        return 0;
    }

    let fixedCount = 0;
    const fixedControls = new Set();
    for (const [index, widget] of node.widgets.entries()) {
        if (!isSeedWidgetName(widget?.name)) {
            continue;
        }

        const candidateControls = [
            ...(Array.isArray(widget.linkedWidgets) ? widget.linkedWidgets : []),
            node.widgets[index + 1],
        ];
        for (const controlWidget of candidateControls) {
            if (!controlWidget || fixedControls.has(controlWidget)) {
                continue;
            }
            fixedControls.add(controlWidget);
            fixedCount += setLiveControlFixed(controlWidget);
        }
    }
    return fixedCount;
}

function graphNodes(graph) {
    if (Array.isArray(graph?.nodes)) {
        return graph.nodes;
    }
    if (Array.isArray(graph?._nodes)) {
        return graph._nodes;
    }
    return [];
}

function graphSubgraphs(graph) {
    const subgraphs = graph?.subgraphs;
    if (Array.isArray(subgraphs)) {
        return subgraphs;
    }
    if (subgraphs instanceof Map) {
        return [...subgraphs.values()];
    }
    if (subgraphs && typeof subgraphs === "object") {
        return Object.values(subgraphs);
    }
    return [];
}

export function fixLiveSeedControls(graph, visited = new WeakSet()) {
    if (!graph || typeof graph !== "object" || visited.has(graph)) {
        return 0;
    }
    visited.add(graph);

    let fixedCount = 0;
    for (const node of graphNodes(graph)) {
        fixedCount += fixLiveSeedControlsForNode(node);
        if (node?.subgraph && (node.isSubgraphNode?.() || typeof node.subgraph === "object")) {
            fixedCount += fixLiveSeedControls(node.subgraph, visited);
        }
    }
    for (const subgraph of graphSubgraphs(graph)) {
        fixedCount += fixLiveSeedControls(subgraph, visited);
    }
    return fixedCount;
}

function basenameWithoutWorkflowExtension(value) {
    const name = String(value ?? "").trim().split(/[\\/]/).pop()?.trim() || "";
    return name.replace(WORKFLOW_FILE_RE, "").trim() || name;
}

function cleanTitleCandidate(value, { fileLike = false } = {}) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    if (fileLike || trimmed.includes("/") || trimmed.includes("\\") || WORKFLOW_FILE_RE.test(trimmed)) {
        return basenameWithoutWorkflowExtension(trimmed);
    }
    return trimmed;
}

function collectWorkflowTitleCandidates(value) {
    if (Array.isArray(value)) {
        return value.flatMap(collectWorkflowTitleCandidates);
    }
    if (typeof value === "string") {
        return [cleanTitleCandidate(value)];
    }
    if (!value || typeof value !== "object") {
        return [];
    }
    return [
        cleanTitleCandidate(value.name),
        cleanTitleCandidate(value.title),
        cleanTitleCandidate(value.workflow_name),
        cleanTitleCandidate(value.filename, { fileLike: true }),
        cleanTitleCandidate(value.file, { fileLike: true }),
        cleanTitleCandidate(value.path, { fileLike: true }),
    ];
}

export function resolveQueueRunTitle(promptData, context = {}) {
    const workflow = promptData?.workflow;
    const candidates = [
        ...collectWorkflowTitleCandidates(context.activeWorkflow),
        cleanTitleCandidate(context.workflowName),
        cleanTitleCandidate(context.workflowTitle),
        cleanTitleCandidate(context.name),
        cleanTitleCandidate(context.title),
        cleanTitleCandidate(context.filename, { fileLike: true }),
        cleanTitleCandidate(context.path, { fileLike: true }),
        workflow?.name,
        workflow?.title,
        workflow?.filename,
        workflow?.file,
        workflow?.path,
        workflow?.extra?.name,
        workflow?.extra?.title,
        workflow?.extra?.workflow_name,
        workflow?.extra?.filename,
        workflow?.extra?.file,
        workflow?.extra?.path,
        workflow?.metadata?.name,
        workflow?.metadata?.title,
        workflow?.metadata?.filename,
        workflow?.metadata?.file,
        workflow?.metadata?.path,
    ].map((value) => cleanTitleCandidate(value));
    const found = candidates.find(Boolean);
    return found || context.fallback || DEFAULT_RUN_TITLE;
}

export function promptWorkflowTitle(promptData, fallback = "Workflow") {
    return resolveQueueRunTitle(promptData, { fallback });
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
    const explicitTitle = cleanTitleCandidate(options.title);
    return {
        id,
        prompt_id: options.promptId || null,
        title: explicitTitle || resolveQueueRunTitle(promptData, options.titleContext || {}),
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
        title: DEFAULT_RUN_TITLE,
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
    normalized.title = cleanTitleCandidate(normalized.title) || DEFAULT_RUN_TITLE;
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

export function applyQueueStateSaveResponse(currentState, savedState, currentRevision, saveRevision) {
    const stale = currentRevision !== saveRevision;
    return {
        state: stale ? currentState : normalizeQueueState(savedState),
        stale,
        needsFollowUpSave: stale,
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

export function runCanBeRerun(run) {
    return !!run?.prompt?.workflow && !!(run.prompt.output || run.prompt.prompt);
}

function extensionFromFilename(filename) {
    const clean = String(filename || "").split(/[?#]/, 1)[0];
    const index = clean.lastIndexOf(".");
    return index >= 0 ? clean.slice(index).toLowerCase() : "";
}

function mediaKindForRecord(record, output) {
    const contentType = String(record?.content_type || "").toLowerCase();
    if (contentType.startsWith("video/")) {
        return "video";
    }
    if (contentType.startsWith("image/")) {
        return "image";
    }

    const extension = extensionFromFilename(record?.filename);
    if (VIDEO_EXTENSIONS.has(extension)) {
        return "video";
    }
    if (IMAGE_EXTENSIONS.has(extension)) {
        return "image";
    }
    if (output?.animated?.[0] === true) {
        return "video";
    }
    return null;
}

function normalizeMediaPreviewRecord(record, output, nodeId, key, index) {
    if (!record || typeof record !== "object") {
        return null;
    }
    const hasPrivateRoute = !!record.private && typeof record.token === "string" && record.token.trim();
    const hasViewRoute = typeof record.filename === "string" && record.filename.trim() && typeof record.type === "string" && record.type.trim();
    if (!hasPrivateRoute && !hasViewRoute) {
        return null;
    }
    const kind = mediaKindForRecord(record, output);
    if (!kind) {
        return null;
    }
    return {
        kind,
        record,
        nodeId,
        key,
        index,
        label: record.filename || `${kind} preview`,
    };
}

export function latestMediaPreviewFromHistory(history) {
    const outputs = history?.outputs;
    if (!outputs || typeof outputs !== "object") {
        return null;
    }

    for (const [nodeId, output] of Object.entries(outputs).reverse()) {
        if (!output || typeof output !== "object") {
            continue;
        }
        const keys = [
            ...MEDIA_OUTPUT_KEYS.filter((key) => Array.isArray(output[key])),
            ...Object.keys(output).filter((key) => !MEDIA_OUTPUT_KEYS.includes(key) && Array.isArray(output[key])),
        ];
        for (const key of keys) {
            const records = output[key];
            for (let index = records.length - 1; index >= 0; index -= 1) {
                const preview = normalizeMediaPreviewRecord(records[index], output, nodeId, key, index);
                if (preview) {
                    return preview;
                }
            }
        }
    }
    return null;
}

function appendOptionalParams(route, ...parts) {
    return `${route}${parts.filter(Boolean).join("")}`;
}

export function mediaRecordToPreviewUrl(preview, options = {}) {
    const record = preview?.record || preview;
    if (!record || typeof record !== "object") {
        return null;
    }
    const apiURL = typeof options.apiURL === "function" ? options.apiURL : (route) => route;
    const randParam = typeof options.getRandParam === "function" ? options.getRandParam() : "";
    if (record.private && record.token) {
        const params = new URLSearchParams({ token: record.token });
        return apiURL(appendOptionalParams(`/helto_utils/private_media?${params.toString()}`, randParam));
    }

    if (!record.filename || !record.type) {
        return null;
    }
    const params = new URLSearchParams({
        filename: record.filename,
        type: record.type,
        subfolder: record.subfolder ?? "",
    });
    const previewFormatParam = typeof options.getPreviewFormatParam === "function" ? options.getPreviewFormatParam() : "";
    return apiURL(appendOptionalParams(`/view?${params.toString()}`, previewFormatParam, randParam));
}

export function historyHasExecutionEvent(history, eventName) {
    const messages = history?.status?.messages;
    if (!Array.isArray(messages) || !eventName) {
        return false;
    }
    return messages.some((entry) => {
        if (Array.isArray(entry)) {
            return entry[0] === eventName;
        }
        if (entry && typeof entry === "object") {
            return entry.event === eventName || entry.type === eventName || entry.name === eventName;
        }
        return false;
    });
}

function promptIdFromComfyQueueItem(item) {
    if (Array.isArray(item)) {
        return item[1] || null;
    }
    if (!item || typeof item !== "object") {
        return null;
    }
    return item.prompt_id || item.promptId || item.job_id || item.id || null;
}

export function comfyQueueHasPromptId(queueInfo, promptId) {
    if (!promptId || !queueInfo || typeof queueInfo !== "object") {
        return false;
    }
    const promptIdValue = String(promptId);
    const queueItems = [
        ...(Array.isArray(queueInfo.queue_running) ? queueInfo.queue_running : []),
        ...(Array.isArray(queueInfo.queue_pending) ? queueInfo.queue_pending : []),
    ];
    return queueItems.some((item) => promptIdFromComfyQueueItem(item) === promptIdValue);
}

export function queueSummary(state) {
    const queue = state.queue || [];
    return {
        pending: queue.filter((run) => run.status === QUEUE_STATUS_PENDING).length,
        running: queue.filter((run) => run.status === QUEUE_STATUS_RUNNING || run.status === QUEUE_STATUS_SUBMITTING).length,
        history: (state.history || []).length,
    };
}
