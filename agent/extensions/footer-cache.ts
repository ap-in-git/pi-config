/**
 * Custom footer: session cost (session | today | last-30-days), current
 * session tokens, context usage, prompt-cache hit rate, DeepSeek peak/off-peak,
 * and the active model + thinking/effort level.
 *
 * Replaces pi's built-in footer with a single line:
 *
 *   Σ 45.2k · [clock] 1h 23m · ◧ 6.2% · ↺ 87.3%     $0.123 · $0.456 · $1.234 · [chart] peak
 *   [branch] main · [folder] ~/.pi                    model · [brain] effort · [speed] 54/s
 *
 * Cost values:
 * - first value: cost recorded in the current session file (all entries).
 * - second value: cost across all saved sessions with a timestamp since
 *   midnight local time.
 * - third value: cost across all saved sessions within the last 30 days.
 *
 * The lifetime scan happens once per session start, in the background, and
 * only covers sessions under <agent-dir>/sessions (the same location pi's
 * `/resume` picker lists). The current session's windows are computed live so
 * the numbers update as the session grows.
 *
 * Σ = total tokens used across the whole session (left side, before cost).
 * [clock] = elapsed time since the session started (refreshes every 15s).
 * [branch] = current git branch (omitted outside a repository).
 * [folder] = working directory, with the home directory shown as "~".
 * [speed]  = generated (output) tokens per second of active time.
 *
 * While a turn is running, the working indicator shows a live task timer
 * ("Working · 12s"), updated once a second and reset when the turn ends.
 * ◧ = context usage (percent of the model's context window; "?" until pi
 *     estimates it). Turns warning/error-colored as it fills up.
 * ↺ = prompt-cache hit percentage: cache reads as a share of all prompt
 *     tokens in the current session (`input` already excludes cache
 *     reads/writes, so total prompt tokens = input + cacheRead + cacheWrite).
 * [chart] peak / [chart] off-peak = DeepSeek's current pricing window,
 *     chart-multiple for peak and trending-down for off-peak (Nerd Font MDI
 *     glyphs, the closest terminal stand-ins for Lucide's
 *     chart-no-axes-combined and chart-no-axes-column-decreasing).
 * The trailing values are the active model id and, for reasoning models, the
 * current thinking/effort level. Both update live when the model or thinking
 * level changes (via /model, model cycling, or thinking-level shortcuts).
 *
 * In fullscreen mode (pi's default), clicking any footer segment opens a small
 * overlay with details for that value.
 *
 * After each turn ends, a "token-usage" custom entry is appended to the
 * transcript showing the tokens, cost, API-call count and wall-clock duration
 * of that last user message, plus the files it changed and their +/- line
 * counts (rendered via pi.registerEntryRenderer(); not sent to the LLM).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Box, MouseRegion, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Visible width of the " · " separator between footer segments. */
const SEP_WIDTH = 3;

interface HitSegment {
	id: string;
	line: number;
	start: number;
	end: number;
}

function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

/** Root sessions directory, mirroring pi's own `getSessionsDir()` resolution. */
function sessionsRoot(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR
		? expandTilde(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
	return join(agentDir, "sessions");
}

async function listSessionFiles(): Promise<string[]> {
	const files: string[] = [];
	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > 8) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				await walk(full, depth + 1);
			} else if (entry.name.endsWith(".jsonl")) {
				files.push(full);
			}
		}
	}
	await walk(sessionsRoot(), 0);
	return files;
}

// DeepSeek prices are time-of-day sensitive (api-docs.deepseek.com): the peak
// rates below apply 01:00-04:00 and 06:00-10:00 UTC on weekdays (excluding
// Chinese public holidays). Every other hour is off-peak at exactly half the
// peak rate. The bundled catalog only stores peak rates, so DeepSeek cost is
// recomputed here from token counts to match DeepSeek's actual billing.
const DEEPSEEK_PEAK_RATES: Record<string, { input: number; output: number; cacheRead: number }> = {
	"deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044 },
	"deepseek-flash": { input: 0.3, output: 1.2, cacheRead: 0.006 },
};

function isDeepseekPeak(ms: number): boolean {
	const d = new Date(ms);
	const dow = d.getUTCDay(); // 0 = Sunday … 6 = Saturday
	if (dow === 0 || dow === 6) return false; // weekends are off-peak in full
	const h = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
	return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** Time-aware DeepSeek cost from token counts, or undefined for other providers. */
function deepseekCost(provider: string | undefined, model: string | undefined, usage: any, ms: number): number | undefined {
	if (provider !== "deepseek") return undefined;
	const rates = DEEPSEEK_PEAK_RATES[model ?? ""];
	if (!rates || !usage) return undefined;
	const factor = isDeepseekPeak(ms) ? 1 : 0.5;
	const input = (usage.input ?? 0) * rates.input * factor;
	const output = (usage.output ?? 0) * rates.output * factor;
	const cacheRead = (usage.cacheRead ?? 0) * rates.cacheRead * factor;
	return (input + output + cacheRead) / 1_000_000;
}

/** Cost of a usage payload, preferring time-aware DeepSeek pricing when known. */
function usageCost(provider: string | undefined, model: string | undefined, usage: any, ms: number): number {
	const deep = deepseekCost(provider, model, usage, ms);
	if (deep !== undefined) return deep;
	return usage?.cost?.total ?? 0;
}

/** Usage payload for an entry, or undefined when the entry carries none. */
function entryUsage(entry: any): Usage | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	switch (entry.type) {
		case "usage":
			return entry.usage;
		case "message": {
			const message = entry.message;
			if (!message) return undefined;
			if (message.role === "assistant" || message.role === "toolResult") return message.usage;
			return undefined;
		}
		case "branch_summary":
		case "compaction":
			return entry.usage;
		default:
			return undefined;
	}
}

