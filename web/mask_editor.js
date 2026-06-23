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
export const ZOOM_MODE_FIT = "fit";
export const ZOOM_MODE_ACTUAL = "actual";

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

export function displayPointToPreviewPoint(point, canvasSize, displaySize) {
    const displayWidth = Number(displaySize.width) || Number(canvasSize.width) || 1;
    const displayHeight = Number(displaySize.height) || Number(canvasSize.height) || 1;
    return {
        x: point.x * ((Number(canvasSize.width) || 1) / displayWidth),
        y: point.y * ((Number(canvasSize.height) || 1) / displayHeight),
    };
}

export function displayBrushSizeToPreviewSize(brushSize, canvasSize, displaySize) {
    const displayWidth = Number(displaySize.width) || Number(canvasSize.width) || 1;
    const canvasWidth = Number(canvasSize.width) || 1;
    return Math.max(1, Number(brushSize) || 1) * (canvasWidth / displayWidth);
}

export function displayBrushSizeToMaskSize(brushSize, canvasSize, displaySize, previewScale) {
    const scale = previewScale > 0 ? previewScale : 1;
    return displayBrushSizeToPreviewSize(brushSize, canvasSize, displaySize) / scale;
}

export function fitDisplaySize(contentWidth, contentHeight, stageWidth, stageHeight) {
    const width = Math.max(1, Number(contentWidth) || 1);
    const height = Math.max(1, Number(contentHeight) || 1);
    const availableWidth = Math.max(1, Number(stageWidth) || width);
    const availableHeight = Math.max(1, Number(stageHeight) || height);
    const scale = Math.min(availableWidth / width, availableHeight / height);
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        scale,
    };
}

export function displaySizeForZoomMode(mode, dimensions) {
    if (mode === ZOOM_MODE_ACTUAL) {
        return {
            width: Math.max(1, Math.round(Number(dimensions.imageWidth) || 1)),
            height: Math.max(1, Math.round(Number(dimensions.imageHeight) || 1)),
            scale: 1,
        };
    }
    return fitDisplaySize(
        dimensions.previewWidth,
        dimensions.previewHeight,
        dimensions.stageWidth,
        dimensions.stageHeight,
    );
}

