export const SAVE_IMAGE_RELEASE_ROUTE = "/helto_save_image_advanced/release";
export const SAVE_VIDEO_RELEASE_ROUTE = "/helto_save_video_advanced/release";
export const PAUSE_CONTROL_RUNTIME_WIDGET_NAMES = new Set(["continue", "run again", "queueing", "hide mode"]);

function asNumberSet(values) {
    return new Set([...values].map((value) => Number(value)).filter(Number.isFinite));
}

function outputSlotIndex(workflowNode, outputName) {
    const outputs = Array.isArray(workflowNode?.outputs) ? workflowNode.outputs : [];
    const index = outputs.findIndex((output) => output?.name === outputName);
    return index >= 0 ? index : 0;
}

function outputSlotIndexes(workflowNode, outputNames) {
    const outputs = Array.isArray(workflowNode?.outputs) ? workflowNode.outputs : [];
    const names = Array.isArray(outputNames) ? outputNames : [outputNames];
    const indexes = new Set();

    for (const name of names) {
        const index = outputs.findIndex((output) => output?.name === name);
        if (index >= 0) {
            indexes.add(index);
        }
    }

    if (indexes.size === 0) {
        indexes.add(outputSlotIndex(workflowNode, names[0]));
    }

    return indexes;
}

function workflowLinks(prompt) {
    return Array.isArray(prompt?.workflow?.links) ? prompt.workflow.links : [];
}

function workflowNodesById(prompt) {
    const nodes = Array.isArray(prompt?.workflow?.nodes) ? prompt.workflow.nodes : [];
    return new Map(nodes.map((node) => [Number(node.id), node]));
}

function linkedInputNodeIds(apiNode) {
    const inputs = apiNode?.inputs ?? {};
    const ids = [];
    for (const value of Object.values(inputs)) {
        if (Array.isArray(value) && value.length === 2) {
            const id = Number(value[0]);
            if (Number.isFinite(id)) {
                ids.push(id);
            }
        }
    }
    return ids;
}

export function downstreamNodeIdsFromOutput(prompt, startNodeId, outputName = "images") {
    const startId = Number(startNodeId);
    const nodesById = workflowNodesById(prompt);
    const startNode = nodesById.get(startId);
    const startSlots = outputSlotIndexes(startNode, outputName);
    const links = workflowLinks(prompt).filter((link) => {
        return Number(link?.[1]) === startId && startSlots.has(Number(link?.[2]));
    });
    const downstream = new Set();
    const queue = links.map((link) => Number(link?.[3])).filter(Number.isFinite);

    while (queue.length > 0) {
        const nodeId = queue.shift();
        if (downstream.has(nodeId)) {
            continue;
        }
        downstream.add(nodeId);

        for (const link of workflowLinks(prompt)) {
            if (Number(link?.[1]) === nodeId) {
                const nextId = Number(link?.[3]);
                if (Number.isFinite(nextId) && !downstream.has(nextId)) {
                    queue.push(nextId);
                }
            }
        }
    }

    return downstream;
}

export function dependencyNodeIdsForPromptOutput(promptOutput, rootIds, stopIds = new Set()) {
    const keep = new Set();
    const queue = [...asNumberSet(rootIds)];
    const stops = asNumberSet(stopIds);

    while (queue.length > 0) {
        const nodeId = queue.shift();
        if (keep.has(nodeId)) {
            continue;
        }
        keep.add(nodeId);

        if (stops.has(nodeId)) {
            continue;
        }

        const apiNode = promptOutput?.[String(nodeId)];
        for (const inputNodeId of linkedInputNodeIds(apiNode)) {
            if (!keep.has(inputNodeId)) {
                queue.push(inputNodeId);
            }
        }
    }

    return keep;
}

function clonePrompt(prompt) {
    if (typeof structuredClone === "function") {
        return structuredClone(prompt);
    }
    return JSON.parse(JSON.stringify(prompt));
}

function removeLinkedInputs(apiNode) {
    const inputs = apiNode?.inputs ?? {};
    const clean = {};
    for (const [key, value] of Object.entries(inputs)) {
        if (!Array.isArray(value)) {
            clean[key] = value;
        }
    }
    apiNode.inputs = clean;
}

export function buildPauseResumePrompt(prompt, startNodeId, outputName = "images") {
    const startId = Number(startNodeId);
    const downstream = downstreamNodeIdsFromOutput(prompt, startId, outputName);
    const keep = dependencyNodeIdsForPromptOutput(prompt?.output, downstream, new Set([startId]));
    keep.add(startId);

    const nextPrompt = clonePrompt(prompt);
    const keepIds = asNumberSet(keep);
    nextPrompt.output = {};
    for (const [nodeId, apiNode] of Object.entries(prompt?.output ?? {})) {
        if (keepIds.has(Number(nodeId))) {
            nextPrompt.output[nodeId] = clonePrompt(apiNode);
        }
    }

    const startApiNode = nextPrompt.output[String(startId)];
    if (startApiNode) {
        removeLinkedInputs(startApiNode);
    }

    if (nextPrompt.workflow) {
        nextPrompt.workflow.nodes = (nextPrompt.workflow.nodes ?? []).filter((node) => keepIds.has(Number(node.id)));
        nextPrompt.workflow.links = workflowLinks(nextPrompt).filter((link) => {
            return keepIds.has(Number(link?.[1])) && keepIds.has(Number(link?.[3]));
        });
    }

    return {
        prompt: nextPrompt,
        downstreamNodeIds: [...downstream],
        keptNodeIds: [...keepIds],
    };
}

