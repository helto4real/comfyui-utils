export const DEFAULT_NODE_PROPERTIES = Object.freeze({
    recursive: false,
    aspectRatioMode: "zoom",
    folders: [],
    hideMode: false,
    privacyMode: true,
    resizeMode: "zoom to fit",
    cols: 4,
    sortBy: "newest",
    folderFilter: "all",
    subfolderFilter: "all",
});

export const SORT_OPTIONS = Object.freeze(["newest", "oldest", "name A-Z", "name Z-A"]);

export function initializeSelectorProperties(properties) {
    for (const [key, value] of Object.entries(DEFAULT_NODE_PROPERTIES)) {
        if (key === "folders") {
            if (!properties.folders || !Array.isArray(properties.folders)) properties.folders = [];
            properties.folders = uniqueFolderPaths(properties.folders);
        } else if (properties[key] === undefined) {
            properties[key] = value;
        }
    }
    if (properties.folderFilter && properties.folderFilter !== "all") {
        properties.folderFilter = normalizeFolderPath(properties.folderFilter);
    }
    if (properties.subfolderFilter && properties.subfolderFilter !== "all") {
        properties.subfolderFilter = normalizeFolderPath(properties.subfolderFilter);
    }
    return properties;
}

export function getBasename(path) {
    const parts = path.split(/[/\\]/);
    return parts.filter(Boolean).pop() || path;
}

export function getFolderPath(folder) {
    if (typeof folder === "string") return folder;
    return folder?.path || "";
}

export function getFolderLabel(folder) {
    if (typeof folder === "string") return getBasename(folder);
    if (folder?.relative) return folder.relative;
    if (folder?.path) return getBasename(folder.path);
    return "";
}

export function getSubfolderFilterLabel(path, allFolders) {
    if (!path || path === "all") return "All folders";
    const folder = allFolders.find((item) => getFolderPath(item) === path);
    return folder ? getFolderLabel(folder) : getBasename(path);
}

export function getRootFolderOptions(allFolders, folders) {
    const roots = allFolders.filter((folder) => folder.relative === "");
    if (roots.length > 0) return roots;
    return (folders || []).map((path) => ({
        path,
        root: path,
        name: getBasename(path),
        relative: "",
    }));
}

export function getRootFolderFilterLabel(path, allFolders, folders) {
    if (!path || path === "all") return "All folders";
    const folder = getRootFolderOptions(allFolders, folders).find((item) => getFolderPath(item) === path);
    return folder ? getFolderLabel(folder) : getBasename(path);
}

export function getSubfolderOptions(allFolders, selectedRoot) {
    if ((selectedRoot || "all") === "all") return allFolders;
    return allFolders.filter((folder) => folder.root === selectedRoot);
}

