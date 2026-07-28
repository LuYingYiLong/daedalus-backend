import WebSocket from "ws";

const url: string = process.env.WS_URL ?? "ws://127.0.0.1:38180";
const authToken: string | undefined = process.env.DAEDALUS_BACKEND_AUTH_TOKEN;
const socket: WebSocket = new WebSocket(url, {
	headers: authToken === undefined ? undefined : { Authorization: `Bearer ${authToken}` }
});

socket.on("open", (): void => {
	socket.send(JSON.stringify({
		protocolVersion: 2,
		type: "request",
		id: "test-1",
		method: "ping",
		params: {}
	}));
});

socket.on("message", (data: WebSocket.RawData, isBinary: boolean): void => {
	const text: string = isBinary ? data.toString("base64") : data.toString("utf8");
	console.log(text);
	socket.close();
});

socket.on("error", (error: Error): void => {
	console.error("WebSocket client error:", error);
	process.exitCode = 1;
});
