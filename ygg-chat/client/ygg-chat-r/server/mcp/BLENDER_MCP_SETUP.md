# Blender MCP setup

This app supports both standard MCP stdio framing with `Content-Length` headers and a `newline-json` compatibility mode for Blender MCP.

## What to install

### 1. Create a virtual environment

Windows example:

```powershell
py -m venv C:\mcp\blender-mcp-venv
C:\mcp\blender-mcp-venv\Scripts\activate
pip install git+https://projects.blender.org/lab/blender_mcp.git
```

### 2. Install the Blender add-on

Blender's MCP integration also requires the Blender add-on to be installed and enabled inside Blender.

## Add server in Ygg Chat

Open Settings → MCP Servers and add a local stdio server with:

- Name: `blender`
- Transport: `Local (stdio)`
- Command: `C:\mcp\blender-mcp-venv\Scripts\blender-mcp.exe`
- Arguments: leave blank unless your installation requires them
- Environment Variables JSON:

```json
{"BLENDER_HOST":"localhost","BLENDER_PORT":"9876"}
```

- stdio Framing: `newline-json`

If direct execution has issues on Windows, try:

- Command: `cmd`
- Arguments: `/c C:\mcp\blender-mcp-venv\Scripts\blender-mcp.exe`

## Notes

- Start Blender and enable/run the Blender MCP add-on before starting the MCP server in Ygg Chat.
- The MCP config file path can be queried from `GET /api/mcp/config-path`.
- Config is stored in the app user data `mcp-servers.json`, not in the repository `.mcp.json` files.
