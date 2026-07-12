export const UTILS_PRIVACY_PROFILE_ID = "helto.comfyui-utils";
export const UTILS_PRIVACY_PROFILE_FINGERPRINT =
    "834a150df10bf4972982bd34fa08e6e0af616e99e20bf506caaa0f893cbd2e69";

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
