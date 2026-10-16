/**
 * /yt-yap <youtube-url>
 *
 * Downloads a YouTube video's audio, transcribes it with the locally installed
 * `yap` CLI, and copies the transcript to the clipboard (macOS pbcopy).
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function run(cmd: string, args: string[], input?: string): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		if (input !== undefined) child.stdin.write(input);
		child.stdin.end();
	});
}

function lastLine(text: string): string {
	const line = text.trim().split("\n").filter(Boolean).pop();
	return line ?? text.trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("yt-yap", {
		description: "Download a YouTube video, transcribe it with yap, and copy the transcript to the clipboard",
		handler: async (args, ctx) => {
			const url = args.trim().split(/\s+/)[0];
			if (!url || !/^https?:\/\//i.test(url)) {
				ctx.ui.notify("Usage: /yt-yap <youtube-url>", "error");
				return;
			}

			const workDir = await mkdtemp(join(tmpdir(), "yt-yap-"));

			try {
				ctx.ui.notify("Downloading audio…", "info");
				const dl = await run("yt-dlp", [
					"-f",
					"bestaudio/best",
					"-x",
					"--audio-format",
					"mp3",
					"--audio-quality",
					"0",
					"-o",
					join(workDir, "audio.%(ext)s"),
					"--no-playlist",
					url,
				]);
				if (dl.code !== 0) {
					ctx.ui.notify(`Download failed: ${lastLine(dl.stderr)}`, "error");
					return;
				}

				const files = await readdir(workDir);
				const audioFile = files.find((f) => /^audio\.(mp3|m4a|webm|opus|ogg|aac|wav)$/i.test(f));
				if (!audioFile) {
					ctx.ui.notify("Downloaded audio file not found", "error");
					return;
				}
				const audioPath = join(workDir, audioFile);

				ctx.ui.notify("Transcribing with yap…", "info");
				const tr = await run("yap", ["transcribe", audioPath, "--txt"]);
				if (tr.code !== 0) {
					ctx.ui.notify(`Transcription failed: ${lastLine(tr.stderr)}`, "error");
					return;
				}
				const transcript = tr.stdout.trim();
				if (!transcript) {
					ctx.ui.notify("Transcription produced no text", "warning");
					return;
				}

				const clip = await run("pbcopy", [], transcript);
				if (clip.code !== 0) {
					ctx.ui.notify("Copy to clipboard failed", "error");
					return;
				}

				ctx.ui.notify(`Transcript (${transcript.length.toLocaleString()} chars) copied to clipboard`, "info");
			} finally {
				await rm(workDir, { recursive: true, force: true }).catch(() => {});
			}
		},
	});
}
