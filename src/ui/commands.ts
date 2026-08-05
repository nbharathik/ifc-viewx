// One definition per command, shared by the ribbon, the command palette, the
// context menu and the keyboard. Anything the app can do is declared once here
// and referenced by id everywhere else.

export interface Command {
  id: string;
  label: string;
  /** Palette grouping, also used as the ribbon-agnostic category. */
  section: string;
  icon?: string;
  /** Displayed chord. Also bound unless `binding` says otherwise. */
  shortcut?: string;
  /** "" keeps the shortcut visible but bound elsewhere (viewer-core owns F/H/I/A). */
  binding?: string;
  /** Secondary label: a count, or the mode a command needs. */
  sub?: string;
  hint?: string;
  /** "local" marks a command that only the local service can carry out. */
  tier?: "local";
  /** Tier availability, separate from `enabled`: unavailable stays clickable
   *  so the UI can explain what is missing instead of going silent. */
  available?: () => boolean;
  enabled?: () => boolean;
  pressed?: () => boolean;
  /** Resolved snapshot for consumers that only read state. */
  disabled?: boolean;
  run: () => void;
}

const normalize = (chord: string): string =>
  chord
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace("cmd+", "ctrl+")
    .replace("meta+", "ctrl+");

/** Both candidates matter: "?" arrives as Shift+/ but is written as "?". */
function eventChords(e: KeyboardEvent): [string, string] {
  const key = e.key.toLowerCase();
  const mod = `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${e.altKey ? "alt+" : ""}`;
  return [`${mod}${e.shiftKey ? "shift+" : ""}${key}`, `${mod}${key}`];
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();
  private readonly keys = new Map<string, string>();

  add(commands: Command[]): void {
    for (const command of commands) {
      this.commands.set(command.id, command);
      const chord = command.binding ?? command.shortcut;
      if (chord) this.keys.set(normalize(chord), command.id);
    }
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  /** Snapshot with `disabled` resolved, in registration order. */
  all(): Command[] {
    return [...this.commands.values()].map((c) => ({ ...c, disabled: !this.isEnabled(c) }));
  }

  isEnabled(command: Command | string): boolean {
    const target = typeof command === "string" ? this.commands.get(command) : command;
    return target ? (target.enabled?.() ?? true) : false;
  }

  isPressed(id: string): boolean {
    return this.commands.get(id)?.pressed?.() ?? false;
  }

  /** False when the tier this command needs is not there right now. */
  isAvailable(id: string): boolean {
    return this.commands.get(id)?.available?.() ?? true;
  }

  /** Returns false when the command is unknown or currently disabled. */
  run(id: string): boolean {
    const command = this.commands.get(id);
    if (!command || !this.isEnabled(command)) return false;
    command.run();
    return true;
  }

  /** Returns true when a command consumed the event. */
  handleKey(e: KeyboardEvent): boolean {
    const [withShift, plain] = eventChords(e);
    const id = this.keys.get(withShift) ?? this.keys.get(plain);
    if (!id) return false;
    const command = this.commands.get(id);
    if (!command || !this.isEnabled(command)) return false;
    e.preventDefault();
    command.run();
    return true;
  }
}
