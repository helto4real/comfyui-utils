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

    thumbnailUrl(path, privacyMode) {
        return `/helto_selector/thumbnail?path=${encodeURIComponent(path)}&privacy=${privacyMode}`;
    },

    viewImageUrl(path) {
        return `/helto_selector/view_image?path=${encodeURIComponent(path)}`;
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
