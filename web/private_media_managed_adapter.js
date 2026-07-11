// Inactive browser binding for shared opaque artifact lease URLs. The media
// node cutover supplies resolveArtifactLeaseURL from helto-privacy.

export function createPrivateMediaLeaseAdapter(resolveArtifactLeaseURL) {
    if (typeof resolveArtifactLeaseURL !== "function") {
        throw new TypeError("A shared artifact lease URL resolver is required.");
    }
    const previewKinds = new Set(["private-image-preview", "private-video-preview"]);
    return Object.freeze({
        async url(record, artifactHandle = null, apiURL = (path) => path) {
            if (!record || record.private !== true) {
                throw new Error("PRIVACY_PRIVATE_MEDIA_RECORD_INVALID");
            }
            const keys = Object.keys(record).sort().join(",");
            if (keys === "lease,private") {
                return resolveArtifactLeaseURL(record.lease, apiURL);
            }
            if (
                keys !== "artifact,artifactKind,private"
                || !previewKinds.has(record.artifactKind)
                || !artifactHandle
                || typeof artifactHandle.lease !== "function"
            ) {
                throw new Error("PRIVACY_PRIVATE_MEDIA_RECORD_INVALID");
            }
            const lease = await artifactHandle.lease(
                record.artifactKind,
                record.artifact,
                "preview",
            );
            return resolveArtifactLeaseURL(lease, apiURL);
        },
    });
}
