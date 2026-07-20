import assert from "node:assert/strict";
import test from "node:test";

import {
    __setPrivacyModuleForTests,
    confirmUnreadablePrivacyReset,
    isPrivacyKeyUnavailableError,
    isPrivacyTriggerError,
    isUnreadablePrivacyValueError,
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

test("privacy error classification resets unreadable values but preserves locked values", async () => {
    __setPrivacyModuleForTests({
        isPrivacyLockedError: (error) => String(error?.message || error).includes("PRIVACY_LOCKED"),
        isUnreadablePrivacyValueError: (error) => String(error?.message || error).includes("PRIVACY_KEY_MISMATCH"),
        isPrivacyKeyUnavailableError: (error) => String(error?.message || error).includes("PRIVACY_KEY_MISSING"),
    });
    try {
        assert.equal(await isUnreadablePrivacyValueError(new Error("PRIVACY_LOCKED: locked")), false);
        assert.equal(await isUnreadablePrivacyValueError(new Error("PRIVACY_KEY_MISMATCH: wrong key")), true);
        assert.equal(await isPrivacyKeyUnavailableError(new Error("PRIVACY_KEY_MISSING: gone")), true);
        assert.equal(await isPrivacyKeyUnavailableError(new Error("PRIVACY_KEY_MISMATCH: wrong key")), false);
    } finally {
        __setPrivacyModuleForTests(null);
    }
});

test("unreadable reset confirmation preserves by default and delegates when available", async () => {
    __setPrivacyModuleForTests({});
    try {
        assert.equal(await confirmUnreadablePrivacyReset(), false);
    } finally {
        __setPrivacyModuleForTests(null);
    }

    const calls = [];
    __setPrivacyModuleForTests({
        confirmUnreadablePrivacyReset: async (options) => {
            calls.push(options);
            return true;
        },
    });
    try {
        assert.equal(await confirmUnreadablePrivacyReset({ reason: "synthetic" }), true);
        assert.deepEqual(calls, [{ reason: "synthetic" }]);
    } finally {
        __setPrivacyModuleForTests(null);
    }
});

test("decrypt does not open setup dialog when the old key is missing", async () => {
    let dialogCalls = 0;
    let fetchCalls = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return {
            ok: false,
            statusText: "Error",
            async text() {
                return JSON.stringify({ error: "PRIVACY_KEYSTORE_UNINITIALIZED: missing" });
            },
        };
    };
    __setPrivacyModuleForTests({
        isPrivacyUnlockRequiredError: () => true,
        isPrivacySetupRequiredError: () => true,
        showPrivacyKeystoreDialog: async () => {
            dialogCalls += 1;
            return true;
        },
    });
    try {
        await assert.rejects(() => privacyFetchJson("/helto_selector/decrypt"), /PRIVACY_KEYSTORE_UNINITIALIZED/);
        assert.equal(fetchCalls, 1);
        assert.equal(dialogCalls, 0);
    } finally {
        globalThis.fetch = oldFetch;
        __setPrivacyModuleForTests(null);
    }
});
