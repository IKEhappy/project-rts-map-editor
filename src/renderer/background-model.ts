import type { BackgroundInfo, BackgroundImageInfo, ConfigFile } from "./types";

export type BackgroundView = "topdown" | "tilt";
export type BackgroundSlot = BackgroundView | "image";

export function backgroundForView(info: BackgroundInfo | null, view: BackgroundView): BackgroundImageInfo | null {
  const order: BackgroundSlot[] = view === "topdown" ? ["topdown", "image", "tilt"] : ["tilt", "image", "topdown"];
  for (const key of order) {
    const image = info?.images[key];
    if (image && !image.error && image.dataUrl) return image;
  }
  return null;
}

export function withBackgroundSlot(doc: ConfigFile, slot: BackgroundSlot, path: string): ConfigFile {
  const current = doc.background;
  const background = current !== null && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...doc, background: { ...background, [slot]: path } };
}

export function withoutBackground(doc: ConfigFile): ConfigFile {
  const next = { ...doc };
  delete next.background;
  return next;
}
