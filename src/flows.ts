import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	DiscoveryError,
	fetchModels,
	filterModels,
	normalizeBaseUrl,
	providerBaseUrl,
	type FetchResult,
	type RawModel,
} from "./discovery.ts";
import { toStoredModel } from "./infer.ts";
import { probeModel } from "./probe.ts";
import {
	configPath,
	escapeConfigValue,
	findProvider,
	isValidProviderId,
	loadConfig,
	maskKey,
	saveConfig,
	slugify,
	timestamp,
	type ApiChoice,
	type HubConfig,
	type ResolvedApi,
	type StoredProvider,
} from "./store.ts";

export interface HubRuntime {
	agentDir: string;
	config: HubConfig;
}

const API_OPTIONS: Array<{ label: string; value: ApiChoice }> = [
	{ label: "自动检测（推荐）", value: "auto" },
	{ label: "OpenAI Chat Completions", value: "openai-completions" },
	{ label: "Anthropic Messages", value: "anthropic-messages" },
	{ label: "OpenAI Responses", value: "openai-responses" },
	{ label: "Google Generative AI", value: "google-generative-ai" },
];

const EDIT_API_OPTIONS: Array<{ label: string; value: ResolvedApi }> = API_OPTIONS.filter(
	(option): option is { label: string; value: ResolvedApi } => option.value !== "auto",
);

export function toProviderConfig(provider: StoredProvider): ProviderConfig {
	return {
		name: provider.name,
		baseUrl: provider.baseUrl,
		apiKey: escapeConfigValue(provider.apiKey),
		api: provider.api,
		models: provider.models.map((model) => ({ ...model, cost: { ...model.cost }, input: [...model.input] })),
	};
}

function providerLabel(provider: StoredProvider): string {
	return `${provider.name} [${provider.id}] · ${provider.models.length} 个模型`;
}

function notifyError(ctx: ExtensionCommandContext, message: string): void {
	ctx.ui.notify(message, "error");
}

function normalizeAndValidateBaseUrl(input: string): string | undefined {
	const normalized = normalizeBaseUrl(input);
	if (!normalized) return undefined;
	try {
		const url = new URL(normalized);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (!url.hostname) return undefined;
		return normalized;
	} catch {
		return undefined;
	}
}

function describeProvider(provider: StoredProvider): string {
	const updated = provider.updatedAt ? provider.updatedAt.replace("T", " ").slice(0, 16) : "未知";
	return [
		`名称：${provider.name}`,
		`ID：${provider.id}`,
		`地址：${provider.baseUrl}`,
		`协议：${provider.api}`,
		`密钥：${maskKey(provider.apiKey)}`,
		`模型：${provider.models.length} 个`,
		`筛选：${provider.filter || "（全部）"}`,
		`更新：${updated}`,
	].join("\n");
}

async function selectProvider(
	ctx: ExtensionCommandContext,
	providers: StoredProvider[],
	title: string,
): Promise<StoredProvider | undefined> {
	if (providers.length === 0) {
		ctx.ui.notify("还没有配置任何站点，先用 /providers add 添加。", "warning");
		return undefined;
	}
	if (providers.length === 1) return providers[0];
	const labels = providers.map(providerLabel);
	const choice = await ctx.ui.select(title, [...labels, "取消"]);
	if (!choice || choice === "取消") return undefined;
	return providers.find((provider) => providerLabel(provider) === choice);
}

async function showDetails(ctx: ExtensionCommandContext, provider: StoredProvider): Promise<void> {
	await ctx.ui.editor(`${provider.name} [${provider.id}]`, describeProvider(provider));
}

