import { ensurePrivacyTokenCookieSoon, privacyFetch, privacyFetchJson } from "./privacy_common.js";

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

export const selectorApi = {
    async getInputDir() {
        return privacyFetchJson("/helto_selector/input_dir");
    },

    async scanFolders(folders, recursive, previousPaths = []) {
        return privacyFetchJson("/helto_selector/scan_folders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folders, recursive, previous_paths: previousPaths })
        });
    },

    async registerFolders(folders) {
        return privacyFetchJson("/helto_selector/register_roots", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folders: Array.isArray(folders) ? folders : [] }),
        });
    },

    async getRegisteredFolders() {
        return privacyFetchJson("/helto_selector/registered_roots");
    },

    async revokeFolder(folder) {
        return privacyFetchJson("/helto_selector/register_roots", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "revoke", folder }),
        });
    },

    async encrypt(data) {
        return privacyFetchJson("/helto_selector/encrypt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data })
        });
    },

    async decrypt(encrypted) {
        return privacyFetchJson("/helto_selector/decrypt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ encrypted })
        });
    },

    async deleteSelectedImages(paths, folders, recursive) {
        return privacyFetchJson("/helto_selector/delete_images", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths, folders, recursive })
        });
    },

    async pasteImage(file, filename, destination, folders) {
        const form = new FormData();
        form.append("image", file, filename);
        form.append("destination", destination);
        form.append("folders", JSON.stringify(Array.isArray(folders) ? folders : []));
        const response = await privacyFetch("/helto_selector/paste_image", {
            method: "POST",
            body: form,
        });
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

    thumbnailUrl(path, privacyMode, image = null) {
        ensurePrivacyTokenCookieSoon();
        const version = selectorImageVersionToken(image);
        return `/helto_selector/thumbnail${selectorImageUrl(path, {
            privacy: selectorPrivacyQueryValue(privacyMode),
            v: version,
        })}`;
    },

    viewImageUrl(path, image = null) {
        ensurePrivacyTokenCookieSoon();
        const version = selectorImageVersionToken(image);
        return `/helto_selector/view_image${selectorImageUrl(path, {
            v: version,
        })}`;
    },

    maskUrl(path) {
        ensurePrivacyTokenCookieSoon();
        return `/helto_selector/mask${selectorImageUrl(path)}`;
    },

    async saveMask(path, maskData, privacyMode) {
        return privacyFetchJson("/helto_selector/save_mask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, mask_data: maskData, privacy: privacyMode })
        });
    },

    async deleteMask(path) {
        return privacyFetchJson("/helto_selector/delete_mask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path })
        });
    },

    async migrateMasks(paths, privacyMode) {
        return privacyFetchJson("/helto_selector/migrate_masks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths, privacy: privacyMode })
        });
    },

    async clearCache() {
        return privacyFetchJson("/helto_selector/clear_cache", { method: "POST" });
    }
};
