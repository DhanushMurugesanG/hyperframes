import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { findFFmpeg, findFFprobe } from "../browser/ffmpeg.js";

export const ffmpeg = findFFmpeg();
export const noTools = !ffmpeg || !findFFprobe();

/** testsrc2, 3 s at 30 fps: the original most of diff's tests compare against. */
export const REF_ARGS = ["-f", "lavfi", "-i", "testsrc2=d=3:r=30:s=320x180"];

/** A temp folder for one test file's clips, removed after its tests, and a maker of lossless synthetic clips in it,
 *  so SSIM differences come from the picture, not the encoder. */
export function clipFolder(prefix: string): {
  dir: string;
  clip: (name: string, args: string[]) => string;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const clip = (name: string, args: string[]): string => {
    const out = join(dir, name);
    execFileSync(ffmpeg!, [
      ...["-hide_banner", "-loglevel", "error", "-y", ...args],
      ...["-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "0", out],
    ]);
    return out;
  };
  return { dir, clip };
}