async function runFetch(
	ctx: ExtensionCommandContext,
	provider: { baseUrl: string; apiKey: string; api: ApiChoice },
): Promise<FetchResult | undefined> {
	ctx.ui.setStatus("provider-hub", `正在获取模型：${provider.baseUrl}`);
	try {
		return await fetchModels({
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey,
			api: provider.api,
			signal: ctx.signal,
		});
	} catch (error) {
		if (error instanceof DiscoveryError) {
			notifyError(ctx, `获取模型失败：${error.message}`);
		} else {
			notifyError(ctx, `获取模型失败：${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	} finally {
		ctx.ui.setStatus("provider-hub", undefined);
	}
}

async function confirmImport(
	ctx: ExtensionCommandContext,
	result: FetchResult,
	selected: RawModel[],
	expression: string,
): Promise<boolean> {
	const preview = selected
		.slice(0, 12)
		.map((model) => `• ${model.id}`)
		.join("\n");
	const extra = selected.length > 12 ? `\n… 另有 ${selected.length - 12} 个` : "";
	const skipped = result.skipped > 0 ? `\n跳过 ${result.skipped} 个非对话模型` : "";
	const filter = expression ? expression : "（全部）";
	return ctx.ui.confirm(
		`导入 ${selected.length} 个模型？`,
		`${preview}${extra}${skipped}\n筛选：${filter}\n接口：${result.api}`,
	);
}

async function chooseFilter(
	ctx: ExtensionCommandContext,
	result: FetchResult,
	initialFilter: string,
): Promise<{ selected: RawModel[]; expression: string } | undefined> {
	let expression = initialFilter;
	for (let attempt = 0; attempt < 3; attempt++) {
		const title =
			attempt === 0
				? `已获取 ${result.models.length} 个模型 · 筛选关键词`
				: "筛选后没有模型，请换个关键词";
		const input = await ctx.ui.input(
			title,
			attempt === 0
				? "留空=全部；可用逗号/空格分隔，例如 claude,gpt；-word 排除"
				: "留空=全部，例如 claude,gpt,-embedding",
		);
		if (input === undefined) return undefined;
		expression = input.trim();
		const selected = filterModels(result.models, expression);
		if (selected.length > 0) return { selected, expression };
		ctx.ui.notify("这个关键词没有匹配到模型。", "warning");
	}
	return undefined;
}

async function refreshProvider(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: HubRuntime,
	provider: StoredProvider,
	options: { askFilter: boolean; skipConfirm?: boolean },
): Promise<void> {
	if (!options.skipConfirm) {
		const confirmed = await ctx.ui.confirm(
			"刷新模型列表",
			`重新请求 ${provider.baseUrl}，成功后替换现有 ${provider.models.length} 个模型。`,
		);
		if (!confirmed) return;
	}

	let expression = provider.filter;
	if (options.askFilter) {
		const input = await ctx.ui.input(
			"筛选关键词",
			provider.filter ? `留空沿用当前：${provider.filter}` : "留空=全部，例如 claude,gpt,-embedding",
		);
		if (input === undefined) return;
		if (input.trim()) expression = input.trim();
	}

	const result = await runFetch(ctx, provider);
	if (!result) return;
	const selected = filterModels(result.models, expression);
	if (selected.length === 0) {
		notifyError(ctx, `筛选后没有模型，未做修改。可用关键词共 ${result.models.length} 个。`);
		return;
	}
	if (!(await confirmImport(ctx, result, selected, expression))) return;

	const previous = {
		models: provider.models,
		filter: provider.filter,
		updatedAt: provider.updatedAt,
		baseUrl: provider.baseUrl,
	};
	provider.models = selected.map(toStoredModel);
	provider.filter = expression;
	provider.updatedAt = timestamp();
	provider.baseUrl = providerBaseUrl(provider.baseUrl, result.url);
	try {
		saveConfig(runtime.agentDir, runtime.config);
	} catch (error) {
		Object.assign(provider, previous);
		notifyError(ctx, `保存配置失败：${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	pi.registerProvider(provider.id, toProviderConfig(provider));
	ctx.ui.notify(`已刷新 ${provider.id}：${provider.models.length} 个模型。`, "info");
}

async function editProvider(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: HubRuntime,
	provider: StoredProvider,
): Promise<void> {
	const baseInput = await ctx.ui.input("Base URL", provider.baseUrl);
	if (baseInput === undefined) return;
	let baseUrl = provider.baseUrl;
	if (baseInput.trim()) {
		const normalized = normalizeAndValidateBaseUrl(baseInput);
		if (!normalized) {
			notifyError(ctx, "Base URL 无效，未做修改。");
			return;
		}
		baseUrl = normalized;
	}

	const keyInput = await ctx.ui.input("API Key（留空保持不变）", maskKey(provider.apiKey));
	if (keyInput === undefined) return;
	const apiKey = keyInput.trim() ? keyInput.trim() : provider.apiKey;

	const labels = EDIT_API_OPTIONS.map((option) =>
		option.value === provider.api ? `${option.label}（当前）` : option.label,
	);
	const choice = await ctx.ui.select("接口协议", labels);
	if (!choice) return;
	const chosen = EDIT_API_OPTIONS.find((option) => choice.startsWith(option.label));
	if (!chosen) return;

	const previous = {
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey,
		api: provider.api,
		updatedAt: provider.updatedAt,
	};
	provider.baseUrl = baseUrl;
	provider.apiKey = apiKey;
	provider.api = chosen.value;
	provider.updatedAt = timestamp();
	try {
		saveConfig(runtime.agentDir, runtime.config);
	} catch (error) {
		Object.assign(provider, previous);
		notifyError(ctx, `保存配置失败：${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	pi.registerProvider(provider.id, toProviderConfig(provider));
	const changed = baseUrl !== previous.baseUrl || apiKey !== previous.apiKey || provider.api !== previous.api;
	ctx.ui.notify(`已更新 ${provider.id}。${changed ? "" : "（没有字段变化）"}`, "info");

	if (changed) {
		const refresh = await ctx.ui.confirm("刷新模型列表", "站点地址、密钥或协议已变化，是否立即重新获取模型列表？");
		if (refresh) await refreshProvider(pi, ctx, runtime, provider, { askFilter: false, skipConfirm: true });
	}
}

async function addProvider(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: HubRuntime,
): Promise<void> {
	const nameInput = await ctx.ui.input("站点名称（显示用）", "例如 My Proxy / sensenova 中转");
	if (nameInput === undefined) return;
	const name = nameInput.trim();
	if (!name) {
		notifyError(ctx, "站点名称不能为空。");
		return;
	}

	let id = slugify(name);
	if (!isValidProviderId(id)) {
		const idInput = await ctx.ui.input("Provider ID（英文/数字/点/下划线/短横线）", "例如 my-proxy");
		if (idInput === undefined) return;
		id = slugify(idInput);
	}
	if (!isValidProviderId(id)) {
		notifyError(ctx, "无法生成合法的 Provider ID，请用英文重试。");
		return;
	}

	if (findProvider(runtime.config, id)) {
		notifyError(ctx, `Provider「${id}」已存在。请用 /providers edit ${id} 修改，或换一个名称。`);
		return;
	}
	if (ctx.modelRegistry.getProvider(id)) {
		const overwrite = await ctx.ui.confirm(
			"Provider ID 冲突",
			`「${id}」与现有 provider（内置站点或 models.json）同名，继续会覆盖它在当前会话中的模型。是否继续？`,
		);
		if (!overwrite) return;
	}

	const baseInput = await ctx.ui.input("Base URL", "https://api.example.com/v1");
	if (baseInput === undefined) return;
	const baseUrl = normalizeAndValidateBaseUrl(baseInput);
	if (!baseUrl) {
		notifyError(ctx, "Base URL 无效，例如 https://api.example.com/v1");
		return;
	}

	const keyInput = await ctx.ui.input("API Key（仅保存在本机 provider-hub.json）", "sk-...");
	if (keyInput === undefined) return;
	const apiKey = keyInput.trim();
	if (!apiKey) {
		notifyError(ctx, "API Key 不能为空。");
		return;
	}

	const apiLabel = await ctx.ui.select("接口协议", API_OPTIONS.map((option) => option.label));
	if (!apiLabel) return;
	const apiChoice = API_OPTIONS.find((option) => option.label === apiLabel)?.value;
	if (!apiChoice) return;

	const result = await runFetch(ctx, { baseUrl, apiKey, api: apiChoice });
	if (!result) return;

	const chosen = await chooseFilter(ctx, result, "");
	if (!chosen) return;
	if (!(await confirmImport(ctx, result, chosen.selected, chosen.expression))) return;

	const provider: StoredProvider = {
		id,
		name,
		baseUrl: providerBaseUrl(baseUrl, result.url),
		apiKey,
		api: result.api,
		filter: chosen.expression,
		models: chosen.selected.map(toStoredModel),
		createdAt: timestamp(),
		updatedAt: timestamp(),
	};
	runtime.config.providers.push(provider);
	try {
		saveConfig(runtime.agentDir, runtime.config);
	} catch (error) {
		runtime.config.providers.pop();
		notifyError(ctx, `保存配置失败：${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	pi.registerProvider(provider.id, toProviderConfig(provider));
	ctx.ui.notify(
		`已添加 ${provider.name}（${provider.id}，${provider.models.length} 个模型）。打开 /model 选择模型。`,
		"info",
	);
}

async function removeProvider(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: HubRuntime,
	provider: StoredProvider,
): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		"删除站点",
		`确定删除 ${provider.name} [${provider.id}] 及其 ${provider.models.length} 个模型？\n（不会修改 models.json）`,
	);
	if (!confirmed) return;
	const next: HubConfig = {
		version: 1,
		providers: runtime.config.providers.filter((item) => item.id !== provider.id),
	};
	try {
		saveConfig(runtime.agentDir, next);
	} catch (error) {
		notifyError(ctx, `保存配置失败：${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	runtime.config = next;
	pi.unregisterProvider(provider.id);
	ctx.ui.notify(`已删除 ${provider.name} [${provider.id}]。`, "info");
}

async function testConnection(
	ctx: ExtensionCommandContext,
	provider: StoredProvider,
): Promise<void> {
	if (provider.models.length === 0) {
		ctx.ui.notify("这个站点还没有模型，先刷新模型列表再测试。", "warning");
		return;
	}
	let model = provider.models[0]!;
	if (provider.models.length > 1) {
		const choice = await ctx.ui.select(
			`选择要测试的模型（${provider.name}）`,
			[...provider.models.map((item) => item.id), "取消"],
		);
		if (!choice || choice === "取消") return;
		const found = provider.models.find((item) => item.id === choice);
		if (!found) return;
		model = found;
	}
	const confirmed = await ctx.ui.confirm(
		"测试连接",
		`向 ${provider.baseUrl} 发送一条最小请求（${model.id}，最多 16 tokens）。`,
	);
	if (!confirmed) return;

	ctx.ui.setStatus("provider-hub", `正在测试 ${provider.id}/${model.id}…`);
	try {
		const result = await probeModel({
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey,
			api: provider.api,
			model: model.id,
			signal: ctx.signal,
		});
		if (!result.ok) {
			notifyError(ctx, `连接失败（${provider.id}/${model.id}）：${result.error}`);
			return;
		}
		const reply = result.reply
			? result.reply.replace(/\s+/g, " ").slice(0, 80)
			: "（请求成功，回复为空）";
		ctx.ui.notify(`连接成功：${provider.name} · ${model.id} · ${result.latencyMs}ms · ${reply}`, "info");
	} finally {
		ctx.ui.setStatus("provider-hub", undefined);
	}
}

async function showProviderMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: HubRuntime,
	provider: StoredProvider,
): Promise<void> {
	while (true) {
		const current = findProvider(runtime.config, provider.id);
		if (!current) return;
		const choice = await ctx.ui.select(`${current.name} [${current.id}]`, [
			"刷新模型列表",
			"测试连接",
			"查看模型",
			"编辑设置",
			"查看详情",
			"删除站点",
			"返回",
		]);
		if (!choice || choice === "返回") return;
		if (choice === "刷新模型列表") {
			await refreshProvider(pi, ctx, runtime, current, { askFilter: true });
			continue;
		}
		if (choice === "测试连接") {
			await testConnection(ctx, current);
			continue;
		}
		if (choice === "查看模型") {
			if (current.models.length === 0) {
				ctx.ui.notify("这个站点还没有模型，先刷新模型列表。", "warning");
				continue;
			}
			await ctx.ui.select(
				`${current.name} 模型（共 ${current.models.length} 个）`,
				[...current.models.map((model) => model.id), "返回"],
			);
			continue;
		}
		if (choice === "编辑设置") {
			await editProvider(pi, ctx, runtime, current);
			continue;
		}
		if (choice === "查看详情") {
			await showDetails(ctx, current);
			continue;
		}
		if (choice === "删除站点") {
			await removeProvider(pi, ctx, runtime, current);
			return;
		}
	}
}

async function showMainMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: HubRuntime,
): Promise<void> {
	while (true) {
		const providers = runtime.config.providers;
		const options = ["＋ 添加新站点", ...providers.map(providerLabel), "关闭"];
		const choice = await ctx.ui.select("Provider Hub · 选择站点", options);
		if (!choice || choice === "关闭") return;
		if (choice === "＋ 添加新站点") {
			await addProvider(pi, ctx, runtime);
			continue;
		}
		const provider = providers.find((item) => providerLabel(item) === choice);
		if (!provider) continue;
		await showProviderMenu(pi, ctx, runtime, provider);
	}
}

async function showList(ctx: ExtensionCommandContext, runtime: HubRuntime): Promise<void> {
	const providers = runtime.config.providers;
	if (providers.length === 0) {
		ctx.ui.notify("还没有配置任何站点，先用 /providers add 添加。", "warning");
		return;
	}
	const labels = providers.map(
		(provider) => `${provider.id} · ${provider.name} · ${provider.models.length} 个模型 · ${provider.api}`,
	);
	const choice = await ctx.ui.select(`已配置 ${providers.length} 个站点（选择查看详情）`, [...labels, "关闭"]);
	if (!choice || choice === "关闭") return;
	const index = labels.indexOf(choice);
	if (index >= 0) await showDetails(ctx, providers[index]!);
}

function findProviderArg(runtime: HubRuntime, id: string): StoredProvider | undefined {
	if (!id) return undefined;
	return findProvider(runtime.config, id);
}

function usage(): string {
	return [
		"用法：/providers [add|list|test|refresh|edit|remove|path]",
		"  add            添加站点",
		"  list           查看站点详情",
		"  test [id]      发送一条最小请求，检查模型是否可用",
		"  refresh [id]   刷新模型列表",
		"  edit [id]      修改 URL / Key / 协议",
		"  remove <id>    删除站点",
		"  path           显示配置文件路径",
	].join("\n");
}

export async function handleProvidersCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: HubRuntime,
	args: string,
): Promise<void> {
	const loaded = loadConfig(runtime.agentDir);
	runtime.config = loaded.config;
	if (loaded.error) {
		const proceed = await ctx.ui.confirm(
			"配置文件读取失败",
			`${loaded.error}\n继续操作并在保存时覆盖该文件？`,
		);
		if (!proceed) return;
	}

	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const sub = tokens[0]?.toLowerCase() ?? "";
	const rest = tokens.slice(1);
	const idArg = rest[0] ?? "";

	if (!sub) {
		await showMainMenu(pi, ctx, runtime);
		return;
	}

	switch (sub) {
		case "add": {
			await addProvider(pi, ctx, runtime);
			return;
		}
		case "list":
		case "ls": {
			await showList(ctx, runtime);
			return;
		}
		case "path": {
			ctx.ui.notify(`配置文件：${configPath(runtime.agentDir)}`, "info");
			return;
		}
		case "test": {
			const provider =
				findProviderArg(runtime, idArg) ??
				(await selectProvider(ctx, runtime.config.providers, "选择要测试的站点"));
			if (provider) await testConnection(ctx, provider);
			return;
		}
		case "refresh": {
			const provider =
				findProviderArg(runtime, idArg) ??
				(await selectProvider(ctx, runtime.config.providers, "选择要刷新的站点"));
			if (provider) await refreshProvider(pi, ctx, runtime, provider, { askFilter: true });
			return;
		}
		case "edit": {
			const provider =
				findProviderArg(runtime, idArg) ??
				(await selectProvider(ctx, runtime.config.providers, "选择要编辑的站点"));
			if (provider) await editProvider(pi, ctx, runtime, provider);
			return;
		}
		case "remove":
		case "rm": {
			const provider =
				findProviderArg(runtime, idArg) ??
				(await selectProvider(ctx, runtime.config.providers, "选择要删除的站点"));
			if (provider) await removeProvider(pi, ctx, runtime, provider);
			return;
		}
		default: {
			ctx.ui.notify(usage(), "warning");
		}
	}
}

export function completeArguments(
	runtime: HubRuntime,
	prefix: string,
): Array<{ value: string; label: string; description?: string }> {
	const trimmed = prefix.trimStart();
	if (trimmed.includes(" ")) {
		const [sub, rest] = trimmed.split(/\s+/, 2);
		const command = sub?.toLowerCase() ?? "";
		if (["refresh", "test", "edit", "remove", "rm"].includes(command)) {
			const current = (rest ?? "").trim();
			return runtime.config.providers
				.filter((provider) => provider.id.startsWith(current))
				.map((provider) => ({
					value: `${sub} ${provider.id}`,
					label: provider.id,
					description: `${provider.name} · ${provider.models.length} 个模型`,
				}));
		}
		return [];
	}
	const commands = [
		{ value: "add", label: "add", description: "添加站点" },
		{ value: "list", label: "list", description: "查看站点详情" },
		{ value: "test", label: "test", description: "测试连接" },
		{ value: "refresh", label: "refresh", description: "刷新模型列表" },
		{ value: "edit", label: "edit", description: "修改 URL / Key / 协议" },
		{ value: "remove", label: "remove", description: "删除站点" },
		{ value: "path", label: "path", description: "显示配置文件路径" },
	];
	return commands.filter((command) => command.value.startsWith(trimmed.toLowerCase()));
}