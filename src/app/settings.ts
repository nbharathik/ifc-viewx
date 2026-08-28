import { safeStorageGet, safeStorageSet } from "../ui/kit.js";

export interface AppSettings {
  scale: number;
  adaptive: boolean;
  doubleSided: boolean;
  antialias: boolean;
  hud: boolean;
  lod: boolean;
  offerConvert: boolean;
}

export const LOD_PIXELS = 2;

const SETTINGS_KEY = "ifcviewx.settings";
const DEFAULT_SETTINGS: AppSettings = {
  scale: 1,
  adaptive: true,
  doubleSided: true,
  antialias: true,
  hud: false,
  lod: true,
  offerConvert: true,
};

export function loadAppSettings(): AppSettings {
  try {
    return {
      ...DEFAULT_SETTINGS,
      ...(JSON.parse(safeStorageGet(SETTINGS_KEY) ?? "{}") as Partial<AppSettings>),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveAppSettings(settings: AppSettings): void {
  safeStorageSet(SETTINGS_KEY, JSON.stringify(settings));
}
