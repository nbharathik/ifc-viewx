import { describe, expect, it, vi } from "vitest";
import { ViewTransactionManager } from "../src/assistant/viewTransactions.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

describe("assistant view transactions", () => {
  it("restores camera, visibility, sections, selection and added measurements once", () => {
    const viewer = {
      getCamera: vi.fn(() => ({ position: [4, 5, 6], target: [1, 2, 3] })),
      getSelectedIds: vi.fn(() => [12, 13]),
      getRules: vi.fn(() => [{ label: "Level 1", mode: "keep", ids: [12, 13] }]),
      getHiddenIds: vi.fn(() => [21]),
      getSections: vi.fn(() => [{ axis: "z", offset: 2, flip: false }]),
      getSectionBox: vi.fn(() => null),
      isPlanView: vi.fn(() => true),
      getModels: vi.fn(() => [
        { index: 0, visible: true },
        { index: 1, visible: false },
      ]),
      isCategoryVisible: vi.fn((type: string) => type === "IfcSpace"),
      getMeasurements: vi.fn()
        .mockReturnValueOnce([{ id: 5 }])
        .mockReturnValue([{ id: 5 }, { id: 9 }]),
      showAll: vi.fn(),
      addRule: vi.fn(),
      setHidden: vi.fn(),
      setModelVisible: vi.fn(),
      setCategoryVisible: vi.fn(async () => undefined),
      setSections: vi.fn(),
      setPlanView: vi.fn(),
      selectMany: vi.fn(),
      removeMeasurement: vi.fn(),
      setCamera: vi.fn(),
    } as unknown as Viewer;

    const transaction = new ViewTransactionManager(viewer).begin("Assistant view");
    transaction.restore();
    transaction.restore();

    expect(viewer.showAll).toHaveBeenCalledTimes(1);
    expect(viewer.addRule).toHaveBeenCalledWith({ label: "Level 1", mode: "keep", ids: [12, 13] });
    expect(viewer.setHidden).toHaveBeenCalledWith([21], true);
    expect(viewer.setModelVisible).toHaveBeenCalledWith(1, false);
    expect(viewer.setSections).toHaveBeenCalledWith([{ axis: "z", offset: 2, flip: false }]);
    expect(viewer.setPlanView).toHaveBeenCalledWith(true);
    expect(viewer.selectMany).toHaveBeenCalledWith([12, 13], "replace");
    expect(viewer.removeMeasurement).toHaveBeenCalledWith(9);
    expect(viewer.setCamera).toHaveBeenCalledWith({ position: [4, 5, 6], target: [1, 2, 3] });
  });
});

