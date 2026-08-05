// Spatial tree (plain DOM, virtualized). Renders Project -> Site -> Building ->
// Storey -> elements. Only the rows inside the scroll window exist in the DOM,
// so a storey with 20k children costs the same as one with 20. Clicking a node
// selects it (3D highlight + properties); a 3D selection reveals the node. A
// per-node eye toggle controls subtree visibility.
//
// The model is flattened once into parallel arrays (node, depth, parent), so
// search is a linear scan over a lowercase haystack that is built on the first
// query and reused: no tree walk and no string allocation per keystroke.
import type { SpatialNode } from '../engine/types.js';
import { ensurePanelStyles } from './styles.js';

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const CHEVRON = svg('<path d="m9 5 7 7-7 7"/>');
const EYE = svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>');
const EYE_OFF = svg('<path d="M10.7 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3.2 4.1M6.3 6.3A18 18 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.1-.9"/><path d="m3 3 18 18"/>');
const TREE_ICON = svg('<path d="m12 2 10 5-10 5L2 7Z"/><path d="m4 12-2 1 10 5 10-5-2-1"/>');
const SEARCH_ICON = svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>');
const CLEAR_ICON = svg('<path d="M6 6l12 12M18 6 6 18"/>');
const ISOLATE_ICON = svg('<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/><circle cx="12" cy="12" r="8"/>');

export interface TreeSource {
  getSpatialTree(): SpatialNode | null;
  select(expressID: number | null): void;
  getSelection(): number | null;
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
  onModelLoaded(listener: () => void): () => void;
  /** Multi-selection: Ctrl-click toggles one row, Shift-click takes a range. */
  getSelectedIds?(): number[];
  selectMany?(expressIDs: Iterable<number>, mode?: 'replace' | 'add' | 'remove' | 'toggle'): void;
  /** Visibility hooks used by the eye toggle. */
  isSubtreeVisible?(expressID: number): boolean;
  toggleSubtreeVisible?(expressID: number): void;
  /** Fires when visibility changed anywhere, so stale eyes repaint. */
  onVisibilityChange?(listener: () => void): () => void;
  /** Backs the isolate toggle in the search bar. */
  isolate?(expressIDs: number[], label?: string): void;
  showAll?(): void;
}

/** Must match .ifc-tree-row in styles.ts. */
const ROW_H = 22;
const OVERSCAN = 6;
const AUTO_EXPAND_DEPTH = 3; // Project, Site, Building expanded; storeys collapsed

