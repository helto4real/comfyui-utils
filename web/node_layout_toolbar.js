import { app } from "../../scripts/app.js";

import { STOP_EVENTS } from "./constants.js";
import {
    NODE_LAYOUT_ACTIONS,
    applyLayoutAction,
    canUseLayoutTools,
    menuItemsForMaster,
    nodeRect,
    selectedNodesFromCanvas,
} from "./node_layout_tools.js";

const STYLE_LINK_ID = "helto-utils-styles";
const DEFAULT_TITLE_HEIGHT = 30;
const TITLE_BUTTON_RIGHT_INSET = 24;
const POPUP_MARGIN = 8;
const TOOL_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M4 18h16"/><path d="M8 3v18"/><path d="M16 3v18"/><rect x="6" y="5" width="4" height="4" rx="1"/><rect x="14" y="15" width="4" height="4" rx="1"/></svg>`;

function ensureSharedStylesheet() {
    if (document.getElementById(STYLE_LINK_ID)) return;
    const link = document.createElement("link");
    link.id = STYLE_LINK_ID;
    link.rel = "stylesheet";
    link.href = new URL("./styles.css", import.meta.url).href;
    document.head.appendChild(link);
}

function stopComfyEvent(event) {
    event.preventDefault();
    event.stopPropagation();
}

function canvasElement(canvas) {
    return canvas?.canvas ?? null;
}

function canvasTransform(canvas) {
    const scale = Number(canvas?.ds?.scale) || 1;
    const offset = Array.isArray(canvas?.ds?.offset) ? canvas.ds.offset : [0, 0];
    return {
        scale,
        offsetX: Number(offset[0]) || 0,
        offsetY: Number(offset[1]) || 0,
    };
}

function eventToGraphPoint(event, canvas) {
    const element = canvasElement(canvas);
    if (!element) return null;

    const rect = element.getBoundingClientRect();
    if (
        event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom
    ) {
        return null;
    }

    if (typeof canvas?.convertEventToCanvasOffset === "function") {
        try {
            const point = canvas.convertEventToCanvasOffset(event);
            if (point && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))) {
                return [Number(point[0]), Number(point[1])];
            }
        } catch (error) {
            console.debug?.("Helto node layout toolbar could not use ComfyUI event conversion.", error);
        }
    }

    const transform = canvasTransform(canvas);
    return [
        (event.clientX - rect.left) / transform.scale - transform.offsetX,
        (event.clientY - rect.top) / transform.scale - transform.offsetY,
    ];
}

function graphToClientPoint(point, canvas) {
    const element = canvasElement(canvas);
    if (!element) return null;

    const rect = element.getBoundingClientRect();
    const transform = canvasTransform(canvas);
    return [
        rect.left + (point[0] + transform.offsetX) * transform.scale,
        rect.top + (point[1] + transform.offsetY) * transform.scale,
    ];
}

function nodeTitleButtonPoint(node) {
    const bounds = nodeRect(node);
    const titleHeight = Number(globalThis.LiteGraph?.NODE_TITLE_HEIGHT) || DEFAULT_TITLE_HEIGHT;
    return [
        bounds.right - TITLE_BUTTON_RIGHT_INSET,
        bounds.top - titleHeight / 2,
    ];
}

function pointInsideNode(point, node) {
    if (typeof node?.isPointInside === "function") {
        return node.isPointInside(point[0], point[1]);
    }

    const bounds = nodeRect(node);
    return point[0] >= bounds.left
        && point[0] <= bounds.right
        && point[1] >= bounds.top
        && point[1] <= bounds.bottom;
}

function nodeFromGraphHitTest(point, canvas) {
    const graph = canvas?.graph;
    if (typeof graph?.getNodeOnPos !== "function") return null;

    const node = graph.getNodeOnPos(point[0], point[1], canvas?.visible_nodes);
    return canUseLayoutTools(node, canvas) ? node : null;
}

function hoveredSelectedNode(event, canvas) {
    const graphPoint = eventToGraphPoint(event, canvas);
    if (!graphPoint) return null;

    const hitNode = nodeFromGraphHitTest(graphPoint, canvas);
    if (hitNode) return hitNode;

    const nodes = selectedNodesFromCanvas(canvas);
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (pointInsideNode(graphPoint, node) && canUseLayoutTools(node, canvas)) {
            return node;
        }
    }

    return null;
}

