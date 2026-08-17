import { h, icon, toast } from './kit.js';
import { emptyState } from './shell.js';
import type { FederatedModel, ModelTransform, SpatialNode, Viewer } from '../viewer-core/viewer.js';

type Position = [number, number, number?];
type Geometry = {
  type: 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
};

interface GeoFeature {
  type: 'Feature';
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry: Geometry | null;
}

interface GeoCollection {
  type: 'FeatureCollection';
  name?: string;
  features: GeoFeature[];
  crs?: unknown;
  'ifcviewx:crs'?: string;
}

export interface GeoContextActions {
  viewer: Viewer;
  log(message: string, kind?: 'info' | 'success' | 'error'): void;
  createIssue(input: {
    title: string;
    description: string;
    point: [number, number, number];
    metadata: Record<string, string | number | boolean>;
  }): Promise<void>;
}

const ALIGNMENT_KEY = 'ifcviewx.geo.alignments';
const LAYER_LIMIT = 400;

const statusLabel: Record<FederatedModel['geoStatus'], string> = {
  ready: 'Anchor ready',
  aligned: 'Auto aligned',
  manual: 'Manual alignment',
  missing: 'CRS incomplete',
  conflict: 'CRS conflict',
};

const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function position(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length < 2 || !numeric(value[0]) || !numeric(value[1])) return null;
  return [value[0], value[1], numeric(value[2]) ? value[2] : 0];
}

function lines(geometry: Geometry): Position[][] {
  if (geometry.type === 'LineString') return [geometry.coordinates as Position[]];
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return geometry.coordinates as Position[][];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Position[][][]).flat();
  if (geometry.type === 'Point') {
    const point = position(geometry.coordinates);
    return point ? [[point]] : [];
  }
  if (geometry.type === 'MultiPoint') return (geometry.coordinates as unknown[]).flatMap((item) => {
    const point = position(item);
    return point ? [[point]] : [];
  });
  return [];
}

function isCollection(value: unknown): value is GeoCollection {
  if (!value || typeof value !== 'object') return false;
  const record = value as { type?: unknown; features?: unknown };
  return record.type === 'FeatureCollection' && Array.isArray(record.features);
}

