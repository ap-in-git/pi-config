/**
 * /summarize — summarize the current conversation context.
 *
 * Calls the active model with pi's own summarization prompt (the same one used
 * for compaction) and appends the result to the transcript as a custom entry.
 * The entry is display-only and is never sent back to the model, so it does not
 * change the conversation context.
 *
 * Usage: /summarize [extra focus, e.g. "only decisions and TODOs"]
 *
 * (Unlike /compact, this does not remove or replace any messages.)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

interface SummaryData {
	text: string;
	model: string;
	timestamp: number;
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<SummaryData>("context-summary", (entry, _options, theme) => {
		const data = entry.data;
		if (!data?.text) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", "Context summary"), 0, 0));
		box.addChild(new Text(data.text, 0, 0));
		box.addChild(new Text(theme.fg("dim", `${data.model} · ${new Date(data.timestamp).toLocaleTimeString()}`), 0, 0));
		return box;
	});

	pi.registerCommand("summarize", {
		description: "Summarize the current context and add it to the transcript",
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			const messages = ctx.sessionManager.buildSessionContext().messages;
			if (messages.length === 0) {
				ctx.ui.notify("Nothing to summarize yet", "warning");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				ctx.ui.notify(`Cannot summarize: ${auth.error}`, "error");
				return;
			}

			ctx.ui.notify("Summarizing context…", "info");
			try {
				const headers = auth.headers
					? Object.fromEntries(Object.entries(auth.headers).filter(([, value]) => value != null))
					: undefined;
				const { text } = await generateSummaryWithUsage(
					messages,
					model,
					DEFAULT_COMPACTION_SETTINGS.reserveTokens,
					auth.apiKey,
					headers,
					ctx.signal,
					args.trim() || undefined,
					undefined,
					ctx.thinkingLevel,
				);
				pi.appendEntry<SummaryData>("context-summary", { text, model: model.id, timestamp: Date.now() });
				ctx.ui.notify("Summary added to the transcript", "info");
			} catch (error) {
				ctx.ui.notify(`Summarize failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