export class TreePanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly window: HTMLElement;
  private readonly doc: Document;
  private readonly search: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly isolateBtn: HTMLButtonElement;
  private readonly unsubs: Array<() => void> = [];
  /** isSubtreeVisible walks a subtree; cache it until visibility changes. */
  private readonly eyeCache = new Map<number, boolean>();
  /** Flattened model, in depth-first order: parents always precede children. */
  private nodes: SpatialNode[] = [];
  private depth = new Int32Array(0);
  private parent = new Int32Array(0);
  private indexById = new Map<number, number>();
  private indexed: SpatialNode | null = null;
  private hay: string[] | null = null;
  /** Rows the filter lets through, and the ones it actually matched. */
  private shown = new Uint8Array(0);
  private matched = new Uint8Array(0);
  private terms: string[] = [];
  private hits = 0;
  private expanded = new Set<number>();
  /** What was open before the search, restored when it clears. */
  private savedExpanded: Set<number> | null = null;
  private isolated = false;
  private selfChange = false;
  private rows: number[] = [];
  private painted: [number, number] = [-1, -1];
  private frame = 0;
  private filterFrame = 0;
  private selected = new Set<number>();
  /** Where a Shift-click range starts, in flat-index space. */
  private anchor = -1;
  private resize: ResizeObserver | null = null;

  constructor(
    container: HTMLElement,
    private readonly source: TreeSource,
  ) {
    this.doc = container.ownerDocument;
    ensurePanelStyles(this.doc);

    this.root = this.doc.createElement('div');
    this.root.className = 'ifc-panel';
    this.root.setAttribute('data-testid', 'tree-panel');

    const head = this.doc.createElement('div');
    head.className = 'ifc-panel__head';
    this.search = this.doc.createElement('input');
    this.search.className = 'ifc-search__input';
    this.search.type = 'text';
    this.search.placeholder = 'Search name, type or #id';
    this.search.spellcheck = false;
    this.search.setAttribute('data-testid', 'tree-search');
    this.search.addEventListener('input', () => this.queueFilter());
    this.search.addEventListener('keydown', (e) => this.onSearchKey(e));
    this.count = this.doc.createElement('span');
    this.count.className = 'ifc-search__count';
    this.clearBtn = this.iconBtn(CLEAR_ICON, 'Clear  Esc', () => this.setQuery(''));
    this.isolateBtn = this.iconBtn(ISOLATE_ICON, '', () => this.toggleIsolate());
    this.isolateBtn.setAttribute('data-testid', 'tree-isolate');
    const field = this.doc.createElement('div');
    field.className = 'ifc-search';
    const glass = this.doc.createElement('span');
    glass.className = 'ifc-search__icon';
    glass.innerHTML = SEARCH_ICON;
    field.append(glass, this.search, this.count, this.clearBtn, this.isolateBtn);
    if (!this.source.isolate) this.isolateBtn.classList.add('ifc-hidden');
    head.appendChild(field);
    this.root.appendChild(head);

    this.body = this.doc.createElement('div');
    this.body.className = 'ifc-panel__body ifc-tree-scroll';
    this.spacer = this.doc.createElement('div');
    this.spacer.className = 'ifc-tree-spacer';
    this.window = this.doc.createElement('div');
    this.window.className = 'ifc-tree-window';
    this.spacer.appendChild(this.window);
    this.body.appendChild(this.spacer);
    this.body.addEventListener('scroll', () => this.schedulePaint(), { passive: true });
    this.window.addEventListener('click', (e) => this.onClick(e));
    this.window.setAttribute('role', 'tree');
    this.window.setAttribute('aria-label', 'Spatial structure');
    this.root.appendChild(this.body);
    container.appendChild(this.root);
    // A taller panel exposes rows the virtualizer never painted, and only a
    // scroll would have brought them in.
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => this.schedulePaint());
      this.resize.observe(this.body);
    }

    this.render();
    this.syncSearch();
    this.unsubs.push(
      this.source.onModelLoaded(() => {
        this.terms = [];
        this.hits = 0;
        this.search.value = '';
        this.expanded.clear();
        this.savedExpanded = null;
        this.isolated = false;
        // A flat index from the previous model is not a range start in this one.
        this.anchor = -1;
        this.selected.clear();
        this.body.scrollTop = 0;
        this.render();
        this.syncSearch();
      }),
      this.source.onSelectionChange((id) => this.reveal(id)),
    );
    if (this.source.onVisibilityChange) {
      this.unsubs.push(this.source.onVisibilityChange(() => {
        // Anyone else changing visibility (Show all, an eye, the ribbon) means
        // the viewport no longer shows exactly what we isolated.
        if (!this.selfChange) this.isolated = false;
        this.eyeCache.clear();
        this.repaint();
        this.syncSearch();
      }));
    }
  }

  private iconBtn(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.className = 'ifc-search__btn';
    button.type = 'button';
    button.title = title;
    button.innerHTML = glyph;
    button.addEventListener('click', onClick);
    return button;
  }

  private empty(title: string, sub?: string): HTMLElement {
    const box = this.doc.createElement('div');
    box.className = 'ifc-empty';
    box.innerHTML = TREE_ICON;
    const label = this.doc.createElement('div');
    label.textContent = title;
    box.appendChild(label);
    if (sub) {
      const hint = this.doc.createElement('div');
      hint.className = 'ifc-empty__sub';
      hint.textContent = sub;
      box.appendChild(hint);
    }
    return box;
  }

  // -- model -> flat arrays --------------------------------------------------
  private index(tree: SpatialNode | null): void {
    if (this.indexed === tree) return;
    this.indexed = tree;
    this.hay = null;
    this.indexById.clear();
    const nodes: SpatialNode[] = [];
    const depth: number[] = [];
    const parent: number[] = [];
    const walk = (node: SpatialNode, level: number, from: number): void => {
      const at = nodes.length;
      nodes.push(node);
      depth.push(level);
      parent.push(from);
      this.indexById.set(node.expressID, at);
      for (const child of node.children) walk(child, level + 1, at);
    };
    if (tree) walk(tree, 0, -1);
    this.nodes = nodes;
    this.depth = Int32Array.from(depth);
    this.parent = Int32Array.from(parent);
    this.shown = new Uint8Array(nodes.length);
    this.matched = new Uint8Array(nodes.length);
  }

  /** Built on the first search only: models nobody searches pay nothing. */
  private haystack(): string[] {
    if (!this.hay) {
      this.hay = this.nodes.map((n) => `${n.name ?? ''} ${n.type} #${n.expressID}`.toLowerCase());
    }
    return this.hay;
  }

  /**
   * Every term must appear somewhere in a row's text. A hit shows its whole
   * subtree (so a storey opens into its elements) and every ancestor, which
   * keeps the path to it on screen.
   */
  private match(): void {
    const n = this.nodes.length;
    this.hits = 0;
    if (this.terms.length === 0) {
      this.shown.fill(1);
      this.matched.fill(0);
      return;
    }
    const hay = this.haystack();
    const hit = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const text = hay[i];
      let all = 1;
      for (const term of this.terms) {
        if (!text.includes(term)) {
          all = 0;
          break;
        }
      }
      hit[i] = all;
      this.hits += all;
    }
    this.shown.set(hit);
    for (let i = n - 1; i > 0; i--) if (this.shown[i]) this.shown[this.parent[i]] = 1;
    this.matched.set(hit);
    for (let i = 1; i < n; i++) {
      if (this.matched[this.parent[i]]) {
        this.matched[i] = 1;
        this.shown[i] = 1;
      }
    }
  }

  private render(): void {
    this.eyeCache.clear();
    this.body.querySelector('.ifc-empty')?.remove();

    const tree = this.source.getSpatialTree();
    this.index(tree);
    this.search.disabled = !tree;
    if (!tree) {
      this.hits = 0;
      this.showEmpty('No model loaded', 'Open an IFC file to browse its spatial structure.', 'tree-empty');
      return;
    }

    this.match();
    if (this.terms.length && this.hits === 0) {
      this.showEmpty('No elements match', `Nothing named or typed like "${this.search.value.trim()}".`);
      return;
    }

    // A filtered view opens the branches leading to hits; a hit's own subtree
    // stays folded so a matching storey does not dump 5000 rows on screen.
    const auto = this.terms.length === 0 && this.expanded.size === 0;
    if (this.terms.length || auto) {
      for (let i = 0; i < this.nodes.length; i++) {
        const open = this.terms.length
          ? this.shown[i] === 1 && this.matched[i] === 0
          : this.depth[i] < AUTO_EXPAND_DEPTH;
        if (open && this.nodes[i].children.length) this.expanded.add(this.nodes[i].expressID);
      }
    }
    this.spacer.classList.remove('ifc-hidden');
    this.flatten();
    this.repaint();
    const selection = this.source.getSelection();
    if (selection !== null) this.reveal(selection);
  }

  private showEmpty(title: string, sub: string, testid?: string): void {
    this.rows = [];
    this.spacer.classList.add('ifc-hidden');
    const box = this.empty(title, sub);
    if (testid) box.setAttribute('data-testid', testid);
    this.body.appendChild(box);
  }

  /** Flat order plus a cut depth: skips collapsed and filtered-out subtrees. */
  private flatten(): void {
    const rows: number[] = [];
    let cut = -1;
    for (let i = 0; i < this.nodes.length; i++) {
      const level = this.depth[i];
      if (cut >= 0 && level > cut) continue;
      cut = -1;
      if (!this.shown[i]) {
        cut = level;
        continue;
      }
      rows.push(i);
      if (!this.expanded.has(this.nodes[i].expressID)) cut = level;
    }
    this.rows = rows;
    this.spacer.style.height = `${rows.length * ROW_H}px`;
  }

  // -- search ----------------------------------------------------------------
  /** Coalesce to one filter per frame; a scan is cheap, a repaint is not. */
  private queueFilter(): void {
    if (this.filterFrame) return;
    this.filterFrame = requestAnimationFrame(() => {
      this.filterFrame = 0;
      this.applyFilter();
    });
  }

  private applyFilter(): void {
    const terms = this.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const was = this.terms.length > 0;
    if (!was && terms.length) this.savedExpanded = new Set(this.expanded);
    if (was && !terms.length && this.savedExpanded) {
      this.expanded = this.savedExpanded;
      this.savedExpanded = null;
    }
    this.terms = terms;
    this.body.scrollTop = 0;
    this.render();
    // Isolation follows the query while it is on, so refining a search refines
    // what the viewport shows.
    if (this.isolated) {
      if (this.hits === 0) this.restoreAll();
      else this.applySelf(() => this.source.isolate?.(this.matchIds(), this.isolateLabel()));
    }
    this.syncSearch();
  }

  /** Names the isolation in the host's filter list, so it can be undone there. */
  private isolateLabel(): string {
    return `Search "${this.search.value.trim()}"`;
  }

  private setQuery(text: string): void {
    this.search.value = text;
    this.search.focus();
    this.applyFilter();
  }

  private onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && this.hits > 0 && this.source.isolate) {
      e.preventDefault();
      this.toggleIsolate();
    } else if (e.key === 'Escape' && this.search.value) {
      e.preventDefault();
      e.stopPropagation();
      this.setQuery('');
    }
  }

  private matchIds(): number[] {
    const ids: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) if (this.matched[i]) ids.push(this.nodes[i].expressID);
    return ids;
  }

  /** Our own visibility calls must not read as "someone else changed it". */
  private applySelf(run: () => void): void {
    this.selfChange = true;
    run();
    this.selfChange = false;
  }

  private restoreAll(): void {
    this.isolated = false;
    this.applySelf(() => this.source.showAll?.());
  }

  private toggleIsolate(): void {
    // Focus goes back to the query: the buttons sit in the field you are
    // typing in, and app shortcuts listen everywhere else.
    this.search.focus();
    if (this.isolated) return this.restoreAll();
    if (this.hits === 0) return;
    this.applySelf(() => this.source.isolate?.(this.matchIds(), this.isolateLabel()));
    this.isolated = true;
    this.syncSearch();
  }

  private syncSearch(): void {
    const active = this.terms.length > 0;
    this.count.textContent = active ? String(this.hits) : '';
    this.clearBtn.classList.toggle('ifc-hidden', !active);
    this.isolateBtn.disabled = this.hits === 0;
    this.isolateBtn.setAttribute('aria-pressed', String(this.isolated));
    this.isolateBtn.title = this.isolated
      ? 'Show everything again'
      : `Isolate ${this.hits || ''} match${this.hits === 1 ? '' : 'es'}  Enter`;
  }

  // -- painting --------------------------------------------------------------
  private schedulePaint(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private repaint(): void {
    this.painted = [-1, -1];
    this.paint();
  }

  private paint(): void {
    const height = this.body.clientHeight || 400;
    const first = Math.max(0, Math.floor(this.body.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(this.rows.length, first + Math.ceil(height / ROW_H) + OVERSCAN * 2);
    if (first === this.painted[0] && last === this.painted[1]) return;
    this.painted = [first, last];

    const frag = this.doc.createDocumentFragment();
    for (let i = first; i < last; i++) frag.appendChild(this.buildRow(this.rows[i]));
    this.window.style.transform = `translateY(${first * ROW_H}px)`;
    this.window.replaceChildren(frag);
  }

  private eyeState(expressID: number): boolean {
    let visible = this.eyeCache.get(expressID);
    if (visible === undefined) {
      visible = this.source.isSubtreeVisible?.(expressID) ?? true;
      this.eyeCache.set(expressID, visible);
    }
    return visible;
  }

  /** Mark the searched-for text inside a label; at most one span per term. */
  private label(text: string): DocumentFragment {
    const frag = this.doc.createDocumentFragment();
    const lower = text.toLowerCase();
    const spans: Array<[number, number]> = [];
    for (const term of this.terms) {
      const at = lower.indexOf(term);
      if (at >= 0) spans.push([at, at + term.length]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [from, to] of spans) {
      if (to <= cursor) continue;
      if (from > cursor) frag.append(text.slice(cursor, from));
      const mark = this.doc.createElement('mark');
      mark.textContent = text.slice(Math.max(from, cursor), to);
      frag.append(mark);
      cursor = to;
    }
    frag.append(text.slice(cursor));
    return frag;
  }

  private buildRow(index: number): HTMLElement {
    const node = this.nodes[index];
    const el = this.doc.createElement('div');
    const visible = this.source.isSubtreeVisible ? this.eyeState(node.expressID) : true;
    const selected = this.selected.has(node.expressID);
    el.className = `ifc-tree-row${selected ? ' ifc-tree-row--selected' : ''}${
      visible ? '' : ' ifc-tree-row--hidden'
    }`;
    el.style.paddingLeft = `${4 + this.depth[index] * 11}px`;
    el.dataset.id = String(node.expressID);
    el.title = `${node.name ?? '(unnamed)'} · ${node.type}`;
    if (selected) el.setAttribute('data-selected', 'true');
    // The rows are the tree, so they say so: a virtualized list still has to
    // report its real depth and its position within the whole model.
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', String(this.depth[index] + 1));
    el.setAttribute('aria-selected', String(selected));
    el.setAttribute('aria-posinset', String(index + 1));
    el.setAttribute('aria-setsize', String(this.rows.length));

    const toggle = this.doc.createElement('span');
    const open = this.expanded.has(node.expressID);
    toggle.className = `ifc-tree-toggle${node.children.length ? '' : ' ifc-tree-toggle--leaf'}${
      open ? ' ifc-tree-toggle--open' : ''
    }`;
    toggle.dataset.act = 'toggle';
    if (node.children.length) {
      toggle.innerHTML = CHEVRON;
      toggle.setAttribute('role', 'button');
      toggle.setAttribute('aria-label', open ? 'Collapse' : 'Expand');
      el.setAttribute('aria-expanded', String(open));
    }
    el.appendChild(toggle);

    // A hit marks what matched, in the name or in the class, so the row says
    // why it is on screen.
    const hit = this.terms.length > 0 && this.matched[index] === 1;
    const label = this.doc.createElement('span');
    label.className = 'ifc-tree-label';
    const text = node.name ?? '(unnamed)';
    if (hit) label.appendChild(this.label(text));
    else label.textContent = text;
    el.appendChild(label);

    const type = this.doc.createElement('span');
    type.className = 'ifc-tree-type';
    const shortType = node.type.replace(/^Ifc/, '');
    if (hit) type.appendChild(this.label(shortType));
    else type.textContent = shortType;
    el.appendChild(type);

    if (this.source.toggleSubtreeVisible && this.source.isSubtreeVisible) {
      const eye = this.doc.createElement('span');
      eye.className = 'ifc-tree-eye';
      eye.dataset.act = 'eye';
      eye.setAttribute('data-testid', `tree-eye-${node.expressID}`);
      eye.setAttribute('role', 'button');
      eye.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${node.name ?? node.type}`);
      eye.innerHTML = visible ? EYE : EYE_OFF;
      eye.title = visible ? 'Hide' : 'Show';
      el.appendChild(eye);
    }
    return el;
  }

  // -- interaction -----------------------------------------------------------
  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('.ifc-tree-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    const act = target?.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'toggle') {
      this.toggle(id);
    } else if (act === 'eye') {
      this.source.toggleSubtreeVisible?.(id);
      if (!this.source.onVisibilityChange) {
        this.eyeCache.clear();
        this.repaint();
      }
    } else {
      this.pick(id, e);
    }
  }

  /**
   * Click replaces, Ctrl-click toggles one row, Shift-click takes everything
   * between the anchor and here. Ranges run over the rows on screen, so what
   * you get is what you can see.
   */
  private pick(expressID: number, e: MouseEvent): void {
    const index = this.indexById.get(expressID) ?? -1;
    const many = this.source.selectMany;
    if (!many) {
      this.source.select(expressID);
      return;
    }
    if (e.shiftKey && this.anchor >= 0) {
      const from = this.rows.indexOf(this.anchor);
      const to = this.rows.indexOf(index);
      if (from >= 0 && to >= 0) {
        const span = this.rows.slice(Math.min(from, to), Math.max(from, to) + 1);
        many.call(this.source, span.map((at) => this.nodes[at].expressID), 'replace');
        return;
      }
    }
    this.anchor = index;
    if (e.ctrlKey || e.metaKey) many.call(this.source, [expressID], 'toggle');
    else this.source.select(expressID);
  }

  expand(expressID: number): void {
    if (this.expanded.has(expressID)) return;
    this.expanded.add(expressID);
    this.flatten();
    this.repaint();
  }

  collapse(expressID: number): void {
    if (!this.expanded.delete(expressID)) return;
    this.flatten();
    this.repaint();
  }

  private toggle(expressID: number): void {
    if (this.expanded.has(expressID)) this.expanded.delete(expressID);
    else this.expanded.add(expressID);
    this.flatten();
    this.repaint();
  }

  /** Expand ancestors, scroll the primary row into view and repaint the set. */
  private reveal(expressID: number | null): void {
    this.selected = new Set(this.source.getSelectedIds?.() ?? (expressID === null ? [] : [expressID]));
    const index = expressID === null ? undefined : this.indexById.get(expressID);
    if (index === undefined) return this.repaint();

    let changed = false;
    for (let at = this.parent[index]; at >= 0; at = this.parent[at]) {
      if (this.expanded.has(this.nodes[at].expressID)) continue;
      this.expanded.add(this.nodes[at].expressID);
      changed = true;
    }
    if (changed) this.flatten();

    const row = this.rows.indexOf(index);
    if (row >= 0) {
      const top = row * ROW_H;
      const view = this.body.scrollTop;
      const height = this.body.clientHeight;
      if (top < view || top + ROW_H > view + height) {
        this.body.scrollTop = Math.max(0, top - height / 2 + ROW_H);
      }
    }
    this.repaint();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.filterFrame);
    this.resize?.disconnect();
    for (const off of this.unsubs) off();
    this.root.remove();
  }
}
