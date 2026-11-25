// Images in messages: ones you paste (to an agent, or into New work) and ones an agent sends you.
// All live in ~/.fleet/uploads (owner-only), which every agent may read. A message carries an image
// as "[image: <path>]": the agent opens that path, the page shows the picture.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
export const IMAGE_MAX = 10 * 1024 * 1024;
/** A saved image's file name: what GET /api/hq/uploads/<name> serves, and nothing else. */
export const UPLOAD_NAME = /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/;

export const uploadsDir = () => join(homedir(), ".fleet", "uploads");

/** Saves an image's bytes; returns its path. */
export function saveImage(bytes: Buffer, ext: string): string {
  if (!IMAGE_TYPES[ext]) throw new Error("Only PNG, JPEG, WebP and GIF images.");
  if (!bytes.length || bytes.length > IMAGE_MAX) throw new Error("An image is at most 10 MB.");
  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `${randomBytes(8).toString("hex")}.${ext}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

/** An image file an agent sends you, copied into uploads (so the page only ever serves that folder). */
export function copyImage(file: string): string {
  if (!file.startsWith("/")) throw new Error(`Give the image's absolute path: ${file}`);
  const ext = extname(file).slice(1).toLowerCase().replace(/^jpeg$/, "jpg");
  if (!IMAGE_TYPES[ext]) throw new Error(`Not a PNG, JPEG, WebP or GIF image: ${file}`);
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error(`No such file: ${file}`);
  if (st.size > IMAGE_MAX) throw new Error(`Over 10 MB: ${file}`);
  return saveImage(readFileSync(file), ext);
}
