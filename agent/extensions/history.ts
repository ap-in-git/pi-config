/**
 * /history — a compact, scrollable history of the conversation.
 *
 * Unlike /tree, this does not show tool output. Each turn shows:
 *   - the user prompt (what was asked)
 *   - the timestamp
 *   - how long the turn took
 *   - how many tool calls and API requests it used
 *
 * Tool calls are summarized as counts (with a per-tool breakdown when a turn
 * is expanded), never as raw commands or output.
 *
 * Usage:
 *   /history            Show the active branch's conversation history
 *   /history <query>    Only show turns whose text matches <query>
 *
 * Keys inside the viewer:
 *   ↑/↓ or j/k   move between turns
 *   PgUp/PgDn    scroll a page
 *   Home/End     jump to first/last turn
 *   Enter        expand/collapse the selected turn
 *   c            copy the selected turn (ask + reply)
 *   p            copy the selected prompt (what you asked)
 *   r            copy the selected reply
 *   a            toggle the assistant reply preview
 *   q / Esc      close
 */

import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface ToolStat {
	name: string;
	count: number;
	errors: number;
}

interface Turn {
	/** Original 1-based position in the conversation (stable across filtering). */
	index: number;
	startMs: number;
	endMs: number;
	userText: string;
	imageCount: number;
	assistantText: string;
	toolCallCount: number;
	apiRequests: number;
	errorCount: number;
	tools: Map<string, ToolStat>;
	tokens: number;
	cost: number;
}

interface History {
	turns: Turn[];
	compactions: number;
}

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
}

