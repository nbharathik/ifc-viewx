// The privacy panel is only worth having if its numbers are true and its
// delete buttons delete. These cover the inventory's arithmetic and, more
// importantly, that clearing the key leaves the provider choice behind and
// that "delete everything" really does reach every namespaced key.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_KEY } from "../src/llm/llmClient.js";
import {
  APP_PREFIX,
  forgetApiKey,
  formatBytes,
  hasStoredKey,
  LLM_SETTINGS_KEY,
  PrivacyPanel,
  storageInventory,
} from "../src/ui/privacy.js";

const area = async (id: string) => (await storageInventory()).find((entry) => entry.id === id)!;

// jsdom ships <dialog> without the modal machinery, and confirmAction opens a
// real one. Same shim the BCF tests use.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement): void {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement): void {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

describe("privacy inventory", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
  });

  it("names the same key the assistant actually writes to", () => {
    expect(LLM_SETTINGS_KEY).toBe(SETTINGS_KEY);
  });

  it("reports no key when the record has none", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ provider: "anthropic", model: "x", apiKey: "" }));

    expect(hasStoredKey()).toBe(false);
    expect((await area("key")).present).toBe(false);
  });

  it("reports a key when one is stored, and marks it as the sensitive one", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ provider: "anthropic", model: "x", apiKey: "sk-real" }));

    const key = await area("key");
    expect(key.present).toBe(true);
    expect(key.sensitive).toBe(true);
    expect(key.where).toContain(SETTINGS_KEY);
  });

  it("clears the key but keeps the provider and model", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ provider: "anthropic", model: "opus", apiKey: "sk-real" }));

    forgetApiKey();

    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)!) as Record<string, unknown>;
    expect(stored.apiKey).toBe("");
    expect(stored.provider).toBe("anthropic");
    expect(stored.model).toBe("opus");
    expect(hasStoredKey()).toBe(false);
  });

  it("counts conversations apart from the rest of the saved work", async () => {
    localStorage.setItem("ifcviewx.chats", JSON.stringify([{ id: 1 }]));
    localStorage.setItem("ifcviewx.views.v1", JSON.stringify([{ name: "Fire" }]));
    localStorage.setItem("ifcviewx.theme", "dark");

    const chats = await area("chats");
    const work = await area("work");
    expect(chats.items).toBe(1);
    expect(work.items).toBe(2);
    expect(work.present).toBe(true);
  });

  it("ignores keys that are not this viewer's", async () => {
    localStorage.setItem("some-other-app", "x".repeat(500));

    const work = await area("work");
    expect(work.items).toBe(0);
    expect(work.bytes).toBe(0);
  });

  it("deleting one area leaves the others alone", async () => {
    localStorage.setItem("ifcviewx.chats", "[]");
    localStorage.setItem("ifcviewx.views.v1", "[]");

    await (await area("chats")).clear();

    expect(localStorage.getItem("ifcviewx.chats")).toBeNull();
    expect(localStorage.getItem("ifcviewx.views.v1")).not.toBeNull();
  });
});

describe("delete everything", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
  });

  it("removes every namespaced key and the assistant record", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey: "sk-real" }));
    localStorage.setItem("ifcviewx.chats", "[]");
    localStorage.setItem("ifcviewx.views.v1", "[]");
    localStorage.setItem("ifcviewx.plug.clash.decisions", "{}");
    localStorage.setItem("unrelated", "keep me");

    const changed = vi.fn();
    const panel = new PrivacyPanel({ paths: () => null, changed });
    document.body.appendChild(panel.root);
    await panel.refresh();

    panel.root.querySelector<HTMLButtonElement>(".btn.danger")!.click();
    // confirmAction renders its own dialog; the confirm is the primary button.
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("dialog .btn.primary")].pop()!;
    confirm.click();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());

    for (const key of [SETTINGS_KEY, "ifcviewx.chats", "ifcviewx.views.v1", "ifcviewx.plug.clash.decisions"]) {
      expect(localStorage.getItem(key)).toBeNull();
    }
    expect(localStorage.getItem("unrelated")).toBe("keep me");
  });

  it("shows Local Studio's real paths when a service reports them", async () => {
    const panel = new PrivacyPanel({
      paths: () => ({ store: "/home/u/.cache/ifcviewx/models", state: "/home/u/.cache/ifcviewx" }),
    });
    document.body.appendChild(panel.root);
    await panel.refresh();

    const paths = [...panel.root.querySelectorAll(".privacy-path")].map((node) => node.textContent);
    expect(paths).toContain("/home/u/.cache/ifcviewx/models");
    expect(paths).toContain("/home/u/.cache/ifcviewx");
  });

  it("says nothing about folders in the browser, because there are none", async () => {
    const panel = new PrivacyPanel({ paths: () => null });
    document.body.appendChild(panel.root);
    await panel.refresh();

    expect(panel.root.querySelector(".privacy-path")).toBeNull();
    expect(panel.root.textContent).not.toContain("Local Studio, on this computer");
  });
});

describe("byte formatting", () => {
  it("reads as a size a person would say out loud", () => {
    expect(formatBytes(0)).toBe("empty");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 GB");
  });
});

describe("namespace", () => {
  it("is the prefix every viewer key actually uses", () => {
    expect(APP_PREFIX).toBe("ifcviewx.");
  });
});
