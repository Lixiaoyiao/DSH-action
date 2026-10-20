import { createServer } from "node:http";
import { sendMessagesSse } from "./messages-sse.mjs";

const responseText = JSON.stringify({
  protocolVersion: 2,
  operation: "review",
  summary: "controlled profile booted",
  findings: [],
  state: "final",
});

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/v1/messages")) {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  request.once("end", () => {
    sendMessagesSse(response, { content: responseText }, "stop");
  });
});

server.listen(0, process.env.DSH_FIXTURE_HOST ?? "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  process.stdout.write(
    `${JSON.stringify({ baseUrl: `http://127.0.0.1:${String(address.port)}` })}\n`,
  );
});

const close = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
