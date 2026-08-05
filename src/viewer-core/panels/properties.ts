// Properties panel (plain DOM). Shows the selected element's direct attributes
// and all psets/qtos with values, and an empty state otherwise. Subscribes to
// the selection source so it updates automatically.
import type { ItemProperties, IfcProperty, IfcPropertySet } from '../engine/types.js';
import { ensurePanelStyles } from './styles.js';

const INFO_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/></svg>';
const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';

/** Long IFC floats are unreadable; keep the exact value in the title. */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString();
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 4;
  const rounded = Number(value.toFixed(digits));
  // A quantity smaller than the rounding step is not zero; say what it is.
  if (rounded === 0) return value.toExponential(2);
  return rounded.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatValue(value: IfcProperty['value']): { text: string; isNull: boolean } {
  if (value === null || value === undefined) return { text: '-', isNull: true };
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', isNull: false };
  if (typeof value === 'number') return { text: formatNumber(value), isNull: false };
  if (value === '') return { text: '(empty)', isNull: true };
  return { text: String(value), isNull: false };
}

export interface PropertiesSource {
  getProperties(expressID: number): Promise<ItemProperties | null>;
  getSelection(): number | null;
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
}

export class PropertiesPanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly unsubscribe: () => void;
  /** Guards against out-of-order async property responses. */
  private renderSeq = 0;

  constructor(
    container: HTMLElement,
    private readonly source: PropertiesSource,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-panel';
    this.root.setAttribute('data-testid', 'properties-panel');

    const head = doc.createElement('div');
    head.className = 'ifc-panel__head';
    this.filter = doc.createElement('input');
    this.filter.className = 'ifc-input';
    this.filter.type = 'search';
    this.filter.placeholder = 'Filter properties';
    this.filter.addEventListener('input', () => this.applyFilter());
    head.appendChild(this.filter);
    this.root.appendChild(head);

    this.body = doc.createElement('div');
    this.body.className = 'ifc-panel__body';
    this.root.appendChild(this.body);

    container.appendChild(this.root);

    void this.render(this.source.getSelection());
    this.unsubscribe = this.source.onSelectionChange((id) => void this.render(id));
  }

  private empty(title: string, sub?: string, testid?: string): HTMLElement {
    const doc = this.root.ownerDocument;
    const box = doc.createElement('div');
    box.className = 'ifc-empty';
    box.innerHTML = INFO_ICON;
    if (testid) box.setAttribute('data-testid', testid);
    const label = doc.createElement('div');
    label.textContent = title;
    box.appendChild(label);
    if (sub) {
      const hint = doc.createElement('div');
      hint.className = 'ifc-empty__sub';
      hint.textContent = sub;
      box.appendChild(hint);
    }
    return box;
  }

  private async render(expressID: number | null): Promise<void> {
    const seq = ++this.renderSeq;

    if (expressID === null) {
      this.body.replaceChildren(
        this.empty('Nothing selected', 'Click an element in the 3D view or the structure tree.', 'properties-empty'),
      );
      return;
    }

    // The worker takes a moment on a heavy model, and leaving the previous
    // element's values up meanwhile reads as if they belonged to this one.
    const pending = setTimeout(() => {
      if (seq === this.renderSeq) this.body.replaceChildren(this.empty('Reading properties'));
    }, 120);
    let props: ItemProperties | null;
    try {
      props = await this.source.getProperties(expressID);
    } catch {
      props = null;
    }
    clearTimeout(pending);
    if (seq !== this.renderSeq) return; // a newer selection superseded this one

    if (!props) {
      this.body.replaceChildren(this.empty('Properties unavailable', `Nothing readable for #${expressID}.`));
      return;
    }

    const name = props.attributes.find((a) => a.name === 'Name')?.value;
    this.body.replaceChildren(this.renderHead(props.type, name ? String(name) : '(unnamed)'));
    this.body.appendChild(this.renderSection('Attributes', null, props.attributes, 'attr'));
    for (const pset of props.psets) {
      this.body.appendChild(this.renderPset(pset));
    }
    this.applyFilter();
  }

  /** Hide rows that do not match, and any section left with none. */
  private applyFilter(): void {
    const query = this.filter.value.trim().toLowerCase();
    for (const section of this.body.querySelectorAll<HTMLElement>('.ifc-section')) {
      let shown = 0;
      for (const row of section.querySelectorAll<HTMLElement>('.ifc-row')) {
        const hit = !query || row.textContent!.toLowerCase().includes(query);
        row.style.display = hit ? '' : 'none';
        if (hit) shown++;
      }
      section.style.display = shown > 0 || !query ? '' : 'none';
      if (query) section.classList.remove('ifc-section--closed');
    }
  }

  private renderHead(type: string, name: string): HTMLElement {
    const doc = this.root.ownerDocument;
    const head = doc.createElement('div');
    head.className = 'ifc-selhead';
    const label = doc.createElement('div');
    label.className = 'ifc-selhead__name';
    label.textContent = name;
    label.title = name;
    const kind = doc.createElement('div');
    kind.className = 'ifc-selhead__type';
    kind.setAttribute('data-testid', 'prop-type');
    kind.textContent = type;
    head.append(label, kind);
    return head;
  }

  private renderPset(pset: IfcPropertySet): HTMLElement {
    const section = this.renderSection(pset.name, pset.kind, pset.properties, `pset:${pset.name}`);
    section.setAttribute('data-pset', pset.name);
    return section;
  }

  private renderSection(
    title: string,
    badge: string | null,
    rows: IfcProperty[],
    scope: string,
  ): HTMLElement {
    const doc = this.root.ownerDocument;
    const section = doc.createElement('div');
    section.className = 'ifc-section';

    const head = doc.createElement('button');
    head.type = 'button';
    head.className = 'ifc-section__title';
    head.title = 'Show or hide this group';
    const label = doc.createElement('span');
    label.textContent = title;
    head.appendChild(label);
    if (badge) {
      const tag = doc.createElement('span');
      tag.className = 'ifc-badge';
      tag.textContent = badge;
      head.appendChild(tag);
    }
    head.addEventListener('click', () => section.classList.toggle('ifc-section--closed'));
    section.appendChild(head);

    if (rows.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'ifc-row';
      empty.setAttribute('data-testid', `pset-empty-${title}`);
      const note = doc.createElement('div');
      note.className = 'ifc-key';
      note.textContent = 'No properties.';
      empty.appendChild(note);
      section.appendChild(empty);
      return section;
    }

    for (const row of rows) {
      const line = doc.createElement('div');
      line.className = 'ifc-row';
      const key = doc.createElement('div');
      key.className = 'ifc-key';
      key.textContent = row.name;
      key.title = row.name;
      const val = doc.createElement('div');
      val.className = 'ifc-val';
      val.setAttribute('data-prop', `${scope}.${row.name}`);
      const { text, isNull } = formatValue(row.value);
      val.textContent = text;
      if (isNull) {
        val.classList.add('ifc-null');
        line.append(key, val);
      } else {
        const exact = String(row.value);
        val.title = exact === text ? row.name : exact;
        // A copy button rather than a clickable cell: the cell has to stay
        // selectable, and overwriting it with "Copied" destroyed what was read.
        const copy = doc.createElement('button');
        copy.type = 'button';
        copy.className = 'ifc-copy';
        copy.title = `Copy ${row.name}`;
        copy.setAttribute('aria-label', `Copy ${row.name}`);
        copy.innerHTML = COPY_ICON;
        copy.addEventListener('click', () => {
          const done = (ok: boolean): void => {
            copy.classList.toggle('ifc-copy--ok', ok);
            copy.title = ok ? 'Copied' : 'The browser blocked the clipboard';
            setTimeout(() => {
              copy.classList.remove('ifc-copy--ok');
              copy.title = `Copy ${row.name}`;
            }, 900);
          };
          if (!navigator.clipboard) return done(false);
          void navigator.clipboard.writeText(exact).then(() => done(true), () => done(false));
        });
        line.append(key, val, copy);
      }
      section.appendChild(line);
    }
    return section;
  }

  dispose(): void {
    this.unsubscribe();
    this.root.remove();
  }
}
