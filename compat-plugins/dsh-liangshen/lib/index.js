import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import z from "schemastery";
import { homedir } from "node:os";
import { isAbsolute as isAbsolute$1, join as join$1 } from "node:path/posix";
//#region src/dsh-home.ts
/**
* DSH_HOME resolution shared by the plugin family's Host halves: the
* environment override wins, the platform home fallback follows. Mirrors
* what dsh-pet and dsh-liangshen each used to implement locally.
*/
/** Expand a leading ~ (or ~user) in a path, platform-style. */
function expandHome(path, home = homedir()) {
	const j = home.startsWith("/") ? join$1 : join;
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return j(home, path.slice(2));
	return path;
}
/**
* Resolve the DSH home directory.
* @param env - process environment to read DSH_HOME from.
* @param home - platform home directory fallback (test seam).
* @returns the absolute DSH home path.
*/
function resolveDshHome(env = process.env, home = homedir()) {
	const isPosix = home.startsWith("/");
	const j = isPosix ? join$1 : join;
	const isAbs = isPosix ? isAbsolute$1 : isAbsolute;
	const raw = env.DSH_HOME;
	if (raw !== void 0 && raw.trim() !== "") {
		const expanded = expandHome(raw.trim(), home);
		return isAbs(expanded) ? expanded : j(process.cwd(), expanded);
	}
	return j(home, ".dsh");
}
/** Resolve the DSH home directory from the live environment. */
function dshHome() {
	return resolveDshHome();
}
//#endregion
//#region src/schema.ts
/**
* Structural validation for a bundled `agent.cordis.yml`.
*
* Deliberately dependency-free: it parses only the flat row metadata the sync
* and the dsh agent-presets loader rely on. Every top-level row is written as
* `- id: <id>` at column zero, with the `name`/`group`/`disabled` keys at two
* spaces of indentation. Nested `config:` and `isolate:` bodies are opaque to
* this validator — the dsh loader checks their semantics.
*
* Returns the list of problems found; an empty array means the document is
* structurally valid.
*/
/** A top-level row opener: `- id: <id>` (id may be blank for diagnostics). */
const ROW_RE = /^-\s+id:\s*(.*)$/;
/** Any top-level list item, for ids missing from a row opener. */
const ITEM_RE = /^-\s/;
/** A two-space-indented flat metadata key: `  name: <value>`. */
const META_RE = /^ {2}([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;
/** The only `name` forms the dsh agent-presets loader mounts from a row. */
const NAME_PREFIX_RE = /^(\.\/|@|cordis:)/;
/** Strip one pair of surrounding single or double quotes from a scalar. */
function unquote(value) {
	if (value.length >= 2) {
		const first = value[0];
		if ((first === "'" || first === "\"") && value.endsWith(first)) return value.slice(1, -1);
	}
	return value;
}
/**
* Validate the structural contract of an `agent.cordis.yml` document.
* @param text - the raw YAML document text.
* @returns a list of human-readable problems; empty means valid.
*/
function validateAgentCordis(text) {
	const errors = [];
	const normalized = text.replace(/\r\n/g, "\n");
	if (normalized.trim() === "") return ["document is empty"];
	const seenIds = /* @__PURE__ */ new Set();
	const current = {
		id: null,
		name: null,
		group: null
	};
	const closeRow = () => {
		if (current.id === null) return;
		if (current.name === null) errors.push(`row "${current.id}": missing "name" key`);
		else if (!NAME_PREFIX_RE.test(current.name)) errors.push(`row "${current.id}": name "${current.name}" must start with "./", "@" or "cordis:"`);
		if (current.group === "true" && current.name !== "cordis:group") errors.push(`row "${current.id}": "group: true" requires name "cordis:group"`);
		current.name = null;
		current.group = null;
		current.id = null;
	};
	const lines = normalized.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const lineNo = index + 1;
		const line = lines[index];
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const row = ROW_RE.exec(line);
		if (row !== null) {
			closeRow();
			const id = row[1].trim();
			if (id === "") {
				errors.push(`line ${lineNo}: empty row id`);
				current.id = null;
			} else {
				if (seenIds.has(id)) errors.push(`line ${lineNo}: duplicate row id "${id}"`);
				seenIds.add(id);
				current.id = id;
			}
			current.name = null;
			current.group = null;
			continue;
		}
		if (current.id === null) {
			if (ITEM_RE.test(line)) errors.push(`line ${lineNo}: list item does not declare an "id:"`);
			else if (/^\S/.test(line)) errors.push(`line ${lineNo}: content outside a "- id:" row`);
			continue;
		}
		const meta = META_RE.exec(line);
		if (meta !== null) {
			const value = unquote(meta[2].trim());
			if (meta[1] === "name") current.name = value;
			else if (meta[1] === "group") current.group = value;
			continue;
		}
		if (/^ {2}/.test(line)) continue;
		errors.push(`line ${lineNo}: unexpected content in row "${current.id}"`);
	}
	closeRow();
	return errors;
}
//#endregion
//#region src/sync.ts
/**
* Sync every preset directory under `sourceRoot` into `targetRoot` — the
* dsh agent-presets discovery root (harness-home `.agent-presets`).
*
* A preset is a directory holding `agent.cordis.yml`; the directory name is
* the preset id. Copy is per-directory and idempotent: a preset whose target
* tree is byte-identical to the source tree is skipped, otherwise the source
* tree is copied and any target files the source does not contain are removed.
* Directories the plugin does not own (other presets the user authored) are
* never touched.
*
* After a preset is synced its `agent.cordis.yml` is validated against the
* structural preset schema; a validation failure is reported through the
* run's `failed` entries instead of being a warn-only side effect, so callers
* can observe (and surface) a broken preset rather than silently shipping it.
*/
/**
* Clock/coarse-grain tolerance for the mtime fast path. When a source and a
* target file share a size and a near-identical mtime we still fall through to
* a byte comparison; a mtime gap beyond this simply proves the pair cannot be
* byte-identical, so we skip the read.
*/
const MTIME_TOLERANCE_MS = 1e3;
function filesUnder(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else out.push(path);
		}
	};
	walk(root);
	return out;
}
/**
* File identity is bytes. Size and mtime are only a fast negative check: a
* size mismatch or a mtime gap beyond the tolerance proves the pair cannot be
* byte-identical without reading both, but an equal size and close mtime still
* fall through to a byte comparison so content differences are never missed.
*/
function sameFile(a, b) {
	const sourceStat = statSync(a);
	const targetStat = statSync(b);
	if (sourceStat.size !== targetStat.size) return false;
	if (Math.abs(sourceStat.mtimeMs - targetStat.mtimeMs) > MTIME_TOLERANCE_MS) return false;
	return readFileSync(a).equals(readFileSync(b));
}
/**
* Remove files not in `keep` (relative paths), then remove only the
* directories those removals left empty — still strictly inside `root`, so
* sibling presets are never touched.
*/
function pruneExtras(root, keep) {
	const parents = /* @__PURE__ */ new Set();
	for (const file of filesUnder(root)) if (!keep.has(relative(root, file))) {
		parents.add(dirname(file));
		rmSync(file, { force: true });
	}
	for (const start of parents) {
		let dir = start;
		while (dir !== void 0 && relative(root, dir) !== "") if (existsSync(dir) && readdirSync(dir).length === 0) {
			rmSync(dir, {
				recursive: true,
				force: true
			});
			dir = dirname(dir);
		} else dir = void 0;
	}
}
/** Validate the synced preset's `agent.cordis.yml` artifact on disk. */
function validatePresetAgentFile(presetDir) {
	const agent = join(presetDir, "agent.cordis.yml");
	if (!existsSync(agent)) return ["agent.cordis.yml is missing from the preset tree"];
	return validateAgentCordis(readFileSync(agent, "utf8"));
}
/**
* Copy the whole tree under `sourceDir` into `targetDir`, creating the target
* directory as needed. Intentionally not `fs.cpSync` (recursive): on Node 22
* for Windows, `fs.cpSync` with `recursive: true` crashes the process with a
* fatal error (STATUS_STACK_BUFFER_OVERRUN / 0xC0000409, no JS exception is
* thrown) whenever the source path contains non-ASCII characters such as a
* CJK home directory (nodejs/node#54476, regression from nodejs/node#53614).
* Since `engines` supports Node ^22.19.0, this must work on Node 22, so the
* copy is done with the same per-entry primitives the rest of the module
* already uses. Source mtimes are preserved to keep the `preserveTimestamps`
* contract of the previous `cpSync` call.
*/
function copyTreeSync(sourceDir, targetDir) {
	mkdirSync(targetDir, { recursive: true });
	for (const entry of readdirSync(sourceDir)) {
		const source = join(sourceDir, entry);
		const target = join(targetDir, entry);
		const stat = statSync(source);
		if (stat.isDirectory()) copyTreeSync(source, target);
		else {
			copyFileSync(source, target);
			utimesSync(target, stat.atime, stat.mtime);
		}
	}
}
/**
* Replace one indented `key: <value>` line inside the block of `- id: <row>`.
*
* Strings render single-quoted and booleans render bare: YAML reads an unquoted
* `false` as a boolean, while `'false'` would be a truthy string and silently
* invert the switch.
*/
function setRowValue(text, rowId, key, value) {
	if (value === void 0) return text;
	const literal = typeof value === "boolean" ? String(value) : `'${value}'`;
	const rowStart = text.indexOf(`- id: ${rowId}
`);
	if (rowStart < 0) return text;
	const afterRow = rowStart + `- id: ${rowId}
`.length;
	const rest = text.slice(afterRow);
	const boundary = rest.search(/^\S/m);
	const body = boundary < 0 ? rest : rest.slice(0, boundary);
	const tail = boundary < 0 ? "" : rest.slice(boundary);
	const pattern = new RegExp(`^(\\s*)${key}:\\s*.*$`, "m");
	const rewritten = pattern.test(body) ? body.replace(pattern, `$1${key}: ${literal}`) : body;
	return text.slice(0, afterRow) + rewritten + tail;
}
/**
* Render `agent.cordis.yml` with the settings overrides applied.
*
* Rows are matched by their `- id:` marker, so the transform does not depend on
* line numbers or on the values the shipped file happens to carry. A row or key
* the source does not contain is left alone rather than invented: the overlay
* narrows the shipped configuration, it never adds a mount the preset did not
* have.
* @param text - the bundled preset composition.
* @param overrides - the operator's settings-surface choices.
* @returns the composition to write into the synced tree.
*/
function renderPresetOverrides(text, overrides) {
	let out = text;
	out = setRowValue(out, "tool-catalog", "presentation", overrides.presentation);
	return out;
}
/** Copy `sourceRoot/<id>` into `targetRoot/<id>`, idempotently. */
function syncOnePreset(sourceDir, targetDir, overrides = {}) {
	const sourceFiles = filesUnder(sourceDir);
	const sourceSet = new Set(sourceFiles.map((file) => relative(sourceDir, file)));
	if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) rmSync(targetDir, {
		recursive: true,
		force: true
	});
	const applyOverrides = () => {
		const agentFile = join(targetDir, "agent.cordis.yml");
		if (!existsSync(agentFile)) return;
		const rendered = renderPresetOverrides(readFileSync(agentFile, "utf8"), overrides);
		if (rendered !== readFileSync(agentFile, "utf8")) writeFileSync(agentFile, rendered);
	};
	if (!existsSync(targetDir)) {
		copyTreeSync(sourceDir, targetDir);
		pruneExtras(targetDir, sourceSet);
		applyOverrides();
		return "synced";
	}
	const agentEntry = join(sourceDir, "agent.cordis.yml");
	const expectedAgent = existsSync(agentEntry) ? Buffer.from(renderPresetOverrides(readFileSync(agentEntry, "utf8"), overrides)) : void 0;
	let dirty = false;
	for (const file of sourceFiles) {
		const dest = join(targetDir, relative(sourceDir, file));
		if (!existsSync(dest)) {
			dirty = true;
			break;
		}
		if (file === agentEntry) {
			if (expectedAgent === void 0 || !expectedAgent.equals(readFileSync(dest))) {
				dirty = true;
				break;
			}
			continue;
		}
		if (!sameFile(file, dest)) {
			dirty = true;
			break;
		}
	}
	if (!dirty) {
		for (const file of filesUnder(targetDir)) if (!sourceSet.has(relative(targetDir, file))) {
			dirty = true;
			break;
		}
	}
	if (!dirty) {
		const before = readFileSync(join(targetDir, "agent.cordis.yml"), "utf8");
		const after = renderPresetOverrides(before, overrides);
		if (after !== before) {
			writeFileSync(join(targetDir, "agent.cordis.yml"), after);
			return "synced";
		}
		return "current";
	}
	pruneExtras(targetDir, sourceSet);
	copyTreeSync(sourceDir, targetDir);
	pruneExtras(targetDir, sourceSet);
	applyOverrides();
	return "synced";
}
/**
* Sync every preset under `sourceRoot` into `targetRoot`, then remove
* target directories named in `retire` that the bundle no longer ships —
* preset ids the plugin once owned and later dropped. Only those exact ids
* are removed; every other target directory is left untouched.
*
* Each synced (or already-current) preset is validated against the structural
* `agent.cordis.yml` schema; a validation failure lands in `failed` so the
* caller can surface a broken preset as a first-class result instead of a
* warn-only log line.
* @param sourceRoot - plugin-owned preset tree (bundled in the package).
* @param targetRoot - dsh agent-presets discovery root (e.g. <home>/.dsh/.agent-presets).
* @param retire - previously bundled preset ids to remove when absent from the source.
*/
function syncPresetTrees(sourceRoot, targetRoot, retire = [], overrides = {}) {
	const result = {
		synced: [],
		current: [],
		failed: [],
		retired: []
	};
	mkdirSync(targetRoot, { recursive: true });
	if (existsSync(sourceRoot)) for (const entry of readdirSync(sourceRoot)) {
		const source = join(sourceRoot, entry);
		if (!statSync(source).isDirectory()) continue;
		const id = basename(source);
		const targetDir = join(targetRoot, id);
		let outcome;
		try {
			outcome = syncOnePreset(source, targetDir, overrides);
		} catch (error) {
			result.failed.push({
				id,
				error: error instanceof Error ? error.message : String(error)
			});
			continue;
		}
		try {
			const problems = validatePresetAgentFile(targetDir);
			if (problems.length > 0) result.failed.push({
				id,
				error: `agent.cordis.yml failed validation: ${problems.join("; ")}`
			});
			else if (outcome === "synced") result.synced.push(id);
			else result.current.push(id);
		} catch (error) {
			result.failed.push({
				id,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
	for (const id of retire) {
		if (existsSync(join(sourceRoot, id))) continue;
		const stale = join(targetRoot, id);
		if (existsSync(stale) && statSync(stale).isDirectory()) {
			rmSync(stale, {
				recursive: true,
				force: true
			});
			result.retired.push(id);
		}
	}
	return result;
}
//#endregion
//#region src/mount-once.ts
/**
* Host single-instance guard shared by the plugin family. The family bundle
* (dsh-web-all / dsh-skins) namespaces every child row id (web-ui-*), so
* the loader accepts a standalone install of the same package side by side;
* without this guard the second instance would still re-register the same
* webserver routes, tools, settings namespaces, and system-prompt sections
* and fail the boot. mountOnce makes the second host apply a no-op for the
* lifetime of the first instance (the browser half is already deduped by
* package name in the client module host).
*
* The registry rides a global symbol so two module instances of the same
* package (npm copy vs repository link) still share one verdict. cordis
* `ctx.effect` runs its callback immediately and treats the callback's
* return value as the fiber disposer, so the unmarker is returned, not run.
*/
const MOUNTED = Symbol.for("dsh-web.mounted-plugins");
function mountedSet() {
	const registry = globalThis;
	return registry[MOUNTED] ??= /* @__PURE__ */ new Set();
}
/**
* Wrap a cordis plugin apply so the package runs at most once per process.
* The first mount registers normally and unmarks when its fiber disposes;
* any later mount of the same package name is a no-op.
* @param packageName - npm package identity shared by every install source.
* @param fn - the original plugin apply.
* @returns an apply of the same shape.
*/
function mountOnce(packageName, fn) {
	return ((...args) => {
		const mounted = mountedSet();
		if (mounted.has(packageName)) return;
		mounted.add(packageName);
		args[0]?.effect?.(() => () => {
			mounted.delete(packageName);
		});
		return fn(...args);
	});
}
//#endregion
//#region src/index.ts
/**
* dsh-liangshen — LiangShen (梁神) agent preset plugin.
*
* Host half only: on startup it syncs the bundled `presets/` tree into the
* harness-home agent-presets root (`~/.dsh/.agent-presets`), making the
* LiangShen preset selectable for new sessions without copying files by hand.
* The capability announcement is a system-prompt section that ships OFF by
* default (`announceToAgent: false`) and can be enabled in the web settings
* surface (plugin config) or the profile patch. No browser half, no routes,
* no agent tools — the preset itself provides the tools.
*
* The preset combines a minimal persona with a lifetime-declared tool
* presentation: the system prompt keeps a minimal persona with standing
* working discipline and workspace instructions, and the wire runs the SDK's
* 'ptc' presentation by default — the wire collapses to the `run_code`
* transport and every other tool is reached through the generated SDK,
* declared once per session instead of staged across a turn boundary
* ('native' and 'both' are one-line opt-outs). High-fan-out tool families
* (default `mcp__*`) stay paged out of the executed surface through the
* host's scoped tool restriction until the preset's own `tool_activate` tool
* loads their namespace (LRU cap three), with the activation state replayed
* from the durable session event stream. The tool catalog — listing exactly
* the tools the request carries plus the paged-out namespace summaries — and a
* one-line working-context projection travel as durable user messages,
* republished only on change.
*/
/** Stable cordis plugin name. */
const name = "liangshen";
/** Settings namespace of the plugin (the web settings surface edits it). */
const LIANGSHEN_SETTINGS_NAMESPACE = "dsh-liangshen";
/** Prompt assembly must exist before the announcement section can register. */
const inject = ["systemPrompt"];
/** The wire presentations the preset's tool catalog accepts. */
const PRESENTATION_OPTIONS = [
	"ptc",
	"native",
	"both"
];
const Config = z.object({
	enabled: z.boolean().default(true),
	announceToAgent: z.boolean().default(false),
	presentation: z.union([...PRESENTATION_OPTIONS]).default("ptc")
});
/** Schema defaults, re-read for hand-built test contexts. */
const DEFAULT_ANNOUNCE = false;
const DEFAULT_PRESENTATION = "ptc";
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150;
/** Model-facing announcement: plugin presence, principle, and limits. */
const LIANGSHEN_GUIDANCE = "本机已安装 dsh-liangshen 插件（梁神模式 agent preset）：新建会话的预设选择器中可选「梁神模式」。原理：系统提示词保持极简 persona（minimal-prompt 放行该段与 plan 模式的 plan:policy），persona 内置本模式工作纪律（反思熔断——同一假设推演不超过两轮、缺事实立即闭合思考并调用原生检测工具；行动导向——思考只决定下一步具体操作、不在思考中预演代码实现；并发探索——多处独立检查或搜索在单轮内并发发射多个工具调用；YAGNI/PDCA——单步验证单一假设、不写冗余注释），并在组装时追加工作区目录行 Your working directory is <cwd>.。AGENTS.md 工作区指令默认交还宿主自身的 agent-instructions 行，以 user 角色注入，本插件不追加任何系统提示词段、也不改动 pre-step 的消息批次；可选 instructionSource: system-prompt 才由本插件在组装时读取 AGENTS.md 链并追加 workspace-instructions 段（65536 字节预算，每次组装重读）。wire 呈现由 tool-catalog 按会话一次声明，取值 'ptc'（默认：wire 收拢为唯一的 run_code，其余工具经生成的 SDK 触达）、'native'（组装出的原生清单）或 'both'（两者同驻），并可在插件设置界面切换（同步 preset 时写入 tool-catalog 行）；未挂载 code runtime 时不做声明，会话运行原生工具面。温和工具分页：匹配 pagedToolPatterns（默认 mcp__*）的工具在激活前被作用域级工具限制移出可见面（既不在 wire，也不在生成的 SDK 声明中），目录消息列出常驻工具签名与未激活命名空间摘要，调用 tool_activate({ namespace }) 按需激活（LRU 上限 3 个活跃命名空间，驱逐最久未用）；激活状态从持久会话事件流重建，resume/压缩后自然恢复。working-context 插件在 pre-step 注入单行 [Working Context: ...] 就近状态投射（plan 模式、活跃命名空间、进行中 todo 标题，全部从事件流折叠，读不到则省略，全部为空则不注入）。历史工具结果修剪为 4096 字符阈值（head 1500 / tail 500）。文件操作受宿主沙箱约束；shell 在每个平台都挂上游标准 Stdio 栈（POSIX 为 bash，Windows 为 pwsh），带简短描述标题卡片与确定性退出码。真实推理探针通过不等于模式集成通过，更不等于统计效果提升。preset 文件由插件维护于 ~/.dsh/.agent-presets，升级插件时自动更新；默认预设由用户自行选择。用户提到「梁神模式 / 锚定模式 / anchored standard」时即指本插件，请据此协作。";
/** Absolute path of the bundled preset tree inside this package. */
function bundledPresetsRoot() {
	return fileURLToPath(new URL("../presets/", import.meta.url));
}
/**
* Mount the plugin: sync bundled presets into the harness-home agent-presets
* root, register the settings namespace (enabled / announceToAgent, live),
* and announce through a system-prompt section when announceToAgent is on
* (off by default).
* @param ctx - host plugin context carrying systemPrompt.
* @param config - resolved plugin config (schema defaults applied by the loader).
*/
const apply = mountOnce("@linxin666/dsh-liangshen", applyImpl);
function applyImpl(ctx, config) {
	let current = () => config ?? {};
	const resolve = () => ({
		announceToAgent: current().announceToAgent ?? DEFAULT_ANNOUNCE,
		enabled: current().enabled ?? true,
		presentation: current().presentation ?? DEFAULT_PRESENTATION
	});
	const sync = () => {
		const targetRoot = join(dshHome(), ".agent-presets");
		try {
			mkdirSync(targetRoot, { recursive: true });
			const settings = resolve();
			const result = syncPresetTrees(bundledPresetsRoot(), targetRoot, ["liangshen-exact"], { presentation: settings.presentation });
			for (const { id, error } of result.failed) ctx.logger?.warn?.(`dsh-liangshen: preset ${id} sync failed: ${error}`);
			if (result.synced.length > 0) ctx.logger?.info?.(`dsh-liangshen: presets synced into ${targetRoot}: ${result.synced.join(", ")}`);
			if (result.retired.length > 0) ctx.logger?.info?.(`dsh-liangshen: retired stale presets from ${targetRoot}: ${result.retired.join(", ")}`);
		} catch (error) {
			ctx.logger?.warn?.(`dsh-liangshen: preset sync failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	let disposeSection;
	const refresh = () => {
		disposeSection?.();
		disposeSection = void 0;
		if (!resolve().enabled) return;
		sync();
		if (resolve().announceToAgent) disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-liangshen",
			order: SECTION_ORDER,
			text: LIANGSHEN_GUIDANCE
		});
	};
	ctx.inject(["settings"], (settingsCtx) => {
		try {
			if (typeof settingsCtx.settings?.installSection === "function") settingsCtx.settings.installSection(ctx, LIANGSHEN_SETTINGS_NAMESPACE, Config, config ?? {}, {
				setSource: (source) => {
					current = source;
					refresh();
				},
				onChange: refresh
			});
			else if (typeof settingsCtx.settings?.register === "function") {
				const scope = settingsCtx.settings.register(LIANGSHEN_SETTINGS_NAMESPACE, Config, { base: config ?? {} });
				current = () => scope?.get?.() ?? config ?? {};
				scope?.watch?.(() => {
					refresh();
				});
				refresh();
			}
		} catch {}
	});
	refresh();
	ctx.effect(() => () => {
		disposeSection?.();
		disposeSection = void 0;
	}, "dsh-liangshen: announcement");
}
//#endregion
export { Config, LIANGSHEN_GUIDANCE, LIANGSHEN_SETTINGS_NAMESPACE, PRESENTATION_OPTIONS, apply, bundledPresetsRoot, dshHome, inject, name };
