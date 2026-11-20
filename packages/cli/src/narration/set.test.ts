import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { lintProject, narrationTextHash } from "@hyperframes/lint";
import { locateCaptionArrays } from "@hyperframes/parsers/caption-array";
import { runCommand } from "citty";
import { consumeCommandResult } from "../utils/commandResult.js";
import { historyDeps, withOwner, withReader } from "../utils/historyOwner.js";

/** Fake Kokoro: the WAV holds the text, and lasts 0.4 s a word plus 0.2 s. */
const synthesizeMock = vi.fn(async (text: string, outputPath: string) => {
  writeFileSync(outputPath, `WAV:${text}`);
  return {
    outputPath,
    sampleRate: 24000,
    durationSeconds: text.split(/\s+/).length * 0.4 + 0.2,
    langApplied: true,
  };
});
vi.mock("../tts/synthesize.js", () => ({ synthesize: synthesizeMock }));

/** Fake transcription: reads the text back out of the WAV, one word every 0.4 s from 0.1 s. */
const transcribeMock = vi.fn(async ({ input, dir }: { input: string; dir: string }) => {
  const words = readFileSync(input, "utf8")
    .slice(4)
    .split(/\s+/)
    .map((text, index) => ({ text, start: 0.1 + index * 0.4, end: 0.4 + index * 0.4 }));
  const transcriptPath = join(dir, "transcript.json");
  writeFileSync(transcriptPath, JSON.stringify(words));
  return { kind: "transcribed", transcriptPath, wordCount: words.length };
});
vi.mock("../api/transcribe.js", () => ({ runTranscribe: transcribeMock }));

const { runNarrationSet } = await import("./set.js");
const { runNarrationInit } = await import("./init.js");
const { default: narrationCommand } = await import("../commands/narration.js");

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

interface Line {
  id: string;
  text: string;
  start: number;
}

const LINES: Line[] = [
  { id: "l1", text: "Hello there", start: 0 },
  { id: "l2", text: "Fourteen renewals", start: 2 },
  { id: "l3", text: "Start here", start: 4 },
];

const durationOf = (text: string) => text.split(/\s+/).length * 0.4 + 0.2;
const wordsOf = (text: string) =>
  text.split(/\s+/).map((word, index) => ({
    text: word,
    start: 0.1 + index * 0.4,
    end: 0.4 + index * 0.4,
  }));

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A project voiced by the fakes above: three clips, tagged captions, and an override on each line. */
function project() {
  const dir = tempDir("hf-narration-set-");
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const clips = LINES.map(
    (line) =>
      `<audio id="vo-${line.id}" src="assets/voice/${line.id}.wav" data-start="${line.start}" data-duration="${durationOf(line.text)}" data-track-index="1" data-narration-line="${line.id}"></audio>`,
  ).join("\n    ");
  const captions = LINES.flatMap((line) =>
    wordsOf(line.text).map((word, index) => ({
      id: `${line.id}w${index}`,
      text: word.text,
      start: Number((line.start + word.start).toFixed(3)),
      end: Number((line.start + word.end).toFixed(3)),
      line: line.id,
    })),
  );
  write(
    "index.html",
    `<!doctype html><html><body>
  <div data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="10">
    ${clips}
  </div>
  <script>
    const TRANSCRIPT = ${JSON.stringify(captions, null, 2)};
    window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({ paused: true });
  </script>
</body></html>`,
  );
  write(
    "caption-overrides.json",
    JSON.stringify([
      { wordIndex: 0, scale: 1.2 },
      { wordIndex: 2, activeColor: "#f00" },
      { wordIndex: 4, scale: 0.9 },
    ]),
  );
  const lines = LINES.map((line) => {
    write(`assets/voice/${line.id}.wav`, `WAV:${line.text}`);
    return {
      id: line.id,
      text: line.text,
      audio: `assets/voice/${line.id}.wav`,
      durationSeconds: durationOf(line.text),
      words: wordsOf(line.text),
      voiced: {
        textHash: narrationTextHash(line.text),
        voiceKey: "kokoro:af_heart:1:en-us",
        audioHash: sha256(`WAV:${line.text}`),
      },
    };
  });
  write(
    "narration.json",
    `${JSON.stringify(
      {
        version: 1,
        defaults: { provider: "kokoro", voice: "af_heart", speed: 1, lang: "en-us" },
        captions: { file: "index.html", array: "TRANSCRIPT" },
        lines,
      },
      null,
      2,
    )}\n`,
  );
  const read = (path: string) => readFileSync(join(dir, path), "utf8");
  return { dir, read, write };
}

