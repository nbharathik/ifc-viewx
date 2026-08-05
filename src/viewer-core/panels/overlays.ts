// Loading progress card and error card (plain DOM). The loading card sits at
// the top of the viewport so streaming geometry stays visible behind it.
import type { LoadProgress } from '../engine/types.js';
import { ensurePanelStyles } from './styles.js';

export class LoadingOverlay {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly cancelBtn: HTMLButtonElement;
  private fresh = true;

  constructor(container: HTMLElement, onCancel?: () => void) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-overlay ifc-overlay--top';
    this.root.setAttribute('data-testid', 'loading-overlay');

    const card = doc.createElement('div');
    card.className = 'ifc-loading-card';

    this.title = doc.createElement('span');
    this.title.className = 'ifc-loading-title';
    this.title.textContent = 'Loading model';

    this.detail = doc.createElement('span');
    this.detail.className = 'ifc-loading-detail';
    this.detail.setAttribute('data-testid', 'loading-detail');
    this.detail.textContent = 'Preparing';

    const head = doc.createElement('div');
    head.className = 'ifc-loading-head';
    head.append(this.title, this.detail);

    const track = doc.createElement('div');
    track.className = 'ifc-progress-track';
    this.fill = doc.createElement('div');
    this.fill.className = 'ifc-progress-fill';
    track.appendChild(this.fill);

    this.cancelBtn = doc.createElement('button');
    this.cancelBtn.className = 'ifc-cancel-btn';
    this.cancelBtn.setAttribute('data-testid', 'btn-cancel-load');
    this.cancelBtn.textContent = 'Cancel';
    this.cancelBtn.style.display = onCancel ? '' : 'none';
    if (onCancel) this.cancelBtn.addEventListener('click', onCancel);

    card.append(head, track, this.cancelBtn);
    this.root.appendChild(card);
    container.appendChild(this.root);
  }

  show(): void {
    this.fresh = true;
    this.title.textContent = 'Loading model';
    this.fill.style.width = '0%';
    this.detail.textContent = 'Preparing';
    this.root.classList.add('ifc-overlay--visible');
  }

  update(progress: LoadProgress): void {
    if (this.fresh && progress.phase !== 'downloading') {
      // A load that starts straight in the geometry phase is a cache replay.
      this.title.textContent =
        progress.phase === 'geometry' ? 'Loading from cache' : 'Loading model';
      this.fresh = false;
    }
    if (progress.phase === 'downloading') {
      const loadedMb = ((progress.bytesLoaded ?? 0) / 1e6).toFixed(1);
      if (progress.bytesTotal) {
        const pct = Math.min(
          100,
          Math.round(((progress.bytesLoaded ?? 0) / progress.bytesTotal) * 100),
        );
        this.fill.style.width = `${pct}%`;
        this.detail.textContent = `${loadedMb} / ${(progress.bytesTotal / 1e6).toFixed(1)} MB`;
      } else {
        this.fill.style.width = '0%';
        this.detail.textContent = `${loadedMb} MB read`;
      }
      return;
    }
    const pct =
      progress.totalEntities > 0
        ? Math.min(100, Math.round((progress.entities / progress.totalEntities) * 100))
        : 0;
    this.fill.style.width = `${pct}%`;
    if (progress.phase === 'parsing') {
      this.detail.textContent = 'Parsing entities';
    } else if (progress.phase === 'geometry') {
      this.detail.textContent = `${pct}% · ${progress.meshes.toLocaleString()} meshes`;
    } else {
      this.detail.textContent = `${progress.meshes.toLocaleString()} meshes`;
    }
  }

  hide(): void {
    this.root.classList.remove('ifc-overlay--visible');
  }

  dispose(): void {
    this.root.remove();
  }
}

export class ErrorCard {
  readonly root: HTMLElement;
  private readonly message: HTMLElement;

  constructor(container: HTMLElement) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-overlay';
    this.root.setAttribute('data-testid', 'error-overlay');

    const card = doc.createElement('div');
    card.className = 'ifc-error-card';
    card.setAttribute('data-testid', 'error-card');
    card.setAttribute('role', 'alert');

    const title = doc.createElement('div');
    title.className = 'ifc-error-title';
    title.textContent = 'Could not open this IFC file';

    this.message = doc.createElement('div');
    this.message.className = 'ifc-error-message';
    this.message.setAttribute('data-testid', 'error-message');

    // Without a way out, a failed load parks a card over the viewport for the
    // rest of the session: hide() is otherwise only reached by the next load.
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ifc-error-close';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => this.hide());

    card.append(title, this.message, dismiss);
    this.root.appendChild(card);
    container.appendChild(this.root);
  }

  show(message: string): void {
    this.message.textContent = message;
    this.root.classList.add('ifc-overlay--visible');
  }

  hide(): void {
    this.root.classList.remove('ifc-overlay--visible');
  }

  dispose(): void {
    this.root.remove();
  }
}
