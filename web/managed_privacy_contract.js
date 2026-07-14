export const UTILS_PRIVACY_PROFILE_ID = "helto.comfyui-utils";
export const UTILS_PRIVACY_PROFILE_FINGERPRINT =
    "517c7d90d335ac12fd30e7fb0eafba9976b8fb8c1be9cdfa55aa508463760cbe";

export function requireActiveUtilsSuite(status) {
    if (
        status?.suiteStatus !== "active"
        || !/^[0-9a-f]{64}$/.test(String(status?.suiteManifestDigest || ""))
    ) {
        throw new Error("PRIVACY_SUITE_BLOCKED");
    }
    return status.suiteManifestDigest;
}

export function requireUtilsProfileFingerprint(fingerprint) {
    if (fingerprint !== UTILS_PRIVACY_PROFILE_FINGERPRINT) {
        throw new Error("PRIVACY_PROFILE_MISMATCH");
    }
    return fingerprint;
}