export function nextZoomMode(mode) {
    return mode === ZOOM_MODE_FIT ? ZOOM_MODE_ACTUAL : ZOOM_MODE_FIT;
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
    return displayPointToPreviewPoint(
        {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        },
        {
            width: canvas.width,
            height: canvas.height,
        },
        {
            width: rect.width,
            height: rect.height,
        },
    );
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

export function normalizeBbox(box, width, height) {
    if (!box || !Number.isFinite(Number(box.x)) || !Number.isFinite(Number(box.y))) return null;
    if (!Number.isFinite(Number(box.width)) || !Number.isFinite(Number(box.height))) return null;

    const x1 = clamp(Number(box.x), 0, width);
    const y1 = clamp(Number(box.y), 0, height);
    const x2 = clamp(Number(box.x) + Number(box.width), 0, width);
    const y2 = clamp(Number(box.y) + Number(box.height), 0, height);
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const right = Math.max(x1, x2);
    const bottom = Math.max(y1, y2);
    if (right <= left || bottom <= top) return null;
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
}

export function bboxFromPoints(startPoint, endPoint, width, height) {
    return normalizeBbox({
        x: startPoint.x,
        y: startPoint.y,
        width: endPoint.x - startPoint.x,
        height: endPoint.y - startPoint.y,
    }, width, height);
}

function pointInBbox(point, box) {
    return (
        point.x >= box.x &&
        point.y >= box.y &&
        point.x <= box.x + box.width &&
        point.y <= box.y + box.height
    );
}

function drawBbox(ctx, box, previewScale, selected = false, index = null) {
    const x = box.x * previewScale;
    const y = box.y * previewScale;
    const width = box.width * previewScale;
    const height = box.height * previewScale;

    ctx.save();
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeStyle = selected ? "#ffffff" : "#54d6ff";
    ctx.fillStyle = selected ? "rgba(84, 214, 255, 0.22)" : "rgba(84, 214, 255, 0.12)";
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);

    if (index !== null) {
        ctx.font = "12px sans-serif";
        ctx.textBaseline = "top";
        const label = String(index + 1);
        const metrics = ctx.measureText(label);
        const labelWidth = metrics.width + 8;
        ctx.fillStyle = selected ? "rgba(255, 255, 255, 0.92)" : "rgba(84, 214, 255, 0.92)";
        ctx.fillRect(x, y, labelWidth, 18);
        ctx.fillStyle = "#071018";
        ctx.fillText(label, x + 4, y + 3);
    }
    ctx.restore();
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
    const zoomBtn = createButton(document, "Actual size");
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

    controls.append(paintBtn, eraseBtn, sizeInput, colorInput, opacityInput, zoomBtn, invertBtn, clearBtn, fillBtn, saveBtn, cancelBtn);
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

    let zoomMode = ZOOM_MODE_FIT;
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

    function applyZoomMode() {
        const size = displaySizeForZoomMode(zoomMode, {
            imageWidth: width,
            imageHeight: height,
            previewWidth,
            previewHeight,
            stageWidth: stage.clientWidth,
            stageHeight: stage.clientHeight,
        });

        canvasWrap.style.width = `${size.width}px`;
        canvasWrap.style.height = `${size.height}px`;
        stage.classList.toggle("actual-size", zoomMode === ZOOM_MODE_ACTUAL);
        zoomBtn.innerText = zoomMode === ZOOM_MODE_FIT ? "Actual size" : "Zoom to fit";
        zoomBtn.title = zoomMode === ZOOM_MODE_FIT ? "Show actual size" : "Zoom to fit";
        refreshBrushCursor();
    }

    function scheduleZoomLayout() {
        (window.requestAnimationFrame?.bind(window) || ((callback) => window.setTimeout(callback, 16)))(applyZoomMode);
    }

    function brushDisplaySize() {
        return clamp(Number(sizeInput.value) || 32, 2, 160);
    }

    function overlayCanvasSize() {
        return {
            width: overlayCanvas.width,
            height: overlayCanvas.height,
        };
    }

    function overlayDisplaySize() {
        const rect = overlayCanvas.getBoundingClientRect();
        return {
            width: rect.width,
            height: rect.height,
        };
    }

    function updateBrushCursor(event) {
        lastCursorEvent = event;
        const wrapRect = canvasWrap.getBoundingClientRect();
        const displaySize = brushDisplaySize();
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
        const displaySize = brushDisplaySize();
        const canvasSize = overlayCanvasSize();
        const visibleSize = overlayDisplaySize();
        const previewBrushSize = displayBrushSizeToPreviewSize(displaySize, canvasSize, visibleSize);
        const maskBrushSize = displayBrushSizeToMaskSize(displaySize, canvasSize, visibleSize, previewScale);
        drawBrushTrail(maskCtx, maskPoint, lastMaskPoint, maskBrushSize, brushValue);
        drawBrushTrail(previewMaskCtx, previewPoint, lastPreviewPoint, previewBrushSize, brushValue, drawAlphaBrush);
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
    zoomBtn.onclick = (event) => {
        event.stopPropagation();
        zoomMode = nextZoomMode(zoomMode);
        applyZoomMode();
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
        resizeObserver?.disconnect();
        window.removeEventListener?.("resize", handleWindowResize);
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

    const resizeObserver = typeof window.ResizeObserver === "function"
        ? new window.ResizeObserver(() => {
            if (zoomMode === ZOOM_MODE_FIT) {
                applyZoomMode();
            }
        })
        : null;
    const handleWindowResize = () => {
        if (zoomMode === ZOOM_MODE_FIT) {
            scheduleZoomLayout();
        }
    };
    resizeObserver?.observe(stage);
    window.addEventListener?.("resize", handleWindowResize);
    scheduleZoomLayout();

    if (hideMode) {
        windowEl.classList.add("hide-mode");
        windowEl.classList.add("hide-content");
        windowEl.addEventListener("mouseenter", () => windowEl.classList.remove("hide-content"));
        windowEl.addEventListener("mouseleave", () => windowEl.classList.add("hide-content"));
    }
}

export async function openBboxEditor({
    document,
    window,
    img,
    imageUrl,
    bboxes = [],
    hideMode,
    containPointerEvents,
    onSaved,
}) {
    document.querySelectorAll(".helto-mask-editor-overlay").forEach((overlay) => overlay.remove());

    const image = await loadImage(imageUrl);

    const overlay = document.createElement("div");
    overlay.className = "helto-mask-editor-overlay";
    containPointerEvents?.(overlay);

    const windowEl = document.createElement("div");
    windowEl.className = "helto-mask-editor-window";

    const header = document.createElement("div");
    header.className = "helto-mask-editor-header";

    const title = document.createElement("div");
    title.className = "helto-mask-editor-title";
    title.innerText = `Edit bboxes - ${img.name}`;
    title.title = img.path;

    const controls = document.createElement("div");
    controls.className = "helto-mask-editor-controls";

    const zoomBtn = createButton(document, "Actual size");
    const deleteBtn = createButton(document, "Delete box");
    const clearBtn = createButton(document, "Clear");
    const saveBtn = createButton(document, "Save", "primary");
    const cancelBtn = createButton(document, "Cancel");
    controls.append(zoomBtn, deleteBtn, clearBtn, saveBtn, cancelBtn);
    header.append(title, controls);

    const stage = document.createElement("div");
    stage.className = "helto-mask-editor-stage";

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "helto-mask-editor-canvas-wrap";

    const imageCanvas = document.createElement("canvas");
    const overlayCanvas = document.createElement("canvas");
    imageCanvas.className = "helto-mask-editor-canvas";
    overlayCanvas.className = "helto-mask-editor-canvas bbox";

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const previewScale = previewScaleForSize(width, height);
    const previewWidth = Math.max(1, Math.round(width * previewScale));
    const previewHeight = Math.max(1, Math.round(height * previewScale));
    for (const canvas of [imageCanvas, overlayCanvas]) {
        canvas.width = previewWidth;
        canvas.height = previewHeight;
    }

    const imageCtx = imageCanvas.getContext("2d");
    const overlayCtx = overlayCanvas.getContext("2d");
    imageCtx.drawImage(image, 0, 0, previewWidth, previewHeight);

    canvasWrap.append(imageCanvas, overlayCanvas);
    stage.appendChild(canvasWrap);
    windowEl.append(header, stage);
    overlay.appendChild(windowEl);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add("active"));

    let zoomMode = ZOOM_MODE_FIT;
    let boxes = (Array.isArray(bboxes) ? bboxes : [])
        .map((box) => normalizeBbox(box, width, height))
        .filter(Boolean);
    let selectedIndex = boxes.length > 0 ? boxes.length - 1 : -1;
    let drawing = false;
    let startPoint = null;
    let currentBox = null;

    function renderOverlayNow() {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        boxes.forEach((box, index) => drawBbox(overlayCtx, box, previewScale, index === selectedIndex, index));
        if (currentBox) {
            drawBbox(overlayCtx, currentBox, previewScale, true, null);
        }
        deleteBtn.disabled = selectedIndex < 0 || selectedIndex >= boxes.length;
    }

    const scheduleOverlayRender = createOverlayScheduler(
        window.requestAnimationFrame?.bind(window) || ((callback) => window.setTimeout(callback, 16)),
        renderOverlayNow,
    );
    renderOverlayNow();

    function overlayDisplaySize() {
        const rect = overlayCanvas.getBoundingClientRect();
        return {
            width: rect.width,
            height: rect.height,
        };
    }

    function eventToOriginalPoint(event) {
        const previewPoint = pointerPoint(event, overlayCanvas);
        const maskPoint = previewPointToMaskPoint(previewPoint, previewScale);
        return {
            x: clamp(maskPoint.x, 0, width),
            y: clamp(maskPoint.y, 0, height),
        };
    }

    function selectedBoxIndexAt(point) {
        for (let index = boxes.length - 1; index >= 0; index--) {
            if (pointInBbox(point, boxes[index])) return index;
        }
        return -1;
    }

    function applyZoomMode() {
        const size = displaySizeForZoomMode(zoomMode, {
            imageWidth: width,
            imageHeight: height,
            previewWidth,
            previewHeight,
            stageWidth: stage.clientWidth,
            stageHeight: stage.clientHeight,
        });

        canvasWrap.style.width = `${size.width}px`;
        canvasWrap.style.height = `${size.height}px`;
        stage.classList.toggle("actual-size", zoomMode === ZOOM_MODE_ACTUAL);
        zoomBtn.innerText = zoomMode === ZOOM_MODE_FIT ? "Actual size" : "Zoom to fit";
        zoomBtn.title = zoomMode === ZOOM_MODE_FIT ? "Show actual size" : "Zoom to fit";
        overlayDisplaySize();
    }

    function scheduleZoomLayout() {
        (window.requestAnimationFrame?.bind(window) || ((callback) => window.setTimeout(callback, 16)))(applyZoomMode);
    }

    overlayCanvas.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        drawing = true;
        startPoint = eventToOriginalPoint(event);
        currentBox = null;
        overlayCanvas.setPointerCapture?.(event.pointerId);
    });

    overlayCanvas.addEventListener("pointermove", (event) => {
        if (!drawing || !startPoint) return;
        event.preventDefault();
        const nextPoint = eventToOriginalPoint(event);
        currentBox = bboxFromPoints(startPoint, nextPoint, width, height);
        scheduleOverlayRender();
    });

    overlayCanvas.addEventListener("pointerup", (event) => {
        if (!drawing) return;
        drawing = false;
        overlayCanvas.releasePointerCapture?.(event.pointerId);
        const endPoint = eventToOriginalPoint(event);
        const distance = startPoint ? Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y) : 0;

        if (currentBox && distance >= 3) {
            boxes = [...boxes, currentBox];
            selectedIndex = boxes.length - 1;
        } else {
            selectedIndex = selectedBoxIndexAt(endPoint);
        }

        startPoint = null;
        currentBox = null;
        renderOverlayNow();
    });

    overlayCanvas.addEventListener("pointercancel", (event) => {
        drawing = false;
        startPoint = null;
        currentBox = null;
        overlayCanvas.releasePointerCapture?.(event.pointerId);
        renderOverlayNow();
    });

    zoomBtn.onclick = (event) => {
        event.stopPropagation();
        zoomMode = nextZoomMode(zoomMode);
        applyZoomMode();
    };

    deleteBtn.onclick = (event) => {
        event.stopPropagation();
        if (selectedIndex < 0 || selectedIndex >= boxes.length) return;
        boxes = boxes.filter((_, index) => index !== selectedIndex);
        selectedIndex = Math.min(selectedIndex, boxes.length - 1);
        renderOverlayNow();
    };

    clearBtn.onclick = (event) => {
        event.stopPropagation();
        boxes = [];
        selectedIndex = -1;
        renderOverlayNow();
    };

    function closeEditor() {
        resizeObserver?.disconnect();
        window.removeEventListener?.("resize", handleWindowResize);
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
            await onSaved?.(img, boxes);
            closeEditor();
        } catch (error) {
            console.error("BBox save failed:", error);
            window.alert?.(error.message || "Failed to save bboxes.");
            saveBtn.disabled = false;
            saveBtn.innerText = "Save";
        }
    };

    overlay.onclick = (event) => {
        if (event.target === overlay) {
            closeEditor();
        }
    };

    const resizeObserver = typeof window.ResizeObserver === "function"
        ? new window.ResizeObserver(() => {
            if (zoomMode === ZOOM_MODE_FIT) {
                applyZoomMode();
            }
        })
        : null;
    const handleWindowResize = () => {
        if (zoomMode === ZOOM_MODE_FIT) {
            scheduleZoomLayout();
        }
    };
    resizeObserver?.observe(stage);
    window.addEventListener?.("resize", handleWindowResize);
    scheduleZoomLayout();

    if (hideMode) {
        windowEl.classList.add("hide-mode");
        windowEl.classList.add("hide-content");
        windowEl.addEventListener("mouseenter", () => windowEl.classList.remove("hide-content"));
        windowEl.addEventListener("mouseleave", () => windowEl.classList.add("hide-content"));
    }
}
