import * as http from "http";
import { JsonRpcRequest, JsonRpcResponse } from "./types";

export class McpHttpServer {
	private server: http.Server | null = null;

	constructor(
		private port: number,
		private onMessage: (
			req: JsonRpcRequest
		) => Promise<JsonRpcResponse | null>
	) {}

	async start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server = http.createServer((req, res) =>
				this.handleRequest(req, res)
			);

			this.server.on("error", reject);
			this.server.listen(this.port, "127.0.0.1", () => {
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		return new Promise((resolve) => {
			if (this.server) {
				this.server.close(() => resolve());
				this.server = null;
			} else {
				resolve();
			}
		});
	}

	private async handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		// CORS headers
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader(
			"Access-Control-Allow-Methods",
			"POST, OPTIONS"
		);
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Content-Type, Accept"
		);

		// Preflight
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		// Only handle POST /mcp
		const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
		if (url.pathname !== "/mcp") {
			res.writeHead(404);
			res.end("Not found");
			return;
		}

		if (req.method !== "POST") {
			res.writeHead(405);
			res.end("Method not allowed");
			return;
		}

		await this.handlePost(req, res);
	}

	private async handlePost(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		try {
			const body = await this.readBody(req);
			const parsed = JSON.parse(body) as JsonRpcRequest;

			// Validate JSON-RPC
			if (parsed.jsonrpc !== "2.0" || !parsed.method) {
				res.writeHead(400);
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: parsed.id ?? null,
						error: { code: -32600, message: "Invalid request" },
					})
				);
				return;
			}

			const response = await this.onMessage(parsed);

			// Notification (no id) — return 202
			if (response === null) {
				res.writeHead(202);
				res.end();
				return;
			}

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(response));
		} catch (err) {
			if (err instanceof SyntaxError) {
				res.writeHead(400);
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: null,
						error: { code: -32700, message: "Parse error" },
					})
				);
			} else {
				res.writeHead(500);
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: null,
						error: { code: -32603, message: "Internal error" },
					})
				);
			}
		}
	}

	private readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString()));
			req.on("error", reject);
		});
	}
}
