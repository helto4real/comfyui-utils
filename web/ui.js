import { ICONS, STOP_EVENTS } from "./constants.js";

let modalId = 0;

export function setWidgetHeight(widget, h) {
    if (widget.height === h) return;
    try {
        widget.height = h;
    } catch (err) {
        Object.defineProperty(widget, "height", {
            value: h,
            writable: true,
            configurable: true
        });
    }
}

export function collapseHiddenWidgetLayout(widget) {
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
}

export function applySelectorElementInset(element) {
    if (!element) return;
    element.style.boxSizing = "border-box";
    element.style.margin = "0";
    element.style.width = "100%";
    element.style.height = "100%";
}

export function containPointerEvents(element) {
    for (const eventName of STOP_EVENTS) {
        element.addEventListener(eventName, (e) => e.stopPropagation());
    }
}

export function createModal(titleText, contentHTML, onSave = null, options = {}) {
    const previousFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "helto-modal-overlay";

    const card = document.createElement("div");
    card.className = `helto-modal-card ${options.cardClass || ""}`.trim();
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");

    const header = document.createElement("div");
    header.className = "helto-modal-header";

    const title = document.createElement("span");
    title.className = "helto-modal-title";
    title.innerText = titleText;
    title.id = `helto-modal-title-${++modalId}`;
    card.setAttribute("aria-labelledby", title.id);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "helto-modal-close-btn";
    closeBtn.setAttribute("aria-label", "Close dialog");
    closeBtn.innerHTML = ICONS.clear;

    header.appendChild(title);
    header.appendChild(closeBtn);
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = `helto-modal-body ${options.bodyClass || ""}`.trim();
    body.innerHTML = contentHTML;
    card.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "helto-modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "helto-modal-btn btn-secondary";
    cancelBtn.innerText = options.cancelText || "Cancel";

    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = `helto-modal-btn ${options.actionClass || "btn-primary"}`;
    actionBtn.innerText = options.actionText || (onSave ? "Save" : "Close");

    footer.appendChild(cancelBtn);
    footer.appendChild(actionBtn);
    card.appendChild(footer);
    overlay.appendChild(card);
    containPointerEvents(overlay);
    document.body.appendChild(overlay);

    let destroyed = false;
    const focusableElements = () => [...card.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");

    const onKeyDown = (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            destroy();
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = focusableElements();
        if (!focusable.length) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        overlay.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        if (previousFocus?.focus && document.contains(previousFocus)) {
            previousFocus.focus();
        }
    };

    overlay.addEventListener("keydown", onKeyDown);

    closeBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        destroy();
    };
    cancelBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        destroy();
    };

    actionBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onSave) {
            actionBtn.disabled = true;
            try {
                const shouldClose = await onSave(body);
                if (shouldClose !== false) destroy();
            } catch (err) {
                console.error("Modal save failed:", err);
                alert(err.message || "Save failed.");
            } finally {
                if (document.body.contains(overlay)) {
                    actionBtn.disabled = false;
                }
            }
        } else {
            destroy();
        }
    };

    overlay.onclick = (e) => {
        e.stopPropagation();
        if (e.target === overlay) destroy();
    };

    queueMicrotask(() => {
        if (destroyed) return;
        const preferred = body.querySelector(
            'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
        );
        (preferred || actionBtn || closeBtn).focus?.();
    });

    return {
        overlay,
        card,
        body,
        footer,
        cancelBtn,
        actionBtn,
        destroy,
    };
}
