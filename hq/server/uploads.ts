// Images in messages: ones you paste (to an agent, or into New work) and ones an agent sends you.
// Each project has its own folder, ~/.fleet/projects/<project>/uploads (owner-only), shared by its teams
// and readable by their agents only. A message carries an image as "[image: <path>]": the agent opens
// that path, the page shows the picture.

import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, writeFileSync, mkdirSync, chmodSync, constants } from "node:fs";
import { extname, join } from "node:path";
import { projectHome } from "./paths";
import { rootSlug } from "./teams";

export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
export const IMAGE_MAX = 10 * 1024 * 1024;
/** A saved image's file name: what GET /api/hq/uploads/<name> serves, and nothing else. */
export const UPLOAD_NAME = /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/;

/** The project's uploads folder (a team uses its project's, so New work's images reach the new team). */
export const uploadsDir = (slug: string) => join(projectHome(rootSlug(slug)), "uploads");

/** The file type its first bytes say, so only real images are ever saved (never a key renamed .png). */
function sniff(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a") return "gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** Saves an image's bytes in the project's uploads; returns its path. */
export function saveImage(slug: string, bytes: Buffer): string {
  if (!bytes.length || bytes.length > IMAGE_MAX) throw new Error("An image is at most 10 MB.");
  const ext = sniff(bytes);
  if (!ext) throw new Error("Only PNG, JPEG, WebP and GIF images.");
  const dir = uploadsDir(slug);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `${randomBytes(8).toString("hex")}.${ext}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

/** An image file an agent sends you, copied into its project's uploads (the page only ever serves that folder). */
export function copyImage(slug: string, file: string): string {
  if (!file.startsWith("/")) throw new Error(`Give the image's absolute path: ${file}`);
  if (!IMAGE_TYPES[extname(file).slice(1).toLowerCase().replace(/^jpeg$/, "jpg")]) throw new Error(`Not a PNG, JPEG, WebP or GIF image: ${file}`);
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`A link, not an image file: ${file}`);
  // O_NOFOLLOW: a link swapped in after the check above still isn't followed.
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`No such image file: ${file}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`No such image file: ${file}`);
    if (st.size > IMAGE_MAX) throw new Error(`Over 10 MB: ${file}`);
    const bytes = Buffer.alloc(st.size);
    readSync(fd, bytes, 0, st.size, 0);
    return saveImage(slug, bytes);
  } finally {
    closeSync(fd);
  }
}
