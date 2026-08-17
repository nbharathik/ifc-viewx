// A small building, written as IFC4 in memory.
//
// The first screen used to be empty until someone found a file of their own,
// which is a poor way to learn what the viewer does. This is generated rather
// than shipped so the bundle carries no model, and it is deliberately varied:
// two storeys, five classes and real property sets, so the tree, the colour
// rules and the property panel all have something to show.

/** 22 characters, unique per element, from the IfcGloballyUniqueId charset. */
const guid = (n: number): string => `2Sample${String(n).padStart(15, "0")}`;

/**
 * Attributes after Representation, per class. IFC4 gives doors and windows four
 * more than the rest, and web-ifc rejects the entity outright if the count is
 * wrong, so this is not cosmetic.
 */
const TAIL: Record<string, string> = {
  WALL: "$,$",
  SLAB: "$,$",
  COLUMN: "$,$",
  DOOR: "$,$,$,$,$,$",
  WINDOW: "$,$,$,$,$,$",
  // LongName, CompositionType, PredefinedType, ElevationWithFlooring.
  SPACE: "$,.ELEMENT.,$,$",
};

interface Placed {
  ref: number;
  storey: number;
}

export const SAMPLE_NAME = "sample-building.ifc";

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
  const app = add(`IFCAPPLICATION(#${org},'1','IFCViewX','ifcviewx')`);
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

  const project = add(`IFCPROJECT('${g()}',#${owner},'Sample building',$,$,$,$,(#${context}),#${units})`);
  const sitePlace = add(`IFCLOCALPLACEMENT($,#${axis})`);
  const site = add(`IFCSITE('${g()}',#${owner},'Site',$,$,#${sitePlace},$,$,.ELEMENT.,$,$,$,$,$)`);
  const buildingPlace = add(`IFCLOCALPLACEMENT(#${sitePlace},#${axis})`);
  const building = add(`IFCBUILDING('${g()}',#${owner},'Sample building',$,$,#${buildingPlace},$,$,.ELEMENT.,$,$,$)`);

  const storeyHeights = [0, 3.4];
  const storeyNames = ["Ground floor", "First floor"];
  const storeys: number[] = [];
  const storeyPlaces: number[] = [];
  for (let i = 0; i < storeyHeights.length; i++) {
    const point = add(`IFCCARTESIANPOINT((0.,0.,${storeyHeights[i].toFixed(3)}))`);
    const place3d = add(`IFCAXIS2PLACEMENT3D(#${point},#${dirZ},#${dirX})`);
    const place = add(`IFCLOCALPLACEMENT(#${buildingPlace},#${place3d})`);
    storeyPlaces.push(place);
    storeys.push(
      add(
        `IFCBUILDINGSTOREY('${g()}',#${owner},'${storeyNames[i]}',$,$,#${place},$,$,.ELEMENT.,${storeyHeights[i].toFixed(3)})`,
      ),
    );
  }

  add(`IFCRELAGGREGATES('${g()}',#${owner},$,$,#${project},(#${site}))`);
  add(`IFCRELAGGREGATES('${g()}',#${owner},$,$,#${site},(#${building}))`);
  add(`IFCRELAGGREGATES('${g()}',#${owner},$,$,#${building},(${storeys.map((s) => `#${s}`).join(",")}))`);

  const placed: Placed[] = [];
  const products: number[][] = storeys.map(() => []);

  /**
   * One box, as a centred rectangle extruded upward. Everything in the sample
   * is a box, so profiles and solids are the only geometry involved and the
   * file stays small enough to read.
   */
  const box = (
    entity: string,
    name: string,
    storey: number,
    x: number,
    y: number,
    z: number,
    width: number,
    depth: number,
    height: number,
    alongY: boolean,
  ): number => {
    const point = add(`IFCCARTESIANPOINT((${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}))`);
    const place3d = add(`IFCAXIS2PLACEMENT3D(#${point},#${dirZ},#${alongY ? dirY : dirX})`);
    const place = add(`IFCLOCALPLACEMENT(#${storeyPlaces[storey]},#${place3d})`);
    const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${profileAxis},${width.toFixed(3)},${depth.toFixed(3)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(#${profile},#${axis},#${dirZ},${height.toFixed(3)})`);
    const shape = add(`IFCSHAPEREPRESENTATION(#${context},'Body','SweptSolid',(#${solid}))`);
    const definition = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${shape}))`);
    const ref = add(
      `IFC${entity}('${g()}',#${owner},'${name}',$,$,#${place},#${definition},${TAIL[entity]})`,
    );
    products[storey].push(ref);
    placed.push({ ref, storey });
    return ref;
  };

  const W = 10;
  const D = 8;
  const WALL_T = 0.3;
  const WALL_H = 3;

  for (let s = 0; s < storeys.length; s++) {
    box("SLAB", `Floor slab ${s + 1}`, s, 0, 0, -0.2, W, D, 0.2, false);
    const walls = [
      [`South wall ${s + 1}`, 0, -D / 2 + WALL_T / 2, W, WALL_T, false],
      [`North wall ${s + 1}`, 0, D / 2 - WALL_T / 2, W, WALL_T, false],
      [`West wall ${s + 1}`, -W / 2 + WALL_T / 2, 0, D - WALL_T * 2, WALL_T, true],
      [`East wall ${s + 1}`, W / 2 - WALL_T / 2, 0, D - WALL_T * 2, WALL_T, true],
    ] as Array<[string, number, number, number, number, boolean]>;
    for (const [name, x, y, length, thickness, alongY] of walls) {
      const ref = box("WALL", name, s, x, y, 0, length, thickness, WALL_H, alongY);
      addProperties(ref, name.startsWith("South") || name.startsWith("North"));
    }
    box("COLUMN", `Column A${s + 1}`, s, -3, -2, 0, 0.4, 0.4, WALL_H, false);
    box("COLUMN", `Column B${s + 1}`, s, 3, 2, 0, 0.4, 0.4, WALL_H, false);
    box("DOOR", `Door ${s + 1}`, s, -2, -D / 2 + WALL_T / 2, 0, 1, WALL_T + 0.02, 2.1, false);
    box("WINDOW", `Window ${s + 1}`, s, 2.5, D / 2 - WALL_T / 2, 1, 1.6, WALL_T + 0.02, 1.2, false);

    // Two rooms per storey, split down the middle, so the room book has real
    // authored quantities to read rather than only bounding boxes.
    const inner = W - WALL_T * 2;
    const depth = D - WALL_T * 2;
    addSpace(s, `${s + 1}01`, "Office", -inner / 4, 0, inner / 2, depth, WALL_H);
    addSpace(s, `${s + 1}02`, "Meeting room", inner / 4, 0, inner / 2, depth, WALL_H);
  }

  /**
   * A space is a spatial structure element, so it decomposes the storey through
   * IfcRelAggregates rather than being contained in it like a wall is.
   */
  function addSpace(
    storey: number,
    name: string,
    longName: string,
    x: number,
    y: number,
    width: number,
    depth: number,
    height: number,
  ): void {
    const point = add(`IFCCARTESIANPOINT((${x.toFixed(3)},${y.toFixed(3)},0.))`);
    const place3d = add(`IFCAXIS2PLACEMENT3D(#${point},#${dirZ},#${dirX})`);
    const place = add(`IFCLOCALPLACEMENT(#${storeyPlaces[storey]},#${place3d})`);
    const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${profileAxis},${width.toFixed(3)},${depth.toFixed(3)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(#${profile},#${axis},#${dirZ},${height.toFixed(3)})`);
    const shape = add(`IFCSHAPEREPRESENTATION(#${context},'Body','SweptSolid',(#${solid}))`);
    const definition = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${shape}))`);
    const ref = add(
      `IFCSPACE('${g()}',#${owner},'${name}','${longName}',$,#${place},#${definition},'${longName}',.ELEMENT.,$,$)`,
    );
    add(`IFCRELAGGREGATES('${g()}',#${owner},$,$,#${storeys[storey]},(#${ref}))`);

    const area = width * depth;
    const netArea = add(`IFCQUANTITYAREA('NetFloorArea',$,$,${area.toFixed(4)},$)`);
    const grossArea = add(`IFCQUANTITYAREA('GrossFloorArea',$,$,${(area * 1.06).toFixed(4)},$)`);
    const volume = add(`IFCQUANTITYVOLUME('NetVolume',$,$,${(area * height).toFixed(4)},$)`);
    const tall = add(`IFCQUANTITYLENGTH('Height',$,$,${height.toFixed(3)},$)`);
    const qto = add(
      `IFCELEMENTQUANTITY('${g()}',#${owner},'Qto_SpaceBaseQuantities',$,$,(#${netArea},#${grossArea},#${volume},#${tall}))`,
    );
    add(`IFCRELDEFINESBYPROPERTIES('${g()}',#${owner},$,$,(#${ref}),#${qto})`);

    const people = add(`IFCPROPERTYSINGLEVALUE('OccupancyNumber',$,IFCCOUNTMEASURE(${Math.max(2, Math.round(area / 8))}),$)`);
    const category = add(`IFCPROPERTYSINGLEVALUE('Category',$,IFCLABEL('${longName}'),$)`);
    const pset = add(`IFCPROPERTYSET('${g()}',#${owner},'Pset_SpaceCommon',$,(#${people},#${category}))`);
    add(`IFCRELDEFINESBYPROPERTIES('${g()}',#${owner},$,$,(#${ref}),#${pset})`);
  }

  function addProperties(ref: number, external: boolean): void {
    const isExternal = add(
      `IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.${external ? "T" : "F"}.),$)`,
    );
    const rating = add(`IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('${external ? "REI 60" : "REI 30"}'),$)`);
    const thickness = add(`IFCPROPERTYSINGLEVALUE('Width',$,IFCPOSITIVELENGTHMEASURE(${WALL_T.toFixed(3)}),$)`);
    const set = add(
      `IFCPROPERTYSET('${g()}',#${owner},'Pset_WallCommon',$,(#${isExternal},#${rating},#${thickness}))`,
    );
    add(`IFCRELDEFINESBYPROPERTIES('${g()}',#${owner},$,$,(#${ref}),#${set})`);
  }

  for (let s = 0; s < storeys.length; s++) {
    if (products[s].length === 0) continue;
    add(
      `IFCRELCONTAINEDINSPATIALSTRUCTURE('${g()}',#${owner},$,$,(${products[s].map((p) => `#${p}`).join(",")}),#${storeys[s]})`,
    );
  }

  const text = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION((''),'2;1');",
    `FILE_NAME('${SAMPLE_NAME}','2026-01-01T00:00:00',(''),(''),'IFCViewX','IFCViewX','');`,
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