interface MessageLike {
	role?: string;
	content?: unknown;
	isError?: boolean;
	toolName?: string;
	usage?: {
		totalTokens?: number;
		cost?: { total?: number };
	};
	timestamp?: number;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function imageCountFromContent(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let count = 0;
	for (const raw of content) {
		if (raw && typeof raw === "object" && (raw as ContentBlock).type === "image") count++;
	}
	return count;
}

function entryMs(entry: SessionEntry): number {
	if (entry.type === "message") {
		const stamp = (entry.message as MessageLike | undefined)?.timestamp;
		if (typeof stamp === "number") return stamp;
	}
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

function buildHistory(entries: SessionEntry[]): History {
	const turns: Turn[] = [];
	let current: Turn | undefined;
	let compactions = 0;

	for (const entry of entries) {
		if (entry.type === "compaction") {
			compactions++;
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message as MessageLike | undefined;
		if (!message) continue;
		const role = message.role;
		const ms = entryMs(entry);

		if (role === "user") {
			current = {
				index: turns.length + 1,
				startMs: ms,
				endMs: ms,
				userText: textFromContent(message.content).trim(),
				imageCount: imageCountFromContent(message.content),
				assistantText: "",
				toolCallCount: 0,
				apiRequests: 0,
				errorCount: 0,
				tools: new Map(),
				tokens: 0,
				cost: 0,
			};
			turns.push(current);
			continue;
		}

		if (!current) continue;
		if (ms > current.endMs) current.endMs = ms;

		if (role === "assistant") {
			current.apiRequests++;
			if (Array.isArray(message.content)) {
				for (const raw of message.content) {
					if (!raw || typeof raw !== "object") continue;
					const block = raw as ContentBlock;
					if (block.type === "toolCall") {
						current.toolCallCount++;
						const name = block.name || "tool";
						const stat = current.tools.get(name) ?? { name, count: 0, errors: 0 };
						stat.count++;
						current.tools.set(name, stat);
					} else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
						current.assistantText = block.text.trim();
					}
				}
			}
			const usage = message.usage;
			if (usage) {
				current.tokens += Number(usage.totalTokens ?? 0);
				current.cost += Number(usage.cost?.total ?? 0);
			}
		} else if (role === "toolResult" && message.isError) {
			current.errorCount++;
			const stat = current.tools.get(message.toolName || "tool");
			if (stat) stat.errors++;
		}
	}

	return { turns, compactions };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "-";
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${pad2(Math.round(s - m * 60))}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${pad2(m - h * 60)}m`;
}

function sanitize(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
}

function wrapPlain(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (const para of sanitize(text).split("\n")) {
		if (para.length === 0) {
			out.push("");
			continue;
		}
		out.push(...wrapTextWithAnsi(para, width));
	}
	return out;
}

function truncatePlain(text: string, width: number): string {
	const oneLine = sanitize(text).replace(/\s+/g, " ").trim();
	return oneLine.length <= width ? oneLine : `${oneLine.slice(0, Math.max(0, width - 1))}…`;
}

function formatTurnForClipboard(turn: Turn): string {
	const header = `#${turn.index} · ${formatTimestamp(turn.startMs)} · ${formatDuration(
		turn.endMs - turn.startMs,
	)} · ${turn.toolCallCount} tool${turn.toolCallCount === 1 ? "" : "s"} · ${turn.apiRequests} request${
		turn.apiRequests === 1 ? "" : "s"
	}`;
	const parts = [header, "", "Ask:", turn.userText || "(empty message)"];
	if (turn.assistantText) parts.push("", "Reply:", turn.assistantText);
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// TUI component
// ---------------------------------------------------------------------------

class HistoryComponent implements Component {
	private readonly allTurns: Turn[];
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly done: () => void;
	private readonly sessionLabel: string;
	private readonly compactions: number;
	private readonly turns: Turn[];

	private selected: number;
	private scrollTop = 0;
	private showAssistant = true;
	private pendingScrollToSelected = true;
	private readonly expanded = new Set<number>();
	private flash: { text: string; error: boolean } | undefined;
	private flashTimer: ReturnType<typeof setTimeout> | undefined;

	// Layout cache, rebuilt each render.
	private contentLines: string[] = [];
	private turnStart: number[] = [];
	private lineOwner: number[] = [];

	constructor(
		turns: Turn[],
		compactions: number,
		sessionLabel: string,
		theme: Theme,
		tui: TUI,
		done: () => void,
		filter: string,
	) {
		this.allTurns = turns;
		this.compactions = compactions;
		this.sessionLabel = sessionLabel;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
		this.turns = filter
			? turns.filter((turn) => `${turn.userText}\n${turn.assistantText}`.toLowerCase().includes(filter.toLowerCase()))
			: turns;
		this.selected = Math.max(0, this.turns.length - 1);
	}

	private viewportHeight(): number {
		const rows = this.tui.terminal?.rows ?? 24;
		// Leave room for the overlay border, title, stats and key hints.
		return Math.max(5, Math.floor(rows * 0.9) - 7);
	}

	private requestedRender(): void {
		this.tui.requestRender();
	}

	private flashMessage(text: string, error = false): void {
		if (this.flashTimer) clearTimeout(this.flashTimer);
		this.flash = { text, error };
		this.flashTimer = setTimeout(() => {
			this.flash = undefined;
			this.flashTimer = undefined;
			this.requestedRender();
		}, 2000);
		this.requestedRender();
	}

	private copySelected(kind: "turn" | "prompt" | "reply"): void {
		const turn = this.turns[this.selected];
		if (!turn) return;
		const text =
			kind === "turn" ? formatTurnForClipboard(turn) : kind === "prompt" ? turn.userText : turn.assistantText;
		if (!text || !text.trim()) {
			this.flashMessage(kind === "reply" ? "No reply to copy" : "Nothing to copy", true);
			return;
		}
		void copyToClipboard(text)
			.then(() => this.flashMessage("Copied ✓"))
			.catch(() => this.flashMessage("Copy failed", true));
	}

	private layout(width: number): void {
		const th = this.theme;
		const lines: string[] = [];
		const turnStart: number[] = [];
		const lineOwner: number[] = [];
		const push = (line: string, owner: number): void => {
			lines.push(truncateToWidth(line, width, ""));
			lineOwner.push(owner);
		};

		for (let i = 0; i < this.turns.length; i++) {
			const turn = this.turns[i]!;
			turnStart.push(lines.length);
			const isSelected = i === this.selected;
			const marker = isSelected
				? th.fg("accent", turn.toolCallCount > 0 ? "▸" : "•")
				: th.fg("borderMuted", "·");
			const idx = isSelected ? th.fg("accent", th.bold(`#${turn.index}`)) : th.fg("muted", `#${turn.index}`);
			const time = th.fg("dim", formatTimestamp(turn.startMs));
			const dur = th.fg(turn.endMs > turn.startMs ? "success" : "dim", formatDuration(turn.endMs - turn.startMs));
			const tools =
				turn.toolCallCount > 0
					? th.fg("warning", `${turn.toolCallCount} tool${turn.toolCallCount === 1 ? "" : "s"}`)
					: th.fg("dim", "0 tools");
			const reqs = th.fg("muted", `${turn.apiRequests} req${turn.apiRequests === 1 ? "" : "s"}`);
			const errs = turn.errorCount > 0 ? th.fg("dim", " · ") + th.fg("error", `${turn.errorCount} err`) : "";
			const dot = th.fg("borderMuted", "·");
			push(` ${marker} ${idx}  ${time}  ${dot}  ${dur}  ${dot}  ${tools}  ${dot}  ${reqs}${errs}`, i);

