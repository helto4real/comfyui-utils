import assert from "node:assert/strict";
import test from "node:test";

import {
    applyProgressEvent,
    createProgressState,
    formatProgressText,
    progressSnapshot,
    rememberPromptData,
} from "../../web/progress_bar_helpers.js";

const PROMPT = {
    output: {
        1: { class_type: "LoadImage", _meta: { title: "Load image" } },
        2: { class_type: "KSampler", _meta: { title: "Sampler" } },
        3: { class_type: "PreviewImage", _meta: { title: "Preview" } },
        4: { class_type: "SaveImage", _meta: { title: "Save" } },
    },
};

test("execution start applies known prompt data and resets runtime state", () => {
    let state = createProgressState();
    state = rememberPromptData(state, "prompt-a", PROMPT);
    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-a" });
    state = applyProgressEvent(state, "executed", { prompt_id: "prompt-a", node: "1" });

    assert.equal(progressSnapshot(state).totalNodes, 4);
    assert.equal(progressSnapshot(state).completedNodes, 1);

    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-b" });
    const snapshot = progressSnapshot(state);

    assert.equal(snapshot.promptId, "prompt-b");
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.totalNodes, 0);
    assert.equal(snapshot.completedNodes, 0);
});

test("cached nodes count toward workflow progress", () => {
    let state = createProgressState();
    state = rememberPromptData(state, "prompt-a", PROMPT);
    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-a" });
    state = applyProgressEvent(state, "execution_cached", { prompt_id: "prompt-a", nodes: ["1", "2"] });

    const snapshot = progressSnapshot(state);

    assert.equal(snapshot.completedNodes, 2);
    assert.equal(snapshot.workflowPercent, 50);
});

test("progress_state updates current node percent", () => {
    let state = createProgressState();
    state = rememberPromptData(state, "prompt-a", PROMPT);
    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-a" });
    state = applyProgressEvent(state, "progress_state", {
        prompt_id: "prompt-a",
        nodes: {
            2: {
                node_id: "2",
                display_node_id: "2",
                state: "running",
                value: 5,
                max: 10,
            },
        },
    });

    const snapshot = progressSnapshot(state);

    assert.equal(snapshot.currentNodeId, "2");
    assert.equal(snapshot.currentPercent, 50);
    assert.match(formatProgressText(snapshot), /Sampler/);
});

test("progress_text updates current status in real time", () => {
    let state = createProgressState();
    state = rememberPromptData(state, "prompt-a", PROMPT);
    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-a" });
    state = applyProgressEvent(state, "progress_state", {
        prompt_id: "prompt-a",
        nodes: {
            2: {
                node_id: "2",
                display_node_id: "2",
                state: "running",
                value: 2,
                max: 10,
            },
        },
    });
    state = applyProgressEvent(state, "progress_text", {
        prompt_id: "prompt-a",
        nodeId: "2",
        text: "Downloading shard 2",
    });

    const snapshot = progressSnapshot(state);

    assert.equal(snapshot.currentPercent, 20);
    assert.equal(snapshot.current.message, "Downloading shard 2");
    assert.equal(snapshot.recentEvents.length, 0);
    assert.match(formatProgressText(snapshot), /Downloading shard 2/);
});

test("progress_text survives following progress_state updates", () => {
    let state = createProgressState();
    state = rememberPromptData(state, "prompt-a", PROMPT);
    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-a" });
    state = applyProgressEvent(state, "progress_text", {
        prompt_id: "prompt-a",
        nodeId: "2",
        text: "Encoding frame 4",
    });
    state = applyProgressEvent(state, "progress_state", {
        prompt_id: "prompt-a",
        nodes: {
            2: {
                node_id: "2",
                display_node_id: "2",
                state: "running",
                value: 6,
                max: 10,
            },
        },
    });

    const snapshot = progressSnapshot(state);
    const text = formatProgressText(snapshot);

    assert.equal(snapshot.currentPercent, 60);
    assert.equal(snapshot.current.message, "Encoding frame 4");
    assert.match(text, /Encoding frame 4/);
});