function collectionCrs(collection: GeoCollection): string | null {
  if (typeof collection['ifcviewx:crs'] === 'string') return collection['ifcviewx:crs'];
  if (!collection.crs || typeof collection.crs !== 'object') return null;
  const properties = (collection.crs as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object') return null;
  const name = (properties as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function crsToken(value: string): string {
  const epsg = value.match(/EPSG(?::|::|\/0\/)(\d+)/i);
  return epsg ? `EPSG:${epsg[1]}` : value.trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Plain decimals, not the reader's locale. A projected coordinate is copied
 * into GIS and survey tools, and a locale that writes 101,000 for 101.000
 * makes that paste either wrong or unparseable.
 */
function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "-";
}

/**
 * The four lines that answer "is this model placed, and where". Everything
 * else the file declares sits behind the details toggle below them.
 */
function placementFacts(model: FederatedModel): Array<[string, string]> {
  const crs = model.geo.projectedCrs;
  const operation = model.geo.operation;
  const origin = !operation
    ? 'no coordinate operation'
    : operation.kind === 'map-conversion'
      ? `${formatCoordinate(operation.eastings)} E, ${formatCoordinate(operation.northings)} N`
      : `${formatCoordinate(operation.firstCoordinate)}, ${formatCoordinate(operation.secondCoordinate)}`;
  return [
    ['Coordinate system', crs?.name ?? 'not declared'],
    ['Model origin at', origin],
    ['True north', model.geo.trueNorth ? `${model.geo.trueNorth.degreesFromGridNorth.toFixed(3)}° from grid north` : 'not declared'],
    ['Read from', `${model.geo.schema || 'unknown schema'} · ${operation ? (operation.kind === 'map-conversion' ? 'IfcMapConversion' : 'IfcRigidOperation') : 'no operation'}`],
  ];
}

function detailFacts(model: FederatedModel): Array<[string, string]> {
  const crs = model.geo.projectedCrs;
  const operation = model.geo.operation;
  const facts: Array<[string, string]> = [
    ['Geodetic datum', crs?.geodeticDatum ?? 'not declared'],
    ['Vertical datum', crs?.verticalDatum ?? 'not declared'],
    ['Projection', [crs?.mapProjection, crs?.mapZone].filter(Boolean).join(' / ') || 'not declared'],
    ['Map unit', crs?.mapUnit ?? 'project unit'],
  ];
  if (operation?.kind === 'map-conversion') {
    facts.push(
      ['Height', formatCoordinate(operation.orthogonalHeight)],
      ['Grid rotation', `${(operation.rotation * 180 / Math.PI).toFixed(6)}°`],
      ['Scale', operation.scale.toPrecision(10)],
    );
  } else if (operation) {
    facts.push(['Height', formatCoordinate(operation.height)], ['Coordinate type', operation.coordinateKind]);
  }
  return facts;
}

function alignmentId(model: FederatedModel): string {
  return `${model.name}|${model.geo.projectedCrs?.name ?? 'no-crs'}`;
}

function readAlignments(): Record<string, ModelTransform> {
  try {
    return JSON.parse(localStorage.getItem(ALIGNMENT_KEY) ?? '{}') as Record<string, ModelTransform>;
  } catch {
    return {};
  }
}

function writeAlignments(value: Record<string, ModelTransform>): void {
  localStorage.setItem(ALIGNMENT_KEY, JSON.stringify(value));
}

function field(label: string, value: number, step: string): { root: HTMLElement; input: HTMLInputElement } {
  const input = h('input', {
    type: 'number',
    value: String(value),
    step,
    'aria-label': label,
  });
  return { root: h('label', { class: 'geo-field' }, [h('span', { text: label }), input]), input };
}

function siteIds(node: SpatialNode | null): number[] {
  if (!node) return [];
  return [
    ...(node.type.toUpperCase() === 'IFCSITE' ? [node.expressID] : []),
    ...node.children.flatMap(siteIds),
  ];
}

export class GeoContextPanel {
  private readonly viewer: Viewer;
  private readonly layerInput: HTMLInputElement;
  private readonly overlayMeasurements: number[] = [];
  /** The two lines of the datum plate the pick position moves, kept so a click
   *  in the viewport updates the readout instead of rebuilding every card. */
  private readonly datumName = h('strong', { text: 'Local engineering coordinates' });
  private readonly datumValue = h('code', { text: 'No projected coordinate' });
  private readonly datumNote = h('small', { text: '' });
  private imported: GeoCollection | null = null;
  private layerName = '';
  private layerCrs: string | null = null;
  private layerWarning: string | null = null;
  private readonly offModel: () => void;
  private readonly offSelection: () => void;

  constructor(private readonly host: HTMLElement, private readonly actions: GeoContextActions) {
    this.viewer = actions.viewer;
    this.layerInput = h('input', { type: 'file', accept: '.geojson,.json,application/geo+json', hidden: true });
    this.layerInput.addEventListener('change', () => {
      const file = this.layerInput.files?.[0];
      this.layerInput.value = '';
      if (file) void this.importGeoJson(file);
    });
    this.host.appendChild(this.layerInput);
    this.offModel = this.viewer.onModelLoaded(() => {
      this.restoreManualAlignments();
      this.paint();
    });
    // Selecting in the viewport moves the readout and nothing else. A full
    // repaint here would throw away a half-typed manual alignment on a click.
    this.offSelection = this.viewer.onSelectionChange(() => this.paintDatum());
    this.restoreManualAlignments();
    this.paint();
  }

  private paintDatum(): void {
    const target = this.viewer.getLastPick()?.point ?? this.viewer.getCamera().target;
    const projected = this.viewer.sceneToGeoreferenced(target);
    const text = projected ? projected.coordinates.map(formatCoordinate).join(' / ') : 'No projected coordinate';
    this.datumName.textContent = projected?.crs ?? 'Local engineering coordinates';
    this.datumValue.textContent = text;
    this.datumValue.title = text;
    this.datumNote.textContent = projected
      ? 'E / N / elevation at the last pick or view target'
      : 'Add IfcProjectedCRS and a coordinate operation for map coordinates';
  }

  dispose(): void {
    this.offModel();
    this.offSelection();
    this.clearLayer(false);
  }

  private restoreManualAlignments(): void {
    const stored = readAlignments();
    const anchor = this.viewer.getGeoAnchor();
    for (const model of this.viewer.getModels()) {
      const transform = stored[alignmentId(model)];
      if (transform && model.index !== anchor) this.viewer.setModelPlacement(model.index, transform);
    }
  }

  private paint(): void {
    const models = this.viewer.getModels();
    this.host.replaceChildren(this.layerInput);
    if (!models.length) {
      this.host.appendChild(emptyState('globe', 'No coordinate context', 'Open an IFC model to inspect its CRS and federation placement.'));
      return;
    }

    const anchor = this.viewer.getGeoAnchor();
    const reference = anchor === null ? null : models.find((model) => model.index === anchor) ?? null;
    const aligned = models.filter((model) => model.geoStatus === 'aligned' || model.geoStatus === 'ready' || model.geoStatus === 'manual').length;
    const attention = models.filter((model) => model.geoStatus === 'missing' || model.geoStatus === 'conflict').length;
    const target = this.viewer.getLastPick()?.point ?? this.viewer.getCamera().target;
    const projected = this.viewer.sceneToGeoreferenced(target);
    const north = reference?.geo.trueNorth?.degreesFromGridNorth ?? 0;
    const origin = this.viewer.getModelOrigin();

    const align = h('button', { class: 'btn sm accent', type: 'button', text: 'Align compatible models' });
    align.addEventListener('click', () => {
      const count = this.viewer.alignGeospatialModels();
      this.paint();
      this.actions.log(`${count} federated model${count === 1 ? '' : 's'} aligned from IFC coordinates`, count ? 'success' : 'info');
    });
    const importLayer = h('button', { class: 'btn sm', type: 'button', text: 'Import GeoJSON' });
    importLayer.addEventListener('click', () => this.layerInput.click());
    const exportContext = h('button', { class: 'btn sm', type: 'button', text: 'Export GeoJSON' });
    exportContext.addEventListener('click', () => void this.exportGeoJson());

    // A dial rather than a drawing: the needle says how far true north turns
    // away from the model's own Y axis, which is the whole question.
    const compass = h('div', { class: 'geo-compass', style: `--north-angle:${north}deg`, 'aria-label': `True north ${north.toFixed(3)} degrees from grid north` }, [
      h('span', { class: 'geo-north' }, [h('i'), h('b', { text: 'N' })]),
    ]);
    const copyCoordinate = h('button', { class: 'btn sm geo-copy', type: 'button', text: 'Copy' });
    copyCoordinate.addEventListener('click', () => {
      const text = this.datumValue.textContent ?? '';
      void navigator.clipboard?.writeText(text).then(
        () => toast('Coordinate copied', 'success'),
        () => toast('The browser blocked the clipboard', 'error'),
      );
    });
    const plate = h('section', { class: 'geo-plate' }, [
      compass,
      h('div', { class: 'geo-plate-copy' }, [
        this.datumName,
        h('span', { class: 'geo-plate-value' }, [this.datumValue, copyCoordinate]),
        this.datumNote,
      ]),
    ]);
    this.paintDatum();

    const summary = h('div', { class: 'geo-summary' }, [
      h('div', {}, [h('b', { text: String(models.length) }), h('span', { text: 'models' })]),
      h('div', {}, [h('b', { text: String(aligned) }), h('span', { text: 'placed' })]),
      h('div', { class: attention ? 'warn' : 'ok' }, [h('b', { text: String(attention) }), h('span', { text: 'needs attention' })]),
    ]);

    const cards = h('div', { class: 'geo-models' }, models.map((model) => this.modelCard(model, anchor)));
    const layer = this.layerCard(projected?.crs ?? reference?.geo.projectedCrs?.name ?? null);
    this.host.appendChild(h('div', { class: 'page geo-page scroll' }, [
      h('div', { class: 'note', text: 'Where each open model sits in real-world coordinates, and how to line them up.' }),
      plate,
      summary,
      h('div', { class: 'geo-actions' }, [align, importLayer, exportContext]),
      h('div', { class: 'group-title' }, [
        h('span', { text: 'Models' }),
        h('span', { class: 'n', title: `Floating origin ${origin.map(formatCoordinate).join(' / ')}`, text: 'floating origin' }),
      ]),
      cards,
      h('div', { class: 'group-title', text: 'Map layer' }),
      layer,
    ]));
  }

  private modelCard(model: FederatedModel, anchor: number | null): HTMLElement {
    const crs = model.geo.projectedCrs;
    const isAnchor = model.index === anchor;
    const details = h('details', { class: `geo-model status-${model.geoStatus}` });
    details.appendChild(h('summary', {}, [
      h('span', { class: 'geo-signal', 'aria-hidden': true }),
      h('span', { class: 'grow geo-model-name' }, [
        h('b', { text: model.name, title: model.name }),
        h('small', { text: crs?.name ?? 'No projected CRS' }),
      ]),
      h('span', { class: 'geo-status', text: statusLabel[model.geoStatus] }),
      icon('chevron', 12),
    ]));

    const ledger = (facts: Array<[string, string]>): HTMLElement => {
      const list = h('dl', { class: 'geo-ledger' });
      for (const [key, value] of facts) list.append(h('dt', { text: key }), h('dd', { text: value, title: value }));
      return list;
    };
    const body = h('div', { class: 'geo-model-body' }, [ledger(placementFacts(model))]);
    if (model.diagnostics.length) {
      body.appendChild(h('div', { class: 'geo-diagnostics' }, model.diagnostics.map((message) =>
        h('p', {}, [icon('alert', 12), h('span', { text: message })]),
      )));
    }
    // The rest of what the file declares, for the day the four lines above
    // are not enough. Same for hand-placing a model: rare, so it stays shut.
    body.append(
      h('details', { class: 'geo-fold' }, [
        h('summary', { text: 'All coordinate facts' }),
        ledger(detailFacts(model)),
      ]),
      h('details', { class: 'geo-fold' }, [
        h('summary', { text: isAnchor ? 'Placement (this model is the anchor)' : 'Place this model by hand' }),
        this.manualAlignment(model, isAnchor),
      ]),
    );
    details.appendChild(body);
    return details;
  }

  private manualAlignment(model: FederatedModel, isAnchor: boolean): HTMLElement {
    const transform = model.transform;
    const east = field('East / X', transform.translation[0], '0.001');
    const north = field('North / Y', transform.translation[1], '0.001');
    const height = field('Height / Z', transform.translation[2], '0.001');
    const rotation = field('Rotation °', transform.rotationZ * 180 / Math.PI, '0.000001');
    const scale = field('Scale', transform.scale, '0.000001');
    const apply = h('button', { class: 'btn sm accent', type: 'button', text: 'Record alignment', disabled: isAnchor });
    const reset = h('button', { class: 'btn sm', type: 'button', text: 'Use IFC alignment', disabled: isAnchor });
    apply.addEventListener('click', () => {
      const next: ModelTransform = {
        translation: [Number(east.input.value), Number(north.input.value), Number(height.input.value)],
        rotationZ: Number(rotation.input.value) * Math.PI / 180,
        scale: Number(scale.input.value),
        source: 'manual',
        recordedAt: new Date().toISOString(),
      };
      if (!next.translation.every(Number.isFinite) || !Number.isFinite(next.rotationZ) || !Number.isFinite(next.scale) || next.scale <= 0) {
        return toast('Enter finite coordinates and a scale above zero', 'error');
      }
      const stored = readAlignments();
      stored[alignmentId(model)] = next;
      writeAlignments(stored);
      this.viewer.setModelPlacement(model.index, next);
      this.paint();
      this.actions.log(`Recorded manual alignment for ${model.name}`, 'success');
    });
    reset.addEventListener('click', () => {
      const stored = readAlignments();
      delete stored[alignmentId(model)];
      writeAlignments(stored);
      this.viewer.setModelPlacement(model.index, {
        translation: [0, 0, 0], rotationZ: 0, scale: 1, source: 'none',
      });
      this.viewer.alignGeospatialModels();
      this.paint();
    });
    return h('section', { class: 'geo-manual' }, [
      h('div', { class: 'note', text: isAnchor
        ? 'The anchor defines the federation frame, so it is never moved. Align the other models to it.'
        : transform.recordedAt
          ? `Hand placed ${new Date(transform.recordedAt).toLocaleString()}. Recorded in this browser, never written to the IFC.`
          : 'Use this when the IFC carries no usable coordinates. Recorded in this browser, never written to the IFC.' }),
      h('div', { class: 'geo-fields' }, [east.root, north.root, height.root, rotation.root, scale.root]),
      h('div', { class: 'geo-actions' }, [apply, reset]),
    ]);
  }

  private layerCard(crs: string | null): HTMLElement {
    const issuePoints = this.issueFeatures();
    const clear = h('button', { class: 'btn sm', type: 'button', text: 'Clear layer', disabled: !this.imported });
    clear.addEventListener('click', () => this.clearLayer());
    const create = h('button', { class: 'btn sm accent', type: 'button', text: `Create issues${issuePoints.length ? ` (${issuePoints.length})` : ''}`, disabled: !issuePoints.length || Boolean(this.layerWarning) });
    create.addEventListener('click', () => void this.createIssues(issuePoints));
    return h('section', { class: 'geo-layer' }, [
      h('div', { class: 'geo-layer-head' }, [
        h('span', {}, [h('b', { text: this.layerName || 'Local map layer' }), h('small', { text: this.imported ? `${this.imported.features.length} GeoJSON features in ${this.layerCrs ?? crs ?? 'an undeclared CRS'}` : 'Import a GeoJSON map, site boundary or issue point set' })]),
        h('span', { class: 'geo-layer-count', text: this.imported ? String(this.imported.features.length) : '0' }),
      ]),
      ...(this.layerWarning ? [h('div', { class: 'geo-diagnostics' }, [
        h('p', {}, [icon('alert', 12), h('span', { text: this.layerWarning })]),
      ])] : []),
      // An empty grid is decoration, so the preview only appears with a layer.
      ...(this.imported ? [this.mapPreview()] : []),
      h('div', { class: 'geo-actions' }, [create, clear]),
    ]);
  }

  private mapPreview(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'geo-map');
    svg.setAttribute('viewBox', '0 0 320 138');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', this.imported ? `Preview of ${this.layerName}` : 'Empty local map layer');
    const grid = document.createElementNS(svg.namespaceURI, 'path');
    grid.setAttribute('class', 'geo-map-grid');
    grid.setAttribute('d', 'M0 34.5H320M0 69H320M0 103.5H320M80 0V138M160 0V138M240 0V138');
    svg.appendChild(grid);
    if (!this.imported) return svg;
    const all = this.imported.features.flatMap((feature) => feature.geometry ? lines(feature.geometry).flat() : []).map(position).filter((item): item is Position => item !== null);
    if (!all.length) return svg;
    // A city-scale GeoJSON carries far more coordinates than the argument
    // limit of Math.min, so the extent is folded rather than spread.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of all) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const map = (item: Position): [number, number] => [
      18 + ((item[0] - minX) / span) * 284,
      120 - ((item[1] - minY) / span) * 104,
    ];
    for (const feature of this.imported.features) {
      if (!feature.geometry) continue;
      for (const line of lines(feature.geometry)) {
        const valid = line.map(position).filter((item): item is Position => item !== null);
        if (!valid.length) continue;
        if (valid.length === 1) {
          const [x, y] = map(valid[0]);
          const circle = document.createElementNS(svg.namespaceURI, 'circle');
          circle.setAttribute('class', 'geo-map-point');
          circle.setAttribute('cx', String(x));
          circle.setAttribute('cy', String(y));
          circle.setAttribute('r', '3.5');
          svg.appendChild(circle);
        } else {
          const path = document.createElementNS(svg.namespaceURI, 'path');
          path.setAttribute('class', 'geo-map-feature');
          path.setAttribute('d', valid.map((item, index) => `${index ? 'L' : 'M'}${map(item).join(' ')}`).join(''));
          svg.appendChild(path);
        }
      }
    }
    return svg;
  }

  private async importGeoJson(file: File): Promise<void> {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isCollection(parsed)) throw new Error('The file is not a GeoJSON FeatureCollection.');
      this.clearLayer(false);
      this.imported = parsed;
      this.layerName = parsed.name || file.name;
      this.layerCrs = collectionCrs(parsed);
      const anchor = this.viewer.getModels().find((model) => model.index === this.viewer.getGeoAnchor());
      const activeCrs = anchor?.geo.projectedCrs?.name ?? null;
      this.layerWarning = this.layerCrs && activeCrs && crsToken(this.layerCrs) !== crsToken(activeCrs)
        ? `Layer CRS ${this.layerCrs} conflicts with federation CRS ${activeCrs}. It is previewed but not placed in the model.`
        : null;
      if (!this.layerWarning) this.drawLayer();
      this.paint();
      this.actions.log(
        this.layerWarning ?? `Imported ${parsed.features.length} GeoJSON features from ${file.name}`,
        this.layerWarning ? 'info' : 'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private drawLayer(): void {
    if (!this.imported) return;
    let count = 0;
    const add = (a: Position, b: Position): void => {
      if (count >= LAYER_LIMIT) return;
      const start = this.viewer.georeferencedToScene([a[0], a[1], a[2] ?? 0]);
      const end = this.viewer.georeferencedToScene([b[0], b[1], b[2] ?? 0]);
      if (!start || !end) return;
      const measurement = this.viewer.addMeasurement(start, end);
      this.viewer.updateMeasurement(measurement.id, { label: 'GeoJSON map layer' });
      this.overlayMeasurements.push(measurement.id);
      count += 1;
    };
    for (const feature of this.imported.features) {
      if (!feature.geometry) continue;
      for (const line of lines(feature.geometry)) {
        const valid = line.map(position).filter((item): item is Position => item !== null);
        if (valid.length === 1) {
          const point = valid[0];
          add([point[0] - 1, point[1], point[2]], [point[0] + 1, point[1], point[2]]);
          add([point[0], point[1] - 1, point[2]], [point[0], point[1] + 1, point[2]]);
        } else for (let index = 1; index < valid.length; index++) add(valid[index - 1], valid[index]);
      }
    }
    if (count >= LAYER_LIMIT) toast(`Map display was limited to ${LAYER_LIMIT} segments`, 'info');
  }

  private clearLayer(repaint = true): void {
    for (const id of this.overlayMeasurements.splice(0)) this.viewer.removeMeasurement(id);
    this.imported = null;
    this.layerName = '';
    this.layerCrs = null;
    this.layerWarning = null;
    if (repaint) this.paint();
  }

  private issueFeatures(): GeoFeature[] {
    return this.imported?.features.filter((feature) => {
      if (feature.geometry?.type !== 'Point') return false;
      const kind = String(feature.properties?.kind ?? feature.properties?.type ?? '').toLowerCase();
      return kind.includes('issue') || kind.includes('bcf');
    }) ?? [];
  }

  private async createIssues(features: GeoFeature[]): Promise<void> {
    let created = 0;
    for (const feature of features.slice(0, 25)) {
      const coordinate = position(feature.geometry?.coordinates);
      if (!coordinate) continue;
      const point = this.viewer.georeferencedToScene([coordinate[0], coordinate[1], coordinate[2] ?? 0]);
      if (!point) continue;
      const title = String(feature.properties?.title ?? feature.properties?.name ?? `Geo issue ${created + 1}`);
      await this.actions.createIssue({
        title,
        description: String(feature.properties?.description ?? 'Imported from GeoJSON.'),
        point,
        metadata: { source: this.layerName, geojsonId: String(feature.id ?? '') },
      });
      created += 1;
    }
    this.actions.log(`Created ${created} BCF issue${created === 1 ? '' : 's'} from GeoJSON`, created ? 'success' : 'info');
  }

  private async exportGeoJson(): Promise<void> {
    const features: GeoFeature[] = [];
    const selected = this.viewer.getSelectedIds();
    for (const id of selected) {
      const bounds = this.viewer.getElementBounds(id);
      if (!bounds) continue;
      const centre: [number, number, number] = [
        (bounds.min.x + bounds.max.x) / 2,
        (bounds.min.y + bounds.max.y) / 2,
        (bounds.min.z + bounds.max.z) / 2,
      ];
      const geo = this.viewer.sceneToGeoreferenced(centre);
      if (!geo) continue;
      const properties = await this.viewer.getProperties(id).catch(() => null);
      const attribute = (name: string): string => String(properties?.attributes.find((item) => item.name === name)?.value ?? '');
      features.push({
        type: 'Feature',
        id: attribute('GlobalId') || id,
        properties: { kind: 'asset', expressID: id, ifcType: properties?.type ?? '', name: attribute('Name'), globalId: attribute('GlobalId') },
        geometry: { type: 'Point', coordinates: geo.coordinates },
      });
    }
    for (const id of siteIds(this.viewer.getSpatialTree())) {
      const bounds = this.viewer.getElementBounds(id);
      const modelBox = this.viewer.getModelBox();
      const point: [number, number, number] = bounds
        ? [
            (bounds.min.x + bounds.max.x) / 2,
            (bounds.min.y + bounds.max.y) / 2,
            (bounds.min.z + bounds.max.z) / 2,
          ]
        : [
            (modelBox.min[0] + modelBox.max[0]) / 2,
            (modelBox.min[1] + modelBox.max[1]) / 2,
            (modelBox.min[2] + modelBox.max[2]) / 2,
          ];
      const geo = this.viewer.sceneToGeoreferenced(point);
      if (geo) features.push({ type: 'Feature', id, properties: { kind: 'site', expressID: id }, geometry: { type: 'Point', coordinates: geo.coordinates } });
    }
    for (const feature of this.issueFeatures()) features.push(structuredClone(feature));
    if (!features.length) return toast('Select assets, load issue points, or open a model with an IfcSite first', 'info');
    const anchor = this.viewer.getModels().find((model) => model.index === this.viewer.getGeoAnchor());
    const crs = anchor?.geo.projectedCrs?.name ?? 'Unnamed projected CRS';
    const collection: GeoCollection = {
      type: 'FeatureCollection',
      name: 'IFCViewX geo context',
      'ifcviewx:crs': crs,
      crs: { type: 'name', properties: { name: crs } },
      features,
    };
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: 'ifcviewx-geo-context.geojson' });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.actions.log(`Exported ${features.length} georeferenced GeoJSON features`, 'success');
  }
}