			const indent = "     ";
			const textWidth = Math.max(10, width - indent.length);

			const expanded = this.expanded.has(i);
			if (!expanded) {
				const askLines = wrapPlain(turn.userText || "(empty message)", textWidth);
				const shown = askLines.slice(0, 2);
				for (let j = 0; j < shown.length; j++) {
					const more = j === shown.length - 1 && askLines.length > shown.length;
					const suffix = more ? th.fg("dim", " …") : "";
					push(indent + th.fg(isSelected ? "text" : "muted", shown[j]!) + suffix, i);
				}
				if (turn.imageCount > 0) {
					push(indent + th.fg("dim", `[+${turn.imageCount} image${turn.imageCount === 1 ? "" : "s"}]`), i);
				}
				if (this.showAssistant && turn.assistantText) {
					push(indent + th.fg("dim", `↳ ${truncatePlain(turn.assistantText, textWidth - 2)}`), i);
				}
			} else {
				const askLines = wrapPlain(turn.userText || "(empty message)", textWidth);
				for (const line of askLines) push(indent + th.fg("text", line), i);
				if (turn.imageCount > 0) {
					push(indent + th.fg("dim", `[+${turn.imageCount} image${turn.imageCount === 1 ? "" : "s"}]`), i);
				}
				if (turn.assistantText) {
					push("", i);
					push(indent + th.fg("dim", "Reply:"), i);
					const replyLines = wrapPlain(turn.assistantText, textWidth);
					const shownReply = replyLines.slice(0, 20);
					for (const line of shownReply) push(indent + th.fg("muted", line), i);
					if (replyLines.length > shownReply.length) {
						push(indent + th.fg("dim", `… ${replyLines.length - shownReply.length} more lines`), i);
					}
				}
				if (turn.tools.size > 0) {
					push("", i);
					const stats = [...turn.tools.values()].sort((a, b) => b.count - a.count);
					const parts = stats.map((s) =>
						s.errors > 0 ? `${s.name} ×${s.count} (${s.errors} err)` : `${s.name} ×${s.count}`,
					);
					push(indent + th.fg("dim", "Tools: ") + th.fg("warning", parts.join(", ")), i);
				}
				push(
					indent +
						th.fg(
							"dim",
							`Tokens: ${turn.tokens.toLocaleString()} · Cost: $${turn.cost.toFixed(4)} · API requests: ${turn.apiRequests}`,
						),
					i,
				);
			}
			push("", i);
		}

		this.contentLines = lines;
		this.turnStart = turnStart;
		this.lineOwner = lineOwner;
	}

	private scrollToSelected(viewport: number): void {
		const start = this.turnStart[this.selected] ?? 0;
		const endExclusive =
			this.selected + 1 < this.turnStart.length ? this.turnStart[this.selected + 1]! : this.contentLines.length;
		const maxScroll = Math.max(0, this.contentLines.length - viewport);
		const fullyVisible = start >= this.scrollTop && endExclusive <= this.scrollTop + viewport;
		if (fullyVisible) return;
		if (endExclusive - start <= viewport) {
			this.scrollTop = Math.max(0, Math.min(endExclusive - viewport, maxScroll));
		} else {
			this.scrollTop = Math.max(0, Math.min(start, maxScroll));
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const totalWidth = Math.max(4, width);
		const innerWidth = Math.max(1, totalWidth - 2);
		const viewport = this.viewportHeight();

		this.layout(innerWidth);

		if (this.turns.length === 0) {
			this.contentLines = [th.fg("dim", " No matching turns.")];
			this.turnStart = [0];
			this.lineOwner = [0];
		} else if (this.pendingScrollToSelected) {
			this.scrollToSelected(viewport);
			this.pendingScrollToSelected = false;
		}

		const maxScroll = Math.max(0, this.contentLines.length - viewport);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
		const visible = this.contentLines.slice(this.scrollTop, this.scrollTop + viewport);

		const totalTools = this.allTurns.reduce((sum, t) => sum + t.toolCallCount, 0);
		const totalReqs = this.allTurns.reduce((sum, t) => sum + t.apiRequests, 0);
		const totalErrors = this.allTurns.reduce((sum, t) => sum + t.errorCount, 0);
		const totalDuration = this.allTurns.reduce((sum, t) => sum + Math.max(0, t.endMs - t.startMs), 0);

		const stats = [
			`${this.turns.length} turn${this.turns.length === 1 ? "" : "s"}`,
			formatDuration(totalDuration),
			`${totalTools} tool${totalTools === 1 ? "" : "s"}`,
			`${totalReqs} request${totalReqs === 1 ? "" : "s"}`,
			totalErrors > 0 ? `${totalErrors} error${totalErrors === 1 ? "" : "s"}` : undefined,
			this.compactions > 0 ? `${this.compactions} compaction${this.compactions === 1 ? "" : "s"}` : undefined,
		]
			.filter((part): part is string => Boolean(part))
			.join(" · ");

		const title = `${th.fg("accent", th.bold(" Conversation History"))}${th.fg("dim", ` · ${this.sessionLabel}`)}`;

		const lines: string[] = [];
		const pad = (text: string): string => truncateToWidth(text, innerWidth, "", true);
		const row = (text: string): string => `${th.fg("border", "│")}${pad(text)}${th.fg("border", "│")}`;

		lines.push(th.fg("border", `╭${"─".repeat(innerWidth)}╮`));
		lines.push(row(title));
		lines.push(row(th.fg("dim", ` ${stats}`)));
		lines.push(th.fg("border", `├${"─".repeat(innerWidth)}┤`));

		for (const line of visible) {
			lines.push(row(` ${line}`));
		}

		lines.push(th.fg("border", `├${"─".repeat(innerWidth)}┤`));
		const flash = this.flash;
		const rightPlain = flash
			? `${flash.text} `
			: this.turns.length > 0
				? `${this.selected + 1}/${this.turns.length} `
				: " ";
		const right = flash ? th.fg(flash.error ? "error" : "success", rightPlain) : th.fg("muted", rightPlain);
		const hint = ` ↑↓ move · enter expand · c copy · p prompt · r reply · a assistant · q close`;
		const hintRoom = Math.max(0, innerWidth - visibleWidth(rightPlain));
		lines.push(row(th.fg("dim", truncateToWidth(hint, hintRoom, "", true)) + right));
		lines.push(th.fg("border", `╰${"─".repeat(innerWidth)}╯`));

		return lines;
	}

	handleInput(data: string): void {
		const last = this.turns.length - 1;
		const viewport = this.viewportHeight();

		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}

		if (this.turns.length === 0) return;

		if (matchesKey(data, "up") || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.pendingScrollToSelected = true;
		} else if (matchesKey(data, "down") || data === "j") {
			this.selected = Math.min(last, this.selected + 1);
			this.pendingScrollToSelected = true;
		} else if (matchesKey(data, "home") || data === "g") {
			this.selected = 0;
			this.pendingScrollToSelected = true;
		} else if (matchesKey(data, "end") || data === "G") {
			this.selected = last;
			this.pendingScrollToSelected = true;
		} else if (matchesKey(data, "pageUp")) {
			this.scrollTop = Math.max(0, this.scrollTop - viewport);
			this.selected = this.lineOwner[this.scrollTop] ?? this.selected;
			this.pendingScrollToSelected = false;
		} else if (matchesKey(data, "pageDown")) {
			const maxScroll = Math.max(0, this.contentLines.length - viewport);
			this.scrollTop = Math.min(maxScroll, this.scrollTop + viewport);
			this.selected = this.lineOwner[this.scrollTop] ?? this.selected;
			this.pendingScrollToSelected = false;
		} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (this.expanded.has(this.selected)) this.expanded.delete(this.selected);
			else this.expanded.add(this.selected);
			this.pendingScrollToSelected = true;
		} else if (data === "c") {
			this.copySelected("turn");
		} else if (data === "p") {
			this.copySelected("prompt");
		} else if (data === "r") {
			this.copySelected("reply");
		} else if (data === "a") {
			this.showAssistant = !this.showAssistant;
		} else {
			return;
		}

		this.requestedRender();
	}

	invalidate(): void {
		this.contentLines = [];
		this.turnStart = [];
		this.lineOwner = [];
	}

	dispose(): void {
		if (this.flashTimer) clearTimeout(this.flashTimer);
		this.flashTimer = undefined;
	}
}

