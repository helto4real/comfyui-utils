function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
        img.src = url;
    });
}

function canvasToDataUrl(canvas) {
    return canvas.toDataURL("image/png");
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export const MAX_PREVIEW_EDGE = 2048;
export const AFFECTED_MASK_VALUE = 255;
export const UNAFFECTED_MASK_VALUE = 0;

export function parsePreviewColor(value) {
    if (typeof value !== "string") return [0, 0, 0];
    const normalized = value.trim();
    const shortMatch = normalized.match(/^#([0-9a-fA-F]{3})$/);
    if (shortMatch) {
        return shortMatch[1].split("").map((channel) => parseInt(`${channel}${channel}`, 16));
    }
    const longMatch = normalized.match(/^#([0-9a-fA-F]{6})$/);
    if (!longMatch) return [0, 0, 0];
    return [
        parseInt(longMatch[1].slice(0, 2), 16),
        parseInt(longMatch[1].slice(2, 4), 16),
        parseInt(longMatch[1].slice(4, 6), 16),
    ];
}

export function maskOverlayPixel(maskValue, previewColor = "#000000", opacityPercent = 60) {
    const [r, g, b] = parsePreviewColor(previewColor);
    const value = clamp(Number(maskValue) || 0, 0, 255);
    const opacity = clamp(Number(opacityPercent) || 0, 0, 100) / 100;
    const maskStrength = value / 255;
    return [r, g, b, Math.round(255 * opacity * maskStrength)];
}

export function maskImageDataIsUnaffected(imageData, unaffectedValue = UNAFFECTED_MASK_VALUE) {
    if (!imageData?.data) return true;
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== unaffectedValue || data[i + 1] !== unaffectedValue || data[i + 2] !== unaffectedValue) {
            return false;
        }
    }
    return true;
}

export function previewScaleForSize(width, height, maxEdge = MAX_PREVIEW_EDGE) {
    const maxDimension = Math.max(Number(width) || 0, Number(height) || 0);
    if (maxDimension <= 0 || maxEdge <= 0) return 1;
    return Math.min(1, maxEdge / maxDimension);
}

export function previewPointToMaskPoint(point, previewScale) {
    const scale = previewScale > 0 ? previewScale : 1;
    return {
        x: point.x / scale,
        y: point.y / scale,
    };
}

export function createOverlayScheduler(requestAnimationFrameImpl, render) {
    let pending = false;
    return function scheduleOverlayRender() {
        if (pending) return;
        pending = true;
        requestAnimationFrameImpl(() => {
            pending = false;
            render();
        });
    };
}

function pointerPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
    };
}

