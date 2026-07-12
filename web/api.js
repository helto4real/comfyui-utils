async function selectorOperation(operationId, payload = undefined) {
    const { requireUtilsPrivacy } = await import("./managed_privacy.js");
    const privacy = await requireUtilsPrivacy();
    return privacy.workflow("selector-workflow").invoke(operationId, payload);
}

export function selectorImageVersionToken(image) {
    const modified = Number(image?.date_modified);
    const size = Number(image?.size_bytes);
    const parts = [];
    if (Number.isFinite(modified)) parts.push(`m${modified}`);
    if (Number.isFinite(size)) parts.push(`s${size}`);
    return parts.join("-");
}

export const selectorApi = {
    async getInputDir() {
        return selectorOperation("selector.input-dir");
    },

    async scanFolders(folders, recursive, previousPaths = []) {
        return selectorOperation("selector.scan", {
            folders, recursive, previous_paths: previousPaths,
        });
    },

    async registerFolders(folders) {
        return selectorOperation("selector.roots-register", {
            folders: Array.isArray(folders) ? folders : [],
        });
    },

    async getRegisteredFolders() {
        return selectorOperation("selector.roots-list");
    },

    async revokeFolder(folder) {
        return selectorOperation("selector.roots-register", { action: "revoke", folder });
    },

    async deleteSelectedImages(paths, folders, recursive) {
        return selectorOperation("selector.image-delete", { paths, folders, recursive });
    },

    async pasteImage(file, filename, destination, folders) {
        return selectorOperation("selector.image-paste", {
            content: [...new Uint8Array(await file.arrayBuffer())],
            content_type: file.type,
            filename,
            destination,
            folders: Array.isArray(folders) ? folders : [],
        });
    },

    async uploadComfyInputImage(file, filename) {
        const form = new FormData();
        form.append("image", file, filename);
        form.append("type", "input");
        const response = await fetch("/upload/image", {
            method: "POST",
            body: form,
        });
        if (!response.ok) {
            let message = "Failed to paste image into ComfyUI input.";
            try {
                const data = await response.json();
                if (data.error) message = data.error;
            } catch (err) {
                // Keep the generic message if the server did not return JSON.
            }
            throw new Error(message);
        }
        return response.json();
    },

    async thumbnailUrl(path, _privacyMode, _image = null) {
        const record = await selectorOperation("selector.thumbnail", { path });
        const { resolveUtilsPrivateMediaRecord } = await import("./managed_privacy.js");
        return resolveUtilsPrivateMediaRecord(record);
    },

    async viewImageUrl(path, _image = null) {
        const record = await selectorOperation("selector.source-view", { path });
        const { resolveUtilsPrivateMediaRecord } = await import("./managed_privacy.js");
        return resolveUtilsPrivateMediaRecord(record);
    },

    async maskUrl(path, reference = null) {
        const record = await selectorOperation("selector.mask-read", { path, reference });
        if (typeof record?.publicDataUrl === "string") return record.publicDataUrl;
        const { resolveUtilsPrivateMediaRecord } = await import("./managed_privacy.js");
        return resolveUtilsPrivateMediaRecord(record);
    },

    async saveMask(path, maskData, privacyMode) {
        return selectorOperation("selector.mask-write", {
            path, mask_data: maskData, privacy: privacyMode,
        });
    },

    async deleteMask(path, reference) {
        return selectorOperation("selector.mask-delete", { path, reference });
    },

    async migrateMasks(masks) {
        return selectorOperation("selector.mask-migrate", { masks });
    },

    async clearCache() {
        return selectorOperation("selector.cache-clear");
    }
};
