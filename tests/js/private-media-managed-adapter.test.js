import assert from "node:assert/strict";
import test from "node:test";

import { createPrivateMediaLeaseAdapter } from "../../web/private_media_managed_adapter.js";


const lease = {
    url: "/helto_privacy/artifacts/hp-lease-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
    expiresInSeconds: 60,
};
const artifact = {
    schema: "helto.private-artifact-reference",
    version: 1,
    id: "hp-art-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
};


test("preview records exchange an opaque reference through the shared browser handle", async () => {
    const resolved = [];
    const leased = [];
    const adapter = createPrivateMediaLeaseAdapter((candidate, apiURL) => {
        resolved.push(candidate);
        return apiURL(candidate.url);
    });
    const artifactHandle = {
        async lease(kind, reference, operation) {
            leased.push({ kind, reference, operation });
            return lease;
        },
    };

    assert.equal(
        await adapter.url(
            { private: true, artifactKind: "private-video-preview", artifact },
            artifactHandle,
            (path) => `/api${path}`,
        ),
        `/api${lease.url}`,
    );
    assert.deepEqual(leased, [{
        kind: "private-video-preview",
        reference: artifact,
        operation: "preview",
    }]);
    assert.deepEqual(resolved, [lease]);
});


test("source records resolve their already-authorized direct stream lease", async () => {
    const adapter = createPrivateMediaLeaseAdapter((candidate, apiURL) => apiURL(candidate.url));
    assert.equal(
        await adapter.url({ private: true, lease }, null, (path) => `/api${path}`),
        `/api${lease.url}`,
    );
});


test("private media browser binding rejects legacy token and metadata records", async () => {
    const adapter = createPrivateMediaLeaseAdapter(() => "unreachable");
    for (const record of [
        { private: true, token: "encrypted-path-token" },
        { private: true, lease, filename: "private.mp4" },
        { private: true, lease, path: "/private/path.mp4" },
        { private: true, lease, content_type: "video/mp4" },
        { private: false, lease },
        { private: true, artifactKind: "private-video-source", artifact },
    ]) {
        await assert.rejects(
            () => adapter.url(record),
            /PRIVACY_PRIVATE_MEDIA_RECORD_INVALID/,
        );
    }
});
