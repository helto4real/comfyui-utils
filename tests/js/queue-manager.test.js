import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    QUEUE_STATUS_ABORTED,
    QUEUE_STATUS_COMPLETED,
    QUEUE_STATUS_PENDING,
    QUEUE_STATUS_RUNNING,
    applyQueueStateSaveResponse,
    comfyQueueHasPromptId,
    createDefaultQueueState,
    createQueueRun,
    historyHasExecutionEvent,
    fixLiveSeedControls,
    latestMediaPreviewFromHistory,
    mediaRecordToPreviewUrl,
    moveRunToHistory,
    normalizeQueueState,
    promptWorkflowTitle,
    queueSummary,
    resolveQueueRunTitle,
    runCanBeRerun,
    workflowWithFixedSeedControls,
} from "../../web/queue_manager_helpers.js";

test("promptWorkflowTitle reads workflow metadata with fallback", () => {
    assert.equal(promptWorkflowTitle({ workflow: { name: "Render pass" } }), "Render pass");
    assert.equal(promptWorkflowTitle({ workflow: {} }, "Untitled"), "Untitled");
});

test("resolveQueueRunTitle prefers active workflow names and cleans filenames", () => {
    assert.equal(
        resolveQueueRunTitle(
            { workflow: { name: "Serialized name" } },
            { activeWorkflow: { filename: "/tmp/Long Workflow Name.json" } },
        ),
        "Long Workflow Name",
    );
    assert.equal(resolveQueueRunTitle({ workflow: {} }), "Untitled run");
});

test("createQueueRun leaves queue number empty when not supplied", () => {
    const run = createQueueRun({ workflow: {}, output: {} }, { id: "run-default", now: 1000 });

    assert.equal(run.number, null);
    assert.equal(run.title, "Untitled run");
    assert.equal(normalizeQueueState({ queue: [run] }).queue[0].number, null);
});

test("queue privacy defaults on for new persisted state", () => {
    assert.equal(createDefaultQueueState().privacy_enabled, true);
    assert.equal(normalizeQueueState(null).privacy_enabled, true);
});

test("normalizeQueueState demotes runtime jobs after server restart", () => {
    const state = createDefaultQueueState();
    state.paused = false;
    state.active_run_id = "run-a";
    state.queue = [{
        id: "run-a",
        title: "Interrupted render",
        status: QUEUE_STATUS_RUNNING,
        prompt_id: "11111111-1111-4111-8111-111111111111",
        prompt: { workflow: {} },
    }];

    const normalized = normalizeQueueState(state, {
        serverSessionId: "new-session",
        storedServerSessionId: "old-session",
    });

    assert.equal(normalized.paused, true);
    assert.equal(normalized.resume_required, true);
    assert.equal(normalized.active_run_id, null);
    assert.equal(normalized.queue[0].status, QUEUE_STATUS_PENDING);
    assert.equal(normalized.queue[0].prompt_id, null);
});

test("moveRunToHistory removes current run and prepends completed history", () => {
    const run = createQueueRun({ workflow: { name: "Done" }, output: {} }, {
        id: "run-done",
        now: 1000,
    });
    const state = {
        ...createDefaultQueueState(),
        active_run_id: "run-done",
        queue: [{ ...run, status: QUEUE_STATUS_RUNNING }],
        history: [],
    };

    const next = moveRunToHistory(state, "run-done", { status: QUEUE_STATUS_COMPLETED }, 2000);

    assert.equal(next.active_run_id, null);
    assert.equal(next.queue.length, 0);
    assert.equal(next.history.length, 1);
    assert.equal(next.history[0].status, QUEUE_STATUS_COMPLETED);
    assert.equal(next.history[0].completed_at, 2000);
    assert.deepEqual(queueSummary(next), { pending: 0, running: 0, history: 1 });
});

test("stale queue state save responses do not clear a newer active run", () => {
    const staleSavedState = createDefaultQueueState();
    const run = {
        ...createQueueRun({ workflow: { name: "Race" }, output: { 1: {} } }, {
            id: "run-race",
            promptId: "11111111-1111-4111-8111-111111111111",
            now: 1000,
        }),
        status: QUEUE_STATUS_RUNNING,
        started_at: 1100,
    };
    const currentState = {
        ...createDefaultQueueState(),
        paused: false,
        active_run_id: "run-race",
        queue: [run],
    };

    const next = applyQueueStateSaveResponse(currentState, staleSavedState, 2, 1);

    assert.equal(next.stale, true);
    assert.equal(next.needsFollowUpSave, true);
    assert.equal(next.state.active_run_id, "run-race");
    assert.equal(next.state.queue.length, 1);
    assert.equal(next.state.queue[0].status, QUEUE_STATUS_RUNNING);
    assert.equal(next.state.history.length, 0);
});

