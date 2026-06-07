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

function renderMaskOverlay(maskCanvas, overlayCanvas) {
    const maskCtx = maskCanvas.getContext("2d");
    const overlayCtx = overlayCanvas.getContext("2d");
    const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const overlayData = overlayCtx.createImageData(overlayCanvas.width, overlayCanvas.height);

    for (let i = 0; i < maskData.data.length; i += 4) {
        const value = maskData.data[i];
        overlayData.data[i] = 255;
        overlayData.data[i + 1] = 64;
        overlayData.data[i + 2] = 64;
        overlayData.data[i + 3] = Math.round(value * 0.45);
    }

    overlayCtx.putImageData(overlayData, 0, 0);
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
    containPointerEvents,
    saveMask,
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

    controls.append(paintBtn, eraseBtn, sizeInput, invertBtn, clearBtn, fillBtn, saveBtn, cancelBtn);
    header.append(title, controls);

    const stage = document.createElement("div");
    stage.className = "helto-mask-editor-stage";

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "helto-mask-editor-canvas-wrap";

    const imageCanvas = document.createElement("canvas");
    const overlayCanvas = document.createElement("canvas");
    const maskCanvas = document.createElement("canvas");
    imageCanvas.className = "helto-mask-editor-canvas";
    overlayCanvas.className = "helto-mask-editor-canvas mask";
    maskCanvas.className = "helto-mask-editor-hidden-canvas";

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    for (const canvas of [imageCanvas, overlayCanvas, maskCanvas]) {
        canvas.width = width;
        canvas.height = height;
    }

    const imageCtx = imageCanvas.getContext("2d");
    const maskCtx = maskCanvas.getContext("2d");
    imageCtx.drawImage(image, 0, 0, width, height);
    maskCtx.fillStyle = "white";
    maskCtx.fillRect(0, 0, width, height);
    maskCtx.drawImage(maskImage, 0, 0, width, height);
    renderMaskOverlay(maskCanvas, overlayCanvas);

    canvasWrap.append(imageCanvas, overlayCanvas, maskCanvas);
    stage.appendChild(canvasWrap);
    windowEl.append(header, stage);
    overlay.appendChild(windowEl);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add("active"));

    let brushValue = 255;
    let drawing = false;
    let lastPoint = null;

    function setMode(value) {
        brushValue = value;
        paintBtn.classList.toggle("active", value === 255);
        eraseBtn.classList.toggle("active", value === 0);
    }

    function drawAt(event) {
        const point = pointerPoint(event, overlayCanvas);
        const size = clamp(Number(sizeInput.value) || 32, 2, 160);
        drawBrush(maskCtx, point, size, brushValue);
        if (lastPoint) {
            const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
            const steps = Math.max(1, Math.ceil(distance / Math.max(1, size / 4)));
            for (let i = 1; i < steps; i++) {
                drawBrush(maskCtx, {
                    x: lastPoint.x + ((point.x - lastPoint.x) * i) / steps,
                    y: lastPoint.y + ((point.y - lastPoint.y) * i) / steps,
                }, size, brushValue);
            }
        }
        lastPoint = point;
        renderMaskOverlay(maskCanvas, overlayCanvas);
    }

    overlayCanvas.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        drawing = true;
        lastPoint = null;
        overlayCanvas.setPointerCapture?.(event.pointerId);
        drawAt(event);
    });
    overlayCanvas.addEventListener("pointermove", (event) => {
        if (!drawing) return;
        event.preventDefault();
        drawAt(event);
    });
    overlayCanvas.addEventListener("pointerup", (event) => {
        drawing = false;
        lastPoint = null;
        overlayCanvas.releasePointerCapture?.(event.pointerId);
    });
    overlayCanvas.addEventListener("pointerleave", () => {
        drawing = false;
        lastPoint = null;
    });

    paintBtn.onclick = (event) => {
        event.stopPropagation();
        setMode(255);
    };
    eraseBtn.onclick = (event) => {
        event.stopPropagation();
        setMode(0);
    };
    invertBtn.onclick = (event) => {
        event.stopPropagation();
        invertMask(maskCanvas);
        renderMaskOverlay(maskCanvas, overlayCanvas);
    };
    clearBtn.onclick = (event) => {
        event.stopPropagation();
        setMaskValue(maskCanvas, 0);
        renderMaskOverlay(maskCanvas, overlayCanvas);
    };
    fillBtn.onclick = (event) => {
        event.stopPropagation();
        setMaskValue(maskCanvas, 255);
        renderMaskOverlay(maskCanvas, overlayCanvas);
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
            const result = await saveMask(img.path, canvasToDataUrl(maskCanvas), privacyMode);
            await onSaved?.(img, result.ref);
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
