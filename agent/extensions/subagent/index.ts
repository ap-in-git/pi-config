/**
 * Subagent Tool — background dispatch via Herdr.
 *
 * Spawns each subagent as a separate `pi` process in its own Herdr tab so the
 * human can watch it live. The dispatching turn returns
 * immediately; poll the result with the `subagent_check` tool.
 *
 * Modes:
 *   - single:   { agent: "name", task: "..." }
 *   - parallel: { tasks: [{ agent, task }, ...] }  (up to 4)
 *
 * The dispatched tab runs `pi --mode json -p` with its output teed to a state
 * file under ~/.pi/agent/subagents/<id>/. `subagent_check` reads that file and
 * the tab's pane to report progress and the final answer.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentsForDisplay, formatAgentsForPrompt } from "./agents.ts";

const MAX_PARALLEL_TASKS = 4;
const DEFAULT_WAIT_MS = 300000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parseJson(s: string): any {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}

function sanitize(name: string): string {
	return name.replace(/[^\w.-]+/g, "_");
}

function resolveHerdr(): string {
	const candidates = [
		path.join(os.homedir(), ".local", "bin", "herdr"),
		"/usr/local/bin/herdr",
		"/opt/homebrew/bin/herdr",
	];
	for (const c of candidates) {
		try {
			if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
		} catch {
			/* ignore */
		}
	}
	return "herdr";
}

function herdr(args: string[]): Promise<RunResult> {
	return run(resolveHerdr(), args);
}

// ---------------------------------------------------------------------------
// Herdr tab control
// ---------------------------------------------------------------------------

async function createTab(cwd: string, label: string): Promise<{ tabId: string; paneId: string }> {
	const res = await herdr(["tab", "create", "--cwd", cwd, "--no-focus", "--label", label]);
	if (res.code !== 0) throw new Error(`herdr tab create failed: ${res.stderr || res.stdout}`);
	const data = parseJson(res.stdout);
	const tabId: string | undefined = data?.result?.tab?.tab_id;
	const paneId: string | undefined = data?.result?.root_pane?.pane_id;
	if (!tabId || !paneId) throw new Error(`herdr tab create returned no ids: ${res.stdout}`);
	return { tabId, paneId };
}

async function runInPane(paneId: string, command: string): Promise<void> {
	let lastError = "";
	for (let i = 0; i < 6; i++) {
		const res = await herdr(["pane", "run", paneId, command]);
		if (res.code === 0) return;
		lastError = res.stderr || res.stdout;
		await sleep(600);
	}
	throw new Error(`herdr pane run failed: ${lastError}`);
}

// ---------------------------------------------------------------------------
// Dispatch bookkeeping
// ---------------------------------------------------------------------------

interface DispatchMeta {
	id: string;
	agent: string;
	paneId: string;
	tabId?: string;
	cwd: string;
	task: string;
	startedAt: number;
	outLog: string;
	doneMarker: string;
	scope: string;
	model?: string;
}

function subagentBaseDir(): string {
	return path.join(getAgentDir(), "subagents");
}

function listDispatchDirs(baseDir: string): string[] {
	try {
		return fs
			.readdirSync(baseDir)
			.filter((d) => fs.statSync(path.join(baseDir, d)).isDirectory())
			.sort();
	} catch {
		return [];
	}
}

function readMeta(dir: string): DispatchMeta | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as DispatchMeta;
	} catch {
		return undefined;
	}
}

function findDispatch(baseDir: string, target: string): { dir: string; meta: DispatchMeta } | undefined {
	let lastAgentMatch: { dir: string; meta: DispatchMeta } | undefined;
	for (const d of listDispatchDirs(baseDir)) {
		const meta = readMeta(path.join(baseDir, d));
		if (!meta) continue;
		if (meta.id === target || meta.paneId === target || meta.tabId === target) return { dir: path.join(baseDir, d), meta };
		if (meta.agent === target) lastAgentMatch = { dir: path.join(baseDir, d), meta };
	}
	return lastAgentMatch;
}

