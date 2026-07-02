import assert from "node:assert/strict";
import test from "node:test";

import {
    __setPrivacyModuleForTests,
    isPrivacyTriggerError,
    privacyFetchJson,
} from "../../web/privacy_common.js";

test("privacyFetchJson opens shared unlock dialog and retries locked requests", async () => {
    const calls = [];
    let dialogMode = null;
    let cookieEnsured = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options = {}) => {
        calls.push(options);
        if (calls.length === 1) {
            return {
                ok: false,
                statusText: "Unauthorized",
                async text() {
                    return JSON.stringify({ error: "PRIVACY_LOCKED: locked" });
                },
            };
        }
        return {
            ok: true,
            async json() {
                return { ok: true, value: 42 };
            },
        };
    };
    __setPrivacyModuleForTests({
        getStoredPrivacyToken: () => "token-after-unlock",
        ensureStoredPrivacyTokenCookie: () => {
            cookieEnsured += 1;
            return true;
        },
        isPrivacyLockedError: isPrivacyTriggerError,
        showPrivacyKeystoreDialog: async (mode) => {
            dialogMode = mode;
            return true;
        },
    });
    try {
        const result = await privacyFetchJson("/private");

        assert.deepEqual(result, { ok: true, value: 42 });
        assert.equal(calls.length, 2);
        assert.equal(dialogMode, "auto");
        assert.equal(cookieEnsured, 3);
        assert.equal(calls[1].headers.get("X-Helto-Privacy-Token"), "token-after-unlock");
    } finally {
        globalThis.fetch = oldFetch;
        __setPrivacyModuleForTests(null);
    }
});
