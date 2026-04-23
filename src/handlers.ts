import { App } from "obsidian";
import { JsonRpcRequest, JsonRpcResponse, VaultMcpSettings } from "./types";
import { getEnabledTools, handleToolCall, ToolContext } from "./tools";
import { SemanticIndex } from "./semantic";

const SERVER_INFO = {
	name: "obsidian-vault-mcp",
	version: "1.0.0",
};

export async function handleMcpRequest(
	app: App,
	settings: VaultMcpSettings,
	semanticIndex: SemanticIndex | null,
	request: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
	if (request.id === undefined || request.id === null) {
		return null;
	}

	// Server name includes vault name so multi-vault clients can tell instances
	// apart in logs without calling get_vault_info first.
	const serverInfo = {
		...SERVER_INFO,
		name: `${SERVER_INFO.name} (${app.vault.getName()})`,
	};

	switch (request.method) {
		case "initialize":
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo,
				},
			};

		case "tools/list":
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: { tools: getEnabledTools(settings.enabledTools) },
			};

		case "tools/call": {
			const params = request.params || {};
			const name = String(params.name || "");

			if (settings.enabledTools[name as keyof typeof settings.enabledTools] === false) {
				return {
					jsonrpc: "2.0",
					id: request.id,
					result: {
						content: [
							{
								type: "text",
								text: `Tool '${name}' is disabled in Obsidian settings.`,
							},
						],
						isError: true,
					},
				};
			}

			const args = (params.arguments || {}) as Record<string, unknown>;
			const ctx: ToolContext = {
				app,
				excludedPaths: settings.excludedPaths,
				semanticIndex,
				semanticEnabled: settings.semantic.enabled,
			};
			const result = await handleToolCall(ctx, name, args);
			return {
				jsonrpc: "2.0",
				id: request.id,
				result,
			};
		}

		case "ping":
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {},
			};

		default:
			return {
				jsonrpc: "2.0",
				id: request.id,
				error: {
					code: -32601,
					message: `Method not found: ${request.method}`,
				},
			};
	}
}
