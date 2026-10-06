import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitArtifact } from "../src/store";
import { allowShareRequest, isSharingConfigured, shareArtifact } from "../src/share";
import { rmStorageRoot, tempProjectDir, tempStorageRoot } from "./helpers";

const shared = { id: `shr_${"a".repeat(32)}`, url: `https://share.example.com/s/${"b".repeat(43)}` };
let root: string;
let project: string;
beforeEach(() => {
  root = tempStorageRoot(); project = tempProjectDir();
  vi.stubEnv("ARTIFACTS_CLOUD_URL", "https://api.example.com");
  vi.stubEnv("ARTIFACTS_CLOUD_API_KEY", "test-key");
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmStorageRoot(root); fs.rmSync(project, { recursive: true, force: true });
});

async function artifact() {
  fs.mkdirSync(path.join(project, "supplements"));
  fs.writeFileSync(path.join(project, "index.html"), '<h1>Report</h1><a href="supplements/data.csv">Data</a>');
  fs.writeFileSync(path.join(project, "supplements/data.csv"), "company,total\nAcme,42");
  fs.writeFileSync(path.join(project, "supplements/appendix.pdf"), "%PDF-sample");
  return (await submitArtifact({ target: project })).entry;
}

describe("shareArtifact", () => {
  it("uploads the immutable stored bundle with supplementary files, never the later source", async () => {
    const entry = await artifact();
    expect(entry.files).toBe(3);
    fs.writeFileSync(path.join(project, "supplements/data.csv"), "Changed after submission");
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({ authorization: "Bearer test-key" });
      const form = init.body as FormData;
      const manifest = JSON.parse(String(form.get("manifest")));
      expect(manifest).not.toHaveProperty("sourcePath");
      expect(JSON.stringify(manifest)).not.toContain(project);
      const csv = manifest.files.find((f: { path: string }) => f.path === "supplements/data.csv");
      expect(await (form.get(csv.part) as Blob).text()).toBe("company,total\nAcme,42");
      return Response.json(shared, { status: 201 });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await shareArtifact(entry)).toEqual(shared);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const cache = fs.readdirSync(path.join(root, "share-cache"))[0]!;
    expect(fs.statSync(path.join(root, "share-cache", cache)).mode & 0o777).toBe(0o600);
  });
  it("coalesces concurrent clicks and reuses an active cloud share after checking status", async () => {
    const entry = await artifact();
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST"
      ? Response.json(shared, { status: 201 }) : Response.json({ status: "active" }));
    vi.stubGlobal("fetch", fetcher);
    const result = await Promise.all([shareArtifact(entry), shareArtifact(entry)]);
    expect(result).toEqual([shared, shared]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await shareArtifact(entry)).toEqual(shared);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("reuploads after revocation and reports authentication errors without caching failure", async () => {
    const entry = await artifact();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(shared, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ status: "revoked" }))
      .mockResolvedValueOnce(Response.json(shared, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    await shareArtifact(entry);
    await shareArtifact(entry);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(shareArtifact(entry)).rejects.toThrow(/API key was rejected/);
  });
  it("does not send credentials to insecure cloud URLs or accept executable result URLs", async () => {
    const entry = await artifact();
    const fetcher = vi.fn(async () => Response.json({ ...shared, url: "javascript:alert(1)" }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("ARTIFACTS_CLOUD_URL", "http://untrusted.example");
    await expect(shareArtifact(entry)).rejects.toThrow(/HTTPS/);
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv("ARTIFACTS_CLOUD_URL", "https://api.example.com");
    await expect(shareArtifact(entry)).rejects.toThrow(/invalid link/);
  });
});

describe("share request boundary", () => {
  const headers = { host: "127.0.0.1:7878", "content-type": "application/json", "x-artifacts-share": "1", origin: "http://localhost:5173" };
  it("accepts the local viewer and rejects forms, remote origins, and rebinding hosts", () => {
    expect(allowShareRequest({ headers })).toBe(true);
    expect(allowShareRequest({ headers: { ...headers, "x-artifacts-share": undefined } })).toBe(false);
    expect(allowShareRequest({ headers: { ...headers, "content-type": "text/plain" } })).toBe(false);
    expect(allowShareRequest({ headers: { ...headers, origin: "https://attacker.example" } })).toBe(false);
    expect(allowShareRequest({ headers: { ...headers, host: "attacker.example" } })).toBe(false);
    expect(allowShareRequest({ headers: { ...headers, origin: "null" } })).toBe(false);
  });
  it("accepts the viewer served through Tailscale only from its own https origin", () => {
    const tailnet = { ...headers, host: "artifacts-m5.dog-snapper.ts.net", origin: "https://artifacts-m5.dog-snapper.ts.net" };
    expect(allowShareRequest({ headers: tailnet })).toBe(true);
    expect(allowShareRequest({ headers: { ...tailnet, origin: undefined } })).toBe(false);
    // Same-origin GETs (the share list) carry no Origin, only Sec-Fetch-Site.
    expect(allowShareRequest({ headers: { ...tailnet, origin: undefined, "sec-fetch-site": "same-origin" } })).toBe(true);
    expect(allowShareRequest({ headers: { ...tailnet, origin: undefined, "sec-fetch-site": "cross-site" } })).toBe(false);
    expect(allowShareRequest({ headers: { ...tailnet, origin: "http://artifacts-m5.dog-snapper.ts.net" } })).toBe(false);
    expect(allowShareRequest({ headers: { ...tailnet, origin: "https://other.dog-snapper.ts.net" } })).toBe(false);
    expect(allowShareRequest({ headers: { ...tailnet, origin: "null" } })).toBe(false);
    expect(allowShareRequest({ headers: { ...tailnet, host: "ts.net.attacker.example", origin: "https://ts.net.attacker.example" } })).toBe(false);
    expect(allowShareRequest({ headers: { ...tailnet, "x-artifacts-share": undefined } })).toBe(false);
  });
});

it("advertises sharing only when the cloud URL and a nonblank key are configured", () => {
  expect(isSharingConfigured()).toBe(true);
  vi.stubEnv("ARTIFACTS_CLOUD_API_KEY", "   ");
  expect(isSharingConfigured()).toBe(false);
  vi.stubEnv("ARTIFACTS_CLOUD_API_KEY", "test-key");
  vi.stubEnv("ARTIFACTS_CLOUD_URL", "");
  expect(isSharingConfigured()).toBe(false);
  vi.stubEnv("ARTIFACTS_CLOUD_URL", "http://unsafe.example");
  expect(isSharingConfigured()).toBe(false);
});

it("tracks publication across revisions and updates the existing URL only on click", async () => {
  const { sharingState } = await import("../src/share");
  const first = await artifact();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method
    ? Response.json(shared) : Response.json({ status: "active" }));
  vi.stubGlobal("fetch", fetcher);
  expect(sharingState(first).state).toBe("share");
  await shareArtifact(first);
  expect(sharingState(first)).toEqual({ state: "shared", url: shared.url });
  fs.writeFileSync(path.join(project, "supplements/data.csv"), "updated supplement");
  const next = (await submitArtifact({ target: project })).entry;
  expect(sharingState(next).state).toBe("update");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await shareArtifact(next)).toEqual(shared);
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`https://api.example.com/v1/shares/${shared.id}`);
  expect(fetcher.mock.calls.at(-1)?.[1].method).toBe("PUT");
  expect(sharingState(next).state).toBe("shared");
  // Navigating to an older revision must not offer to roll back the cloud copy.
  expect(sharingState(first).state).toBe("shared");
});

