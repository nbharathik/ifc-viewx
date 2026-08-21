import { describe, expect, it, vi } from "vitest";
import {
  OpenCdeClient,
  OpenCdeEndpointTrustError,
  type OpenCdeAuth,
  type OpenCdeFetch,
} from "../src/opencde/client.js";

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("OpenCDE client", () => {
  it("discovers BCF 3.0 publicly and authenticates project requests", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: OpenCdeFetch = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/foundation/versions")) return response({ versions: [
        { api_id: "foundation", version_id: "1.0", api_base_url: "https://cde.test/foundation/1.0" },
        { api_id: "bcf", version_id: "3.0", api_base_url: "https://cde.test/bcf/3.0" },
      ] });
      if (url.includes("/projects?") && init?.method !== "POST") return response([
        { project_id: "p1", name: "Hospital" },
      ]);
      if (url.endsWith("/projects/p1/extensions")) return response({ topic_status: ["Open", "Done"] });
      if (url.includes("/projects/p1/topics?") && !init?.method) return response([{ guid: "t1", title: "Door clearance" }]);
      if (url.endsWith("/projects/p1/topics") && init?.method === "POST") {
        return response({ ...JSON.parse(String(init.body)), server_assigned_id: "42" }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OpenCdeClient(fetcher);

    await client.connect("cde.test", { kind: "bearer", token: "secret-token" });
    expect((calls[0].init?.headers as Headers).get("Authorization")).toBeNull();
    expect(await client.projects()).toEqual([{ project_id: "p1", name: "Hospital" }]);
    expect((calls[1].init?.headers as Headers).get("Authorization")).toBe("Bearer secret-token");
    expect(await client.projectExtensions("p1")).toMatchObject({ topic_status: ["Open", "Done"] });
    expect(await client.topics("p1")).toHaveLength(1);
    const created = await client.createTopic("p1", { guid: "t2", title: "New issue" });
    expect(created.server_assigned_id).toBe("42");
    const createHeaders = calls.at(-1)?.init?.headers as Headers;
    expect(createHeaders.get("Content-Type")).toBe("application/json");
  });

  it("requires confirmation before credentials reach an advertised origin", async () => {
    const fetcher: OpenCdeFetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/foundation/versions")) return response({ versions: [
        { api_id: "foundation", version_id: "1.0", api_base_url: "https://api.vendor.test/foundation/1.0" },
        { api_id: "bcf", version_id: "3.0", api_base_url: "https://api.vendor.test/bcf/3.0" },
      ] });
      if (url.includes("/projects?")) {
        expect((init?.headers as Headers).get("Authorization")).toBe("Bearer token");
        return response([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OpenCdeClient(fetcher);

    await expect(client.connect("https://portal.vendor.test", { kind: "bearer", token: "token" }))
      .rejects.toBeInstanceOf(OpenCdeEndpointTrustError);
    await client.connect(
      "https://portal.vendor.test",
      { kind: "bearer", token: "token" },
      { trustAdvertisedOrigins: true },
    );
    await client.projects();
  });

  it("rejects insecure remote servers before making a request", async () => {
    const fetcher: OpenCdeFetch = vi.fn();
    const client = new OpenCdeClient(fetcher);
    await expect(client.connect("http://cde.example.com", { kind: "none" }))
      .rejects.toMatchObject({ code: "insecure_server" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not expose mutable session or authentication state", async () => {
    const calls: Array<{ url: string; headers: Headers; redirect?: RequestRedirect }> = [];
    const fetcher: OpenCdeFetch = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
      if (url.endsWith("/foundation/versions")) return response({ versions: [
        { api_id: "foundation", version_id: "1.0", api_base_url: "https://cde.test/foundation/1.0" },
        { api_id: "bcf", version_id: "3.0", api_base_url: "https://cde.test/bcf/3.0" },
      ] });
      return response([]);
    });
    const auth: OpenCdeAuth = { kind: "bearer", token: "original" };
    const client = new OpenCdeClient(fetcher);

    const returned = await client.connect("cde.test", auth);
    returned.bcfBaseUrl = "https://attacker.test/bcf";
    returned.versions[0].api_base_url = "https://attacker.test/foundation";
    auth.token = "mutated";
    const snapshot = client.getSession()!;
    snapshot.bcfBaseUrl = "https://attacker.test/again";
    await client.projects();

    expect(calls.at(-1)?.url).toContain("https://cde.test/bcf/3.0/projects");
    expect(calls.at(-1)?.headers.get("Authorization")).toBe("Bearer original");
    expect(calls.at(-1)?.redirect).toBe("error");
  });

  it("does not send a request for an already-aborted operation", async () => {
    const fetcher = vi.fn<OpenCdeFetch>(async (input) => String(input).endsWith("/foundation/versions")
      ? response({ versions: [
        { api_id: "foundation", version_id: "1.0", api_base_url: "https://cde.test/foundation/1.0" },
        { api_id: "bcf", version_id: "3.0", api_base_url: "https://cde.test/bcf/3.0" },
      ] })
      : response([]));
    const client = new OpenCdeClient(fetcher);
    await client.connect("cde.test", { kind: "none" });
    const controller = new AbortController();
    controller.abort();

    await expect(client.projects(controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("prevents an older connection response from replacing a newer session", async () => {
    const pending = new Map<string, (response: Response) => void>();
    const fetcher: OpenCdeFetch = vi.fn(async (input) => new Promise<Response>((resolve) => {
      pending.set(new URL(String(input)).hostname, resolve);
    }));
    const versions = (host: string) => response({ versions: [
      { api_id: "foundation", version_id: "1.0", api_base_url: `https://${host}/foundation/1.0` },
      { api_id: "bcf", version_id: "3.0", api_base_url: `https://${host}/bcf/3.0` },
    ] });
    const client = new OpenCdeClient(fetcher);
    const older = client.connect("older.test", { kind: "none" });
    const olderOutcome = older.then(() => null, (error: unknown) => error);
    const newer = client.connect("newer.test", { kind: "none" });

    await vi.waitFor(() => expect([...pending.keys()].sort()).toEqual(["newer.test", "older.test"]));
    pending.get("newer.test")!(versions("newer.test"));
    await newer;
    pending.get("older.test")!(versions("older.test"));
    await expect(olderOutcome).resolves.toMatchObject({ code: "connection_superseded" });
    expect(client.getSession()?.serverUrl).toBe("https://newer.test");
  });
});
