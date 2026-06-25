const STYLE_ID = "helto-media-preview-styles";
const OVERLAY_CLASS = "helto-preview-overlay";
const THUMBNAIL_CLASS = "helto-media-preview-thumb-popover";
const DEFAULT_KIND = "image";

let activeThumbnail = null;
let activeThumbnailAnchor = null;
let activeThumbnailCleanup = null;

function mediaKind(kind) {
    return kind === "video" ? "video" : DEFAULT_KIND;
}

function previewLabel(preview, fallback = "Preview") {
    return String(preview?.title || preview?.label || fallback);
}

function stopEvent(event) {
    event.stopPropagation();
}

function maybePlayVideo(video) {
    const playPromise = video.play?.();
    if (playPromise?.catch) {
        playPromise.catch(() => {
            // Browser autoplay policies can block even muted thumbnail videos.
        });
    }
}

function ensureStyles(documentRef = document) {
    if (documentRef.getElementById(STYLE_ID)) return;

    const style = documentRef.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .helto-preview-overlay {
            align-items: center;
            background: rgba(0, 0, 0, 0.85);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            display: flex;
            height: 100vh;
            justify-content: center;
            left: 0;
            opacity: 0;
            pointer-events: none;
            position: fixed;
            top: 0;
            transition: opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            width: 100vw;
            z-index: 100000;
        }
        .helto-preview-overlay.active {
            opacity: 1;
            pointer-events: auto;
        }
        .helto-preview-window {
            align-items: center;
            background: var(--bg-primary, #151c2a);
            border: 1px solid var(--border-subtle, #2a3346);
            border-radius: 12px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
            display: flex;
            flex-direction: column;
            justify-content: center;
            max-height: 90vh;
            max-width: 90vw;
            padding: 8px;
            position: relative;
            transform: scale(0.95);
            transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .helto-preview-overlay.active .helto-preview-window {
            transform: scale(1);
        }
        .helto-preview-media,
        .helto-preview-img,
        .helto-preview-video {
            background: #0d1320;
            border-radius: 8px;
            display: block;
            max-height: 80vh;
            max-width: 85vw;
            object-fit: contain;
        }
        .helto-preview-video {
            min-height: 180px;
        }
        .helto-preview-title {
            color: var(--text-secondary, #aeb7c6);
            font-family: var(--font-sans, Inter, system-ui, sans-serif);
            font-size: 12px;
            margin-top: 8px;
            max-width: 80vw;
            overflow: hidden;
            padding: 2px 8px;
            text-align: center;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .helto-preview-close {
            align-items: center;
            background: var(--bg-secondary, #1b2333);
            border: 1px solid var(--border-subtle, #2a3346);
            border-radius: 50%;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            color: var(--text-primary, #e7ebf3);
            cursor: pointer;
            display: flex;
            font-size: 20px;
            height: 32px;
            justify-content: center;
            line-height: 1;
            position: absolute;
            right: -16px;
            top: -16px;
            transition: background 0.2s, border-color 0.2s, color 0.2s, transform 0.2s;
            width: 32px;
            z-index: 100001;
        }
        .helto-preview-close:hover {
            background: var(--danger, #ec5a6b);
            border-color: var(--danger, #ec5a6b);
            color: #fff;
            transform: scale(1.1);
        }
        .helto-media-preview-thumb-popover {
            background: var(--bg-primary, #151c2a);
            border: 1px solid var(--border-subtle, #2a3346);
            border-radius: 8px;
            box-shadow: 0 14px 34px rgba(0, 0, 0, 0.46);
            max-width: 240px;
            opacity: 0;
            padding: 6px;
            pointer-events: none;
            position: fixed;
            transform: translateY(3px);
            transition: opacity 0.12s ease, transform 0.12s ease;
            width: min(240px, calc(100vw - 24px));
            z-index: 100002;
        }
        .helto-media-preview-thumb-popover.active {
            opacity: 1;
            transform: translateY(0);
        }
        .helto-media-preview-thumb-media {
            aspect-ratio: 16 / 10;
            background: #0d1320;
            border-radius: 6px;
            display: block;
            max-height: 160px;
            object-fit: contain;
            width: 100%;
        }
        .helto-media-preview-thumb-title {
            color: var(--text-secondary, #aeb7c6);
            font-family: var(--font-sans, Inter, system-ui, sans-serif);
            font-size: 11px;
            margin-top: 5px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
    `;
    documentRef.head.appendChild(style);
}

function removeElementAfterFade(element) {
    element.classList.remove("active");
    setTimeout(() => {
        if (element.parentNode) {
            element.remove();
        }
    }, 250);
}

function createMediaElement(documentRef, preview, { thumbnail = false } = {}) {
    const kind = mediaKind(preview?.kind);
    const label = previewLabel(preview, kind === "video" ? "Video preview" : "Image preview");

    if (kind === "video") {
        const video = documentRef.createElement("video");
        video.className = thumbnail ? "helto-media-preview-thumb-media" : "helto-preview-media helto-preview-video";
        video.src = preview.url;
        video.muted = true;
        video.playsInline = true;
        video.preload = thumbnail ? "metadata" : "auto";
        video.autoplay = true;
        if (thumbnail) {
            video.loop = true;
        } else {
            video.controls = true;
        }
        video.addEventListener("loadedmetadata", () => maybePlayVideo(video), { once: true });
        return video;
    }

    const img = documentRef.createElement("img");
    img.className = thumbnail ? "helto-media-preview-thumb-media" : "helto-preview-media helto-preview-img";
    img.src = preview.url;
    img.alt = label;
    return img;
}

export function closeHeltoMediaPreview(documentRef = document) {
    documentRef.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((overlay) => {
        if (typeof overlay.__heltoMediaPreviewDismiss === "function") {
            overlay.__heltoMediaPreviewDismiss();
        } else {
            removeElementAfterFade(overlay);
        }
    });
}

export function openHeltoMediaPreview(preview, options = {}) {
    const documentRef = options.document || document;
    if (!preview?.url) return null;

    ensureStyles(documentRef);
    closeHeltoMediaPreview(documentRef);

    const overlay = documentRef.createElement("div");
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Media preview");
    overlay.addEventListener("pointerdown", stopEvent);
    overlay.addEventListener("click", (event) => {
        event.stopPropagation();
        if (event.target === overlay) {
            dismiss();
        }
    });

    const windowEl = documentRef.createElement("div");
    windowEl.className = "helto-preview-window";
    windowEl.addEventListener("pointerdown", stopEvent);
    windowEl.addEventListener("click", stopEvent);

    const closeBtn = documentRef.createElement("button");
    closeBtn.className = "helto-preview-close";
    closeBtn.type = "button";
    closeBtn.title = "Close preview";
    closeBtn.setAttribute("aria-label", "Close preview");
    closeBtn.textContent = "\u00d7";

    const titleEl = documentRef.createElement("div");
    titleEl.className = "helto-preview-title";
    titleEl.title = previewLabel(preview);
    titleEl.textContent = previewLabel(preview);

    const media = createMediaElement(documentRef, preview);
    media.addEventListener("error", () => {
        titleEl.textContent = "Preview unavailable.";
    });

    windowEl.appendChild(closeBtn);
    windowEl.appendChild(media);
    windowEl.appendChild(titleEl);
    overlay.appendChild(windowEl);
    documentRef.body.appendChild(overlay);

    const keyHandler = (event) => {
        if (event.key === "Escape") {
            dismiss();
        }
    };

    function dismiss() {
        documentRef.removeEventListener("keydown", keyHandler, true);
        overlay.__heltoMediaPreviewDismiss = null;
        removeElementAfterFade(overlay);
    }
    overlay.__heltoMediaPreviewDismiss = dismiss;

    closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        dismiss();
    });
    documentRef.addEventListener("keydown", keyHandler, true);

    requestAnimationFrame(() => {
        overlay.classList.add("active");
        if (media.tagName === "VIDEO") {
            maybePlayVideo(media);
        }
    });

    return overlay;
}

function positionThumbnail(anchor, popover, options = {}) {
    const view = options.window || anchor.ownerDocument?.defaultView || window;
    const viewportPadding = options.viewportPadding ?? 12;
    const gap = options.gap ?? 8;
    const anchorRect = anchor.getBoundingClientRect();
    const rect = popover.getBoundingClientRect();
    let left = anchorRect.right - rect.width;
    let top = anchorRect.top - rect.height - gap;

    left = Math.max(viewportPadding, Math.min(left, view.innerWidth - rect.width - viewportPadding));
    if (top < viewportPadding) {
        top = anchorRect.bottom + gap;
    }
    top = Math.max(viewportPadding, Math.min(top, view.innerHeight - rect.height - viewportPadding));

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
}

export function hideHeltoMediaPreviewThumbnail() {
    if (activeThumbnailCleanup) {
        activeThumbnailCleanup();
        activeThumbnailCleanup = null;
    }
    if (activeThumbnail) {
        activeThumbnail.remove();
        activeThumbnail = null;
    }
    activeThumbnailAnchor = null;
}

export function showHeltoMediaPreviewThumbnail(anchor, preview, options = {}) {
    const documentRef = options.document || document;
    if (!anchor || !preview?.url) return null;

    ensureStyles(documentRef);
    hideHeltoMediaPreviewThumbnail();

    const popover = documentRef.createElement("div");
    popover.className = THUMBNAIL_CLASS;
    popover.setAttribute("role", "tooltip");

    const title = documentRef.createElement("div");
    title.className = "helto-media-preview-thumb-title";
    title.title = previewLabel(preview);
    title.textContent = previewLabel(preview);

    const media = createMediaElement(documentRef, preview, { thumbnail: true });
    media.addEventListener("error", () => {
        title.textContent = "Preview unavailable.";
    });

    popover.appendChild(media);
    popover.appendChild(title);
    documentRef.body.appendChild(popover);

    const view = documentRef.defaultView || window;
    const reposition = () => positionThumbnail(anchor, popover, { ...options, window: view });
    const removeOnScroll = () => hideHeltoMediaPreviewThumbnail();
    view.addEventListener("resize", reposition, { passive: true });
    view.addEventListener("scroll", removeOnScroll, { passive: true, capture: true });
    activeThumbnailCleanup = () => {
        view.removeEventListener("resize", reposition);
        view.removeEventListener("scroll", removeOnScroll, true);
    };
    activeThumbnail = popover;
    activeThumbnailAnchor = anchor;

    requestAnimationFrame(() => {
        if (activeThumbnail === popover && activeThumbnailAnchor === anchor) {
            reposition();
            popover.classList.add("active");
            if (media.tagName === "VIDEO") {
                maybePlayVideo(media);
            }
        }
    });

    return popover;
}

export function attachHeltoMediaPreviewHover(anchor, preview, options = {}) {
    if (!anchor) return () => {};
    const resolvePreview = typeof preview === "function" ? preview : () => preview;
    const show = () => showHeltoMediaPreviewThumbnail(anchor, resolvePreview(), options);
    const hide = () => hideHeltoMediaPreviewThumbnail();

    anchor.addEventListener("mouseenter", show);
    anchor.addEventListener("focus", show);
    anchor.addEventListener("mouseleave", hide);
    anchor.addEventListener("blur", hide);

    return () => {
        anchor.removeEventListener("mouseenter", show);
        anchor.removeEventListener("focus", show);
        anchor.removeEventListener("mouseleave", hide);
        anchor.removeEventListener("blur", hide);
        if (activeThumbnailAnchor === anchor) {
            hideHeltoMediaPreviewThumbnail();
        }
    };
}
