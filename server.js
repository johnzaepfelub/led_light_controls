import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const portText = process.env.PORT ?? "49173";
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
  console.error("PORT must be an integer between 1 and 65535.");
  process.exit(1);
}
const port = Number(portText);

const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/lights.js", ["lights.js", "text/javascript"]],
  ["/sequences.js", ["sequences.js", "text/javascript"]],
  ["/python-client.js", ["python-client.js", "text/javascript"]],
]);

const server = createServer(async (request, response) => {
  const file = files.get(request.url);
  if (!file || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  try {
    const content = await readFile(new URL(file[0], import.meta.url));
    response.writeHead(200, {
      "Content-Type": `${file[1]}; charset=utf-8`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    console.error("Unable to serve application file:", error);
    response.writeHead(500);
    response.end("Unable to load application file. See the server terminal.");
  }
});

server.on("error", (error) => {
  console.error("Server failed:", error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Open http://lotuslantern.localhost:${port} in Chrome. Press Ctrl+C to stop.`);
});
