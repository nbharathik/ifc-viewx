export type BsddKind = "Class" | "Property" | "Material";

export interface BsddHit {
  kind: BsddKind;
  code: string;
  name: string;
  uri: string;
  dictionaryUri: string;
  dictionaryName: string;
  description: string;
  relatedIfcEntities: string[];
}

interface TextSearchItem {
  dictionaryUri?: string | null;
  uri?: string | null;
  code?: string | null;
  name?: string | null;
  classType?: string | null;
  description?: string | null;
  relatedIfcEntityNames?: string[] | null;
}

interface TextSearchDictionary {
  uri?: string | null;
  name?: string | null;
}

interface TextSearchResponse {
  classes?: TextSearchItem[] | null;
  properties?: TextSearchItem[] | null;
  dictionaries?: TextSearchDictionary[] | null;
}

const API = "https://api.bsdd.buildingsmart.org/api/TextSearch/v2";

function dictionaryCode(uri: string): string {
  const parts = uri.split("/").filter(Boolean);
  const marker = parts.indexOf("uri");
  return marker >= 0 ? parts[marker + 2] ?? uri : uri;
}

function stable(uri: string): boolean {
  return uri.startsWith("https://") && !/\/latest(?:\/|$)/i.test(uri);
}

export async function searchBsdd(
  query: string,
  kind: BsddKind | "All" = "All",
  signal?: AbortSignal,
): Promise<BsddHit[]> {
  const search = query.trim();
  if (search.length < 2) throw new Error("Enter at least two characters to search bSDD.");
  const params = new URLSearchParams({
    SearchText: search,
    TypeFilter: kind === "All" ? "Class;Property;Material" : kind,
    OnlyLatestVersion: "true",
    IncludeInactive: "false",
    IncludePreview: "false",
    Limit: "40",
  });
  let response: Response;
  try {
    response = await fetch(`${API}?${params}`, {
      signal,
      headers: { Accept: "application/json", "X-User-Agent": `IFCViewX/${__APP_VERSION__}` },
    });
  } catch (error) {
    if (signal?.aborted) throw new DOMException("bSDD search cancelled", "AbortError");
    throw new Error("bSDD could not be reached. This deployment may need its origin added to the bSDD CORS allowlist.", { cause: error });
  }
  if (!response.ok) throw new Error(`bSDD search failed with HTTP ${response.status}.`);
  const data = await response.json() as TextSearchResponse;
  const dictionaries = new Map((data.dictionaries ?? []).map((item) => [item.uri ?? "", item.name ?? ""]));
  const map = (item: TextSearchItem, itemKind: BsddKind): BsddHit | null => {
    const uri = item.uri ?? "";
    const dictionaryUri = item.dictionaryUri ?? "";
    if (!uri || !stable(uri)) return null;
    return {
      kind: itemKind,
      code: item.code ?? item.name ?? uri.split("/").pop() ?? "",
      name: item.name ?? item.code ?? "Unnamed bSDD concept",
      uri,
      dictionaryUri,
      dictionaryName: dictionaries.get(dictionaryUri) || dictionaryCode(dictionaryUri),
      description: item.description ?? "",
      relatedIfcEntities: item.relatedIfcEntityNames ?? [],
    };
  };
  const hits = [
    ...(data.classes ?? []).map((item) => map(item, item.classType === "Material" ? "Material" : "Class")),
    ...(data.properties ?? []).map((item) => map(item, "Property")),
  ].filter((item): item is BsddHit => item !== null);
  return hits;
}