async function dispatchAgent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	scope: AgentScope,
	ctx: { model?: { provider: string; id: string } | null; thinkingLevel?: string },
): Promise<DispatchMeta> {
	const baseDir = subagentBaseDir();
	fs.mkdirSync(baseDir, { recursive: true });

	const id = `${sanitize(agent.name)}-${Date.now().toString(36)}`;
	const dir = path.join(baseDir, id);
	fs.mkdirSync(dir, { recursive: true });

	const taskPath = path.join(dir, "task.md");
	fs.writeFileSync(taskPath, `Task: ${task}`, "utf8");

	const cmdParts: string[] = ["pi", "--mode", "json", "-p", "--no-session"];
	let model: string | undefined;
	if (agent.model) {
		model = agent.model;
		cmdParts.push("--model", agent.model);
	} else {
		if (ctx.model) {
			model = `${ctx.model.provider}/${ctx.model.id}`;
			cmdParts.push("--model", model);
		}
		if (ctx.thinkingLevel) cmdParts.push("--thinking", ctx.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) cmdParts.push("--tools", agent.tools.join(","));
	if (agent.systemPrompt.trim()) {
		const systemPath = path.join(dir, "system.md");
		fs.writeFileSync(systemPath, agent.systemPrompt, "utf8");
		cmdParts.push("--append-system-prompt", systemPath);
	}
	cmdParts.push(`@${taskPath}`);

	const outLog = path.join(dir, "out.log");
	const doneMarker = `__SUBSAGENT_DONE_${id}__`;

	const { tabId, paneId } = await createTab(cwd, agent.name);
	await sleep(700);

	const herdrPath = resolveHerdr();
	const command = `${cmdParts.map(shellQuote).join(" ")} 2>&1 | tee ${shellQuote(outLog)}; echo ${shellQuote(doneMarker)} | tee -a ${shellQuote(outLog)}; ${shellQuote(herdrPath)} tab close ${shellQuote(tabId)}`;
	await runInPane(paneId, command);

	const meta: DispatchMeta = {
		id,
		agent: agent.name,
		paneId,
		tabId,
		cwd,
		task,
		startedAt: Date.now(),
		outLog,
		doneMarker,
		scope,
		model,
	};
	fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
	return meta;
}

// ---------------------------------------------------------------------------
// Result reading
// ---------------------------------------------------------------------------

interface ExtractedMessage {
	finalText: string;
	stopReason?: string;
	usage?: any;
	model?: string;
}

function extractMessageEnd(text: string): ExtractedMessage {
	let finalText = "";
	let stopReason: string | undefined;
	let usage: any;
	let model: string | undefined;
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("{")) continue;
		const ev = parseJson(t);
		if (ev?.type !== "message_end") continue;
		const msg = ev.message;
		if (msg?.role !== "assistant") continue;
		for (const part of msg.content ?? []) {
			if (part.type === "text") finalText = part.text;
		}
		if (msg.stopReason) stopReason = msg.stopReason;
		if (msg.usage) usage = msg.usage;
		if (msg.model) model = msg.model;
	}
	return { finalText, stopReason, usage, model };
}

async function readDispatchState(dir: string, meta: DispatchMeta) {
	const outLog = meta.outLog || path.join(dir, "out.log");
	let raw = "";
	try {
		raw = fs.readFileSync(outLog, "utf8");
	} catch {
		/* not written yet */
	}

	const fromLog = extractMessageEnd(raw);

	// The done marker is appended to out.log only after `pi` exits, so the log
	// is the authoritative completion signal. Do not use the pane for done
	// detection: the pane can surface the marker (via tee) before the final
	// message_end is flushed to out.log, causing premature/empty results.
	const done = raw.includes(meta.doneMarker);

	let finalText = fromLog.finalText;
	if (done && !finalText) {
		// Marker is in the log but the final message_end may still be in
		// flight; wait briefly and re-read.
		await sleep(400);
		let raw2 = "";
		try {
			raw2 = fs.readFileSync(outLog, "utf8");
		} catch {
			/* ignore */
		}
		finalText = extractMessageEnd(raw2).finalText;
	}

	const state = done ? "done" : "running";
	let body: string;
	if (done) {
		body = finalText || "(no text output — check the pane)";
	} else {
		body = finalText ? `(still running) latest:\n\n${finalText}` : "(still running)";
	}

	const details = {
		agent: meta.agent,
		paneId: meta.paneId,
		tabId: meta.tabId,
		id: meta.id,
		state,
		stopReason: fromLog.stopReason,
		usage: fromLog.usage,
		model: fromLog.model ?? meta.model,
	};

	return {
		done,
		content: [{ type: "text" as const, text: `[${state}] ${meta.agent} · tab ${meta.tabId ?? meta.paneId}\n\n${body}` }],
		details,
	};
}

async function checkDispatch(target: string, wait: boolean, timeoutMs: number) {
	const baseDir = subagentBaseDir();
	const found = findDispatch(baseDir, target);
	if (!found) {
		const known =
			listDispatchDirs(baseDir)
				.map((d) => readMeta(path.join(baseDir, d))?.id)
				.filter(Boolean)
				.join(", ") || "none";
		return {
			content: [{ type: "text" as const, text: `No subagent dispatch found for "${target}". Known dispatches: ${known}` }],
			details: undefined,
		};
	}

	const deadline = Date.now() + timeoutMs;
	while (true) {
		const res = await readDispatchState(found.dir, found.meta);
		if (res.done || !wait || Date.now() > deadline) return res;
		await sleep(2000);
	}
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Name of the agent to invoke" }),
				task: Type.String({ description: "Task to delegate" }),
				cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
			}),
			{ description: "Tasks to dispatch in parallel" },
		),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the session cwd)" })),
	agentScope: Type.Optional(
		Type.String({ description: 'Agent directories to use: "user" (default), "both", or "project"' }),
	),
});