async function narrationFindings(dir: string) {
  const { results } = await lintProject(dir);
  return results
    .flatMap((entry) => entry.result.findings)
    .filter((finding) => finding.code.startsWith("narration_"))
    .map((finding) => finding.code);
}

beforeEach(() => {
  historyDeps.historyRoot = tempDir("hf-narration-history-");
  historyDeps.findServer = async () => null;
  synthesizeMock.mockClear();
  transcribeMock.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe("narration set", () => {
  it("changes only line l2: its clip, its caption words, the overrides after it and its manifest entry", async () => {
    const { dir, read } = project();
    const before = read("index.html");
    const [array] = locateCaptionArrays(before);
    const result = await runNarrationSet({ dir, line: "l2", text: "Twenty renewals today" });

    expect(result.kind).toBe("written");
    const after = read("index.html");
    // The other clips and the other lines' caption words are byte-identical.
    for (const word of array!.words.filter((w) => w.line !== "l2")) {
      expect(after).toContain(before.slice(word.start, word.end));
    }
    expect(after).toContain(`<audio id="vo-l1" src="assets/voice/l1.wav"`);
    const audio = `assets/voice/l2-${sha256("WAV:Twenty renewals today").slice(0, 8)}.wav`;
    expect(after).toContain(`src="${audio}" data-start="2" data-duration="1.4"`);
    const [edited] = locateCaptionArrays(after);
    expect(edited!.words.filter((w) => w.line === "l2").map((w) => [w.text, w.startTime])).toEqual([
      ["Twenty", 2.1],
      ["renewals", 2.5],
      ["today", 2.9],
    ]);
    // One more word on l2: l3's override index moves by one; l2's own overrides go (its word count changed).
    expect(JSON.parse(read("caption-overrides.json"))).toEqual([
      { wordIndex: 0, scale: 1.2 },
      { wordIndex: 5, scale: 0.9 },
    ]);
    expect(result).toMatchObject({ overridesDropped: 1, captions: { removed: 2, added: 3 } });
    const line = JSON.parse(read("narration.json")).lines[1];
    expect(line).toMatchObject({ text: "Twenty renewals today", audio, durationSeconds: 1.4 });
    expect(line.voiced.textHash).toBe(narrationTextHash("Twenty renewals today"));
    // The old take is kept, the new one is in the project, and lint finds nothing left to fix.
    expect(existsSync(join(dir, "assets/voice/l2.wav"))).toBe(true);
    expect(read(audio)).toBe("WAV:Twenty renewals today");
    expect(await narrationFindings(dir)).toEqual([]);
  });

  it("voices and transcribes outside the project", async () => {
    const { dir } = project();
    await runNarrationSet({ dir, line: "l1", text: "Hi" });
    const [, out] = synthesizeMock.mock.calls[0]!;
    expect(out.startsWith(dir)).toBe(false);
    expect(transcribeMock.mock.calls[0]![0].dir.startsWith(dir)).toBe(false);
  });

  it("does nothing when the line is already voiced from its text", async () => {
    const { dir, read } = project();
    const before = read("index.html");
    expect(await runNarrationSet({ dir, line: "l1" })).toEqual({ kind: "unchanged", line: "l1" });
    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(read("index.html")).toBe(before);
  });

  it("writes nothing on a dry run", async () => {
    const { dir, read } = project();
    const files = ["index.html", "narration.json", "caption-overrides.json"].map(read);
    const result = await runNarrationSet({
      dir,
      line: "l2",
      text: "Twenty renewals",
      dryRun: true,
    });
    expect(result).toMatchObject({ kind: "planned", files: ["index.html", "narration.json"] });
    expect(["index.html", "narration.json", "caption-overrides.json"].map(read)).toEqual(files);
  });

  it("refuses a longer take that runs into the next clip, and keeps it with allowOverlap", async () => {
    const { dir, read } = project();
    const long = "Fourteen renewals are due today so start now";
    await expect(runNarrationSet({ dir, line: "l2", text: long })).rejects.toThrow(
      "runs into line l3, which starts at 4s on the same track",
    );
    expect(JSON.parse(read("narration.json")).lines[1].text).toBe("Fourteen renewals");
    const kept = await runNarrationSet({ dir, line: "l2", text: long, allowOverlap: true });
    expect(kept.kind === "written" && kept.warnings[0]).toContain("kept because of --no-retime");
  });

  it("refuses, and writes nothing, when a file changes while the line is voiced", async () => {
    const { dir, read, write } = project();
    synthesizeMock.mockImplementationOnce(async (text: string, outputPath: string) => {
      write("index.html", read("index.html").replace("Hello", "Howdy"));
      writeFileSync(outputPath, `WAV:${text}`);
      return { outputPath, sampleRate: 24000, durationSeconds: 0.6, langApplied: true };
    });
    const manifest = read("narration.json");
    await expect(runNarrationSet({ dir, line: "l2", text: "Hi" })).rejects.toThrow(
      /changed while the line was re-voiced|line l2/,
    );
    expect(read("narration.json")).toBe(manifest);
    expect(existsSync(join(dir, `assets/voice/l2-${sha256("WAV:Hi").slice(0, 8)}.wav`))).toBe(
      false,
    );
  });

  it("keeps a re-voiced line's overrides when its word count is unchanged, and files one history entry", async () => {
    const { dir, read } = project();
    await runNarrationSet({ dir, line: "l2", text: "Twenty renewals", who: "claude" });
    expect(JSON.parse(read("caption-overrides.json"))).toEqual([
      { wordIndex: 0, scale: 1.2 },
      { wordIndex: 2, activeColor: "#f00" },
      { wordIndex: 4, scale: 0.9 },
    ]);
    const entries = await withReader(dir, (reader) => reader.list());
    expect(entries.map((entry) => [entry.label, entry.who.name])).toContainEqual([
      "narration: re-voice l2",
      "claude",
    ]);
  });

  it("is undone in one step by history undo", async () => {
    const { dir, read } = project();
    const files = ["index.html", "narration.json", "caption-overrides.json"];
    const before = files.map(read);
    await runNarrationSet({ dir, line: "l2", text: "Twenty renewals today", who: "claude" });
    expect(files.map(read)).not.toEqual(before);
    await withOwner(dir, async (owner) => {
      const entry = (await owner.list()).find((e) => e.label === "narration: re-voice l2")!;
      const undone = await owner.undo(entry.id, { kind: "agent", name: "claude" });
      expect(undone.ok).toBe(true);
    });
    expect(files.map(read)).toEqual(before);
  });

  it("refuses a provider other than Kokoro", async () => {
    const { dir, read, write } = project();
    write(
      "narration.json",
      read("narration.json").replace('"provider": "kokoro"', '"provider": "heygen"'),
    );
    await expect(runNarrationSet({ dir, line: "l1", text: "Hi" })).rejects.toThrow(
      "re-voice with media-use --only tts",
    );
  });
});

describe("narration check", () => {
  it("exits 1 with the drift as JSON, and 0 once the line is re-voiced", async () => {
    const { dir, read, write } = project();
    write(
      "narration.json",
      read("narration.json").replace('"Fourteen renewals"', '"Twenty renewals"'),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    consumeCommandResult();
    await runCommand(narrationCommand, { rawArgs: ["check", "--dir", dir, "--json"] });
    const report = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(report.ok).toBe(false);
    expect(report.findings.map((f: { code: string; line: string }) => [f.code, f.line])).toEqual([
      ["narration_audio_stale", "l2"],
      ["narration_transcript_mismatch", "l2"],
    ]);
    expect(consumeCommandResult().exitCode).toBe(1);
    await runCommand(narrationCommand, { rawArgs: ["set", "l2", "--dir", dir, "--json"] });
    consumeCommandResult();
    await runCommand(narrationCommand, { rawArgs: ["check", "--dir", dir, "--json"] });
    expect(JSON.parse(String(log.mock.calls.at(-1)![0])).ok).toBe(true);
    expect(consumeCommandResult().exitCode).toBe(0);
  });
});

describe("narration init", () => {
  it("adopts a media-use project: lines from audio_meta.json, text from the request, clips tagged", async () => {
    const { dir, read, write } = project();
    rmSync(join(dir, "narration.json"));
    write("index.html", read("index.html").replace(/ data-narration-line="l\d"/g, ""));
    write(
      "audio_request.json",
      JSON.stringify({
        voice: "af_heart",
        lang: "en-us",
        lines: LINES.map(({ id, text }) => ({ id, text })),
      }),
    );
    write(
      "audio_meta.json",
      JSON.stringify({
        tts_provider: "kokoro",
        voice_id: "af_heart",
        voices: LINES.map((line) => ({
          id: line.id,
          path: `assets/voice/${line.id}.wav`,
          duration_s: durationOf(line.text),
          words: wordsOf(line.text),
        })),
      }),
    );
    const result = await runNarrationInit({ dir });
    expect(result).toMatchObject({
      source: "media-use",
      lines: ["l1", "l2", "l3"],
      linked: ["l1", "l2", "l3"],
      captions: "index.html",
    });
    expect(read("index.html")).toContain('data-narration-line="l2"');
    expect(await narrationFindings(dir)).toEqual([]);
    await expect(runNarrationInit({ dir })).rejects.toThrow("already exists");
  });
});
