import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeArguments, handleProvidersCommand, toProviderConfig, type HubRuntime } from "./src/flows.ts";
import { loadConfig } from "./src/store.ts";

/**
 * pi-provider-hub
 *
 * Keeps every site you use in ~/.pi/agent/provider-hub.json, registers the
 * stored providers (with their previously discovered models) at startup and
 * offers /providers to add, refresh, test, edit or remove them at runtime.
 */
export default function providerHub(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const loaded = loadConfig(agentDir);
	const runtime: HubRuntime = { agentDir, config: loaded.config };

	// Register stored providers without touching the network: models come from
	// the last successful discovery run, so startup stays fast and offline-safe.
	for (const provider of runtime.config.providers) {
		if (provider.models.length === 0) continue;
		try {
			pi.registerProvider(provider.id, toProviderConfig(provider));
		} catch (error) {
			console.error(
				`[provider-hub] 无法注册 ${provider.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	pi.registerCommand("providers", {
		description: "管理多站点模型来源（添加 / 刷新 / 测试 / 编辑 / 删除）",
		getArgumentCompletions: (prefix) => completeArguments(runtime, prefix),
		handler: async (args, ctx) => {
			await handleProvidersCommand(pi, ctx, runtime, args);
		},
	});
}