import { describe, expect, it } from "vitest";
import { unzipSync, zipSync } from "fflate";

import {
  buildPackage,
  carriesState,
  isPackageName,
  readPackage,
  PACKAGE_FORMAT,
  STATE_PREFIXES,
} from "../src/share/package.js";
import type { ViewDefinition } from "../src/views/definition.js";
import type { StoredSheet } from "../src/sheets/sheet.js";

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const png = (): Uint8Array => new Uint8Array(PNG_BYTES);

const view = (): ViewDefinition => ({
  id: "v1",
  name: "Fire compartmentation",
  folder: "Reviews",
  description: "",
  filters: [{ label: "Fire doors", mode: "keep", selector: { kind: "class", values: ["IfcDoor"] } }],
  color: { kind: "storey" },
  camera: { position: [1, 2, 3], target: [0, 0, 0] },
  projection: "perspective",
  sections: [],
  box: null,
  xray: null,
  hidden: null,
  offsets: [],
  annotations: [],
  measurements: [],
  categories: { spaces: false, openings: false },
  ghostHidden: false,
  thumbnail: "",
  updatedAt: "2026-08-19T00:00:00.000Z",
});

const sheet = (): StoredSheet => ({
  id: "s1",
  name: "A-101",
  source: "A-101.pdf",
  page: 1,
  pageCount: 2,
  width: 2400,
  height: 1600,
  storey: "Level 1",
  cutHeight: null,
  calibration: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, distance: 5 },
  placement: null,
  markups: [],
  addedAt: 12,
  image: new Blob([new Uint8Array(PNG_BYTES).buffer], { type: "image/png" }),
});

const input = () => ({
  project: "Tower",
  app: "IFCViewX test",
  model: { name: "tower.ifc", bytes: new Uint8Array([73, 83, 79]) },
  views: [view()],
  properties: [{ id: "c1", name: "Fire rating", kind: "coalesce" as const, sources: ["FireRating"] }],
  sheets: [sheet()],
  state: { "ifcviewx.bcf.10-20": '[{"title":"Snag"}]' },
  preview: png(),
});

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decoded = (value: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(value)) as unknown;

