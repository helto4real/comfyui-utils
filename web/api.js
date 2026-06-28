export function selectorImageVersionToken(image) {
    const modified = Number(image?.date_modified);
    const size = Number(image?.size_bytes);
    const parts = [];
    if (Number.isFinite(modified)) parts.push(`m${modified}`);
    if (Number.isFinite(size)) parts.push(`s${size}`);
    return parts.join("-");
}

function selectorImageUrl(path, extraParams = {}) {
    const params = new URLSearchParams({ path: String(path ?? "") });
    for (const [key, value] of Object.entries(extraParams)) {
        if (value !== undefined && value !== null && value !== "") {
            params.set(key, String(value));
        }
    }
    return `?${params.toString()}`;
}

function selectorPrivacyQueryValue(privacyMode) {
    return privacyMode === true || String(privacyMode).toLowerCase() === "true" ? "true" : "false";
}

function selectorFoldersQueryValue(folders, image = null) {
    let roots = Array.isArray(folders) ? folders : [];
    if (roots.length === 0 && image?.folder) {
        roots = [image.folder];
    }
    roots = roots.filter((folder) => typeof folder === "string" && folder.trim());
    return roots.length ? JSON.stringify(roots) : undefined;
}

export const selectorApi = {
    async getInputDir() {
        const response = await fetch("/helto_selector/input_dir");
        return response.json();
    },

    async scanFolders(folders, recursive, previousPaths = []) {
        const response = await fetch("/helto_selector/scan_folders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folders, recursive, previous_paths: previousPaths })
        });
        return response.json();
    },

    async encrypt(data) {
        const response = await fetch("/helto_selector/encrypt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data })
        });
        return response.json();
    },

    async decrypt(encrypted) {
        const response = await fetch("/helto_selector/decrypt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ encrypted })
        });
        return response.json();
    },

    async deleteSelectedImages(paths, folders, recursive) {
        const response = await fetch("/helto_selector/delete_images", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths, folders, recursive })
        });
        if (!response.ok) {
            let message = "Failed to delete selected images.";
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

    async pasteImage(file, filename, destination, folders) {
        const form = new FormData();
        form.append("image", file, filename);
        form.append("destination", destination);
        form.append("folders", JSON.stringify(Array.isArray(folders) ? folders : []));
        const response = await fetch("/helto_selector/paste_image", {
            method: "POST",
            body: form,
        });
        if (!response.ok) {
            let message = "Failed to paste image.";
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

    thumbnailUrl(path, privacyMode, image = null, folders = []) {
        const version = selectorImageVersionToken(image);
        return `/helto_selector/thumbnail${selectorImageUrl(path, {
            privacy: selectorPrivacyQueryValue(privacyMode),
            v: version,
            folders: selectorFoldersQueryValue(folders, image),
        })}`;
    },

    viewImageUrl(path, image = null, folders = []) {
        const version = selectorImageVersionToken(image);
        return `/helto_selector/view_image${selectorImageUrl(path, {
            v: version,
            folders: selectorFoldersQueryValue(folders, image),
        })}`;
    },

    maskUrl(path, folders = []) {
        return `/helto_selector/mask${selectorImageUrl(path, {
            folders: selectorFoldersQueryValue(folders),
        })}`;
    },

    async saveMask(path, maskData, privacyMode, folders = []) {
        const response = await fetch("/helto_selector/save_mask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, mask_data: maskData, privacy: privacyMode, folders })
        });
        if (!response.ok) {
            let message = "Failed to save edited mask.";
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

    async deleteMask(path, folders = []) {
        const response = await fetch("/helto_selector/delete_mask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, folders })
        });
        if (!response.ok) {
            let message = "Failed to clear edited mask.";
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

    async migrateMasks(paths, privacyMode, folders = []) {
        const response = await fetch("/helto_selector/migrate_masks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths, privacy: privacyMode, folders })
        });
        if (!response.ok) {
            let message = "Failed to migrate edited masks.";
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

    async clearCache() {
        const response = await fetch("/helto_selector/clear_cache", { method: "POST" });
        if (!response.ok) {
            let message = "Failed to clear cached thumbnails.";
            try {
                const data = await response.json();
                if (data.error) message = data.error;
            } catch (err) {
                // Keep the generic message if the server did not return JSON.
            }
            throw new Error(message);
        }
        return response.json();
    }
};