test("moveRunToHistory preserves aborted history status", () => {
    const run = createQueueRun({ workflow: { name: "Stopped" }, output: {} }, {
        id: "run-aborted",
        now: 1000,
    });
    const state = {
        ...createDefaultQueueState(),
        active_run_id: "run-aborted",
        queue: [{ ...run, status: QUEUE_STATUS_RUNNING, prompt_id: "prompt-aborted" }],
        history: [],
    };

    const next = moveRunToHistory(state, "run-aborted", { status: QUEUE_STATUS_ABORTED }, 2000);

    assert.equal(next.active_run_id, null);
    assert.equal(next.queue.length, 0);
    assert.equal(next.history[0].status, QUEUE_STATUS_ABORTED);
    assert.equal(next.history[0].completed_at, 2000);
});

test("historyHasExecutionEvent detects interrupted ComfyUI history", () => {
    assert.equal(historyHasExecutionEvent({
        status: {
            messages: [
                ["execution_start", { prompt_id: "a" }],
                ["execution_interrupted", { prompt_id: "a" }],
            ],
        },
    }, "execution_interrupted"), true);
    assert.equal(historyHasExecutionEvent({
        status: {
            messages: [["execution_success", { prompt_id: "a" }]],
        },
    }, "execution_interrupted"), false);
});

test("comfyQueueHasPromptId detects positional and object queue items", () => {
    assert.equal(comfyQueueHasPromptId({
        queue_running: [[3, "running-prompt", {}, {}, []]],
        queue_pending: [],
    }, "running-prompt"), true);
    assert.equal(comfyQueueHasPromptId({
        queue_running: [],
        queue_pending: [{ prompt_id: "pending-prompt" }],
    }, "pending-prompt"), true);
    assert.equal(comfyQueueHasPromptId({
        queue_running: [[3, "other-prompt", {}, {}, []]],
        queue_pending: [],
    }, "missing-prompt"), false);
});

test("runCanBeRerun requires stored workflow and executable prompt data", () => {
    assert.equal(runCanBeRerun({ prompt: { workflow: {}, output: { 1: {} } } }), true);
    assert.equal(runCanBeRerun({ prompt: { workflow: {}, prompt: { 1: {} } } }), true);
    assert.equal(runCanBeRerun({ prompt: { workflow: {} } }), false);
    assert.equal(runCanBeRerun({ prompt: { output: { 1: {} } } }), false);
});

test("workflowWithFixedSeedControls fixes flat seed control widgets", () => {
    const workflow = {
        nodes: [{
            type: "KSampler",
            inputs: [
                { name: "model", type: "MODEL", link: 1 },
                { name: "seed", type: "INT", widget: { name: "seed" }, link: null },
                { name: "steps", type: "INT", widget: { name: "steps" }, link: null },
            ],
            widgets_values: [123, "randomize", 20],
        }],
    };

    const nextWorkflow = workflowWithFixedSeedControls(workflow);

    assert.deepEqual(nextWorkflow.nodes[0].widgets_values, [123, "fixed", 20]);
});

test("workflowWithFixedSeedControls fixes noise seed and custom seed suffix controls", () => {
    const workflow = {
        nodes: [{
            type: "Generator",
            inputs: [
                { name: "noise_seed", type: "INT", widget: { name: "noise_seed" }, link: null },
                { name: "render_seed", type: "INT", widget: { name: "render_seed" }, link: null },
                { name: "mode", type: "STRING", widget: { name: "mode" }, link: null },
            ],
            widgets_values: [7, "increment", 9, "decrement", "randomize"],
        }],
    };

    const nextWorkflow = workflowWithFixedSeedControls(workflow);

    assert.deepEqual(nextWorkflow.nodes[0].widgets_values, [7, "fixed", 9, "fixed", "randomize"]);
});

test("workflowWithFixedSeedControls traverses nested subgraphs", () => {
    const workflow = {
        nodes: [],
        definitions: {
            subgraphs: [{
                nodes: [{
                    type: "KSamplerAdvanced",
                    inputs: [{ name: "noise_seed", type: "INT", widget: { name: "noise_seed" }, link: null }],
                    widgets_values: [44, "decrement"],
                }],
                definitions: {
                    subgraphs: [{
                        nodes: [{
                            type: "SeedNode",
                            inputs: [{ name: "seed", type: "INT", widget: { name: "seed" }, link: null }],
                            widgets_values: [55, "increment-wrap"],
                        }],
                    }],
                },
            }],
        },
    };

    const nextWorkflow = workflowWithFixedSeedControls(workflow);

    assert.equal(nextWorkflow.definitions.subgraphs[0].nodes[0].widgets_values[1], "fixed");
    assert.equal(nextWorkflow.definitions.subgraphs[0].definitions.subgraphs[0].nodes[0].widgets_values[1], "fixed");
});

