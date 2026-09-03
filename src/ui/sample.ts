// A compact IFC4 demonstration building generated in memory.
//
// Keeping the sample in source makes its provenance unambiguous and avoids a
// large binary in the offline shell. The model is deliberately useful for UI
// testing: two connected storeys, a roof, rooms, doors, windows, columns,
// authored quantities, property sets, presentation colours and materials.

/** 22 characters from the IfcGloballyUniqueId character set. */
const guid = (n: number): string => `2Sample${String(n).padStart(15, "0")}`;

/** Attributes after Representation for the IFC4 product subclasses we use. */
const TAIL: Record<string, string> = {
  WALL: "$,$",
  SLAB: "$,$",
  COLUMN: "$,$",
  DOOR: "$,$,$,$,$,$",
  WINDOW: "$,$,$,$,$,$",
  // LongName, CompositionType, PredefinedType, ElevationWithFlooring.
  SPACE: "$,.ELEMENT.,$,$",
};

interface MaterialDef {
  ref: number;
  style: number;
  products: number[];
}

export const SAMPLE_NAME = "ifcviewx-demo-building.ifc";

export function sampleModel(): Uint8Array {
  const lines: string[] = [];
  let next = 1;
  let guids = 0;
  const add = (body: string): number => {
    const id = next++;
    lines.push(`#${id}=${body};`);
    return id;
  };
  const g = (): string => guid(guids++);

  const person = add("IFCPERSON($,$,'',$,$,$,$,$)");
  const org = add("IFCORGANIZATION($,'IFCViewX',$,$,$)");
  const pao = add(`IFCPERSONANDORGANIZATION(#${person},#${org},$)`);
  const app = add(`IFCAPPLICATION(#${org},'0.1.4','IFCViewX','ifcviewx')`);
  const owner = add(`IFCOWNERHISTORY(#${pao},#${app},$,.ADDED.,$,$,$,0)`);

  const metre = add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
  const sqm = add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)");
  const cbm = add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)");
  const units = add(`IFCUNITASSIGNMENT((#${metre},#${sqm},#${cbm}))`);

  const origin = add("IFCCARTESIANPOINT((0.,0.,0.))");
  const profileOrigin = add("IFCCARTESIANPOINT((0.,0.))");
  const dirZ = add("IFCDIRECTION((0.,0.,1.))");
  const dirX = add("IFCDIRECTION((1.,0.,0.))");
  const dirY = add("IFCDIRECTION((0.,1.,0.))");
  const axis = add(`IFCAXIS2PLACEMENT3D(#${origin},#${dirZ},#${dirX})`);
  const profileAxis = add(`IFCAXIS2PLACEMENT2D(#${profileOrigin},$)`);
  const context = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#${axis},#${dirY})`);
  const projectedCrs = add(`IFCPROJECTEDCRS('EPSG:25833','ETRS89 / UTM zone 33N','ETRS89','DHHN2016','UTM','33N',#${metre})`);
  add(`IFCMAPCONVERSION(#${context},#${projectedCrs},451000.,5990000.,12.5,0.999961923,0.008726535,1.)`);

  const project = add(`IFCPROJECT('${g()}',#${owner},'IFCViewX demo building',$,$,$,$,(#${context}),#${units})`);
  const sitePlace = add(`IFCLOCALPLACEMENT($,#${axis})`);
  const site = add(`IFCSITE('${g()}',#${owner},'Demo site',$,$,#${sitePlace},$,$,.ELEMENT.,$,$,$,$,$)`);
  const buildingPlace = add(`IFCLOCALPLACEMENT(#${sitePlace},#${axis})`);
  const building = add(`IFCBUILDING('${g()}',#${owner},'Riverside office',$,$,#${buildingPlace},$,$,.ELEMENT.,$,$,$)`);

  // The upper placement is exactly one wall plus one floor slab above the
  // ground placement. Ground walls meet the upper slab at 3.000 m, upper
  // walls begin on its top at 3.200 m, and the roof begins at 6.200 m.
  const storeyElevations = [0, 3.2];
  const storeyNames = ["Ground floor", "First floor"];
  const storeys: number[] = [];
  const storeyPlaces: number[] = [];
  for (let i = 0; i < storeyElevations.length; i++) {
    const elevation = storeyElevations[i];
    const point = add(`IFCCARTESIANPOINT((0.,0.,${elevation.toFixed(3)}))`);
    const place3d = add(`IFCAXIS2PLACEMENT3D(#${point},#${dirZ},#${dirX})`);
    const place = add(`IFCLOCALPLACEMENT(#${buildingPlace},#${place3d})`);
    storeyPlaces.push(place);
    storeys.push(add(
      `IFCBUILDINGSTOREY('${g()}',#${owner},'${storeyNames[i]}',$,$,#${place},$,$,.ELEMENT.,${elevation.toFixed(3)})`,
    ));
  }

  add(`IFCRELAGGREGATES('${g()}',#${owner},$,$,#${project},(#${site}))`);
  add(`IFCRELAGGREGATES('${g()}',#${owner},$,$,#${site},(#${building}))`);
  add(`IFCRELAGGREGATES('${g()}',#${owner},$,$,#${building},(${storeys.map((id) => `#${id}`).join(",")}))`);

  const material = (name: string, rgb: [number, number, number]): MaterialDef => {
    const ref = add(`IFCMATERIAL('${name}',$,$)`);
    const colour = add(`IFCCOLOURRGB('${name}',${rgb[0]},${rgb[1]},${rgb[2]})`);
    const shading = add(`IFCSURFACESTYLESHADING(#${colour},0.)`);
    const style = add(`IFCSURFACESTYLE('${name}',.BOTH.,(#${shading}))`);
    return { ref, style, products: [] };
  };
  const concrete = material("Concrete", [0.62, 0.66, 0.7]);
  const masonry = material("Warm white masonry", [0.84, 0.79, 0.69]);
  const timber = material("Oak", [0.55, 0.31, 0.14]);
  const glass = material("Clear glass", [0.32, 0.66, 0.78]);
  const steel = material("Painted steel", [0.25, 0.3, 0.36]);
  const materials = [concrete, masonry, timber, glass, steel];

  const products: number[][] = storeys.map(() => []);
  const spaces: number[][] = storeys.map(() => []);

  /** A styled rectangular extrusion placed relative to its storey. */
  const box = (
    entity: "WALL" | "SLAB" | "COLUMN" | "DOOR" | "WINDOW",
    name: string,
    storey: number,
    x: number,
    y: number,
    z: number,
    width: number,
    depth: number,
    height: number,
    alongY: boolean,
    finish: MaterialDef,
  ): number => {
    const point = add(`IFCCARTESIANPOINT((${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}))`);
    const place3d = add(`IFCAXIS2PLACEMENT3D(#${point},#${dirZ},#${alongY ? dirY : dirX})`);
    const place = add(`IFCLOCALPLACEMENT(#${storeyPlaces[storey]},#${place3d})`);
    const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${profileAxis},${width.toFixed(3)},${depth.toFixed(3)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(#${profile},#${axis},#${dirZ},${height.toFixed(3)})`);
    add(`IFCSTYLEDITEM(#${solid},(#${finish.style}),$)`);
    const shape = add(`IFCSHAPEREPRESENTATION(#${context},'Body','SweptSolid',(#${solid}))`);
    const definition = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${shape}))`);
    const ref = add(`IFC${entity}('${g()}',#${owner},'${name}',$,$,#${place},#${definition},${TAIL[entity]})`);
    products[storey].push(ref);
    finish.products.push(ref);
    return ref;
  };

  const W = 12;
  const D = 9;
  const WALL_T = 0.25;
  const WALL_H = 3;
  const SLAB_T = 0.2;
  const DOOR_W = 1.2;
  const DOOR_H = 2.1;
  const WINDOW_W = 2.2;
  const WINDOW_H = 1.25;
  const WINDOW_SILL = 0.9;

  const addWall = (
    name: string, storey: number, x: number, y: number, z: number,
    length: number, height: number, alongY: boolean, external = true,
  ): void => {
    const ref = box("WALL", name, storey, x, y, z, length, WALL_T, height, alongY, masonry);
    const isExternal = add(`IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.${external ? "T" : "F"}.),$)`);
    const rating = add(`IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('${external ? "REI 60" : "REI 30"}'),$)`);
    const thickness = add(`IFCPROPERTYSINGLEVALUE('Width',$,IFCPOSITIVELENGTHMEASURE(${WALL_T}),$)`);
    const set = add(`IFCPROPERTYSET('${g()}',#${owner},'Pset_WallCommon',$,(#${isExternal},#${rating},#${thickness}))`);
    add(`IFCRELDEFINESBYPROPERTIES('${g()}',#${owner},$,$,(#${ref}),#${set})`);
  };

  const addSpace = (
    storey: number, name: string, longName: string, x: number, width: number, depth: number,
  ): void => {
    const point = add(`IFCCARTESIANPOINT((${x.toFixed(3)},0.,0.))`);
    const place3d = add(`IFCAXIS2PLACEMENT3D(#${point},#${dirZ},#${dirX})`);
    const place = add(`IFCLOCALPLACEMENT(#${storeyPlaces[storey]},#${place3d})`);
    const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${profileAxis},${width.toFixed(3)},${depth.toFixed(3)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(#${profile},#${axis},#${dirZ},${WALL_H.toFixed(3)})`);
    const shape = add(`IFCSHAPEREPRESENTATION(#${context},'Body','SweptSolid',(#${solid}))`);
    const definition = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${shape}))`);
    const ref = add(`IFCSPACE('${g()}',#${owner},'${name}','${longName}',$,#${place},#${definition},'${longName}',.ELEMENT.,$,$)`);
    spaces[storey].push(ref);

    const area = width * depth;
    const netArea = add(`IFCQUANTITYAREA('NetFloorArea',$,$,${area.toFixed(4)},$)`);
    const grossArea = add(`IFCQUANTITYAREA('GrossFloorArea',$,$,${(area * 1.06).toFixed(4)},$)`);
    const volume = add(`IFCQUANTITYVOLUME('NetVolume',$,$,${(area * WALL_H).toFixed(4)},$)`);
    const height = add(`IFCQUANTITYLENGTH('Height',$,$,${WALL_H.toFixed(3)},$)`);
    const qto = add(`IFCELEMENTQUANTITY('${g()}',#${owner},'Qto_SpaceBaseQuantities',$,$,(#${netArea},#${grossArea},#${volume},#${height}))`);
    add(`IFCRELDEFINESBYPROPERTIES('${g()}',#${owner},$,$,(#${ref}),#${qto})`);
    const people = add(`IFCPROPERTYSINGLEVALUE('OccupancyNumber',$,IFCCOUNTMEASURE(${Math.max(2, Math.round(area / 9))}),$)`);
    const category = add(`IFCPROPERTYSINGLEVALUE('Category',$,IFCLABEL('${longName}'),$)`);
    const pset = add(`IFCPROPERTYSET('${g()}',#${owner},'Pset_SpaceCommon',$,(#${people},#${category}))`);
    add(`IFCRELDEFINESBYPROPERTIES('${g()}',#${owner},$,$,(#${ref}),#${pset})`);
  };

  for (let s = 0; s < storeys.length; s++) {
    box("SLAB", s === 0 ? "Ground-bearing slab" : "First-floor slab", s, 0, 0, -SLAB_T, W, D, SLAB_T, false, concrete);

    // South facade: two full-height piers and a lintel leave a real door gap.
    const doorSide = (W - DOOR_W) / 2;
    addWall(`South wall left ${s + 1}`, s, -(DOOR_W + doorSide) / 2, -D / 2 + WALL_T / 2, 0, doorSide, WALL_H, false);
    addWall(`South wall right ${s + 1}`, s, (DOOR_W + doorSide) / 2, -D / 2 + WALL_T / 2, 0, doorSide, WALL_H, false);
    addWall(`South door lintel ${s + 1}`, s, 0, -D / 2 + WALL_T / 2, DOOR_H, DOOR_W, WALL_H - DOOR_H, false);
    box("DOOR", s === 0 ? "Main entrance" : "Terrace door", s, 0, -D / 2 + WALL_T / 2, 0, DOOR_W, WALL_T + 0.035, DOOR_H, false, timber);
    if (s === 1) {
      // The upper facade door lands on a cantilevered slab, not in mid-air.
      box("SLAB", "First-floor balcony", s, 0, -D / 2 - 0.75, -SLAB_T, 3.4, 1.5, SLAB_T, false, concrete);
    }

    // North facade: piers, sill and head surround a glazed opening.
    const windowSide = (W - WINDOW_W) / 2;
    addWall(`North wall left ${s + 1}`, s, -(WINDOW_W + windowSide) / 2, D / 2 - WALL_T / 2, 0, windowSide, WALL_H, false);
    addWall(`North wall right ${s + 1}`, s, (WINDOW_W + windowSide) / 2, D / 2 - WALL_T / 2, 0, windowSide, WALL_H, false);
    addWall(`North window sill ${s + 1}`, s, 0, D / 2 - WALL_T / 2, 0, WINDOW_W, WINDOW_SILL, false);
    const headZ = WINDOW_SILL + WINDOW_H;
    addWall(`North window head ${s + 1}`, s, 0, D / 2 - WALL_T / 2, headZ, WINDOW_W, WALL_H - headZ, false);
    box("WINDOW", `North window ${s + 1}`, s, 0, D / 2 - WALL_T / 2, WINDOW_SILL, WINDOW_W, WALL_T + 0.025, WINDOW_H, false, glass);

    addWall(`West wall ${s + 1}`, s, -W / 2 + WALL_T / 2, 0, 0, D - WALL_T * 2, WALL_H, true);
    addWall(`East wall ${s + 1}`, s, W / 2 - WALL_T / 2, 0, 0, D - WALL_T * 2, WALL_H, true);

    // A central partition has its own doorway, so the authored rooms match
    // the visible plan instead of being two overlapping space boxes.
    const innerLength = D - WALL_T * 2;
    const partitionSide = (innerLength - DOOR_W) / 2;
    addWall(`Partition south ${s + 1}`, s, 0, -(DOOR_W + partitionSide) / 2, 0, partitionSide, WALL_H, true, false);
    addWall(`Partition north ${s + 1}`, s, 0, (DOOR_W + partitionSide) / 2, 0, partitionSide, WALL_H, true, false);
    addWall(`Partition lintel ${s + 1}`, s, 0, 0, DOOR_H, DOOR_W, WALL_H - DOOR_H, true, false);
    box("DOOR", `Internal door ${s + 1}`, s, 0, 0, 0, DOOR_W, WALL_T + 0.035, DOOR_H, true, timber);

    for (const [label, x, y] of [
      ["A", -4.2, -2.7], ["B", 4.2, -2.7], ["C", -4.2, 2.7], ["D", 4.2, 2.7],
    ] as Array<[string, number, number]>) {
      box("COLUMN", `Column ${label}${s + 1}`, s, x, y, 0, 0.32, 0.32, WALL_H, false, steel);
    }

    const roomWidth = (W - WALL_T * 3) / 2;
    const roomDepth = D - WALL_T * 2;
    const roomOffset = WALL_T / 2 + roomWidth / 2;
    addSpace(s, `${s + 1}01`, s === 0 ? "Open office" : "Studio", -roomOffset, roomWidth, roomDepth);
    addSpace(s, `${s + 1}02`, s === 0 ? "Meeting room" : "Project room", roomOffset, roomWidth, roomDepth);
  }

  // The roof starts exactly where the upper walls stop.
  box("SLAB", "Warm roof", 1, 0, 0, WALL_H, W + 0.4, D + 0.4, 0.25, false, concrete);

  for (let s = 0; s < storeys.length; s++) {
    add(`IFCRELAGGREGATES('${g()}',#${owner},$,$,#${storeys[s]},(${spaces[s].map((id) => `#${id}`).join(",")}))`);
    add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${g()}',#${owner},$,$,(${products[s].map((id) => `#${id}`).join(",")}),#${storeys[s]})`);
  }
  for (const finish of materials) {
    if (!finish.products.length) continue;
    add(`IFCRELASSOCIATESMATERIAL('${g()}',#${owner},$,$,(${finish.products.map((id) => `#${id}`).join(",")}),#${finish.ref})`);
  }

  const text = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');",
    `FILE_NAME('${SAMPLE_NAME}','2026-08-31T00:00:00',('IFCViewX'),(''),'IFCViewX 0.1.4','IFCViewX','');`,
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
  return new TextEncoder().encode(text);
}
