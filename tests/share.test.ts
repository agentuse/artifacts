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
