# Local-First Kasa Smart Home Architecture (2026)
**Focus:** Privacy, MCP Integration, and Angular/Node.js Development.

---

## 1. System Components
* **Hardware:** TP-Link Kasa Smart Plug (Static IP assigned via Router).
* **Backend:** Node.js v24 / Express Server.
* **AI Layer:** MCP Server (Model Context Protocol) via StreamableHTTP transport (2025 spec).
* **Frontend:** Angular v21 with RxJS & Socket.io.
* **Network:** Tailscale or Headscale (self-hosted) Mesh VPN for secure, port-forward-free remote access.

---

## 2. Backend Strategy (Node.js + MCP)
Your Express server should host the MCP logic. This allows local AI agents to "talk" to your house.

### Core MCP Tools to Implement:
1.  `list_devices()`: Scans the subnet and returns aliases and IPs.
2.  `set_power_state(device_ip, state)`: Toggles the relay.
3.  `get_energy_metrics(device_ip)`: Returns voltage, current, and wattage.

Integrating a Model Context Protocol (MCP) server into your smart home stack is a sophisticated way to future-proof your setup. By using MCP, you allow AI agents (like Claude Desktop, Cursor, or your own Angular app) to interact with your physical hardware using standardized tool calls.

In this architecture, your Node.js/Express backend will serve two roles:

The IoT Controller: Managing the low-level TCP connection to the Kasa plugs.

The MCP Server: Exposing those capabilities as "Tools" (e.g., toggle_plug, get_energy_usage) that an LLM can understand and execute.

Comprehensive Architecture: The "Private AI Home"
This setup uses Tailscale for secure remote access and MCP to bridge your hardware to AI intelligence—all while keeping your data off the TP-Link cloud.

1. Why use MCP here?
Instead of hard-coding every button in your Angular app, an MCP server allows you to ask an AI: "Turn off the office lights if the power draw is less than 10W for an hour." The AI "sees" your Kasa plug as a tool it can call.

2. Implementation Overview
Protocol: Use tplink-smarthome-api for the Kasa handshake.

MCP SDK: Use @modelcontextprotocol/sdk to define your tools.

Remote Access: Use Tailscale's Funnel or Exit Nodes to access your dashboard from outside.