export const PRIVACY_ENVELOPE_SCHEMA = "helto.comfyui-utils";
export const PRIVACY_ENVELOPE_ALGORITHM = "AES-256-GCM";
export const ENCRYPTED_PREFIX = `{"algorithm":"${PRIVACY_ENVELOPE_ALGORITHM}"`;
export const LEGACY_ENCRYPTED_PREFIX = "__HELTO_ENC__:";

const OWNER_MEMOS = new WeakMap();
const FALLBACK_OWNER = {};

function ownerKey(owner) {
    return owner && (typeof owner === "object" || typeof owner === "function") ? owner : FALLBACK_OWNER;
}

function fieldKey(fieldName) {
    return String(fieldName || "value");
}

function memoForOwner(owner, create = false) {
    const key = ownerKey(owner);
    let memo = OWNER_MEMOS.get(key);
    if (!memo && create) {
        memo = new Map();
        OWNER_MEMOS.set(key, memo);
    }
    return memo || null;
}

function stableJsonValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => {
            const next = stableJsonValue(item);
            return next === undefined ? null : next;
        });
    }
    if (value && typeof value === "object") {
        const result = {};
        for (const key of Object.keys(value).sort()) {
            const next = stableJsonValue(value[key]);
            if (next !== undefined) {
                result[key] = next;
            }
        }
        return result;
    }
    if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
        return undefined;
    }
    return value;
}

export function stablePrivacyJsonStringify(value) {
    return JSON.stringify(stableJsonValue(value));
}

export function canonicalPrivacyValue(value) {
    if (typeof value === "string") {
        return value;
    }
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "object") {
        const serialized = stablePrivacyJsonStringify(value);
        return serialized === undefined ? "" : serialized;
    }
    return String(value);
}

export function parsePrivacyEnvelope(value) {
    if (typeof value === "string") {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }
    return value && typeof value === "object" ? value : null;
}

export function serializePrivacyEnvelope(value) {
    if (typeof value === "string") {
        return value;
    }
    if (!value || typeof value !== "object") {
        return "";
    }
    return stablePrivacyJsonStringify(value) || "";
}

export function isPrivacyEnvelope(value) {
    const payload = parsePrivacyEnvelope(value);
    return (
        !!payload
        && payload.encrypted === true
        && payload.schema === PRIVACY_ENVELOPE_SCHEMA
        && payload.algorithm === PRIVACY_ENVELOPE_ALGORITHM
    );
}

export function isLegacyPrivacyEnvelope(value) {
    return typeof value === "string" && value.startsWith(LEGACY_ENCRYPTED_PREFIX);
}

export function rememberPrivacyEnvelope(owner, fieldName, plaintext, envelope) {
    const encrypted = serializePrivacyEnvelope(envelope);
    if (!isPrivacyEnvelope(encrypted)) {
        return "";
    }
    const memo = memoForOwner(owner, true);
    memo.set(fieldKey(fieldName), {
        canonical: canonicalPrivacyValue(plaintext),
        envelope: encrypted,
    });
    return encrypted;
}

export function rememberedPrivacyEnvelope(owner, fieldName, plaintext) {
    const memo = memoForOwner(owner, false);
    const entry = memo?.get(fieldKey(fieldName));
    if (!entry) {
        return "";
    }
    return entry.canonical === canonicalPrivacyValue(plaintext) ? entry.envelope : "";
}

export function forgetPrivacyEnvelope(owner, fieldName) {
    memoForOwner(owner, false)?.delete(fieldKey(fieldName));
}

export async function decryptAndRememberPrivacyValue(owner, fieldName, envelope, selectorApi, fallback = "") {
    const encrypted = serializePrivacyEnvelope(envelope);
    if (!isPrivacyEnvelope(encrypted)) {
        return fallback;
    }
    const response = await selectorApi.decrypt(encrypted);
    const plaintext = typeof response?.data === "string" ? response.data : String(fallback ?? "");
    rememberPrivacyEnvelope(owner, fieldName, plaintext, encrypted);
    return plaintext;
}

export async function encryptedOrReusePrivacyValue(owner, fieldName, currentValue, options = {}) {
    const {
        privacyMode = true,
        selectorApi,
        defaultValue = "",
        canonicalValue = currentValue,
        encryptEmpty = true,
    } = options;
    const serialized = canonicalPrivacyValue(currentValue);

    if (isPrivacyEnvelope(serialized)) {
        return serialized;
    }
    if (!privacyMode) {
        forgetPrivacyEnvelope(owner, fieldName);
        return serialized;
    }
    if (!encryptEmpty && !serialized) {
        forgetPrivacyEnvelope(owner, fieldName);
        return String(defaultValue ?? "");
    }

    const remembered = rememberedPrivacyEnvelope(owner, fieldName, canonicalValue);
    if (remembered) {
        return remembered;
    }

    if (typeof selectorApi?.encrypt !== "function") {
        return String(defaultValue ?? "");
    }

    const response = await selectorApi.encrypt(serialized);
    const encrypted = String(response?.encrypted || "");
    if (!isPrivacyEnvelope(encrypted)) {
        return String(defaultValue ?? "");
    }
    rememberPrivacyEnvelope(owner, fieldName, canonicalValue, encrypted);
    return encrypted;
}
