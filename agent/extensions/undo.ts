/**
 * /undo — revert the last turn.
 *
 * Removes the most recent user turn from the transcript and restores the files
 * the agent changed in it.
 *
 * - Transcript: uses pi's tree navigation on the last user message. pi moves the
 *   leaf to that message's parent and puts the user's text back in the editor,
 *   so the turn disappears and you can edit and resend.
 * - Files: every `edit`/`write` is snapshotted just before it runs, so undo can
 *   restore exact prior contents and delete files that were newly created.
 *   Edits made before this extension loaded fall back to reversing the recorded
 *   `oldText`/`newText` (and `write` overwrites made before then cannot be
 *   restored, since their prior contents were never recorded).
 *
 * Snapshots live in memory for the current process; they are not written to the
 * session file.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Snapshot {
	path: string;
	existed: boolean;
	content?: string;
}

interface FileOp {
	id: string;
	name: "edit" | "write";
	args: any;
}

export default function (pi: ExtensionAPI) {
	/** Pre-edit contents keyed by tool-call id. */
	const snapshots = new Map<string, Snapshot>();

	// Record the file's contents immediately before the agent edits or writes it.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (event.parentToolCallId) return; // nested calls are not in the transcript
		const path = (event.input as any)?.path;
		if (typeof path !== "string" || !path) return;
		const absolute = resolve(ctx.cwd, path);
		try {
			snapshots.set(event.toolCallId, { path: absolute, existed: true, content: readFileSync(absolute, "utf8") });
		} catch {
			snapshots.set(event.toolCallId, { path: absolute, existed: false });
		}
	});

	pi.registerCommand("undo", {
		description: "Undo the last turn: restore the files it changed and remove it from the transcript",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish before undoing", "warning");
				return;
			}

			const entries = ctx.sessionManager.getBranch();
			let lastUser = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry: any = entries[i];
				if (entry.type === "message" && entry.message?.role === "user") {
					lastUser = i;
					break;
				}
			}
			if (lastUser < 0) {
				ctx.ui.notify("Nothing to undo", "warning");
				return;
			}

			// File operations the agent performed after the last user message.
			const ops: FileOp[] = [];
			for (let i = lastUser; i < entries.length; i++) {
				const entry: any = entries[i];
				if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
				for (const block of entry.message.content ?? []) {
					if (block?.type === "toolCall" && (block.name === "edit" || block.name === "write")) {
						ops.push({ id: block.id, name: block.name, args: block.arguments ?? {} });
					}
				}
			}

			const restored = new Set<string>();
			const failed = new Set<string>();

			// Restore in reverse so a file edited multiple times ends at its earliest snapshot.
			for (const op of [...ops].reverse()) {
				const snapshot = snapshots.get(op.id);
				try {
					if (snapshot) {
						if (snapshot.existed) {
							writeFileSync(snapshot.path, snapshot.content ?? "", "utf8");
						} else {
							rmSync(snapshot.path, { force: true });
						}
						restored.add(snapshot.path);
						continue;
					}

					// Fallback for edits made before this extension was loaded.
					if (op.name === "edit" && typeof op.args?.path === "string") {
						const absolute = resolve(ctx.cwd, op.args.path);
						let text = readFileSync(absolute, "utf8");
						for (const edit of op.args.edits ?? []) {
							if (typeof edit?.newText === "string" && edit.newText && text.includes(edit.newText)) {
								text = text.replace(edit.newText, edit.oldText ?? "");
							}
						}
						writeFileSync(absolute, text, "utf8");
						restored.add(absolute);
					} else {
						failed.add(String(op.args?.path ?? "unknown"));
					}
				} catch {
					failed.add(snapshot?.path ?? String(op.args?.path ?? "unknown"));
				}
			}

			// Remove the turn. pi restores the user's message text to the editor.
			const userEntry: any = entries[lastUser];
			try {
				await ctx.navigateTree(userEntry.id);
			} catch (error) {
				ctx.ui.notify(
					`Restored files but could not remove the turn: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			const summary: string[] = [];
			if (restored.size) summary.push(`restored ${restored.size} file${restored.size === 1 ? "" : "s"}`);
			if (failed.size) summary.push(`${failed.size} not restorable`);
			ctx.ui.notify(`Undone${summary.length ? ` — ${summary.join(", ")}` : ""}`, failed.size ? "warning" : "info");
		},
	});
}
