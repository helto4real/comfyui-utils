export const SAVE_IMAGE_RELEASE_ROUTE = "/helto_save_image_advanced/release";

function asNumberSet(values) {
    return new Set([...values].map((value) => Number(value)).filter(Number.isFinite));
}

function outputSlotIndex(workflowNode, outputName) {
    const outputs = Array.isArray(workflowNode?.outputs) ? workflowNode.outputs : [];
    const index = outputs.findIndex((output) => output?.name === outputName);
    return index >= 0 ? index : 0;
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
    const startSlot = outputSlotIndex(startNode, outputName);
    const links = workflowLinks(prompt).filter((link) => {
        return Number(link?.[1]) === startId && Number(link?.[2]) === startSlot;
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
