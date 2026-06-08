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

export function applyEditedMaskSaveResult(editedMasks, imagePath, ref, result) {
    const nextMasks = { ...(editedMasks && typeof editedMasks === "object" ? editedMasks : {}) };
    if (result?.cleared) {
        delete nextMasks[imagePath];
    } else {
        nextMasks[imagePath] = ref || { edited: true };
    }
    return nextMasks;
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