test("helto_progress augments current node phase and message", () => {
    let state = createProgressState();
    state = rememberPromptData(state, "prompt-a", PROMPT);
    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-a" });
    state = applyProgressEvent(state, "progress", {
        prompt_id: "prompt-a",
        node: "2",
        value: 2,
        max: 10,
    });
    state = applyProgressEvent(state, "helto_progress", {
        version: 1,
        event: "update",
        prompt_id: "prompt-a",
        node_id: "2",
        display_node_id: "2",
        phase: "load_model",
        message: "Loading checkpoint",
        detail: { log: "Read 4 model shards" },
        level: "info",
        percent: 70,
        timestamp: 1,
    });

    const snapshot = progressSnapshot(state);
    const text = formatProgressText(snapshot);

    assert.equal(snapshot.currentPercent, 70);
    assert.equal(snapshot.latestLogText, "Read 4 model shards");
    assert.match(text, /Load model/);
    assert.match(text, /Loading checkpoint/);
    assert.match(text, /Loading checkpoint.* \| Read 4 model shards/);
    assert.equal(snapshot.recentEvents.length, 1);
});

test("progress_text separator does not duplicate helto_progress detail log", () => {
    let state = createProgressState();
    state = rememberPromptData(state, "prompt-a", PROMPT);
    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-a" });
    state = applyProgressEvent(state, "progress_state", {
        prompt_id: "prompt-a",
        nodes: {
            2: {
                node_id: "2",
                display_node_id: "2",
                state: "running",
                value: 4,
                max: 10,
            },
        },
    });
    state = applyProgressEvent(state, "progress_text", {
        prompt_id: "prompt-a",
        nodeId: "2",
        text: "Writing frame | ffmpeg accepted frame 4",
    });
    state = applyProgressEvent(state, "helto_progress", {
        version: 1,
        event: "update",
        prompt_id: "prompt-a",
        node_id: "2",
        display_node_id: "2",
        phase: "encode_video",
        message: "Writing frame",
        detail: { log: "ffmpeg accepted frame 4" },
        level: "info",
        percent: 40,
        timestamp: 1,
    });

    const text = formatProgressText(progressSnapshot(state));

    assert.match(text, /Writing frame.* \| ffmpeg accepted frame 4/);
    assert.equal(text.match(/ffmpeg accepted frame 4/g).length, 1);
});

test("blank progress_text does not clear current message", () => {
    let state = createProgressState();
    state = rememberPromptData(state, "prompt-a", PROMPT);
    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-a" });
    state = applyProgressEvent(state, "progress_text", {
        prompt_id: "prompt-a",
        nodeId: "2",
        text: "Keep this status",
    });
    state = applyProgressEvent(state, "progress_text", {
        prompt_id: "prompt-a",
        nodeId: "2",
        text: "   ",
    });

    const snapshot = progressSnapshot(state);

    assert.equal(snapshot.current.message, "Keep this status");
    assert.match(formatProgressText(snapshot), /Keep this status/);
});

test("execution error and interruption update active state", () => {
    let state = createProgressState();
    state = rememberPromptData(state, "prompt-a", PROMPT);
    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-a" });
    state = applyProgressEvent(state, "execution_error", {
        prompt_id: "prompt-a",
        node_id: "2",
        node_type: "KSampler",
        exception_message: "CUDA out of memory",
    });

    let snapshot = progressSnapshot(state);
    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.currentNodeId, "2");
    assert.match(formatProgressText(snapshot), /CUDA out of memory/);

    state = applyProgressEvent(state, "execution_interrupted", { prompt_id: "prompt-a", node_id: "2" });
    snapshot = progressSnapshot(state);
    assert.equal(snapshot.status, "interrupted");
    assert.equal(snapshot.current, null);
});

test("recent helto_progress events are capped", () => {
    let state = createProgressState({ eventLimit: 3 });
    state = applyProgressEvent(state, "execution_start", { prompt_id: "prompt-a" });

    for (let index = 0; index < 5; index += 1) {
        state = applyProgressEvent(state, "helto_progress", {
            prompt_id: "prompt-a",
            node_id: "2",
            event: "update",
            message: `event ${index}`,
            timestamp: index,
        });
    }

    const snapshot = progressSnapshot(state);

    assert.equal(snapshot.recentEvents.length, 3);
    assert.equal(snapshot.recentEvents[0].message, "event 4");
    assert.equal(snapshot.recentEvents[2].message, "event 2");
});
