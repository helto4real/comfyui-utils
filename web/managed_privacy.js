import { app } from "../../scripts/app.js";
import {
    installPrivacyConnectionSerializationGate,
} from "/helto_privacy/ui/privacy_snapshot.js";

import {
    createPrivacyShowAnyModeBrowserAdapter,
    createPrivacyShowAnyWorkflowBrowserAdapter,
} from "./privacy_show_any_managed_adapter.js";
import {
    createPromptEnhancerModeBrowserAdapter,
    createPromptEnhancerWorkflowBrowserAdapter,
} from "./prompt_enhancer_privacy_adapter.js";
import {
    createSelectorModeBrowserAdapter,
    createSelectorWorkflowBrowserAdapter,
} from "./selector_privacy_adapter.js";
import { createPrivateMediaLeaseAdapter } from "./private_media_managed_adapter.js";
import {
    UTILS_PRIVACY_PROFILE_FINGERPRINT,
    UTILS_PRIVACY_PROFILE_ID,
    requireConfiguredUtilsSuite,
} from "./managed_privacy_contract.js";


export { UTILS_PRIVACY_PROFILE_FINGERPRINT, UTILS_PRIVACY_PROFILE_ID };

installPrivacyConnectionSerializationGate(app).coalesce();

const browserAdapters = Object.freeze({
    "privacy-show-any-mode-browser": createPrivacyShowAnyModeBrowserAdapter(),
    "privacy-show-any-workflow-browser": createPrivacyShowAnyWorkflowBrowserAdapter({ app }),
    "prompt-enhancer-mode-browser": createPromptEnhancerModeBrowserAdapter(),
    "prompt-enhancer-workflow-browser": createPromptEnhancerWorkflowBrowserAdapter({ app }),
    "selector-mode-browser": createSelectorModeBrowserAdapter(),
    "selector-workflow-browser": createSelectorWorkflowBrowserAdapter({ app }),
});

async function connect() {
    const response = await fetch("/helto_privacy/status", {
        cache: "no-store",
        credentials: "same-origin",
    });
    if (!response.ok) throw new Error("PRIVACY_SUITE_BLOCKED");
    const status = await response.json();
    const suiteManifestDigest = requireConfiguredUtilsSuite(status);
    const runtime = await import(
        `/helto_privacy/ui/privacy_profile/${suiteManifestDigest}.js`
    );
    return runtime.connectPrivacyPack({
        app,
        packId: UTILS_PRIVACY_PROFILE_ID,
        profileFingerprint: UTILS_PRIVACY_PROFILE_FINGERPRINT,
        suiteManifestDigest,
        adapters: browserAdapters,
    });
}

export const utilsPrivacy = connect();

export async function requireUtilsPrivacy() {
    const pack = await utilsPrivacy;
    await pack.readiness.waitUntilReady();
    pack.authorization.requireReady();
    return pack;
}

const privateMediaLeaseAdapter = createPrivateMediaLeaseAdapter(
    (lease, apiURL) => apiURL(lease.url),
);

export async function resolveUtilsPrivateMediaRecord(record, apiURL = (path) => path) {
    const privacy = await requireUtilsPrivacy();
    return privateMediaLeaseAdapter.url(
        record,
        privacy.artifacts("private-media-artifacts"),
        apiURL,
    );
}
