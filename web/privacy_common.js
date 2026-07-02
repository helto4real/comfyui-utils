const PRIVACY_MODULE_URL = "/helto_privacy/ui/privacy.js";
const PRIVACY_TOKEN_HEADER = "X-Helto-Privacy-Token";
const PRIVACY_ERROR_CODES = [
    "PRIVACY_LOCKED",
    "PRIVACY_TOKEN_REQUIRED",
    "PRIVACY_KEYSTORE_UNINITIALIZED",
];

let privacyModulePromise = null;

export function __setPrivacyModuleForTests(module) {
    if (module) {
        globalThis.__heltoPrivacyModule = module;
    } else {
        delete globalThis.__heltoPrivacyModule;
    }
    privacyModulePromise = null;
}

export async function loadHeltoPrivacyModule() {
    if (globalThis.__heltoPrivacyModule) {
        return globalThis.__heltoPrivacyModule;
    }
    if (!privacyModulePromise) {
        privacyModulePromise = import(PRIVACY_MODULE_URL).catch(() => null);
    }
    return privacyModulePromise;
}

export function isPrivacyTriggerError(error) {
    const message = String(error?.message ?? error ?? "");
    return PRIVACY_ERROR_CODES.some((code) => message.includes(code));
}

export function ensurePrivacyTokenCookieSoon() {
    void loadHeltoPrivacyModule().then((privacy) => {
        privacy?.ensureStoredPrivacyTokenCookie?.();
    });
}

async function privacyHeaders(headers = undefined) {
    const nextHeaders = new Headers(headers || {});
    const privacy = await loadHeltoPrivacyModule();
    privacy?.ensureStoredPrivacyTokenCookie?.();
    const token = privacy?.getStoredPrivacyToken?.();
    if (token && !nextHeaders.has(PRIVACY_TOKEN_HEADER)) {
        nextHeaders.set(PRIVACY_TOKEN_HEADER, token);
    }
    return nextHeaders;
}

async function responseError(response) {
    const text = await response.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = {};
    }
    return new Error(data?.error || text || response.statusText || `HTTP ${response.status}`);
}

export async function withPrivacyUnlock(operation) {
    try {
        return await operation();
    } catch (error) {
        const privacy = await loadHeltoPrivacyModule();
        const locked = privacy?.isPrivacyLockedError?.(error) || isPrivacyTriggerError(error);
        if (!locked) {
            throw error;
        }
        const unlocked = await privacy?.showPrivacyKeystoreDialog?.("auto");
        if (!unlocked) {
            throw error;
        }
        privacy?.ensureStoredPrivacyTokenCookie?.();
        return operation();
    }
}

export async function privacyFetch(input, options = {}) {
    const { fetcher = fetch, ...fetchOptions } = options;
    return withPrivacyUnlock(async () => {
        const headers = await privacyHeaders(fetchOptions.headers);
        const response = await fetcher(input, { ...fetchOptions, headers });
        if (response.ok) {
            return response;
        }
        throw await responseError(response);
    });
}

export async function privacyFetchJson(input, options = {}) {
    const response = await privacyFetch(input, options);
    const payload = await response.json().catch(() => ({}));
    if (payload?.ok === false || payload?.error) {
        throw new Error(payload?.error || "Privacy request failed.");
    }
    return payload;
}
