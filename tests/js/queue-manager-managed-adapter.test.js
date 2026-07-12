import assert from "node:assert/strict";
import test from "node:test";

import { createManagedQueueLifecycle } from "../../web/queue_manager_managed_adapter.js";


function sharedFactory({ workflow, capturePrompt, submitPrompt, rebuildPrompt }) {
    return {
        async captureBatches(options) {
            const results = [];
            for (let batchIndex = 0; batchIndex < options.batchCount; batchIndex += 1) {
                await options.beforeSnapshot?.({ ...options, batchIndex });
                results.push(await workflow.runWithSnapshot("queue-manager", async (transaction) => {
                    const prompt = await capturePrompt(transaction, { ...options, batchIndex });
                    return submitPrompt(prompt, { ...options, batchIndex, replay: false });
                }));
                await options.afterSubmit?.({ ...options, batchIndex });
            }
            return results;
        },
        replay(stored, options) {
            return workflow.runWithSnapshot("replay", async (transaction) => {
                const prompt = await rebuildPrompt(stored, transaction, options);
                assert.notEqual(prompt, stored);
                return submitPrompt(prompt, { ...options, replay: true });
            });
        },
    };
}

function productBindings(events = []) {
    return {
        operationsHandle: {
            async invoke(operationId, payload) {
                events.push([operationId, payload]);
                return { ok: true };
            },
        },
        previewRun: async () => null,
        deleteRun: async () => null,
        clearHistory: async () => null,
    };
}


test("managed capture preserves batch callbacks inside settled snapshots", async () => {
    const events = [];
    let grant = 0;
    const lifecycle = createManagedQueueLifecycle({
        createPrivacyQueueCoordinator: sharedFactory,
        ...productBindings(),
        workflowHandle: {
            runWithSnapshot(reason, operation) {
                events.push(`settle:${reason}`);
                return operation({ graphToPrompt: async () => ({ grant: ++grant }) });
            },
        },
        serializePrompt: (graphToPrompt) => graphToPrompt(),
        rebuildPrompt: async () => ({ grant: ++grant }),
        enqueuePrompt: async (prompt) => {
            events.push(`submit:${prompt.grant}`);
            return prompt.grant;
        },
    });

    const result = await lifecycle.captureBatches({
        batchCount: 2,
        beforeQueued: ({ batchIndex }) => events.push(`before:${batchIndex}`),
        afterQueued: ({ batchIndex }) => events.push(`after:${batchIndex}`),
    });

    assert.deepEqual(result, [1, 2]);
    assert.deepEqual(events, [
        "before:0", "settle:queue-manager", "submit:1", "after:0",
        "before:1", "settle:queue-manager", "submit:2", "after:1",
    ]);
});


test("managed replay regenerates a fresh grant on every attempt", async () => {
    const submitted = [];
    let grant = 0;
    const lifecycle = createManagedQueueLifecycle({
        createPrivacyQueueCoordinator: sharedFactory,
        ...productBindings(),
        workflowHandle: {
            runWithSnapshot: (_reason, operation) => operation({ graphToPrompt: async () => ({}) }),
        },
        serializePrompt: async () => ({}),
        rebuildPrompt: async ({ workflow }) => ({ workflow, grant: `fresh-${++grant}` }),
        enqueuePrompt: async (prompt) => {
            submitted.push(prompt);
            return prompt.grant;
        },
    });
    const run = { prompt: { workflow: { id: "synthetic" }, grant: "expired" } };

    assert.equal(await lifecycle.replay(run), "fresh-1");
    assert.equal(await lifecycle.replay(run), "fresh-2");
    assert.deepEqual(submitted.map((prompt) => prompt.grant), ["fresh-1", "fresh-2"]);
    assert(!submitted.includes(run.prompt));
});


test("managed replay rejects missing snapshots without invoking product code", async () => {
    let called = false;
    const lifecycle = createManagedQueueLifecycle({
        createPrivacyQueueCoordinator: sharedFactory,
        ...productBindings(),
        workflowHandle: { runWithSnapshot: () => { called = true; } },
        serializePrompt: async () => ({}),
        rebuildPrompt: async () => ({}),
        enqueuePrompt: async () => ({}),
    });

    await assert.rejects(
        () => lifecycle.replay({}),
        (error) => error.message === "PRIVACY_QUEUE_MANAGER_SNAPSHOT_INVALID",
    );
    assert.equal(called, false);
});


test("managed lifecycle authorizes every queue-domain operation", async () => {
    const calls = [];
    const products = productBindings(calls);
    products.previewRun = async (runId) => `preview:${runId}`;
    products.deleteRun = async (runId) => `delete:${runId}`;
    products.clearHistory = async () => "cleared";
    const lifecycle = createManagedQueueLifecycle({
        createPrivacyQueueCoordinator: sharedFactory,
        ...products,
        workflowHandle: {
            runWithSnapshot: (_reason, operation) => operation({
                graphToPrompt: async () => ({ workflow: {}, output: {} }),
            }),
        },
        serializePrompt: (graphToPrompt) => graphToPrompt(),
        rebuildPrompt: async ({ workflow }) => ({ workflow, output: {} }),
        enqueuePrompt: async () => ({ prompt_id: "synthetic" }),
    });

    await lifecycle.captureBatches({ batchCount: 1 });
    await lifecycle.load();
    await lifecycle.save({ queue: [] }, 1);
    assert.equal(await lifecycle.preview("run-a", "history"), "preview:run-a");
    assert.equal(await lifecycle.delete("run-a", "history"), "delete:run-a");
    assert.equal(await lifecycle.clear(), "cleared");

    assert.deepEqual(calls.map(([operation]) => operation), [
        "queue-manager.capture",
        "queue-manager.submit",
        "queue-manager.load",
        "queue-manager.save",
        "queue-manager.preview",
        "queue-manager.delete",
        "queue-manager.clear",
    ]);
});
