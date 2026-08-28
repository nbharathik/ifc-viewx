// Saved conversations, per model, in this browser.
//
// A reload used to lose the chat. Conversations are keyed by the same model
// shape viewpoints and selection sets use, so opening a model brings back what
// was asked about that model and nothing from another one.
import type { ChatMessage } from "./llmClient.js";

export interface Conversation {
  id: string;
  title: string;
  /** Epoch millis of the last write, for ordering and for the label. */
  at: number;
  messages: ChatMessage[];
}

const INDEX_KEY = "ifcviewx.chats";
/** Conversations kept per model before the oldest is dropped. */
const KEEP = 20;
/** A conversation past this many characters is trimmed from the front. */
const MAX_CHARS = 120_000;
/** Title length, ellipsis included, so a row cannot outgrow the menu. */
const TITLE_CHARS = 52;

const keyFor = (model: string): string => `${INDEX_KEY}.${model || "none"}`;

export function readChats(model: string): Conversation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(keyFor(model)) ?? "[]") as Conversation[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((chat) => chat && typeof chat.id === "string" && Array.isArray(chat.messages))
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

function write(model: string, chats: Conversation[]): boolean {
  try {
    localStorage.setItem(keyFor(model), JSON.stringify(chats.slice(0, KEEP)));
    return true;
  } catch {
    return false;
  }
}

/** First user line, shortened. What a chat is about is what was asked first. */
export function titleOf(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user" && !message.context);
  const text = (first?.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "New chat";
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 3)}...` : text;
}

/**
 * Store one conversation, dropping the oldest turns first if it has grown past
 * the budget. A conversation with no user turn is not worth a slot.
 */
export function saveChat(model: string, id: string, messages: ChatMessage[], now: number): boolean {
  const real = messages.filter((message) => message.role !== "system");
  if (!real.some((message) => message.role === "user")) return false;
  // Trim to a user boundary. A stored conversation that opens with a tool
  // result whose call was dropped is rejected by every provider that takes
  // tools, so an exact character cut is not enough.
  let trimmed = real;
  while (trimmed.length > 2 && JSON.stringify(trimmed).length > MAX_CHARS) {
    let cut = 1;
    while (cut < trimmed.length && trimmed[cut].role !== "user") cut += 1;
    if (cut >= trimmed.length) break;
    trimmed = trimmed.slice(cut);
  }
  const chats = readChats(model).filter((chat) => chat.id !== id);
  chats.unshift({ id, title: titleOf(trimmed), at: now, messages: trimmed });
  return write(model, chats);
}

export function deleteChat(model: string, id: string): void {
  write(model, readChats(model).filter((chat) => chat.id !== id));
}

export function clearChats(model: string): void {
  write(model, []);
}

/** Short, human relative age: chats are picked by "which one", not by clock. */
export function ageLabel(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
