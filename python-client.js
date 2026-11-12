export async function serviceRequest(action, body) {
  const response = await fetch(`/api/${action}`, body === undefined
    ? { cache: "no-store" }
    : {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Lotus-Client": "local" },
      body: JSON.stringify(body),
    });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Python service ${response.status}: ${detail}`);
  }
  return response.json();
}

export class PythonLights {
  constructor(onState) {
    this.state = null;
    this.onState = onState;
    this.connected = false;
  }

  async refresh() {
    this.state = await serviceRequest("state");
    this.connected = this.state.connected;
    this.onState(this.state);
    return this.state;
  }

  async scan() {
    return serviceRequest("scan", {});
  }

  async connect(address) {
    await serviceRequest("select", { address });
    await this.refresh();
  }

  async disconnect() {
    await serviceRequest("disconnect", {});
    await this.refresh();
  }

  async send(command) {
    await serviceRequest("command", { command: Array.from(command) });
  }

  async play(sequence) {
    await serviceRequest("play", { sequence });
    await this.refresh();
  }

  async stop() {
    await serviceRequest("stop", {});
    await this.refresh();
  }
}