export async function queueFilteredPrompt(apiClient, promptData) {
    if (!promptData || typeof promptData !== "object" || !promptData.output || !promptData.workflow) {
        throw new Error("Cannot queue resume without filtered prompt data.");
    }
    if (typeof apiClient?.queuePrompt !== "function") {
        throw new Error("Cannot queue resume because ComfyUI API queuePrompt is unavailable.");
    }

    return apiClient.queuePrompt(-1, promptData);
}

export function bindPauseReleaseToken(promptData, nodeId, releaseToken) {
    const token = String(releaseToken || "");
    const apiNode = promptData?.output?.[String(nodeId)];
    if (!apiNode || !token) {
        throw new Error("Cannot queue resume without a bound release token.");
    }
    apiNode.inputs ??= {};
    apiNode.inputs.release_token = token;
    return promptData;
}

export async function queueWithReleaseRollback(release, queue, cancel) {
    const releasePayload = await release();
    try {
        return await queue(releasePayload);
    } catch (error) {
        try {
            await cancel(releasePayload);
        } catch (cancelError) {
            console.error("[Helto pause control] Failed to cancel release after queue failure:", cancelError);
        }
        throw error;
    }
}

export function isPauseControlRuntimeWidget(widget, runtimeNames = PAUSE_CONTROL_RUNTIME_WIDGET_NAMES) {
    return runtimeNames.has(widget?.name);
}

export function serializableWidgets(node, runtimeNames = PAUSE_CONTROL_RUNTIME_WIDGET_NAMES) {
    return (Array.isArray(node?.widgets) ? node.widgets : []).filter((widget) => {
        return !isPauseControlRuntimeWidget(widget, runtimeNames)
            && widget?.serialize !== false
            && widget?.options?.serialize !== false;
    });
}

export function serializedWidgetValues(node, runtimeNames = PAUSE_CONTROL_RUNTIME_WIDGET_NAMES) {
    return serializableWidgets(node, runtimeNames).map((widget, index) => {
        if (typeof widget.serializeValue === "function") {
            const value = widget.serializeValue(node, index);
            if (!value || typeof value.then !== "function") {
                return value;
            }
        }
        return widget.value;
    });
}

export function serializedWidgetValueMap(node, runtimeNames = PAUSE_CONTROL_RUNTIME_WIDGET_NAMES) {
    const values = {};
    for (const widget of serializableWidgets(node, runtimeNames)) {
        if (typeof widget.serializeValue === "function") {
            const value = widget.serializeValue(node);
            if (!value || typeof value.then !== "function") {
                values[widget.name] = value;
                continue;
            }
        }
        values[widget.name] = widget.value;
    }
    return values;
}

export function sanitizeSerializedWidgetValues(node, info, runtimeNames = PAUSE_CONTROL_RUNTIME_WIDGET_NAMES) {
    if (!info) {
        return;
    }
    info.widgets_values = serializedWidgetValueMap(node, runtimeNames);
}

function restoreWidgetValue(widget, value) {
    if (value !== undefined) {
        widget.value = value;
    }
}

function restoreSerializedWidgetValueMap(node, values, runtimeNames) {
    const widgets = serializableWidgets(node, runtimeNames);
    for (const widget of widgets) {
        if (Object.prototype.hasOwnProperty.call(values, widget.name)) {
            restoreWidgetValue(widget, values[widget.name]);
        }
    }
}

function restoreSerializedWidgetValueArray(node, values, runtimeNames) {
    const widgets = serializableWidgets(node, runtimeNames);
    const allWidgets = Array.isArray(node?.widgets) ? node.widgets : [];

    if (values.length === allWidgets.length) {
        for (let index = 0; index < allWidgets.length; index += 1) {
            const widget = allWidgets[index];
            if (!isPauseControlRuntimeWidget(widget, runtimeNames)
                && widget?.serialize !== false
                && widget?.options?.serialize !== false) {
                restoreWidgetValue(widget, values[index]);
            }
        }
        return;
    }

    for (let index = 0; index < widgets.length && index < values.length; index += 1) {
        restoreWidgetValue(widgets[index], values[index]);
    }
}

export function restoreSerializedWidgetValues(node, values, runtimeNames = PAUSE_CONTROL_RUNTIME_WIDGET_NAMES) {
    if (Array.isArray(values)) {
        restoreSerializedWidgetValueArray(node, values, runtimeNames);
        return;
    }

    if (values && typeof values === "object") {
        restoreSerializedWidgetValueMap(node, values, runtimeNames);
    }
}
