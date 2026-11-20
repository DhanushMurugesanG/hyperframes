import { lintProject } from "@hyperframes/lint";
import type { NarrationManifest } from "@hyperframes/parsers/narration";
import { readManifest } from "./project.js";

export interface NarrationFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  fixHint?: string;
  line?: string;
}

export interface NarrationLineStatus {
  id: string;
  text: string;
  audio: string;
  durationSeconds: number;
  /** The narration finding codes on this line; empty when it is in sync. */
  problems: string[];
}

/** The project's narration findings, from the same lint pass `hyperframes lint` runs. */
async function narrationFindings(projectDir: string): Promise<NarrationFinding[]> {
  const { results } = await lintProject(projectDir);
  return results
    .flatMap((entry) => entry.result.findings)
    .filter((finding) => finding.code.startsWith("narration_"))
    .map((finding) => {
      const line = /Narration line (\S+?)[:\s]/.exec(finding.message)?.[1];
      return {
        code: finding.code,
        severity: finding.severity,
        message: finding.message,
        ...(finding.fixHint && { fixHint: finding.fixHint }),
        ...(line && { line }),
      };
    });
}

export async function narrationStatus(projectDir: string): Promise<{
  manifest: NarrationManifest;
  lines: NarrationLineStatus[];
  findings: NarrationFinding[];
}> {
  const manifest = readManifest(projectDir);
  const findings = await narrationFindings(projectDir);
  const lines = manifest.lines.map((line) => ({
    id: line.id,
    text: line.text,
    audio: line.audio,
    durationSeconds: line.durationSeconds,
    problems: findings.filter((finding) => finding.line === line.id).map((finding) => finding.code),
  }));
  return { manifest, lines, findings };
}
