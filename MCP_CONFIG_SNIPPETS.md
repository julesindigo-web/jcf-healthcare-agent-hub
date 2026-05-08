# MCP Client Configuration Snippets

## Claude Desktop (claude_desktop_config.json)

```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "url": "https://your-project-name.railway.app/mcp",
      "transport": "http"
    }
  }
}
```

**Location:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
**Location:** `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

---

## Cursor (.cursor/mcp.json)

```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "url": "https://your-project-name.railway.app/mcp"
    }
  }
}
```

**Location:** `.cursor/mcp.json` in project root

---

## Windsurf (mcp_config.json)

```json
{
  "mcpServers": {
    "jcf-healthcare-agent-hub": {
      "url": "https://your-project-name.railway.app/mcp",
      "transport": "http"
    }
  }
}
```

**Location:** `~/.codeium/windsurf/mcp_config.json`

---

## Installation Instructions

### Claude Desktop
1. Open Claude Desktop
2. Go to Settings → MCP
3. Add new server with URL: `https://your-project-name.railway.app/mcp`
4. Save and restart Claude Desktop

### Cursor
1. Open Cursor
2. Go to Settings → MCP Servers
3. Add new server with URL: `https://your-project-name.railway.app/mcp`
4. Save and restart Cursor

### Windsurf
1. Open Windsurf IDE
2. Edit `~/.codeium/windsurf/mcp_config.json`
3. Add server configuration above
4. Save and restart Windsurf