// ---------------------------------------------------------------------------
// Non-interactive fallback
// ---------------------------------------------------------------------------

function plainReport(turns: Turn[], sessionLabel: string): string {
	const lines = [`Conversation History · ${sessionLabel}`, ""];
	for (const turn of turns) {
		const duration = formatDuration(turn.endMs - turn.startMs);
		lines.push(`#${turn.index}  ${formatTimestamp(turn.startMs)}  ${duration}  ${turn.toolCallCount} tools  ${turn.apiRequests} reqs`);
		lines.push(`     ${truncatePlain(turn.userText || "(empty message)", 120)}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

async function showHistory(ctx: ExtensionCommandContext, filter: string): Promise<void> {
	const entries = ctx.sessionManager.getBranch();
	const { turns, compactions } = buildHistory(entries);
	const sessionLabel =
		ctx.sessionManager.getSessionName()?.trim() ||
		ctx.sessionManager.getSessionId()?.slice(0, 8) ||
		"session";

	if (turns.length === 0) {
		if (ctx.hasUI) ctx.ui.notify("No conversation history yet", "info");
		return;
	}

	if (ctx.mode !== "tui") {
		const report = plainReport(turns, sessionLabel);
		if (ctx.hasUI) ctx.ui.notify(report, "info");
		else console.log(report);
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new HistoryComponent(turns, compactions, sessionLabel, theme, tui, () => done(), filter),
		{
			overlay: true,
			overlayOptions: { width: "92%", maxHeight: "92%", anchor: "center", margin: 1 },
		},
	);
}

export default function historyExtension(pi: ExtensionAPI): void {
	pi.registerCommand("history", {
		description: "Show the conversation history as a compact list of turns (usage: /history [query])",
		handler: async (args, ctx) => {
			await showHistory(ctx, args.trim());
		},
	});
}