export function normalizeFilterPath(path) {
    return (path || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function normalizeFolderPath(path) {
    const rawPath = typeof path === "string" ? path.trim().replace(/\\/g, "/") : "";
    if (!rawPath) return "";

    let prefix = "";
    let remainingPath = rawPath;
    const driveMatch = rawPath.match(/^[A-Za-z]:(?:\/|$)/);

    if (driveMatch) {
        prefix = `${rawPath.slice(0, 2)}/`;
        remainingPath = rawPath.slice(driveMatch[0].length);
    } else if (rawPath.startsWith("/")) {
        prefix = "/";
        remainingPath = rawPath.replace(/^\/+/, "");
    }

    const parts = [];
    for (const part of remainingPath.split("/")) {
        if (!part || part === ".") continue;
        if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") {
            parts.pop();
            continue;
        }
        if (part === ".." && prefix) continue;
        parts.push(part);
    }

    return `${prefix}${parts.join("/")}`.replace(/\/+$/, "") || prefix;
}

export function uniqueFolderPaths(paths) {
    const folders = [];
    const seenPaths = new Set();

    for (const path of Array.isArray(paths) ? paths : []) {
        const normalized = normalizeFolderPath(path);
        if (!normalized || seenPaths.has(normalized)) continue;
        folders.push(normalized);
        seenPaths.add(normalized);
    }

    return folders;
}

export function isSameOrChildPath(path, parentPath) {
    const normalizedPath = normalizeFilterPath(path);
    const normalizedParent = normalizeFilterPath(parentPath);
    return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function relativeSelectorImagePath(image) {
    const imagePath = normalizeFilterPath(image?.path);
    const folderPath = normalizeFilterPath(image?.folder);
    const fallbackName = image?.name || getBasename(imagePath);

    if (!imagePath || !folderPath || !isSameOrChildPath(imagePath, folderPath)) {
        return fallbackName;
    }

    if (imagePath === folderPath) {
        return fallbackName;
    }

    return imagePath.slice(folderPath.length).replace(/^\/+/, "") || fallbackName;
}

function selectorImageMatchesQuery(image, query) {
    if (!query) return true;
    const searchText = [
        image?.name || "",
        relativeSelectorImagePath(image),
    ].join("\n").toLowerCase();
    return searchText.includes(query);
}

export function filterSelectorImages(images, options = {}) {
    const selectedFolder = options.folderFilter || "all";
    const selectedSubfolder = options.subfolderFilter || "all";
    const query = String(options.searchQuery || "").toLowerCase().trim();

    return (Array.isArray(images) ? images : []).filter((image) => {
        if (selectedFolder !== "all" && normalizeFilterPath(image?.folder) !== normalizeFilterPath(selectedFolder)) {
            return false;
        }

        if (selectedSubfolder !== "all") {
            const imageFolder = image?.image_folder || image?.folder;
            const matchesSubfolder = options.recursive
                ? isSameOrChildPath(imageFolder, selectedSubfolder)
                : normalizeFilterPath(imageFolder) === normalizeFilterPath(selectedSubfolder);
            if (!matchesSubfolder) {
                return false;
            }
        }

        return selectorImageMatchesQuery(image, query);
    });
}

export function resolveSelectorPasteDestination(properties = {}) {
    const selectedSubfolder = properties.subfolderFilter || "all";
    if (selectedSubfolder !== "all") {
        const destination = normalizeFolderPath(selectedSubfolder);
        if (destination) return { type: "selector", destination };
    }

    const selectedFolder = properties.folderFilter || "all";
    if (selectedFolder !== "all") {
        const destination = normalizeFolderPath(selectedFolder);
        if (destination) return { type: "selector", destination };
    }

    return { type: "comfy-input", destination: "" };
}

export function pastedImageExtensionForType(type) {
    const normalizedType = (type || "").toLowerCase();
    if (normalizedType === "image/jpeg" || normalizedType === "image/jpg") return ".jpg";
    if (normalizedType === "image/webp") return ".webp";
    if (normalizedType === "image/gif") return ".gif";
    if (normalizedType === "image/bmp") return ".bmp";
    if (normalizedType === "image/tiff") return ".tiff";
    return ".png";
}

export function buildPastedImageFilename(file, now = new Date()) {
    const currentName = typeof file?.name === "string" ? file.name.trim() : "";
    if (currentName && currentName !== "image" && currentName !== "blob") {
        return currentName;
    }

    const timestamp = now.toISOString()
        .replace(/\.\d{3}Z$/, "Z")
        .replace(/[-:]/g, "")
        .replace("T", "-")
        .replace("Z", "");
    return `pasted-image-${timestamp}${pastedImageExtensionForType(file?.type)}`;
}

export function firstClipboardImageFile(items) {
    for (const item of Array.from(items || [])) {
        if (!item?.type?.startsWith("image/") || typeof item.getAsFile !== "function") {
            continue;
        }
        const file = item.getAsFile();
        if (file) return file;
    }
    return null;
}

export function applyEditedMaskSaveResult(editedMasks, imagePath, ref, result) {
    const nextMasks = { ...(editedMasks && typeof editedMasks === "object" ? editedMasks : {}) };
    if (result?.cleared) {
        delete nextMasks[imagePath];
    } else {
        nextMasks[imagePath] = ref || { edited: true };
    }
    return nextMasks;
}

export function applyEditedBboxSaveResult(editedBboxes, imagePath, boxes) {
    const nextBboxes = { ...(editedBboxes && typeof editedBboxes === "object" ? editedBboxes : {}) };
    const validBoxes = Array.isArray(boxes)
        ? boxes.filter((box) => (
            box &&
            Number.isFinite(Number(box.x)) &&
            Number.isFinite(Number(box.y)) &&
            Number.isFinite(Number(box.width)) &&
            Number.isFinite(Number(box.height)) &&
            Number(box.width) > 0 &&
            Number(box.height) > 0
        )).map((box) => ({
            x: Number(box.x),
            y: Number(box.y),
            width: Number(box.width),
            height: Number(box.height),
        }))
        : [];

    if (validBoxes.length === 0) {
        delete nextBboxes[imagePath];
    } else {
        nextBboxes[imagePath] = validBoxes;
    }
    return nextBboxes;
}

export function sortImagesInPlace(images, mode) {
    images.sort((a, b) => {
        if (mode === "newest") return b.date_modified - a.date_modified;
        if (mode === "oldest") return a.date_modified - b.date_modified;
        if (mode === "name A-Z") return a.name.localeCompare(b.name);
        if (mode === "name Z-A") return b.name.localeCompare(a.name);
        return 0;
    });
    return images;
}