it("keeps Update state after a failed publication", async () => {
  const { sharingState } = await import("../src/share");
  const first = await artifact();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(shared)));
  await shareArtifact(first);
  fs.writeFileSync(path.join(project, "index.html"), "<h1>Changed</h1>");
  const next = (await submitArtifact({ target: project })).entry;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => init.method === "PUT"
    ? new Response(null, { status: 500 }) : Response.json({ status: "active" })));
  await expect(shareArtifact(next)).rejects.toThrow();
  expect(sharingState(next)).toEqual({ state: "update", url: shared.url });
});

it("adopts existing per-revision share caches without creating another URL", async () => {
  const { createHash } = await import("node:crypto");
  const { sharingState } = await import("../src/share");
  const first = await artifact();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const oldScope = hash(JSON.stringify([root, first.id, first.contentHash, "https://api.example.com", hash("test-key")]));
  fs.mkdirSync(path.join(root, "share-cache"));
  fs.writeFileSync(path.join(root, "share-cache", `${oldScope}.json`), JSON.stringify(shared));
  expect(sharingState(first)).toEqual({ state: "shared", url: shared.url });
  fs.writeFileSync(path.join(project, "index.html"), "<h1>New revision</h1>");
  const next = (await submitArtifact({ target: project })).entry;
  expect(sharingState(next)).toEqual({ state: "update", url: shared.url });
});