function clampPopupPosition(left, top, popup) {
    const width = popup.offsetWidth || 240;
    const height = popup.offsetHeight || 44;
    const maxLeft = Math.max(POPUP_MARGIN, window.innerWidth - width - POPUP_MARGIN);
    const maxTop = Math.max(POPUP_MARGIN, window.innerHeight - height - POPUP_MARGIN);
    return {
        left: Math.min(Math.max(POPUP_MARGIN, left), maxLeft),
        top: Math.min(Math.max(POPUP_MARGIN, top), maxTop),
    };
}

class HeltoNodeLayoutToolbar {
    constructor() {
        this.button = null;
        this.popup = null;
        this.canvasElement = null;
        this.hoveredNode = null;
        this.masterNode = null;
        this.isPointerOverButton = false;
        this.isPointerOverPopup = false;
        this.boundPointerMove = (event) => this.handlePointerMove(event);
        this.boundPointerLeave = () => this.handleCanvasPointerLeave();
        this.boundPointerDown = () => this.closePopup();
        this.boundResize = () => this.reposition();
        this.boundDocumentPointerMove = (event) => this.handlePointerMove(event);
        this.boundDocumentPointerDown = (event) => this.handleDocumentPointerDown(event);
        this.boundKeyDown = (event) => this.handleKeyDown(event);
    }

    setup() {
        ensureSharedStylesheet();
        this.createDom();
        this.scheduleCanvasInstall();
        window.addEventListener("resize", this.boundResize);
        document.addEventListener("pointermove", this.boundDocumentPointerMove, true);
        document.addEventListener("pointerdown", this.boundDocumentPointerDown, true);
        document.addEventListener("keydown", this.boundKeyDown, true);
    }

    createDom() {
        if (this.button && this.popup) return;

        this.button = document.createElement("button");
        this.button.type = "button";
        this.button.className = "helto-node-layout-button";
        this.button.title = "Layout tools";
        this.button.setAttribute("aria-label", "Layout tools");
        this.button.innerHTML = TOOL_ICON;
        this.button.addEventListener("pointerenter", () => {
            this.isPointerOverButton = true;
        });
        this.button.addEventListener("pointerleave", () => {
            this.isPointerOverButton = false;
            this.maybeHideButtonSoon();
        });
        this.button.addEventListener("click", (event) => {
            stopComfyEvent(event);
            this.openPopup();
        });
        for (const eventName of STOP_EVENTS) {
            this.button.addEventListener(eventName, stopComfyEvent);
        }

        this.popup = document.createElement("div");
        this.popup.className = "helto-node-layout-popup";
        this.popup.setAttribute("role", "toolbar");
        this.popup.setAttribute("aria-label", "Node layout tools");
        this.popup.addEventListener("pointerenter", () => {
            this.isPointerOverPopup = true;
        });
        this.popup.addEventListener("pointerleave", () => {
            this.isPointerOverPopup = false;
        });
        for (const eventName of STOP_EVENTS) {
            this.popup.addEventListener(eventName, stopComfyEvent);
        }

        for (const action of NODE_LAYOUT_ACTIONS) {
            const actionButton = document.createElement("button");
            actionButton.type = "button";
            actionButton.className = "helto-node-layout-action";
            actionButton.title = action.label;
            actionButton.setAttribute("aria-label", action.label);
            actionButton.dataset.actionId = action.id;
            actionButton.innerHTML = action.icon;
            actionButton.addEventListener("click", (event) => {
                stopComfyEvent(event);
                this.applyAction(action.id);
            });
            this.popup.appendChild(actionButton);
        }

        document.body.appendChild(this.button);
        document.body.appendChild(this.popup);
    }

    installCanvasListeners() {
        const element = canvasElement(app.canvas);
        if (!element) return false;
        if (element === this.canvasElement) return true;

        if (this.canvasElement) {
            this.canvasElement.removeEventListener("pointermove", this.boundPointerMove);
            this.canvasElement.removeEventListener("pointerleave", this.boundPointerLeave);
            this.canvasElement.removeEventListener("pointerdown", this.boundPointerDown);
            this.canvasElement.removeEventListener("wheel", this.boundPointerDown);
        }

        this.canvasElement = element;
        this.canvasElement.addEventListener("pointermove", this.boundPointerMove);
        this.canvasElement.addEventListener("pointerleave", this.boundPointerLeave);
        this.canvasElement.addEventListener("pointerdown", this.boundPointerDown);
        this.canvasElement.addEventListener("wheel", this.boundPointerDown, { passive: true });
        return true;
    }

