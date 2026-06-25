import assert from "node:assert/strict";
import test from "node:test";

import {
    QUEUE_STATUS_COMPLETED,
    QUEUE_STATUS_PENDING,
    QUEUE_STATUS_RUNNING,
    createDefaultQueueState,
    createQueueRun,
    moveRunToHistory,
    normalizeQueueState,
    promptWorkflowTitle,
    queueSummary,
} from "../../web/queue_manager_helpers.js";

test("promptWorkflowTitle reads workflow metadata with fallback", () => {
    assert.equal(promptWorkflowTitle({ workflow: { name: "Render pass" } }), "Render pass");
    assert.equal(promptWorkflowTitle({ workflow: {} }, "Untitled"), "Untitled");
});

test("createQueueRun leaves queue number empty when not supplied", () => {
    const run = createQueueRun({ workflow: {}, output: {} }, { id: "run-default", now: 1000 });

    assert.equal(run.number, null);
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