test("workflowWithFixedSeedControls does not mutate the original workflow", () => {
    const workflow = {
        nodes: [{
            inputs: [{ name: "seed", type: "INT", widget: { name: "seed" }, link: null }],
            widgets_values: [123, "randomize"],
        }],
    };

    const nextWorkflow = workflowWithFixedSeedControls(workflow);

    assert.notEqual(nextWorkflow, workflow);
    assert.deepEqual(workflow.nodes[0].widgets_values, [123, "randomize"]);
    assert.deepEqual(nextWorkflow.nodes[0].widgets_values, [123, "fixed"]);
});

test("workflowWithFixedSeedControls leaves non-seed and unsupported nodes unchanged", () => {
    const workflow = {
        nodes: [
            {
                inputs: [{ name: "mode", type: "STRING", widget: { name: "mode" }, link: null }],
                widgets_values: ["fixed", "randomize"],
            },
            {
                inputs: null,
                widgets_values: [1, "randomize"],
            },
            {
                inputs: [{ name: "seed", type: "INT", widget: { name: "seed" }, link: null }],
                widgets_values: [1, "custom-control"],
            },
        ],
    };

    const nextWorkflow = workflowWithFixedSeedControls(workflow);

    assert.deepEqual(nextWorkflow, workflow);
});

test("fixLiveSeedControls fixes linked seed control widgets", () => {
    let callbackValue = null;
    const controlWidget = {
        name: "control_after_generate",
        value: "randomize",
        options: { values: ["fixed", "increment", "decrement", "randomize"] },
        callback(value) {
            callbackValue = value;
        },
    };
    const graph = {
        nodes: [{
            widgets: [
                { name: "seed", value: 123, linkedWidgets: [controlWidget] },
                controlWidget,
            ],
        }],
    };

    assert.equal(fixLiveSeedControls(graph), 1);
    assert.equal(controlWidget.value, "fixed");
    assert.equal(callbackValue, "fixed");
});

test("fixLiveSeedControls fixes adjacent seed control widgets", () => {
    const controlWidget = {
        name: "control_after_generate",
        value: "increment",
        options: { values: ["fixed", "increment", "decrement", "randomize"] },
    };
    const graph = {
        nodes: [{
            widgets: [
                { name: "seed", value: 123 },
                controlWidget,
            ],
        }],
    };

    assert.equal(fixLiveSeedControls(graph), 1);
    assert.equal(controlWidget.value, "fixed");
});

test("fixLiveSeedControls handles seed suffixes and custom control names with control options", () => {
    const controlWidget = {
        name: "generation_mode",
        value: "decrement",
        options: { values: ["fixed", "increment", "decrement", "randomize", "increment-wrap"] },
    };
    const graph = {
        nodes: [{
            widgets: [
                { name: "noise_seed", value: 123 },
                controlWidget,
            ],
        }],
    };

    assert.equal(fixLiveSeedControls(graph), 1);
    assert.equal(controlWidget.value, "fixed");
});

test("fixLiveSeedControls traverses live subgraphs", () => {
    const controlWidget = {
        name: "control_after_generate",
        value: "randomize",
        options: { values: ["fixed", "increment", "decrement", "randomize"] },
    };
    const graph = {
        nodes: [{
            widgets: [],
            isSubgraphNode() {
                return true;
            },
            subgraph: {
                nodes: [{
                    widgets: [
                        { name: "seed", value: 123 },
                        controlWidget,
                    ],
                }],
            },
        }],
    };

    assert.equal(fixLiveSeedControls(graph), 1);
    assert.equal(controlWidget.value, "fixed");
});

test("fixLiveSeedControls leaves non-control widgets unchanged", () => {
    const modeWidget = {
        name: "mode",
        value: "randomize",
        options: { values: ["randomize", "precise"] },
    };
    const graph = {
        nodes: [
            {
                widgets: [
                    { name: "seed", value: 123 },
                    modeWidget,
                ],
            },
            {
                widgets: [
                    { name: "mode", value: "fixed" },
                    { name: "control_after_generate", value: "randomize" },
                ],
            },
            {
                widgets: null,
            },
        ],
    };

    assert.equal(fixLiveSeedControls(graph), 0);
    assert.equal(modeWidget.value, "randomize");
});

