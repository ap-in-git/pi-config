/**
 * /summarize — summarize and compact the current context.
 *
 * Runs pi's compaction, which replaces the summarized part of the conversation
 * with a summary and therefore *reduces* the context window usage. The resulting
 * summary is also appended to the transcript as a display-only custom entry so
 * you can read/copy it (it is not sent back to the model).
 *
 * Usage: /summarize [extra focus, e.g. "only decisions and open TODOs"]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

interface SummaryData {
	text: string;
	model: string;
	tokensBefore: number;
	tokensAfter?: number;
	timestamp: number;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<SummaryData>("context-summary", (entry, _options, theme) => {
		const data = entry.data;
		if (!data?.text) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", "Context summary"), 0, 0));
		box.addChild(new Text(data.text, 0, 0));
		const saving =
			data.tokensAfter !== undefined
				? ` · ${formatTokens(data.tokensBefore)} → ${formatTokens(data.tokensAfter)} tokens`
				: ` · ${formatTokens(data.tokensBefore)} tokens`;
		box.addChild(new Text(theme.fg("dim", `${data.model} · ${new Date(data.timestamp).toLocaleTimeString()}${saving}`), 0, 0));
		return box;
	});

	pi.registerCommand("summarize", {
		description: "Summarize and compact the current context (reduces the context window)",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish before summarizing", "warning");
				return;
			}
			ctx.ui.notify("Summarizing and compacting…", "info");
			ctx.compact({
				customInstructions: args.trim() || undefined,
				onComplete: (result) => {
					pi.appendEntry<SummaryData>("context-summary", {
						text: result.summary,
						model: ctx.model?.id ?? "model",
						tokensBefore: result.tokensBefore,
						tokensAfter: result.estimatedTokensAfter,
						timestamp: Date.now(),
					});
					ctx.ui.notify("Context summarized and compacted", "info");
				},
				onError: (error) => ctx.ui.notify(`Summarize failed: ${error.message}`, "error"),
			});
		},
	});
}