it("sends artifact identity and revision without leaking local paths", async () => {
  const entry = await artifact();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const manifest = JSON.parse(String((init.body as FormData).get("manifest")));
    expect(manifest.artifact).toEqual({ projectId: entry.projectId, slug: entry.slug, revision: entry.rev });
    expect(JSON.stringify(manifest)).not.toContain(project);
    return Response.json(shared);
  }));
  await shareArtifact(entry);
});

it("removal invalidates cached button state while retaining the local artifact", async () => {
  const { removeSharedArtifact, sharingState } = await import("../src/share");
  const entry = await artifact();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => init.method === "DELETE"
    ? new Response(null, { status: 204 }) : Response.json(shared)));
  await shareArtifact(entry);
  expect(sharingState(entry).state).toBe("shared");
  await removeSharedArtifact(shared.id);
  expect(sharingState(entry).state).toBe("share");
  expect(fs.existsSync(path.join(project, "index.html"))).toBe(true);
});

it("backfills only cloud shares whose fingerprint matches the cached local snapshot", async () => {
  const { listSharedArtifacts } = await import("../src/share");
  const { createHash } = await import("node:crypto");
  const entry = await artifact();
  let fingerprint = "";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { artifact: _metadata, ...manifest } = JSON.parse(String((init.body as FormData).get("manifest")));
    fingerprint = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    return Response.json(shared);
  }));
  await shareArtifact(entry);
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method === "PATCH"
    ? new Response(null, { status: 204 })
    : Response.json({ shares: [{ ...shared, status: "active", artifact: null, fingerprint }], nextCursor: null }));
  vi.stubGlobal("fetch", fetcher);
  expect((await listSharedArtifacts()).shares[0]?.artifact?.revision).toBe(entry.rev);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fingerprint = "mismatch";
  fetcher.mockClear();
  expect((await listSharedArtifacts()).shares[0]?.artifact).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

describe("syncSharedArtifacts", () => {
  it("pushes a new revision of a shared artifact to its existing link and leaves unshared ones alone", async () => {
    const { sharingState, syncSharedArtifacts } = await import("../src/share");
    const first = await artifact();
    const other = path.join(tempProjectDir(), "notes.md");
    fs.writeFileSync(other, "# Never shared");
    await submitArtifact({ target: other });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(shared)));
    await shareArtifact(first);
    fs.writeFileSync(path.join(project, "index.html"), "<h1>Dashboard v2</h1>");
    const next = (await submitArtifact({ target: project })).entry;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method
      ? Response.json(shared) : Response.json({ status: "active" }));
    vi.stubGlobal("fetch", fetcher);
    expect(await syncSharedArtifacts()).toEqual({ updated: 1, failed: [] });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [`https://api.example.com/v1/shares/${shared.id}`, undefined],
      [`https://api.example.com/v1/shares/${shared.id}`, "PUT"],
    ]);
    expect(sharingState(next)).toEqual({ state: "shared", url: shared.url });
    expect(await syncSharedArtifacts()).toEqual({ updated: 0, failed: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fs.rmSync(path.dirname(other), { recursive: true, force: true });
  });

  it("never re-creates a link that was revoked in the cloud", async () => {
    const { sharingState, syncSharedArtifacts } = await import("../src/share");
    const first = await artifact();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(shared)));
    await shareArtifact(first);
    fs.writeFileSync(path.join(project, "index.html"), "<h1>Changed</h1>");
    const next = (await submitArtifact({ target: project })).entry;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method
      ? Response.json(shared) : Response.json({ status: "revoked" }));
    vi.stubGlobal("fetch", fetcher);
    expect(await syncSharedArtifacts()).toEqual({ updated: 0, failed: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sharingState(next).state).toBe("share");
  });

  it("reports a failed push and keeps the card in Update", async () => {
    const { sharingState, syncSharedArtifacts } = await import("../src/share");
    const first = await artifact();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(shared)));
    await shareArtifact(first);
    fs.writeFileSync(path.join(project, "index.html"), "<h1>Changed</h1>");
    const next = (await submitArtifact({ target: project })).entry;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => init.method === "PUT"
      ? new Response(null, { status: 500 }) : Response.json({ status: "active" })));
    const { failed } = await syncSharedArtifacts();
    expect(failed.map(f => f.entry.id)).toEqual([next.id]);
    expect(sharingState(next).state).toBe("update");
  });
});