test("latestMediaPreviewFromHistory finds private image outputs", () => {
    const preview = latestMediaPreviewFromHistory({
        outputs: {
            7: {
                helto_private_images: [{
                    filename: "secret.png",
                    type: "private",
                    private: true,
                    token: "abc.def",
                    content_type: "image/png",
                }],
                images: [],
            },
        },
    });

    assert.equal(preview.kind, "image");
    assert.equal(preview.record.token, "abc.def");
    assert.equal(preview.key, "helto_private_images");
});

test("latestMediaPreviewFromHistory finds standard image outputs", () => {
    const preview = latestMediaPreviewFromHistory({
        outputs: {
            9: {
                images: [
                    { filename: "old.png", subfolder: "", type: "temp" },
                    { filename: "new.png", subfolder: "run", type: "output" },
                ],
            },
        },
    });

    assert.equal(preview.kind, "image");
    assert.equal(preview.record.filename, "new.png");
});

test("latestMediaPreviewFromHistory detects video outputs", () => {
    const preview = latestMediaPreviewFromHistory({
        outputs: {
            12: {
                images: [{ filename: "clip.mp4", subfolder: "helto_save_video_advanced", type: "temp" }],
                animated: [true],
            },
        },
    });

    assert.equal(preview.kind, "video");
    assert.equal(preview.record.filename, "clip.mp4");
});

test("latestMediaPreviewFromHistory detects private video outputs", () => {
    const preview = latestMediaPreviewFromHistory({
        outputs: {
            13: {
                images: [{
                    filename: "clip.mp4",
                    type: "private",
                    private: true,
                    token: "video.token",
                    content_type: "video/mp4",
                }],
                animated: [true],
            },
        },
    });

    assert.equal(preview.kind, "video");
    assert.equal(preview.record.token, "video.token");
});

test("latestMediaPreviewFromHistory ignores unsupported outputs", () => {
    assert.equal(latestMediaPreviewFromHistory({ outputs: { 1: { helto_pause_control: [{ mode: "ready" }] } } }), null);
});

test("mediaRecordToPreviewUrl builds private and view URLs", () => {
    const privateUrl = mediaRecordToPreviewUrl(
        { record: { private: true, token: "abc.def" } },
        { apiURL: (route) => `/api${route}`, getRandParam: () => "&r=1" },
    );
    const imageUrl = mediaRecordToPreviewUrl(
        { record: { filename: "new.png", subfolder: "run", type: "output" } },
        {
            apiURL: (route) => `/api${route}`,
            getPreviewFormatParam: () => "&format=webp",
            getRandParam: () => "&r=2",
        },
    );

    assert.equal(privateUrl, "/api/helto_utils/private_media?token=abc.def&r=1");
    assert.equal(imageUrl, "/api/view?filename=new.png&type=output&subfolder=run&format=webp&r=2");
});

test("queue manager row markup uses compact one-line container", () => {
    const source = readFileSync(new URL("../../web/queue_manager.js", import.meta.url), "utf8");

    assert.match(source, /class="helto-qm-row-line"/);
    assert.match(source, /grid-template-columns: minmax\(0, 1fr\) auto auto/);
    assert.match(source, /data-action="rerun-history"/);
    assert.match(source, /rerunHistoryRun/);
    assert.match(source, /data-action="abort-queue"/);
    assert.match(source, /Abort workflow/);
    assert.match(source, /helto-qm-time-pill/);
    assert.doesNotMatch(source, /run\.prompt_id\.slice\(0, 8\)/);
    assert.doesNotMatch(source, /<div class="helto-qm-row-title"[^>]*>\$\{escapeHtml\(run\.title\)\}<\/div>\s*<div class="helto-qm-row-meta">/);
});

test("queue manager sidebar icon shows active queue count badge", () => {
    const source = readFileSync(new URL("../../web/queue_manager.js", import.meta.url), "utf8");

    assert.match(source, /\.HeltoQueueManagerIcon::after/);
    assert.match(source, /content: attr\(data-queue-count\)/);
    assert.match(source, /data-queue-count=""\]::after/);
    assert.match(source, /updateSidebarBadge\(summary = queueSummary\(this\.state\)\)/);
    assert.match(source, /const count = summary\.running \+ summary\.pending/);
    assert.match(source, /count > 99 \? "99\+" : String\(count\)/);
    assert.match(source, /icon\.dataset\.queueCount = label/);
    assert.match(source, /delete icon\.dataset\.queueCount/);
    assert.match(source, /scheduleSidebarBadgeUpdate/);
});

