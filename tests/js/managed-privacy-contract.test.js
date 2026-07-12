import assert from "node:assert/strict";
import test from "node:test";

import {
    UTILS_PRIVACY_PROFILE_FINGERPRINT,
    UTILS_PRIVACY_PROFILE_ID,
    requireActiveUtilsSuite,
    requireUtilsProfileFingerprint,
} from "../../web/managed_privacy_contract.js";

test("Utils browser contract locks one profile identity and fingerprint", () => {
    assert.equal(UTILS_PRIVACY_PROFILE_ID, "helto.comfyui-utils");
    assert.equal(
        requireUtilsProfileFingerprint(UTILS_PRIVACY_PROFILE_FINGERPRINT),
        UTILS_PRIVACY_PROFILE_FINGERPRINT,
    );
    assert.throws(
        () => requireUtilsProfileFingerprint("0".repeat(64)),
        /PRIVACY_PROFILE_MISMATCH/,
    );
});

test("Utils browser contract rejects missing and inactive suites", () => {
    const digest = "a".repeat(64);
    assert.equal(
        requireActiveUtilsSuite({ suiteStatus: "active", suiteManifestDigest: digest }),
        digest,
    );
    assert.throws(() => requireActiveUtilsSuite(null), /PRIVACY_SUITE_BLOCKED/);
    assert.throws(
        () => requireActiveUtilsSuite({ suiteStatus: "ready", suiteManifestDigest: digest }),
        /PRIVACY_SUITE_BLOCKED/,
    );
});
