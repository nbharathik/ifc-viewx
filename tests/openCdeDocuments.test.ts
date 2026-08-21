import { describe, expect, it, vi } from "vitest";

import { OpenCdeClient, type OpenCdeFetch } from "../src/opencde/client.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const VERSIONS = {
  versions: [
    { api_id: "foundation", version_id: "1.0", api_base_url: "https://cde.test/foundation/1.0" },
    { api_id: "bcf", version_id: "3.0", api_base_url: "https://cde.test/bcf/3.0" },
    { api_id: "documents", version_id: "1.0", api_base_url: "https://cde.test/documents/1.0" },
  ],
};

async function connected(handler: OpenCdeFetch): Promise<OpenCdeClient> {
  const client = new OpenCdeClient(handler);
  await client.connect("cde.test", { kind: "bearer", token: "t" });
  return client;
}

describe("the documents half of a CDE link", () => {
  it("discovers the Documents API when the server advertises it", async () => {
    const client = await connected(async () => json(VERSIONS));
    expect(client.hasDocuments()).toBe(true);
    expect(client.getSession()?.documentsBaseUrl).toBe("https://cde.test/documents/1.0");
  });

  it("says plainly when a server has no Documents API", async () => {
    const client = await connected(async () =>
      json({ versions: VERSIONS.versions.filter((entry) => entry.api_id !== "documents") }));
    expect(client.hasDocuments()).toBe(false);
    await expect(client.documents()).rejects.toThrow(/Documents API/);
  });

  it("reads a register whichever way the server spells its fields", async () => {
    const client = await connected(async (input) => {
      const url = String(input);
      if (url.endsWith("/foundation/versions")) return json(VERSIONS);
      if (url.endsWith("/documents")) {
        return json({
          documents: [
            { guid: "d1", file_name: "arch.ifc", version: "R3", file_size: 12, _links: { download: { href: "https://cde.test/blob/1" } } },
            { document_guid: "d2", name: "mep.ifc", version_id: "R7", size: 34, content_url: "https://cde.test/blob/2" },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const documents = await client.documents();
    expect(documents).toHaveLength(2);
    expect(documents[0]).toMatchObject({ guid: "d1", name: "arch.ifc", version: "R3", downloadUrl: "https://cde.test/blob/1" });
    expect(documents[1]).toMatchObject({ guid: "d2", name: "mep.ifc", version: "R7", downloadUrl: "https://cde.test/blob/2" });
  });

  it("treats a server with no listing as empty rather than as an error", async () => {
    const client = await connected(async (input) =>
      String(input).endsWith("/foundation/versions") ? json(VERSIONS) : json({}, 404));
    expect(await client.documents()).toEqual([]);
  });

  it("lists the versions of one document", async () => {
    const client = await connected(async (input) => {
      const url = String(input);
      if (url.endsWith("/foundation/versions")) return json(VERSIONS);
      if (url.endsWith("/documents/d1/versions")) {
        return json({ versions: [{ guid: "v2", name: "arch.ifc", version: "R4" }, { guid: "v1", name: "arch.ifc", version: "R3" }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const versions = await client.documentVersions("d1");
    expect(versions.map((entry) => entry.version)).toEqual(["R4", "R3"]);
  });

  it("resolves a reference URL and falls back to it when no download link is given", async () => {
    const client = await connected(async (input) =>
      String(input).endsWith("/foundation/versions") ? json(VERSIONS) : json({ guid: "d9", file_name: "bridge.ifc" }));
    const document_ = await client.documentReference("https://cde.test/ref/d9");
    expect(document_.name).toBe("bridge.ifc");
    expect(document_.downloadUrl).toBe("https://cde.test/ref/d9");
  });

  it("downloads the bytes and prefers the name the server attached", async () => {
    const client = await connected(async (input) => {
      const url = String(input);
      if (url.endsWith("/foundation/versions")) return json(VERSIONS);
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-disposition": 'attachment; filename="arch-R4.ifc"' },
      });
    });
    const content = await client.documentContent({ guid: "d1", name: "fallback.ifc", downloadUrl: "https://cde.test/blob/1" });
    expect(content.name).toBe("arch-R4.ifc");
    expect([...content.bytes]).toEqual([1, 2, 3]);
  });

  it("keeps server filenames as leaf names and rejects oversized downloads before reading", async () => {
    const client = await connected(async (input) => {
      if (String(input).endsWith("/foundation/versions")) return json(VERSIONS);
      if (String(input).endsWith("/large")) {
        return new Response(new Uint8Array([1]), { headers: { "content-length": String(800 * 1024 * 1024) } });
      }
      return new Response(new Uint8Array([1]), {
        headers: { "content-disposition": 'attachment; filename="../../arch.ifc"' },
      });
    });
    const safe = await client.documentContent({ guid: "d", name: "fallback", downloadUrl: "https://cde.test/file" });
    expect(safe.name).toBe("arch.ifc");
    await expect(client.documentContent({ guid: "d", name: "large", downloadUrl: "https://cde.test/large" }))
      .rejects.toMatchObject({ code: "response_too_large" });
  });

  it("carries the authorization the session was opened with", async () => {
    const seen: Array<Headers> = [];
    const client = await connected(async (input, init) => {
      seen.push(new Headers(init?.headers));
      return String(input).endsWith("/foundation/versions") ? json(VERSIONS) : new Response(new Uint8Array([9]));
    });
    await client.documentContent({ guid: "d", name: "x", downloadUrl: "https://cde.test/blob/9" });
    expect(seen[seen.length - 1].get("Authorization")).toBe("Bearer t");
  });

  it("never forwards CDE credentials to cross-origin reference or download URLs", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const client = await connected(async (input, init) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
      if (url.endsWith("/foundation/versions")) return json(VERSIONS);
      if (url === "https://documents.example/ref/9") {
        return json({ guid: "d9", name: "external.ifc", download_url: "https://objects.example/files/9" });
      }
      return new Response(new Uint8Array([9]));
    });

    const document_ = await client.documentReference("https://documents.example/ref/9");
    await client.documentContent(document_);

    expect(seen.find((entry) => entry.url === "https://documents.example/ref/9")?.authorization).toBeNull();
    expect(seen.find((entry) => entry.url === "https://objects.example/files/9")?.authorization).toBeNull();
  });

  it("resolves relative document links against the metadata URL", async () => {
    const client = await connected(async (input) => {
      const url = String(input);
      if (url.endsWith("/foundation/versions")) return json(VERSIONS);
      return json({ guid: "d9", name: "relative.ifc", _links: { download: { href: "../content/9" } } });
    });

    const document_ = await client.documentReference("https://cde.test/documents/1.0/references/9");

    expect(document_.downloadUrl).toBe("https://cde.test/documents/1.0/content/9");
  });

  it("rejects insecure remote document URLs before fetching them", async () => {
    const fetcher = vi.fn(async () => json(VERSIONS));
    const client = await connected(fetcher as unknown as OpenCdeFetch);

    await expect(client.documentReference("http://documents.example/ref/9")).rejects.toMatchObject({
      code: "insecure_document_url",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses to download a document that says nothing about where it is", async () => {
    const client = await connected(async () => json(VERSIONS));
    await expect(client.documentContent({ guid: "d", name: "x" })).rejects.toThrow(/where its content is/);
  });

  it("does not reach the network at all before a session exists", async () => {
    const fetcher = vi.fn(async () => json({}));
    const client = new OpenCdeClient(fetcher as unknown as OpenCdeFetch);
    await expect(client.documents()).rejects.toThrow(/Connect to an OpenCDE server/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
