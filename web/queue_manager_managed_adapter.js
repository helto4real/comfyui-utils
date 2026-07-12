// Inactive Queue Manager adapter for helto-privacy's settled queue coordinator.

export function createManagedQueueLifecycle({
    createPrivacyQueueCoordinator,
    workflowHandle,
    operationsHandle,
    serializePrompt,
    rebuildPrompt,
    enqueuePrompt,
    previewRun,
    deleteRun,
    clearHistory,
}) {
    if (
        typeof createPrivacyQueueCoordinator !== "function"
        || typeof workflowHandle?.runWithSnapshot !== "function"
        || typeof operationsHandle?.invoke !== "function"
        || typeof serializePrompt !== "function"
        || typeof rebuildPrompt !== "function"
        || typeof enqueuePrompt !== "function"
        || typeof previewRun !== "function"
        || typeof deleteRun !== "function"
        || typeof clearHistory !== "function"
    ) {
        throw new Error("PRIVACY_QUEUE_MANAGER_ADAPTER_INVALID");
    }

    const coordinator = createPrivacyQueueCoordinator({
        workflow: workflowHandle,
        capturePrompt: (transaction, options) => serializePrompt(
            transaction.graphToPrompt,
            options.graph,
        ),
        rebuildPrompt: (stored, transaction, options) => rebuildPrompt({
            workflow: clone(stored.workflow),
            graphToPrompt: transaction.graphToPrompt,
            options,
        }),
        submitPrompt: async (prompt, options) => {
            await operationsHandle.invoke("queue-manager.submit");
            return enqueuePrompt(prompt, options);
        },
    });

    return Object.freeze({
        async captureBatches(options = {}) {
            await operationsHandle.invoke("queue-manager.capture");
            return coordinator.captureBatches({
                ...options,
                beforeSnapshot: options.beforeQueued,
                afterSubmit: options.afterQueued,
            });
        },
        async replay(run, options = {}) {
            if (!run?.prompt || typeof run.prompt !== "object") {
                throw new Error("PRIVACY_QUEUE_MANAGER_SNAPSHOT_INVALID");
            }
            await operationsHandle.invoke("queue-manager.replay");
            return coordinator.replay(run.prompt, options);
        },
        async rerun(run, options = {}) {
            await operationsHandle.invoke("queue-manager.rerun");
            if (!run?.prompt || typeof run.prompt !== "object") {
                throw new Error("PRIVACY_QUEUE_MANAGER_SNAPSHOT_INVALID");
            }
            return coordinator.replay(run.prompt, options);
        },
        load() {
            return operationsHandle.invoke("queue-manager.load");
        },
        save(state, expectedRevision) {
            return operationsHandle.invoke("queue-manager.save", {
                state: clone(state),
                expectedRevision,
            });
        },
        async preview(runId, source) {
            await operationsHandle.invoke("queue-manager.preview", { runId, source });
            return previewRun(runId, source);
        },
        async delete(runId, source) {
            await operationsHandle.invoke("queue-manager.delete", { runId, source });
            return deleteRun(runId, source);
        },
        async clear() {
            await operationsHandle.invoke("queue-manager.clear");
            return clearHistory();
        },
    });
}

function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}