describe("the share package", () => {
  it("round-trips everything a handover needs", async () => {
    const contents = readPackage(await buildPackage(input()));
    expect(contents.manifest.format).toBe(PACKAGE_FORMAT);
    expect(contents.manifest.project).toBe("Tower");
    expect(contents.model?.name).toBe("tower.ifc");
    expect([...(contents.model?.bytes ?? [])]).toEqual([73, 83, 79]);
    expect(contents.views[0].name).toBe("Fire compartmentation");
    expect(contents.views[0].filters[0].selector).toEqual({ kind: "class", values: ["IfcDoor"] });
    expect(contents.properties[0].name).toBe("Fire rating");
    expect(contents.sheets[0].record.calibration?.distance).toBe(5);
    expect([...contents.sheets[0].image]).toEqual(PNG_BYTES);
    expect(contents.state["ifcviewx.bcf.10-20"]).toContain("Snag");
    expect(contents.preview).not.toBeNull();
  });

  it("is an ordinary zip whose parts are readable without this application", async () => {
    const files = unzipSync(await buildPackage(input()));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["manifest.json", "views.json", "properties.json", "state.json", "README.txt", "model/tower.ifc"]),
    );
    expect(new TextDecoder().decode(files["README.txt"])).toContain("ordinary zip file");
  });

  it("counts what it carries in the manifest", async () => {
    const contents = readPackage(await buildPackage(input()));
    expect(contents.manifest.counts).toEqual({ views: 1, properties: 1, sheets: 1, state: 1 });
    expect(contents.manifest.model?.bytes).toBe(3);
  });

  it("rejects manifest counts that do not match the structured files", async () => {
    const files = unzipSync(await buildPackage(input()));
    const manifest = decoded(files["manifest.json"]) as Record<string, unknown> & {
      counts: Record<string, number>;
    };
    manifest.counts.views = 2;
    files["manifest.json"] = json(manifest);
    expect(() => readPackage(zipSync(files))).toThrow(/manifest view count/i);
  });

  it("requires the model declaration, filename and byte count to agree", async () => {
    const original = await buildPackage(input());

    const absent = unzipSync(original);
    delete absent["model/tower.ifc"];
    expect(() => readPackage(zipSync(absent))).toThrow(/model.*manifest/i);

    const renamed = unzipSync(original);
    const renamedManifest = decoded(renamed["manifest.json"]) as { model: { name: string; bytes: number } };
    renamedManifest.model.name = "other.ifc";
    renamed["manifest.json"] = json(renamedManifest);
    expect(() => readPackage(zipSync(renamed))).toThrow(/model.*manifest/i);

    const wrongSize = unzipSync(original);
    const sizeManifest = decoded(wrongSize["manifest.json"]) as { model: { name: string; bytes: number } };
    sizeManifest.model.bytes += 1;
    wrongSize["manifest.json"] = json(sizeManifest);
    expect(() => readPackage(zipSync(wrongSize))).toThrow(/model.*manifest/i);
  });

  it("rejects every malformed structured file instead of silently dropping it", async () => {
    const original = await buildPackage(input());
    for (const path of ["views.json", "properties.json", "state.json", "sheets/s1.json"]) {
      const files = unzipSync(original);
      files[path] = new TextEncoder().encode("{");
      expect(() => readPackage(zipSync(files)), path).toThrow(new RegExp(path.replace(".", "\\."), "i"));
    }
  });

  it("keeps the intentional legacy array envelopes for views and computed properties", async () => {
    const files = unzipSync(await buildPackage(input()));
    files["views.json"] = json((decoded(files["views.json"]) as { views: unknown[] }).views);
    files["properties.json"] = json((decoded(files["properties.json"]) as { properties: unknown[] }).properties);
    const contents = readPackage(zipSync(files));
    expect(contents.views).toHaveLength(1);
    expect(contents.properties).toHaveLength(1);
  });

  it("validates sheet records and requires each record/image pair", async () => {
    const original = await buildPackage(input());
    const invalid = unzipSync(original);
    const record = decoded(invalid["sheets/s1.json"]) as Record<string, unknown>;
    record.page = 0;
    invalid["sheets/s1.json"] = json(record);
    expect(() => readPackage(zipSync(invalid))).toThrow(/sheet record/i);

    const orphan = unzipSync(original);
    delete orphan["sheets/s1.png"];
    expect(() => readPackage(zipSync(orphan))).toThrow(/missing its PNG/i);
  });

  it("bounds imported sheet geometry before it reaches CSS or SVG", async () => {
    const original = await buildPackage(input());

    const oversized = unzipSync(original);
    const oversizedRecord = decoded(oversized["sheets/s1.json"]) as Record<string, unknown>;
    oversizedRecord.width = 1_000_000_000;
    oversized["sheets/s1.json"] = json(oversizedRecord);
    expect(() => readPackage(zipSync(oversized))).toThrow(/sheet record/i);

    const remoteMarkup = unzipSync(original);
    const markupRecord = decoded(remoteMarkup["sheets/s1.json"]) as Record<string, unknown>;
    markupRecord.markups = [{
      id: "m1",
      kind: "line",
      points: [{ x: 0, y: 0 }, { x: 1e100, y: 1 }],
      createdAt: "2026-08-21T00:00:00.000Z",
    }];
    remoteMarkup["sheets/s1.json"] = json(markupRecord);
    expect(() => readPackage(zipSync(remoteMarkup))).toThrow(/sheet record/i);
  });

  it("requires PNG signatures at both package image boundaries", async () => {
    const original = await buildPackage(input());

    const sheetImage = unzipSync(original);
    sheetImage["sheets/s1.png"] = new Uint8Array([1, 2, 3, 4]);
    expect(() => readPackage(zipSync(sheetImage))).toThrow(/sheet image.*PNG/i);

    const preview = unzipSync(original);
    preview["preview.png"] = new Uint8Array([1, 2, 3, 4]);
    expect(() => readPackage(zipSync(preview))).toThrow(/preview.*PNG/i);

    await expect(buildPackage({ ...input(), preview: new Uint8Array([1, 2, 3, 4]) }))
      .rejects.toThrow(/preview.*PNG/i);
    const badSheet = sheet();
    badSheet.image = new Blob([new Uint8Array([1, 2, 3, 4]).buffer], { type: "image/png" });
    await expect(buildPackage({ ...input(), sheets: [badSheet] })).rejects.toThrow(/sheet.*PNG/i);
  });

  it("builds a package with no model, for views and rules alone", async () => {
    const contents = readPackage(await buildPackage({ ...input(), model: null, sheets: [], preview: null }));
    expect(contents.model).toBeNull();
    expect(contents.manifest.model).toBeNull();
    expect(contents.views).toHaveLength(1);
  });

  it("refuses a zip that is not a package", () => {
    expect(() => readPackage(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it("rejects directory entries that hide an unpacked payload", async () => {
    const files = unzipSync(await buildPackage(input()));
    files["payload/"] = new Uint8Array(32);
    expect(() => readPackage(zipSync(files))).toThrow(/directory entry contains data/i);
  });

  it("rejects unsupported manifests before restoring any contents", async () => {
    const files = unzipSync(await buildPackage(input()));
    files["manifest.json"] = new TextEncoder().encode(JSON.stringify({
      ...JSON.parse(new TextDecoder().decode(files["manifest.json"])),
      version: 99,
    }));
    expect(() => readPackage(zipSync(files))).toThrow(/version/);
  });

  it("preflights implausibly expanding entries before decompression", () => {
    const bomb = zipSync({
      "manifest.json": new TextEncoder().encode(JSON.stringify({
        format: PACKAGE_FORMAT,
        version: 1,
        createdAt: "2026-01-01T00:00:00Z",
        app: "test",
        project: "test",
        model: null,
        counts: { views: 0, properties: 0, sheets: 0, state: 0 },
        note: "",
      })),
      "sheets/huge.png": new Uint8Array(17 * 1024 * 1024),
    }, { level: 9 });
    expect(() => readPackage(bomb)).toThrow(/expands implausibly/);
  });

  it("keeps a name with no extension usable inside the archive", async () => {
    const files = unzipSync(await buildPackage({ ...input(), model: { name: "a b/c.ifc", bytes: new Uint8Array([1]) } }));
    expect(Object.keys(files).some((name) => name.startsWith("model/") && !name.includes(" "))).toBe(true);
  });
});

describe("what state travels", () => {
  it("carries views, issues, notes, sets and plugin state", () => {
    expect(carriesState("ifcviewx.views.v1")).toBe(true);
    expect(carriesState("ifcviewx.bcf.100-200")).toBe(true);
    expect(carriesState("ifcviewx.plug.rule-studio.ruleset")).toBe(true);
    expect(carriesState("ifcviewx.notes.10-20")).toBe(true);
  });

  it("never carries a provider key or anything outside the allowlist", () => {
    // The assistant's settings live under a different prefix entirely, and an
    // allowlist is what keeps a key added next year out of a shared file.
    expect(carriesState("ifc-studio.llm-settings")).toBe(false);
    expect(carriesState("ifcviewx.opencde.server")).toBe(false);
    expect(carriesState("ifcviewx.settings")).toBe(false);
    expect(STATE_PREFIXES.every((prefix) => prefix.startsWith("ifcviewx."))).toBe(true);
  });

  it("applies the allowlist inside buildPackage, even when a caller does not", async () => {
    const files = unzipSync(await buildPackage({
      ...input(),
      state: {
        "ifcviewx.notes.10-20": "safe",
        "ifc-studio.llm-settings": "provider-secret",
        "ifcviewx.opencde.server": "https://private.example",
        "ifcviewx.plug.python.code": "token = 'do-not-share'",
        "ifcviewx.plug.third-party.secret": "do-not-share",
        "ifcviewx.plug.rule-studio.ruleset": "safe-rules",
      },
    }));
    expect(decoded(files["state.json"])).toEqual({
      "ifcviewx.notes.10-20": "safe",
      "ifcviewx.plug.rule-studio.ruleset": "safe-rules",
    });
    const manifest = decoded(files["manifest.json"]) as { counts: { state: number } };
    expect(manifest.counts.state).toBe(2);
  });

  it("refuses to emit packages that its own reader would reject", async () => {
    await expect(buildPackage({
      ...input(),
      views: [{ ...view(), camera: { position: [0, 0, 0], target: [0, 0, 0] } }],
    })).rejects.toThrow(/view definition is invalid/i);
    await expect(buildPackage({
      ...input(),
      model: { name: "payload.exe", bytes: new Uint8Array([1]) },
    })).rejects.toThrow(/IFC or IFCX/i);
  });

  it("drops unapproved imported keys but rejects malformed approved values", async () => {
    const original = await buildPackage(input());
    const sanitized = unzipSync(original);
    sanitized["state.json"] = json({
      "ifcviewx.bcf.10-20": '[{"title":"Snag"}]',
      "ifc-studio.llm-settings": "provider-secret",
    });
    expect(readPackage(zipSync(sanitized)).state).toEqual({
      "ifcviewx.bcf.10-20": '[{"title":"Snag"}]',
    });

    const malformed = unzipSync(original);
    malformed["state.json"] = json({ "ifcviewx.bcf.10-20": { title: "not serialized" } });
    expect(() => readPackage(zipSync(malformed))).toThrow(/state entry is invalid/i);
  });
});

describe("recognizing a package", () => {
  it("knows one by its extension", () => {
    expect(isPackageName("handover.ifcpkg")).toBe(true);
    expect(isPackageName("handover.IFCPKG")).toBe(true);
    expect(isPackageName("model.ifc")).toBe(false);
  });
});