test("queue manager guards in-flight state saves with a local revision", () => {
    const source = readFileSync(new URL("../../web/queue_manager.js", import.meta.url), "utf8");

    assert.match(source, /this\.stateRevision = 0/);
    assert.match(source, /this\.stateRevision \+= 1/);
    assert.match(source, /const saveRevision = this\.stateRevision/);
    assert.match(source, /const stateSnapshot = cloneJson\(this\.state\)/);
    assert.match(source, /applyQueueStateSaveResponse\(/);
    assert.match(source, /if \(needsFollowUpSave\) \{\s*this\.scheduleSave\(\);/s);
});

test("queue manager aborts active runs and maps interrupted prompts to Aborted", () => {
    const source = readFileSync(new URL("../../web/queue_manager.js", import.meta.url), "utf8");

    assert.match(source, /QUEUE_STATUS_ABORTED/);
    assert.match(source, /execution_interrupted/);
    assert.match(source, /historyHasExecutionEvent\(history, "execution_interrupted"\)/);
    assert.match(source, /\/api\/jobs\/\$\{encodeURIComponent\(promptIdValue\)\}\/cancel/);
    assert.match(source, /routeUrl\("\/interrupt"\)/);
    assert.match(source, /data-action="abort-queue"/);
    assert.match(source, /isActiveRunStatus\(run\.status\)/);
    assert.match(source, /displayStatus/);
});

test("queue manager reconciles stale active runs after ComfyUI crashes", () => {
    const source = readFileSync(new URL("../../web/queue_manager.js", import.meta.url), "utf8");

    assert.match(source, /STALE_PROMPT_MISS_LIMIT = 2/);
    assert.match(source, /fetchComfyQueue/);
    assert.match(source, /routeUrl\("\/queue"\)/);
    assert.match(source, /reconcileActiveRun/);
    assert.match(source, /comfyQueueHasPromptId\(queueInfo, run\.prompt_id\)/);
    assert.match(source, /ComfyUI stopped before this run completed\./);
    assert.match(source, /setTimeout\(\(\) => this\.drainQueue\(\), 0\)/);
});

test("queue manager preview button uses shared hover thumbnail and preview window", () => {
    const source = readFileSync(new URL("../../web/queue_manager.js", import.meta.url), "utf8");

    assert.match(source, /from "\.\/media_preview\.js"/);
    assert.match(source, /openHeltoMediaPreview/);
    assert.match(source, /attachHeltoMediaPreviewHover/);
    assert.match(source, /data-preview-url/);
    assert.match(source, /data-preview-kind/);
    assert.doesNotMatch(source, /helto-qm-preview/);
    assert.doesNotMatch(source, /previewHtml\(/);
});

test("queue manager history has compact live search and workflow filters", () => {
    const source = readFileSync(new URL("../../web/queue_manager.js", import.meta.url), "utf8");

    assert.match(source, /class="helto-qm-history-filters"/);
    assert.match(source, /grid-template-columns: minmax\(0, 1fr\) minmax\(96px, 0\.7fr\)/);
    assert.match(source, /data-action="history-search"/);
    assert.match(source, /type="search"/);
    assert.match(source, /data-action="history-workflow-filter"/);
    assert.match(source, /All workflows/);
    assert.match(source, /historyWorkflowNames/);
    assert.match(source, /filteredHistoryRuns/);
    assert.match(source, /refreshHistoryResults/);
    assert.match(source, /addEventListener\("input"/);
    assert.match(source, /addEventListener\("change"/);
    assert.match(source, /data-history-list/);
});

test("selector preview popup delegates to the shared media preview window", () => {
    const source = readFileSync(new URL("../../web/selector.js", import.meta.url), "utf8");

    assert.match(source, /from "\.\/media_preview\.js"/);
    assert.match(source, /openHeltoMediaPreview\(\{/);
    assert.match(source, /closeHeltoMediaPreview\(\)/);
    assert.doesNotMatch(source, /overlay\.className = "helto-preview-overlay"/);
});

test("shared media preview supports image and video modals plus hover thumbnails", () => {
    const source = readFileSync(new URL("../../web/media_preview.js", import.meta.url), "utf8");

    assert.match(source, /export function openHeltoMediaPreview/);
    assert.match(source, /export function attachHeltoMediaPreviewHover/);
    assert.match(source, /documentRef\.createElement\("video"\)/);
    assert.match(source, /video\.controls = true/);
    assert.match(source, /video\.loop = true/);
    assert.match(source, /helto-media-preview-thumb-popover/);
    assert.match(source, /documentRef\.createElement\("img"\)/);
});
