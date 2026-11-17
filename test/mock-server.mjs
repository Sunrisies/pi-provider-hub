// Mock OpenAI-compatible site used by the integration test.
// GET /v1/models  -> requires "Authorization: Bearer test-key"
// GET /models     -> 404 (forces the /v1 discovery path)
// POST /v1/chat/completions -> minimal SSE stream so `pi -e … -p` can chat
import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? 41873);

const models = {
	object: "list",
	data: [
		{ id: "mock-chat-pro", object: "model", context_length: 200000 },
		{ id: "mock-chat-mini", object: "model", context_length: 128000 },
		{ id: "text-embedding-mock", object: "model" },
	],
};

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
	const authorized = req.headers.authorization === "Bearer test-key";

	if (req.method === "GET" && url.pathname === "/v1/models") {
		if (!authorized) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "invalid api key" } }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(models));
		return;
	}

	if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
		if (!authorized) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "invalid api key" } }));
			return;
		}
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const chunk = (delta) => `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock-chat-pro", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
			res.write(chunk({ role: "assistant", content: "mock-reply-ok" }));
			res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock-chat-pro", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		});
		return;
	}

	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message: `not found: ${url.pathname}` } }));
});

server.listen(port, "127.0.0.1", () => {
	console.log(`mock site listening on http://127.0.0.1:${port}`);
});