const CheckParams = Type.Object({
	target: Type.String({ description: "Dispatch name (e.g. scout-m123abc) or Herdr tab id (e.g. w4:t2)" }),
	wait: Type.Optional(Type.Boolean({ description: "Poll until the subagent finishes (default true)", default: true })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait in ms", default: DEFAULT_WAIT_MS })),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Advertise available subagents in the system prompt as a `<subagents>`
	// section, mirroring how skills, prompt templates, and extensions are
	// surfaced. Discovered per-run so project agents appear after trust.
	pi.on("before_agent_start", (event, ctx) => {
		const { agents } = discoverAgents(ctx.cwd, "both");
		const section = formatAgentsForPrompt(agents);
		if (section) {
			event.systemPromptOptions.sections.subagents = section;
		}
	});

	// Visible listing: `/subagents` prints the same set of agents into the
	// transcript so the user can see them, just like prompt templates show up
	// as slash commands and skills as `/skill:name`.
	pi.registerCommand("subagents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			const { agents } = discoverAgents(ctx.cwd, "both");
			pi.sendMessage({
				customType: "subagent-list",
				content: formatAgentsForDisplay(agents),
				display: true,
			});
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Dispatch tasks to specialized subagents that run in the background inside their own Herdr tab,",
			"so they can be watched live without cluttering the current tab.",
			"Modes: single (agent + task) or parallel (tasks array, max 4).",
			"Returns immediately with a dispatch id/tab id; poll results with the subagent_check tool.",
			`Agent definitions live in ${path.join(getAgentDir(), "agents")}.`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope: AgentScope = (params.agentScope as AgentScope) ?? "user";
			const { agents } = discoverAgents(ctx.cwd, scope);

			const hasSingle = Boolean(params.agent && params.task);
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			if (hasSingle === hasTasks) {
				const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Provide exactly one mode (single: agent+task, or parallel: tasks[]). Available agents: ${available}`,
						},
					],
					details: undefined,
				};
			}

			const dispatchDefaults = {
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
				thinkingLevel: ctx.thinkingLevel,
			};

			try {
				if (params.tasks && params.tasks.length > 0) {
					if (params.tasks.length > MAX_PARALLEL_TASKS) {
						return {
							content: [
								{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` },
							],
							details: undefined,
						};
					}

					const metas: DispatchMeta[] = [];
					for (const t of params.tasks) {
						const agent = agents.find((a) => a.name === t.agent);
						if (!agent) {
							const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
							return {
								content: [{ type: "text", text: `Unknown agent "${t.agent}". Available: ${available}` }],
								details: undefined,
							};
						}
						const meta = await dispatchAgent(agent, t.task, t.cwd ?? params.cwd ?? ctx.cwd, scope, dispatchDefaults);
						metas.push(meta);
					}

					const lines = metas.map(
						(m) => `- ${m.agent} → tab ${m.tabId} (check with target "${m.id}")`,
					);
					return {
						content: [
							{
								type: "text",
								text: `Dispatched ${metas.length} subagent(s) to background Herdr tabs:\n\n${lines.join("\n")}`,
							},
						],
						details: { mode: "parallel", dispatches: metas },
					};
				}

				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return {
						content: [{ type: "text", text: `Unknown agent "${params.agent}". Available: ${available}` }],
						details: undefined,
					};
				}

				const meta = await dispatchAgent(agent, params.task!, params.cwd ?? ctx.cwd, scope, dispatchDefaults);
				return {
					content: [
						{
							type: "text",
							text:
								`Dispatched subagent "${meta.agent}" to tab ${meta.tabId} (background).\n` +
								`Watch it in Herdr, then poll with subagent_check { target: "${meta.id}" } or { target: "${meta.tabId}" }.`,
						},
					],
					details: { mode: "single", dispatch: meta },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Subagent dispatch failed: ${(error as Error).message}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "subagent_check",
		label: "Subagent Check",
		description: [
			"Check the status and final output of a background subagent dispatched by the subagent tool.",
			"Pass the dispatch id or the Herdr tab id returned by subagent.",
			"Use wait:true to poll until it finishes.",
		].join(" "),
		parameters: CheckParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return checkDispatch(params.target, params.wait ?? true, params.timeoutMs ?? DEFAULT_WAIT_MS);
		},
	});
}
