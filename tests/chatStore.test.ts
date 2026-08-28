import { beforeEach, describe, expect, it } from "vitest";

import { ageLabel, clearChats, deleteChat, readChats, saveChat, titleOf } from "../src/llm/chatStore.js";
import type { ChatMessage } from "../src/llm/llmClient.js";

const MODEL = "1000-2000";
const OTHER = "9-9";
const T0 = 1_700_000_000_000;

const turn = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

beforeEach(() => {
  localStorage.clear();
});

describe("titles", () => {
  it("uses the first question, not the first message", () => {
    expect(titleOf([turn("system", "rules"), turn("user", "How many walls?"), turn("assistant", "12")])).toBe(
      "How many walls?",
    );
  });

  it("collapses whitespace and truncates a long one", () => {
    const long = "a".repeat(80);
    const title = titleOf([turn("user", long)]);
    expect(title.length).toBeLessThanOrEqual(52);
    expect(title.endsWith("...")).toBe(true);
    expect(titleOf([turn("user", "  two\n\nlines  ")])).toBe("two lines");
  });

  it("names an empty conversation rather than showing a blank row", () => {
    expect(titleOf([])).toBe("New chat");
  });
});

describe("saving", () => {
  it("round trips a conversation and drops the system prompt", () => {
    saveChat(MODEL, "a", [turn("system", "rules"), turn("user", "hi"), turn("assistant", "hello")], T0);
    const chats = readChats(MODEL);
    expect(chats).toHaveLength(1);
    expect(chats[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(chats[0].title).toBe("hi");
  });

  it("refuses a conversation with nothing asked in it", () => {
    expect(saveChat(MODEL, "a", [turn("system", "rules")], T0)).toBe(false);
    expect(readChats(MODEL)).toHaveLength(0);
  });

  it("updates in place rather than duplicating the same id", () => {
    saveChat(MODEL, "a", [turn("user", "one")], T0);
    saveChat(MODEL, "a", [turn("user", "one"), turn("assistant", "two")], T0 + 1000);
    const chats = readChats(MODEL);
    expect(chats).toHaveLength(1);
    expect(chats[0].messages).toHaveLength(2);
  });

  it("keeps conversations for different models apart", () => {
    saveChat(MODEL, "a", [turn("user", "mine")], T0);
    saveChat(OTHER, "b", [turn("user", "theirs")], T0);
    expect(readChats(MODEL).map((c) => c.title)).toEqual(["mine"]);
    expect(readChats(OTHER).map((c) => c.title)).toEqual(["theirs"]);
  });

  it("returns newest first", () => {
    saveChat(MODEL, "a", [turn("user", "old")], T0);
    saveChat(MODEL, "b", [turn("user", "new")], T0 + 60_000);
    expect(readChats(MODEL).map((c) => c.title)).toEqual(["new", "old"]);
  });

  it("keeps at most twenty per model", () => {
    for (let i = 0; i < 25; i++) saveChat(MODEL, `id${i}`, [turn("user", `q${i}`)], T0 + i * 1000);
    expect(readChats(MODEL)).toHaveLength(20);
    // The newest survive; the oldest are the ones dropped.
    expect(readChats(MODEL)[0].title).toBe("q24");
  });

  it("trims a conversation that outgrew the budget, oldest turns first", () => {
    const big = "x".repeat(20_000);
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(turn("user", `${big}${i}`), turn("assistant", big));
    }
    saveChat(MODEL, "a", messages, T0);
    const stored = readChats(MODEL)[0];
    expect(stored.messages.length).toBeLessThan(messages.length);
    // What survives is the tail, which is the part still worth continuing from.
    expect(stored.messages[stored.messages.length - 1].content).toBe(big);
  });
});

describe("deleting", () => {
  it("removes one and leaves the rest", () => {
    saveChat(MODEL, "a", [turn("user", "one")], T0);
    saveChat(MODEL, "b", [turn("user", "two")], T0 + 1000);
    deleteChat(MODEL, "a");
    expect(readChats(MODEL).map((c) => c.title)).toEqual(["two"]);
  });

  it("clears a model without touching another", () => {
    saveChat(MODEL, "a", [turn("user", "one")], T0);
    saveChat(OTHER, "b", [turn("user", "two")], T0);
    clearChats(MODEL);
    expect(readChats(MODEL)).toHaveLength(0);
    expect(readChats(OTHER)).toHaveLength(1);
  });
});

describe("robustness", () => {
  it("survives storage holding something that is not a conversation list", () => {
    localStorage.setItem(`ifcviewx.chats.${MODEL}`, "{not json");
    expect(readChats(MODEL)).toEqual([]);
    localStorage.setItem(`ifcviewx.chats.${MODEL}`, '{"a":1}');
    expect(readChats(MODEL)).toEqual([]);
    localStorage.setItem(`ifcviewx.chats.${MODEL}`, '[{"id":"x"},null,3]');
    expect(readChats(MODEL)).toEqual([]);
  });
});

describe("age labels", () => {
  it("reads as an age, not a clock", () => {
    expect(ageLabel(T0, T0 + 5_000)).toBe("just now");
    expect(ageLabel(T0, T0 + 120_000)).toBe("2m ago");
    expect(ageLabel(T0, T0 + 3 * 3600_000)).toBe("3h ago");
    expect(ageLabel(T0, T0 + 48 * 3600_000)).toBe("2d ago");
  });
});