/**
 * Cost of a single session entry. Works for both parsed SessionEntry objects
 * (from ctx.sessionManager) and raw JSONL FileEntry objects.
 */
function entryCost(entry: any): number {
	const usage = entryUsage(entry);
	if (!usage) return 0;
	const ms = entryTime(entry);
	switch (entry.type) {
		case "usage":
			return usageCost(entry.provider, entry.model, usage, ms);
		case "message": {
			const message = entry.message;
			if (message?.role === "assistant") return usageCost(message.provider, message.model, usage, ms);
			if (message?.role === "toolResult") return usageCost(message.provider, message.model, usage, ms);
			return 0;
		}
		case "branch_summary":
		case "compaction":
			return usageCost(entry.provider, entry.model, usage, ms);
		default:
			return 0;
	}
}

/** Timestamp of an entry in milliseconds since epoch (0 when unknown). */
function entryTime(entry: any): number {
	const timestamp = entry?.timestamp;
	if (typeof timestamp === "string") {
		const ms = Date.parse(timestamp);
		if (!Number.isNaN(ms)) return ms;
	}
	if (typeof timestamp === "number") return timestamp;
	return 0;
}

function startOfToday(now: number): number {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** Compact token count for footer display. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Human-readable duration for the transcript card. */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m ${rest}s`;
}

/** Human-readable elapsed time for the footer ("1h 23m", "23m 5s", "45s"). */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** Total billed tokens in a usage payload (input + output + cache reads/writes). */
function usageTokens(usage: Usage | undefined): number {
	if (!usage) return 0;
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

interface TurnStats {
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	apiCalls: number;
	toolCalls: number;
	durationMs: number;
}

/** Tokens, cost, duration and API calls for the latest turn (since the last user message). */
function turnStats(ctx: ExtensionContext): TurnStats {
	const entries = ctx.sessionManager.getEntries();
	let lastUserIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message.role === "user") {
			lastUserIndex = i;
			break;
		}
	}
	const stats: TurnStats = { total: 0, input: 0, output: 0, cacheRead: 0, cost: 0, apiCalls: 0, toolCalls: 0, durationMs: 0 };
	if (lastUserIndex < 0) return stats;
	const startMs = entryTime(entries[lastUserIndex]);
	let endMs = 0;
	for (let i = lastUserIndex; i < entries.length; i++) {
		const entry = entries[i];
		const usage = entryUsage(entry);
		if (usage) {
			stats.input += usage.input ?? 0;
			stats.output += usage.output ?? 0;
			stats.cacheRead += usage.cacheRead ?? 0;
			stats.total += usageTokens(usage);
			stats.apiCalls += 1;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const block of entry.message.content ?? []) {
				if (block?.type === "toolCall") stats.toolCalls += 1;
			}
		}
		stats.cost += entryCost(entry);
		const t = entryTime(entry);
		if (t > endMs) endMs = t;
	}
	if (startMs > 0 && endMs > startMs) stats.durationMs = endMs - startMs;
	return stats;
}

/** Session output tokens and active turn time (user message → last entry of the turn). */
function turnThroughput(ctx: ExtensionContext): { output: number; activeMs: number } {
	let output = 0;
	let activeMs = 0;
	let turnStart = 0;
	let turnEnd = 0;
	let inTurn = false;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "user") {
			if (inTurn) activeMs += Math.max(0, turnEnd - turnStart);
			turnStart = entryTime(entry);
			turnEnd = turnStart;
			inTurn = true;
			continue;
		}
		const usage = entryUsage(entry);
		if (usage) output += usage.output ?? 0;
		const t = entryTime(entry);
		if (inTurn && t > turnEnd) turnEnd = t;
	}
	if (inTurn) activeMs += Math.max(0, turnEnd - turnStart);
	return { output, activeMs };
}

/** Path relative to the session cwd when inside it, else the original path. */
function shortPath(path: string, cwd: string): string {
	const rel = relative(cwd, resolve(cwd, path));
	return rel && !rel.startsWith("..") ? rel : path;
}

/** Files changed in the latest turn, with added/deleted line counts. */
function collectFileChanges(ctx: ExtensionContext): FileChange[] {
	const entries = ctx.sessionManager.getEntries();
	let lastUser = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry: any = entries[i];
		if (entry.type === "message" && entry.message?.role === "user") {
			lastUser = i;
			break;
		}
	}
	if (lastUser < 0) return [];

	const results = new Map<string, any>();
	for (let i = lastUser; i < entries.length; i++) {
		const entry: any = entries[i];
		if (entry.type === "message" && entry.message?.role === "toolResult") {
			results.set(entry.message.toolCallId, entry.message);
		}
	}

	const changes = new Map<string, FileChange>();
	for (let i = lastUser; i < entries.length; i++) {
		const entry: any = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const block of entry.message.content ?? []) {
			if (block?.type !== "toolCall") continue;
			const path = block.arguments?.path;
			if (typeof path !== "string" || !path) continue;
			let added = 0;
			let deleted = 0;
			if (block.name === "edit") {
				const patch = results.get(block.id)?.details?.patch;
				if (typeof patch === "string") {
					patch.split("\n").forEach((line: string, index: number) => {
						if (index < 2 || line.startsWith("@@")) return; // file / hunk header
						if (line.startsWith("+")) added++;
						else if (line.startsWith("-")) deleted++;
					});
				}
			} else if (block.name === "write") {
				const content = typeof block.arguments?.content === "string" ? block.arguments.content : "";
				added = content ? content.replace(/\n$/, "").split("\n").length : 0;
			} else {
				continue;
			}
			const key = resolve(ctx.cwd, path);
			const current = changes.get(key) ?? { path: shortPath(path, ctx.cwd), added: 0, deleted: 0 };
			current.added += added;
			current.deleted += deleted;
			changes.set(key, current);
		}
	}
	return [...changes.values()];
}

/** Context usage for the footer: value text plus a severity level. */
function contextDisplay(ctx: ExtensionContext): { text: string; level: "error" | "warning" | "normal" } {
	const usage = ctx.getContextUsage();
	if (!usage) return { text: "◧ —", level: "normal" };
	const percent = usage.percent;
	if (percent === null || percent === undefined) return { text: "◧ ?", level: "normal" };
	const level = percent > 90 ? "error" : percent > 70 ? "warning" : "normal";
	return { text: `◧ ${percent.toFixed(1)}%`, level };
}

interface Display {
	sessionTokens: string;
	sessionTotalTokens: number;
	sessionOutputTokens: number;
	throughput: number;
	costSession: string;
	costToday: string;
	cost30d: string;
	ctxText: string;
	ctxLevel: "error" | "warning" | "normal";
	chText: string;
	peakKind: "peak" | "off-peak";
	peakText: string;
	model: string;
	thinking: string;
}

interface FileChange {
	path: string;
	added: number;
	deleted: number;
}

interface TurnUsageData {
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	apiCalls: number;
	toolCalls: number;
	durationMs: number;
	files?: FileChange[];
	timestamp: number;
}

interface WindowCosts {
	today: number;
	last30: number;
}

/** Sum cost from a raw JSONL session file within the today/30-day windows. */
async function scanFileWindows(path: string, now: number): Promise<WindowCosts> {
	const todayStart = startOfToday(now);
	const last30Start = now - 30 * DAY_MS;
	let today = 0;
	let last30 = 0;
	try {
		const text = await readFile(path, "utf8");
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let entry: any;
			try {
				entry = JSON.parse(trimmed);
			} catch {
				continue;
			}
			const cost = entryCost(entry);
			if (!cost) continue;
			const time = entryTime(entry);
			if (time >= todayStart) today += cost;
			if (time >= last30Start) last30 += cost;
		}
	} catch {
		// Unreadable file: contributes nothing.
	}
	return { today, last30 };
}

/** Local-time YYYY-MM-DD key for bucketing cost by day. */
function localDayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface FileStats {
	cwd: string;
	name: string;
	firstUser: string;
	startedAt: number;
	today: number;
	byDay: Map<string, number>;
}

/** Per-day cost buckets (and today's total) for one session file. */
async function scanFileStats(path: string, now: number): Promise<FileStats> {
	const todayStart = startOfToday(now);
	const byDay = new Map<string, number>();
	let cwd = "";
	let name = "";
	let firstUser = "";
	let startedAt = 0;
	let today = 0;
	try {
		const text = await readFile(path, "utf8");
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let entry: any;
			try {
				entry = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (entry.type === "session") {
				cwd = entry.cwd ?? "";
				startedAt = entryTime(entry);
				continue;
			}
			if (entry.type === "session_info") {
				name = entry.name ?? "";
				continue;
			}
			if (!firstUser && entry.type === "message" && entry.message?.role === "user") {
				firstUser = messageText(entry.message);
			}
			const cost = entryCost(entry);
			if (!cost) continue;
			const time = entryTime(entry);
			if (!time) continue;
			if (time >= todayStart) today += cost;
			const key = localDayKey(time);
			byDay.set(key, (byDay.get(key) ?? 0) + cost);
		}
	} catch {
		// Unreadable file: contributes nothing.
	}
	return { cwd, name, firstUser, startedAt, today, byDay };
}

/** Plain text of a message's content (string or content blocks). */
function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
	if (Array.isArray(content)) {
		return content
			.filter((c) => c?.type === "text")
			.map((c) => c.text)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
	}
	return "";
}

/** Best label for a session: its name, else its first user message, else cwd. */
function sessionLabel(stats: FileStats): string {
	if (stats.name) return stats.name;
	const base = stats.firstUser || cwdLabel(stats.cwd);
	const clock = stats.startedAt ? new Date(stats.startedAt).toTimeString().slice(0, 5) : "";
	const short = base.length > 22 ? base.slice(0, 22) : base;
	return clock ? `${short} · ${clock}` : short;
}

/** Short label for a session's working directory. */
function cwdLabel(cwd: string): string {
	if (!cwd) return "unknown";
	const home = homedir();
	let p = cwd;
	if (p === home) p = "~";
	else if (p.startsWith(home + "/") || p.startsWith(home + "\\")) p = "~" + p.slice(home.length);
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts.slice(-2).join("/") || p;
}

/** Full path with the home directory shortened to "~". */
function formatCwd(cwd: string): string {
	if (!cwd) return "unknown";
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(home + "/") || cwd.startsWith(home + "\\")) return "~" + cwd.slice(home.length);
	return cwd;
}

/** Render rows as a horizontal bar chart. */
function barRows(rows: { label: string; cost: number }[]): string[] {
	if (rows.length === 0) return ["(no usage in range)"];
	const max = Math.max(...rows.map((r) => r.cost));
	const labelW = Math.min(30, Math.max(...rows.map((r) => r.label.length)));
	const barW = 18;
	return rows.map((r) => {
		const label = r.label.length > labelW ? r.label.slice(0, labelW) : r.label;
		const len = max > 0 ? Math.max(r.cost > 0 ? 1 : 0, Math.round((r.cost / max) * barW)) : 0;
		return `${label.padEnd(labelW)} ${"\u2588".repeat(len).padEnd(barW)} $${r.cost.toFixed(3)}`;
	});
}

export default function (pi: ExtensionAPI) {
	let ready = false; // whether the background baseline has finished loading
	let baseline: WindowCosts = { today: 0, last30: 0 }; // other sessions' windows
	let scanGeneration = 0; // invalidates background scans after a session switch
	let activeTui: { requestRender(): void } | null = null;
	let invalidateCurrent: (() => void) | null = null;
	let currentModel = "no-model";
	let currentProvider = "";
	let currentContextWindow = 0;
	let currentThinking = "off";
	let currentReasoning = false;
	let hitSegments: HitSegment[] = [];
	let infoOpen = false;
	let sessionStart = 0;
	let durationTimer: ReturnType<typeof setInterval> | undefined;
	let taskTimer: ReturnType<typeof setInterval> | undefined;
	let currentBranch: string | null = null;

	/** Live session cost plus its today/30-day window contributions. */
	function liveCosts(ctx: ExtensionContext, now: number) {
		const todayStart = startOfToday(now);
		const last30Start = now - 30 * DAY_MS;
		let session = 0;
		let today = 0;
		let last30 = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			const cost = entryCost(entry);
			if (!cost) continue;
			session += cost;
			const time = entryTime(entry);
			if (time >= todayStart) today += cost;
			if (time >= last30Start) last30 += cost;
		}
		return { session, today, last30 };
	}

	/** Cache-hit share of prompt tokens in the current session. */
	function liveCache(ctx: ExtensionContext): { cacheRead: number; promptTokens: number } {
		let cacheRead = 0;
		let input = 0;
		let cacheWrite = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			const usage = entryUsage(entry);
			if (!usage) continue;
			cacheRead += usage.cacheRead ?? 0;
			input += usage.input ?? 0;
			cacheWrite += usage.cacheWrite ?? 0;
		}
		return { cacheRead, promptTokens: input + cacheRead + cacheWrite };
	}

	/** Cumulative session tokens (with output subtotal) plus the latest turn total. */
	function liveTokens(ctx: ExtensionContext): { sessionTotal: number; outputTotal: number; turnTotal: number } {
		const entries = ctx.sessionManager.getEntries();
		let sessionTotal = 0;
		let outputTotal = 0;
		let lastUserIndex = -1;
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const usage = entryUsage(entry);
			sessionTotal += usageTokens(usage);
			outputTotal += usage?.output ?? 0;
			if (entry.type === "message" && entry.message.role === "user") lastUserIndex = i;
		}
		let turnTotal = 0;
		if (lastUserIndex >= 0) {
			for (let i = lastUserIndex; i < entries.length; i++) {
				turnTotal += usageTokens(entryUsage(entries[i]));
			}
		}
		return { sessionTotal, outputTotal, turnTotal };
	}

	function computeDisplay(ctx: ExtensionContext): Display {
		const now = Date.now();
		const live = liveCosts(ctx, now);
		const today = live.today + baseline.today;
		const last30 = live.last30 + baseline.last30;
		const costSession = `$${live.session.toFixed(3)}`;
		const costToday = ready ? `$${today.toFixed(3)}` : "…";
		const cost30d = ready ? `$${last30.toFixed(3)}` : "…";

		const ctxInfo = contextDisplay(ctx);

		const cache = liveCache(ctx);
		const chText = cache.promptTokens > 0
			? `↺ ${((cache.cacheRead / cache.promptTokens) * 100).toFixed(1)}%`
			: "↺ —";

		const tokens = liveTokens(ctx);
		const sessionTokens = `Σ ${formatTokens(tokens.sessionTotal)}`;
		const sessionTotalTokens = tokens.sessionTotal;
		const sessionOutputTokens = tokens.outputTotal;
		const tput = turnThroughput(ctx);
		const throughput = tput.activeMs > 0 ? tput.output / (tput.activeMs / 1000) : 0;

		const peakKind = isDeepseekPeak(now) ? "peak" : "off-peak";
		const peakText = peakKind === "peak" ? "\u{F1213} peak" : "\u{F0533} off-peak";
		const model = currentModel;
		const thinking = currentReasoning ? `\u{F09D1} ${currentThinking}` : "";

		return { sessionTokens, sessionTotalTokens, sessionOutputTokens, throughput, costSession, costToday, cost30d, ctxText: ctxInfo.text, ctxLevel: ctxInfo.level, chText, peakKind, peakText, model, thinking };
	}

	function refresh(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		invalidateCurrent?.();
		activeTui?.requestRender();
	}

	/** Best label for the current in-memory session. */
	function liveSessionLabel(ctx: ExtensionContext): string {
		const name = ctx.sessionManager.getSessionName();
		if (name) return name;
		const header = ctx.sessionManager.getHeader();
		const clock = header ? new Date(Date.parse(header.timestamp)).toTimeString().slice(0, 5) : "";
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "user") {
				const text = messageText(entry.message);
				if (text) return clock ? `${text.slice(0, 22)} · ${clock}` : text.slice(0, 32);
			}
		}
		return cwdLabel(ctx.cwd);
	}

	/** Bar chart of today's cost broken down by session. */
	async function todaySessionsInfo(ctx: ExtensionContext): Promise<{ title: string; lines: string[] }> {
		const now = Date.now();
		const files = await listSessionFiles();
		const currentPath = ctx.sessionManager.getSessionFile();
		const resolvedCurrent = currentPath ? resolve(currentPath) : undefined;
		const rows: { label: string; cost: number }[] = [];
		for (const file of files) {
			if (resolvedCurrent && resolve(file) === resolvedCurrent) continue;
			const stats = await scanFileStats(file, now);
			if (stats.today > 0) rows.push({ label: sessionLabel(stats), cost: stats.today });
		}
		const live = liveCosts(ctx, now);
		if (live.today > 0) rows.push({ label: `${liveSessionLabel(ctx)} *`, cost: live.today });
		rows.sort((a, b) => b.cost - a.cost);
		const total = rows.reduce((sum, r) => sum + r.cost, 0);
		const lines = barRows(rows);
		lines.push("", `Total      $${total.toFixed(3)}`);
		return { title: "Today · cost by session", lines };
	}

	/** Bar chart of cost per day over the last 30 days. */
	async function last30DaysInfo(ctx: ExtensionContext): Promise<{ title: string; lines: string[] }> {
		const now = Date.now();
		const cutoffKey = localDayKey(now - 30 * DAY_MS);
		const files = await listSessionFiles();
		const currentPath = ctx.sessionManager.getSessionFile();
		const resolvedCurrent = currentPath ? resolve(currentPath) : undefined;
		const byDay = new Map<string, number>();
		for (const file of files) {
			if (resolvedCurrent && resolve(file) === resolvedCurrent) continue;
			const stats = await scanFileStats(file, now);
			for (const [day, cost] of stats.byDay) byDay.set(day, (byDay.get(day) ?? 0) + cost);
		}
		for (const entry of ctx.sessionManager.getEntries()) {
			const cost = entryCost(entry);
			if (!cost) continue;
			const time = entryTime(entry);
			if (!time) continue;
			const key = localDayKey(time);
			byDay.set(key, (byDay.get(key) ?? 0) + cost);
		}
		const rows = [...byDay.entries()]
			.filter(([day]) => day >= cutoffKey)
			.sort((a, b) => (a[0] < b[0] ? 1 : -1))
			.map(([day, cost]) => ({ label: day, cost }));
		const total = rows.reduce((sum, r) => sum + r.cost, 0);
		const lines = barRows(rows);
		lines.push("", `Total      $${total.toFixed(3)}`);
		return { title: "Last 30 days · cost by day", lines };
	}

	/** Details shown in the click-through overlay for one footer segment. */
	function infoFor(id: string, ctx: ExtensionContext): { title: string; lines: string[] } | undefined {
		const now = Date.now();
		const tokens = liveTokens(ctx);
		const cache = liveCache(ctx);
		const costs = liveCosts(ctx, now);
		const turn = turnStats(ctx);
		const cu = ctx.getContextUsage();
		const cachePct = cache.promptTokens > 0 ? (cache.cacheRead / cache.promptTokens) * 100 : null;
		const peak = isDeepseekPeak(now);
		const utc = new Date(now).toISOString().slice(11, 16);

		switch (id) {
			case "tokens":
				return {
					title: "Session tokens",
					lines: [
						`Total      ${formatTokens(tokens.sessionTotal)}`,
						`Last turn  ${formatTokens(tokens.turnTotal)} · $${turn.cost.toFixed(3)}`,
						`Cost       $${costs.session.toFixed(3)}`,
					],
				};
			case "session-time": {
				const started = new Date(sessionStart);
				return {
					title: "Session time",
					lines: [
						`Elapsed    ${formatElapsed(Date.now() - sessionStart)}`,
						`Started    ${started.toLocaleString()}`,
					],
				};
			}
			case "branch":
				return {
					title: "Git branch",
					lines: [`Branch     ${currentBranch ?? "(not a git repository)"}`],
				};
			case "cwd":
				return {
					title: "Working directory",
					lines: [`Path       ${ctx.cwd}`, `Shortened  ${formatCwd(ctx.cwd)}`],
				};
			case "tps": {
				const tput = turnThroughput(ctx);
				const seconds = tput.activeMs / 1000;
				return {
					title: "Throughput",
					lines: [
						`Output/s   ${(seconds > 0 ? tput.output / seconds : 0).toFixed(1)}`,
						`Output     ${formatTokens(tput.output)}`,
						`Total      ${formatTokens(tokens.sessionTotal)}`,
						`Active     ${formatElapsed(tput.activeMs)}`,
					],
				};
			}
			case "cost-session":
				return {
					title: "Cost",
					lines: [
						`Session    $${costs.session.toFixed(3)}`,
						`Today      ${ready ? `$${(costs.today + baseline.today).toFixed(3)}` : "…"}`,
						`30 days    ${ready ? `$${(costs.last30 + baseline.last30).toFixed(3)}` : "…"}`,
					],
				};
			case "context": {
				const used = cu?.tokens;
				return {
					title: "Context window",
					lines: [
						`Used       ${used === null || used === undefined ? "unknown" : formatTokens(used)}`,
						`Window     ${formatTokens(cu?.contextWindow ?? currentContextWindow)}`,
						`Percent    ${cu?.percent === null || cu?.percent === undefined ? "unknown" : `${cu.percent.toFixed(1)}%`}`,
						`Model      ${currentModel}`,
					],
				};
			}
			case "cache":
				return {
					title: "Prompt cache",
					lines: [
						`Hit rate   ${cachePct === null ? "—" : `${cachePct.toFixed(1)}%`}`,
						`Cache read ${formatTokens(cache.cacheRead)}`,
						`Prompt     ${formatTokens(cache.promptTokens)}`,
					],
				};
			case "peak": {
				const r = DEEPSEEK_PEAK_RATES[currentModel];
				const row = (label: string, peakRate: number) =>
					`${label.padEnd(8)}${`$${peakRate.toFixed(3)}/M`.padEnd(12)}$${(peakRate * 0.5).toFixed(3)}/M`;
				const rateLines = r
					? [
							`${"".padEnd(8)}${"peak".padEnd(12)}off-peak`,
							row("Input", r.input),
							row("Output", r.output),
							row("Cache", r.cacheRead),
						]
					: [`Rates      n/a for ${currentModel}`];
				return {
					title: "DeepSeek pricing",
					lines: [
						...rateLines,
						"",
						`Peak       01:00-04:00, 06:00-10:00 UTC, Mon-Fri`,
						`Off-peak   50% of peak rates`,
						`Now        ${peak ? "peak" : "off-peak"} · ${utc} UTC`,
					],
				};
			}
			case "model":
				return {
					title: "Model",
					lines: [
						`Model      ${currentModel}`,
						`Provider   ${currentProvider || "unknown"}`,
						`Context    ${formatTokens(currentContextWindow)}`,
						`Reasoning  ${currentReasoning ? "yes" : "no"}`,
					],
				};
			case "thinking":
				return {
					title: "Thinking level",
					lines: [`Level      ${currentThinking}`, `Model      ${currentModel}`],
				};
			default:
				return undefined;
		}
	}

	/** Open a dismissible overlay card with details for one footer segment. */
	async function showInfo(id: string, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui" || infoOpen) return;
		infoOpen = true;
		try {
			const info =
				id === "cost-today"
					? await todaySessionsInfo(ctx)
					: id === "cost-30d"
						? await last30DaysInfo(ctx)
						: infoFor(id, ctx);
			if (!info) return;
			await ctx.ui.custom<void>(
				(_tui, theme, _kb, done) => {
					const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
					box.addChild(new Text(theme.fg("accent", info.title), 0, 0));
					for (const line of info.lines) box.addChild(line === "" ? new Spacer(1) : new Text(line, 0, 0));
					box.addChild(new Text(theme.fg("dim", "press any key or click to close"), 0, 0));
					return {
						invalidate() {
							box.invalidate();
						},
						handleInput() {
							done();
						},
						handleMouse() {
							done();
							return { handled: true };
						},
						render(width: number): string[] {
							return box.render(width);
						},
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: 64, maxHeight: "80%" } },
			);
		} finally {
			infoOpen = false;
		}
	}

	// After each turn, append a durable transcript line with the tokens used in
	// the last user message. Rendered via registerEntryRenderer (not sent to LLM).
	pi.registerEntryRenderer<TurnUsageData>("token-usage", (entry, _options, theme) => {
		const data = entry.data;
		if (!data || (data.total <= 0 && !data.files?.length)) return undefined;
		const meta = [`${data.apiCalls} call${data.apiCalls === 1 ? "" : "s"}`];
		if (data.toolCalls > 0) meta.push(`${data.toolCalls} tool${data.toolCalls === 1 ? "" : "s"}`);
		if (data.durationMs > 0) meta.push(formatDuration(data.durationMs));
		const total = theme.fg("accent", `→ ${formatTokens(data.total)} tokens`);
		const rest = theme.fg("dim", ` · $${data.cost.toFixed(3)} · ${meta.join(" · ")}`);
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${total}${rest}`, 0, 0));
		// One Text per file so a single line can be underlined on hover. Row 0 is
		// the totals line and row 1 is the header line, so file i is at row i + 2.
		const FILE_ROW_OFFSET = 2;
		const fileRows: { text: Text; plain: string }[] = [];
		if (data.files && data.files.length > 0) {
			const added = data.files.reduce((sum, f) => sum + f.added, 0);
			const deleted = data.files.reduce((sum, f) => sum + f.deleted, 0);
			const count = `${data.files.length} file${data.files.length === 1 ? "" : "s"}`;
			box.addChild(new Text(theme.fg("dim", `${"\u{F11E7}"} ${count} changed · +${added} −${deleted}`), 0, 0));
			for (const file of data.files) {
				const stat = [file.added ? theme.fg("success", `+${file.added}`) : "", file.deleted ? theme.fg("error", `−${file.deleted}`) : ""]
					.filter(Boolean)
					.join(" ");
				const line = `  ${file.path}  ${stat}`;
				const text = new Text(line, 0, 0);
				fileRows.push({ text, plain: line });
				box.addChild(text);
			}
		}
		if (fileRows.length === 0) return box;

		// Underline the file line under the pointer, like hovering a link.
		let hovered = -1;
		return new MouseRegion(box, (event) => {
			if (event.type !== "move") return undefined;
			const index = event.y - FILE_ROW_OFFSET;
			const next = index >= 0 && index < fileRows.length ? index : -1;
			if (next === hovered) return undefined;
			hovered = next;
			fileRows.forEach((row, i) => row.text.setText(i === hovered ? theme.underline(row.plain) : row.plain));
			return { handled: true, render: true };
		});
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ready = false;
		baseline = { today: 0, last30: 0 };
		const generation = ++scanGeneration;
		currentModel = ctx.model?.id ?? "no-model";
		currentProvider = ctx.model?.provider ?? "";
		currentContextWindow = ctx.model?.contextWindow ?? 0;
		currentThinking = ctx.thinkingLevel ?? "off";
		currentReasoning = ctx.model?.reasoning ?? false;

		const header = ctx.sessionManager.getHeader();
		sessionStart = header ? Date.parse(header.timestamp) : Date.now();
		if (durationTimer) clearInterval(durationTimer);
		durationTimer = setInterval(() => activeTui?.requestRender(), 15_000);

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			let cached: Display | undefined;
			const invalidate = () => {
				cached = undefined;
			};
			invalidateCurrent = invalidate;
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubscribeBranch();
					if (invalidateCurrent === invalidate) invalidateCurrent = null;
					if (activeTui === tui) activeTui = null;
				},
				invalidate,
				render(width: number): string[] {
					if (cached === undefined) {
						try {
							cached = computeDisplay(ctx);
						} catch {
							// The captured context can become stale across session switches.
							cached = {
								sessionTokens: "Σ 0",
								sessionTotalTokens: 0,
								sessionOutputTokens: 0,
								throughput: 0,
								costSession: "$0.000",
								costToday: "…",
								cost30d: "…",
								ctxText: "◧ —",
								ctxLevel: "normal",
								chText: "↺ —",
								peakKind: "off-peak",
								peakText: "\u{F0533} off-peak",
								model: "no-model",
								thinking: "",
							};
						}
					}
					const sep = theme.fg("dim", " · ");
					const ctxStyled = cached.ctxLevel === "error"
						? theme.fg("error", cached.ctxText)
						: cached.ctxLevel === "warning"
							? theme.fg("warning", cached.ctxText)
							: theme.fg("dim", cached.ctxText);
					const peakStyled = cached.peakKind === "peak"
						? theme.fg("warning", cached.peakText)
						: theme.fg("success", cached.peakText);
					const elapsed = `${"\u{F0150}"} ${formatElapsed(Date.now() - sessionStart)}`;
					const branch = footerData.getGitBranch();
					currentBranch = branch;
					const tps = cached.throughput;
					const dim = (text: string) => theme.fg("dim", text);

					// Line 1 — context info (left) · pricing (right).
					const r1Left = [
						{ id: "tokens", text: dim(cached.sessionTokens) },
						{ id: "session-time", text: dim(elapsed) },
						{ id: "context", text: ctxStyled },
						{ id: "cache", text: dim(cached.chText) },
					];
					const r1Right = [
						{ id: "cost-session", text: dim(cached.costSession) },
						{ id: "cost-today", text: dim(cached.costToday) },
						{ id: "cost-30d", text: dim(cached.cost30d) },
						{ id: "peak", text: peakStyled },
					];

					// Line 2 — context info (left) · model (right).
					const r2Left = [
						...(branch ? [{ id: "branch", text: dim(`${"\u{F062C}"} ${branch}`) }] : []),
						{ id: "cwd", text: dim(`${"\u{F0256}"} ${formatCwd(ctx.cwd)}`) },
					];
					const r2Right = [{ id: "model", text: dim(cached.model) }];
					if (cached.thinking) r2Right.push({ id: "thinking", text: dim(cached.thinking) });
					r2Right.push({ id: "tps", text: dim(`${"\u{F04C5}"} ${tps.toFixed(1)}/s`) });

					const lines: string[] = [];
					const ranges: HitSegment[] = [];
					const rows = [
						{ left: r1Left, right: r1Right },
						{ left: r2Left, right: r2Right },
					];
					for (const [lineIndex, row] of rows.entries()) {
						const leftText = row.left.map((s) => s.text).join(sep);
						const rightText = row.right.map((s) => s.text).join(sep);
						const leftWidth = visibleWidth(leftText);
						const padLen = Math.max(1, width - leftWidth - visibleWidth(rightText));
						lines.push(truncateToWidth(leftText + " ".repeat(padLen) + rightText, width));
						let x = 0;
						for (const s of row.left) {
							const w = visibleWidth(s.text);
							if (x < width) ranges.push({ id: s.id, line: lineIndex, start: x, end: Math.min(x + w, width) });
							x += w + SEP_WIDTH;
						}
						x = leftWidth + padLen;
						for (const s of row.right) {
							const w = visibleWidth(s.text);
							if (x < width) ranges.push({ id: s.id, line: lineIndex, start: x, end: Math.min(x + w, width) });
							x += w + SEP_WIDTH;
						}
					}
					hitSegments = ranges;

					return lines;
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (event.type !== "click" || event.button !== "left") return undefined;
					const hit = hitSegments.find((s) => s.line === event.y && event.x >= s.start && event.x < s.end);
					if (!hit) return undefined;
					void showInfo(hit.id, ctx);
					return { handled: true };
				},
			};
		});

		const currentPath = ctx.sessionManager.getSessionFile();
		const resolvedCurrent = currentPath ? resolve(currentPath) : undefined;

		// Load the baseline from other sessions in the background so startup isn't blocked.
		void (async () => {
			const now = Date.now();
			const files = await listSessionFiles();
			let today = 0;
			let last30 = 0;
			let currentToday = 0;
			let currentLast30 = 0;
			for (const file of files) {
				const windows = await scanFileWindows(file, now);
				today += windows.today;
				last30 += windows.last30;
				if (resolvedCurrent && resolve(file) === resolvedCurrent) {
					currentToday = windows.today;
					currentLast30 = windows.last30;
				}
			}
			if (generation !== scanGeneration) return; // a newer session started
			baseline = {
				today: today - currentToday,
				last30: last30 - currentLast30,
			};
			ready = true;
			refresh(ctx);
		})();
	});

	// Model / thinking-level changes must refresh the footer explicitly: the
	// context captured in the footer factory carries the model as of session
	// start, so read the live values from these events instead.
	pi.on("model_select", (event, ctx) => {
		currentModel = event.model?.id ?? "no-model";
		currentProvider = event.model?.provider ?? "";
		currentContextWindow = event.model?.contextWindow ?? 0;
		currentReasoning = event.model?.reasoning ?? false;
		refresh(ctx);
	});
	pi.on("thinking_level_select", (event, ctx) => {
		currentThinking = event.level;
		refresh(ctx);
	});

	// Live task timer in the working indicator ("Working · 12s"), from turn_start to agent_end.
	pi.on("turn_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const started = Date.now();
		const tick = () => ctx.ui.setWorkingMessage(`Working · ${formatElapsed(Date.now() - started)}`);
		tick();
		if (taskTimer) clearInterval(taskTimer);
		taskTimer = setInterval(tick, 1000);
	});

	// Usage is finalized when messages and runs end; refresh the footer then.
	pi.on("message_end", (_event, ctx) => refresh(ctx));
	pi.on("agent_end", (_event, ctx) => {
		if (taskTimer) {
			clearInterval(taskTimer);
			taskTimer = undefined;
		}
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage(undefined);
		const stats = turnStats(ctx);
		const files = collectFileChanges(ctx);
		if (stats.total > 0 || files.length > 0) {
			pi.appendEntry<TurnUsageData>("token-usage", {
				total: stats.total,
				input: stats.input,
				output: stats.output,
				cacheRead: stats.cacheRead,
				cost: stats.cost,
				apiCalls: stats.apiCalls,
				toolCalls: stats.toolCalls,
				durationMs: stats.durationMs,
				files,
				timestamp: Date.now(),
			});
		}
		refresh(ctx);
	});

	// Stop the elapsed-time tickers when the session ends.
	pi.on("session_shutdown", () => {
		if (durationTimer) clearInterval(durationTimer);
		if (taskTimer) clearInterval(taskTimer);
		durationTimer = undefined;
		taskTimer = undefined;
	});
}