    scheduleCanvasInstall(attempt = 0) {
        if (this.installCanvasListeners()) return;
        if (attempt >= 20) return;
        window.setTimeout(() => this.scheduleCanvasInstall(attempt + 1), 250);
    }

    currentCanvas() {
        this.installCanvasListeners();
        return app.canvas ?? null;
    }

    handlePointerMove(event) {
        if (this.button?.contains(event.target) || this.popup?.contains(event.target)) return;

        const canvas = this.currentCanvas();
        const node = hoveredSelectedNode(event, canvas);
        if (!node) {
            this.hoveredNode = null;
            this.maybeHideButtonSoon();
            return;
        }

        this.hoveredNode = node;
        this.masterNode = this.popup?.classList.contains("visible") ? this.masterNode : node;
        this.showButtonForNode(node, canvas);
    }

    handleCanvasPointerLeave() {
        this.hoveredNode = null;
        this.maybeHideButtonSoon();
    }

    showButtonForNode(node, canvas) {
        if (!this.button) return;

        const point = graphToClientPoint(nodeTitleButtonPoint(node), canvas);
        if (!point) return;

        this.button.style.left = `${point[0]}px`;
        this.button.style.top = `${point[1]}px`;
        this.button.classList.add("visible");
    }

    hideButton() {
        if (this.popup?.classList.contains("visible")) return;
        this.button?.classList.remove("visible");
        this.hoveredNode = null;
        this.masterNode = null;
    }

    maybeHideButtonSoon() {
        window.setTimeout(() => {
            if (this.hoveredNode || this.isPointerOverButton || this.isPointerOverPopup) return;
            this.hideButton();
        }, 80);
    }

    openPopup() {
        const canvas = this.currentCanvas();
        const master = this.hoveredNode ?? this.masterNode;
        if (!master || !canUseLayoutTools(master, canvas) || !this.popup || !this.button) {
            this.closePopup();
            return;
        }

        this.masterNode = master;
        this.popup.classList.add("visible");
        this.button.classList.add("active", "visible");
        this.repositionPopup();
    }

    closePopup() {
        this.popup?.classList.remove("visible");
        this.button?.classList.remove("active");
        if (!this.hoveredNode && !this.isPointerOverButton) {
            this.hideButton();
        }
    }

    applyAction(actionId) {
        const canvas = this.currentCanvas();
        const master = this.masterNode;
        if (!master) return;

        applyLayoutAction(actionId, master, { canvas });
        this.closePopup();
        this.reposition();
    }

    reposition() {
        const canvas = this.currentCanvas();
        const node = this.masterNode ?? this.hoveredNode;
        if (node && canUseLayoutTools(node, canvas)) {
            this.showButtonForNode(node, canvas);
            this.repositionPopup();
        } else {
            this.hideButton();
            this.closePopup();
        }
    }

    repositionPopup() {
        if (!this.popup?.classList.contains("visible") || !this.button) return;

        const buttonRect = this.button.getBoundingClientRect();
        const position = clampPopupPosition(buttonRect.left, buttonRect.bottom + 6, this.popup);
        this.popup.style.left = `${position.left}px`;
        this.popup.style.top = `${position.top}px`;
    }

    handleDocumentPointerDown(event) {
        if (!this.popup?.classList.contains("visible")) return;
        if (this.popup.contains(event.target) || this.button?.contains(event.target)) return;
        this.closePopup();
    }

    handleKeyDown(event) {
        if (event.key === "Escape") {
            this.closePopup();
        }
    }
}

const toolbar = new HeltoNodeLayoutToolbar();

app.registerExtension({
    name: "Comfy.Helto.NodeLayoutToolbar",
    setup() {
        toolbar.setup();
    },
    getNodeMenuItems(node) {
        return menuItemsForMaster(node, { canvas: app.canvas });
    },
});