function drawBrush(ctx, point, size, value) {
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = `rgb(${value}, ${value}, ${value})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawAlphaBrush(ctx, point, size, value) {
    ctx.save();
    ctx.globalCompositeOperation = value === AFFECTED_MASK_VALUE ? "source-over" : "destination-out";
    ctx.fillStyle = "rgba(255, 255, 255, 1)";
    ctx.beginPath();
    ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawBrushTrail(ctx, point, lastPoint, size, value, brushFn = drawBrush) {
    brushFn(ctx, point, size, value);
    if (!lastPoint) return;

    const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, size / 4)));
    for (let i = 1; i < steps; i++) {
        brushFn(ctx, {
            x: lastPoint.x + ((point.x - lastPoint.x) * i) / steps,
            y: lastPoint.y + ((point.y - lastPoint.y) * i) / steps,
        }, size, value);
    }
}

function renderMaskOverlay(previewMaskCanvas, overlayCanvas, previewColor = "#000000", opacityPercent = 60) {
    const overlayCtx = overlayCanvas.getContext("2d");
    const [r, g, b] = parsePreviewColor(previewColor);
    const opacity = clamp(Number(opacityPercent) || 0, 0, 100) / 100;

    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (opacity <= 0) return;

    overlayCtx.save();
    overlayCtx.globalCompositeOperation = "source-over";
    overlayCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
    overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.globalCompositeOperation = "destination-in";
    overlayCtx.drawImage(previewMaskCanvas, 0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.restore();
}

function syncPreviewMaskFromMask(maskCanvas, previewMaskCanvas) {
    const previewCtx = previewMaskCanvas.getContext("2d");
    previewCtx.clearRect(0, 0, previewMaskCanvas.width, previewMaskCanvas.height);
    previewCtx.drawImage(maskCanvas, 0, 0, previewMaskCanvas.width, previewMaskCanvas.height);

    const data = previewCtx.getImageData(0, 0, previewMaskCanvas.width, previewMaskCanvas.height);
    for (let i = 0; i < data.data.length; i += 4) {
        const value = data.data[i];
        data.data[i] = 255;
        data.data[i + 1] = 255;
        data.data[i + 2] = 255;
        data.data[i + 3] = value;
    }
    previewCtx.putImageData(data, 0, 0);
}

function setPreviewMaskValue(previewMaskCanvas, value) {
    const ctx = previewMaskCanvas.getContext("2d");
    if (value === AFFECTED_MASK_VALUE) {
        ctx.fillStyle = "rgba(255, 255, 255, 1)";
        ctx.fillRect(0, 0, previewMaskCanvas.width, previewMaskCanvas.height);
    } else {
        ctx.clearRect(0, 0, previewMaskCanvas.width, previewMaskCanvas.height);
    }
}

function invertPreviewMask(previewMaskCanvas) {
    const ctx = previewMaskCanvas.getContext("2d");
    const tempCanvas = previewMaskCanvas.ownerDocument.createElement("canvas");
    tempCanvas.width = previewMaskCanvas.width;
    tempCanvas.height = previewMaskCanvas.height;
    const tempCtx = tempCanvas.getContext("2d");

    tempCtx.fillStyle = "rgba(255, 255, 255, 1)";
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    tempCtx.globalCompositeOperation = "destination-out";
    tempCtx.drawImage(previewMaskCanvas, 0, 0);

    ctx.clearRect(0, 0, previewMaskCanvas.width, previewMaskCanvas.height);
    ctx.drawImage(tempCanvas, 0, 0);
}

function invertMask(maskCanvas) {
    const ctx = maskCanvas.getContext("2d");
    const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    for (let i = 0; i < data.data.length; i += 4) {
        const value = 255 - data.data[i];
        data.data[i] = value;
        data.data[i + 1] = value;
        data.data[i + 2] = value;
        data.data[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
}

function setMaskValue(maskCanvas, value) {
    const ctx = maskCanvas.getContext("2d");
    ctx.fillStyle = `rgb(${value}, ${value}, ${value})`;
    ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
}

function maskCanvasIsUnaffected(maskCanvas) {
    const ctx = maskCanvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    return maskImageDataIsUnaffected(imageData);
}

function createButton(document, label, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `helto-mask-editor-btn ${className}`.trim();
    button.innerText = label;
    return button;
}

export async function openMaskEditor({
    document,
    window,
    img,
    imageUrl,
    maskUrl,
    privacyMode,
    hideMode,
    hasEditedMask = false,
    containPointerEvents,
    saveMask,
    deleteMask,
    onSaved,
}) {
    document.querySelectorAll(".helto-mask-editor-overlay").forEach((overlay) => overlay.remove());

    const [image, maskImage] = await Promise.all([loadImage(imageUrl), loadImage(maskUrl)]);

    const overlay = document.createElement("div");
    overlay.className = "helto-mask-editor-overlay";
    containPointerEvents?.(overlay);

    const windowEl = document.createElement("div");
    windowEl.className = "helto-mask-editor-window";

    const header = document.createElement("div");
    header.className = "helto-mask-editor-header";

    const title = document.createElement("div");
    title.className = "helto-mask-editor-title";
    title.innerText = `Edit mask - ${img.name}`;
    title.title = img.path;

    const controls = document.createElement("div");
    controls.className = "helto-mask-editor-controls";

    const paintBtn = createButton(document, "Paint", "active");
    const eraseBtn = createButton(document, "Erase");
    const invertBtn = createButton(document, "Invert");
    const clearBtn = createButton(document, "Clear");
    const fillBtn = createButton(document, "Fill");
    const saveBtn = createButton(document, "Save", "primary");
    const cancelBtn = createButton(document, "Cancel");

    const sizeInput = document.createElement("input");
    sizeInput.type = "range";
    sizeInput.min = "2";
    sizeInput.max = "160";
    sizeInput.value = "32";
    sizeInput.className = "helto-mask-editor-size";
    sizeInput.title = "Brush size";
    sizeInput.setAttribute("aria-label", "Brush size");

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = "#000000";
    colorInput.className = "helto-mask-editor-color";
    colorInput.title = "Overlay color";
    colorInput.setAttribute("aria-label", "Overlay color");

    const opacityInput = document.createElement("input");
    opacityInput.type = "range";
    opacityInput.min = "0";
    opacityInput.max = "100";
    opacityInput.value = "60";
    opacityInput.className = "helto-mask-editor-opacity";
    opacityInput.title = "Overlay opacity";
    opacityInput.setAttribute("aria-label", "Overlay opacity");

    controls.append(paintBtn, eraseBtn, sizeInput, colorInput, opacityInput, invertBtn, clearBtn, fillBtn, saveBtn, cancelBtn);
    header.append(title, controls);

    const stage = document.createElement("div");
    stage.className = "helto-mask-editor-stage";

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "helto-mask-editor-canvas-wrap";

    const imageCanvas = document.createElement("canvas");
    const overlayCanvas = document.createElement("canvas");
    const maskCanvas = document.createElement("canvas");
    const previewMaskCanvas = document.createElement("canvas");
    const brushCursor = document.createElement("div");
    imageCanvas.className = "helto-mask-editor-canvas";
    overlayCanvas.className = "helto-mask-editor-canvas mask";
    maskCanvas.className = "helto-mask-editor-hidden-canvas";
    previewMaskCanvas.className = "helto-mask-editor-hidden-canvas";
    brushCursor.className = "helto-mask-editor-brush-cursor";

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const previewScale = previewScaleForSize(width, height);
    const previewWidth = Math.max(1, Math.round(width * previewScale));
    const previewHeight = Math.max(1, Math.round(height * previewScale));
    for (const canvas of [imageCanvas, overlayCanvas, previewMaskCanvas]) {
        canvas.width = previewWidth;
        canvas.height = previewHeight;
    }
    maskCanvas.width = width;
    maskCanvas.height = height;

    const imageCtx = imageCanvas.getContext("2d");
    const maskCtx = maskCanvas.getContext("2d");
    const previewMaskCtx = previewMaskCanvas.getContext("2d");
    imageCtx.drawImage(image, 0, 0, previewWidth, previewHeight);
    maskCtx.fillStyle = `rgb(${UNAFFECTED_MASK_VALUE}, ${UNAFFECTED_MASK_VALUE}, ${UNAFFECTED_MASK_VALUE})`;
    maskCtx.fillRect(0, 0, width, height);
    if (hasEditedMask) {
        maskCtx.drawImage(maskImage, 0, 0, width, height);
        syncPreviewMaskFromMask(maskCanvas, previewMaskCanvas);
    } else {
        previewMaskCtx.clearRect(0, 0, previewWidth, previewHeight);
    }

    canvasWrap.append(imageCanvas, overlayCanvas, brushCursor, maskCanvas, previewMaskCanvas);
    stage.appendChild(canvasWrap);
    windowEl.append(header, stage);
    overlay.appendChild(windowEl);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add("active"));

    function renderOverlayNow() {
        renderMaskOverlay(previewMaskCanvas, overlayCanvas, colorInput.value, opacityInput.value);
    }

    const scheduleOverlayRender = createOverlayScheduler(
        window.requestAnimationFrame?.bind(window) || ((callback) => window.setTimeout(callback, 16)),
        renderOverlayNow,
    );
    renderOverlayNow();

    let brushValue = AFFECTED_MASK_VALUE;
    let drawing = false;
    let lastMaskPoint = null;
    let lastPreviewPoint = null;
    let lastCursorEvent = null;

    function setMode(value) {
        brushValue = value;
        paintBtn.classList.toggle("active", value === AFFECTED_MASK_VALUE);
        eraseBtn.classList.toggle("active", value === UNAFFECTED_MASK_VALUE);
    }

    function refreshOverlay() {
        scheduleOverlayRender();
    }

    function updateBrushCursor(event) {
        lastCursorEvent = event;
        const canvasRect = overlayCanvas.getBoundingClientRect();
        const wrapRect = canvasWrap.getBoundingClientRect();
        const brushSize = clamp(Number(sizeInput.value) || 32, 2, 160);
        const previewBrushSize = brushSize * previewScale;
        const displayScale = canvasRect.width / overlayCanvas.width;
        const displaySize = Math.max(2, previewBrushSize * displayScale);
        brushCursor.style.display = "block";
        brushCursor.style.width = `${displaySize}px`;
        brushCursor.style.height = `${displaySize}px`;
        brushCursor.style.left = `${event.clientX - wrapRect.left}px`;
        brushCursor.style.top = `${event.clientY - wrapRect.top}px`;
        brushCursor.style.borderColor = colorInput.value;
    }

    function refreshBrushCursor() {
        if (lastCursorEvent) {
            updateBrushCursor(lastCursorEvent);
        }
    }

    function drawAt(event) {
        updateBrushCursor(event);
        const previewPoint = pointerPoint(event, overlayCanvas);
        const maskPoint = previewPointToMaskPoint(previewPoint, previewScale);
        const size = clamp(Number(sizeInput.value) || 32, 2, 160);
        drawBrushTrail(maskCtx, maskPoint, lastMaskPoint, size, brushValue);
        drawBrushTrail(previewMaskCtx, previewPoint, lastPreviewPoint, size * previewScale, brushValue, drawAlphaBrush);
        lastMaskPoint = maskPoint;
        lastPreviewPoint = previewPoint;
        refreshOverlay();
    }

    overlayCanvas.addEventListener("pointerenter", (event) => {
        updateBrushCursor(event);
    });
    overlayCanvas.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        drawing = true;
        lastMaskPoint = null;
        lastPreviewPoint = null;
        overlayCanvas.setPointerCapture?.(event.pointerId);
        drawAt(event);
    });
    overlayCanvas.addEventListener("pointermove", (event) => {
        updateBrushCursor(event);
        if (!drawing) return;
        event.preventDefault();
        drawAt(event);
    });
    overlayCanvas.addEventListener("pointerup", (event) => {
        drawing = false;
        lastMaskPoint = null;
        lastPreviewPoint = null;
        overlayCanvas.releasePointerCapture?.(event.pointerId);
    });
    overlayCanvas.addEventListener("pointercancel", (event) => {
        drawing = false;
        lastMaskPoint = null;
        lastPreviewPoint = null;
        overlayCanvas.releasePointerCapture?.(event.pointerId);
    });
    overlayCanvas.addEventListener("pointerleave", () => {
        drawing = false;
        lastMaskPoint = null;
        lastPreviewPoint = null;
        lastCursorEvent = null;
        brushCursor.style.display = "none";
    });

    paintBtn.onclick = (event) => {
        event.stopPropagation();
        setMode(AFFECTED_MASK_VALUE);
    };
    eraseBtn.onclick = (event) => {
        event.stopPropagation();
        setMode(UNAFFECTED_MASK_VALUE);
    };
    sizeInput.oninput = (event) => {
        event.stopPropagation();
        refreshBrushCursor();
    };
    colorInput.oninput = (event) => {
        event.stopPropagation();
        refreshOverlay();
        refreshBrushCursor();
    };
    opacityInput.oninput = (event) => {
        event.stopPropagation();
        refreshOverlay();
    };
    invertBtn.onclick = (event) => {
        event.stopPropagation();
        invertMask(maskCanvas);
        invertPreviewMask(previewMaskCanvas);
        refreshOverlay();
    };
    clearBtn.onclick = (event) => {
        event.stopPropagation();
        setMaskValue(maskCanvas, UNAFFECTED_MASK_VALUE);
        setPreviewMaskValue(previewMaskCanvas, UNAFFECTED_MASK_VALUE);
        refreshOverlay();
    };
    fillBtn.onclick = (event) => {
        event.stopPropagation();
        setMaskValue(maskCanvas, AFFECTED_MASK_VALUE);
        setPreviewMaskValue(previewMaskCanvas, AFFECTED_MASK_VALUE);
        refreshOverlay();
    };

    function closeEditor() {
        overlay.classList.remove("active");
        window.setTimeout(() => overlay.remove(), 180);
    }

    cancelBtn.onclick = (event) => {
        event.stopPropagation();
        closeEditor();
    };

    saveBtn.onclick = async (event) => {
        event.stopPropagation();
        saveBtn.disabled = true;
        saveBtn.innerText = "Saving";
        try {
            const result = maskCanvasIsUnaffected(maskCanvas) && deleteMask
                ? await deleteMask(img.path)
                : await saveMask(img.path, canvasToDataUrl(maskCanvas), privacyMode);
            await onSaved?.(img, result.ref ?? null, result);
            closeEditor();
        } catch (error) {
            console.error("Mask save failed:", error);
            window.alert?.(error.message || "Failed to save edited mask.");
            saveBtn.disabled = false;
            saveBtn.innerText = "Save";
        }
    };

    overlay.onclick = (event) => {
        if (event.target === overlay) {
            closeEditor();
        }
    };

    if (hideMode) {
        windowEl.classList.add("hide-mode");
        windowEl.classList.add("hide-content");
        windowEl.addEventListener("mouseenter", () => windowEl.classList.remove("hide-content"));
        windowEl.addEventListener("mouseleave", () => windowEl.classList.add("hide-content"));
    }
}
