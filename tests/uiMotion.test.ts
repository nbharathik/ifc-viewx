// The motion layer has to stay correct when nothing actually animates: that is
// every headless run, and it is also what a reduced-motion user gets. These
// cover the two helpers whose contract is "behave synchronously when there is
// no animation to wait for", plus the pill's refusal to paint at zero size.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fadeOut, slidingPill, swapText } from "../src/ui/kit.js";

describe("exit motion", () => {
  beforeEach(() => document.body.replaceChildren());

  it("removes a node at once when nothing is animating", () => {
    const node = document.createElement("div");
    document.body.appendChild(node);

    fadeOut(node);

    expect(node.isConnected).toBe(false);
  });

  it("marks the node and waits when an animation is running", async () => {
    const node = document.createElement("div");
    document.body.appendChild(node);
    let settle = (): void => undefined;
    const finished = new Promise<void>((resolve) => (settle = resolve));
    Object.defineProperty(node, "getAnimations", {
      configurable: true,
      value: () => [{ finished }],
    });

    fadeOut(node);
    expect(node.classList.contains("closing")).toBe(true);
    expect(node.isConnected).toBe(true);

    settle();
    // Promise.all plus its .then sit two microtask turns behind the animation,
    // so awaiting the animation alone is one turn too early.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(node.isConnected).toBe(false);
  });

  it("takes the node at once when the tab is in the background", () => {
    const node = document.createElement("div");
    document.body.appendChild(node);
    Object.defineProperty(node, "getAnimations", {
      configurable: true,
      value: () => [{ finished: new Promise<void>(() => undefined) }],
    });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);

    fadeOut(node);

    // A background tab stops advancing animations, so the promise above is the
    // one that never settles.
    expect(node.isConnected).toBe(false);
    hidden.mockRestore();
  });

  it("uses the class the caller asked for", () => {
    const node = document.createElement("div");
    document.body.appendChild(node);

    fadeOut(node, "gone");

    expect(node.classList.contains("gone")).toBe(true);
  });
});

describe("live value swap", () => {
  beforeEach(() => document.body.replaceChildren());

  it("writes the new value and animates it in", () => {
    const node = document.createElement("span");
    node.textContent = "4 selected";
    document.body.appendChild(node);
    const animate = vi.fn();
    Object.defineProperty(node, "animate", { configurable: true, value: animate });

    swapText(node, "9 selected");

    expect(node.textContent).toBe("9 selected");
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when the value is unchanged", () => {
    const node = document.createElement("span");
    node.textContent = "9 selected";
    document.body.appendChild(node);
    const animate = vi.fn();
    Object.defineProperty(node, "animate", { configurable: true, value: animate });

    swapText(node, "9 selected");

    expect(animate).not.toHaveBeenCalled();
  });
});

describe("segmented control pill", () => {
  beforeEach(() => document.body.replaceChildren());

  function seg(): HTMLElement {
    const root = document.createElement("div");
    root.className = "seg";
    for (const label of ["Tree", "Types", "Organize"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-pressed", String(label === "Tree"));
      root.appendChild(button);
    }
    document.body.appendChild(root);
    return root;
  }

  it("adds one pill ahead of the options", () => {
    const root = seg();

    slidingPill(root);

    const pill = root.querySelector(".seg-pill");
    expect(pill).not.toBeNull();
    expect(root.firstElementChild).toBe(pill);
    expect(pill?.getAttribute("aria-hidden")).toBe("true");
  });

  it("never installs a second pill on the same control", () => {
    const root = seg();

    slidingPill(root);
    slidingPill(root);

    expect(root.querySelectorAll(".seg-pill")).toHaveLength(1);
  });

  it("parks the pill rather than drawing it where nothing has been laid out", () => {
    const root = seg();

    slidingPill(root);

    // jsdom measures every element at zero, which is the same signal a
    // collapsed panel gives in a real browser.
    expect(root.querySelector<HTMLElement>(".seg-pill")!.style.opacity).not.toBe("1");
  });

  it("leaves the options themselves untouched", () => {
    const root = seg();

    slidingPill(root);

    const pressed = [...root.querySelectorAll("button")].map((b) => b.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["true", "false", "false"]);
  });
});
