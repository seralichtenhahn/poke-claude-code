# Poke Claude Code

An MCP server that runs Claude Code via a [Poke](https://poke.com) tunnel. Start the server once, and your Poke agent gets access to Claude Code's full capabilities — file editing, git, terminal commands, and more.

## How It Works

The server starts a local HTTP MCP endpoint and connects it to Poke via a tunnel. Poke forwards requests from your agent to the local server, which executes them through the Claude CLI with `--dangerously-skip-permissions`.

## Prerequisites

- Node.js v20 or later
- Claude CLI installed and `--dangerously-skip-permissions` accepted
- A [Poke](https://poke.com) account

## Quick Start

### 1. Accept Claude CLI permissions (one-time)

```bash
npm install -g @anthropic-ai/claude-code
claude --dangerously-skip-permissions
```

Follow the prompts to accept.

### 2. Clone and install

```bash
git clone https://github.com/seralichtenhahn/poke-claude-code.git
cd poke-claude-code
npm install
```

### 3. Start the server

```bash
npm start
```

On first run, a browser window opens for Poke login. After that, the server starts the HTTP endpoint and connects the Poke tunnel. You'll see output like:

```
MCP HTTP server listening on http://127.0.0.1:3000/mcp
Poke tunnel connected!
  Tunnel URL: https://...
  Local URL:  http://127.0.0.1:3000/mcp
```

Your Poke agent can now use the `claude_code` tool.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Local HTTP server port | `3000` |
| `POKE_NAME` | Display name for the tunnel in Poke | `claude-code-mcp` |
| `CLAUDE_CLI_NAME` | Custom Claude CLI binary name or absolute path | `claude` |
| `MCP_CLAUDE_DEBUG` | Enable verbose debug logging | `false` |

Example:

```bash
PORT=8080 POKE_NAME="my-claude" npm start
```

## Tool: `claude_code`

The server exposes a single MCP tool.

**Arguments:**
- `prompt` (string, required): The prompt to send to Claude Code.
- `workFolder` (string, optional): Working directory for the execution. Must be an absolute path.

**Example:**
```json
{
  "toolName": "claude_code",
  "arguments": {
    "prompt": "Refactor the function foo in main.py to be async.",
    "workFolder": "/path/to/project"
  }
}
```

### What it can do

- File operations: create, read, edit, move, copy, delete
- Code generation, analysis, and refactoring
- Git: stage, commit, push, tag, create PRs
- Run terminal commands
- Web search and summarization
- Multi-step workflows (version bumps, changelog updates, releases)

## Development

```bash
# Run in dev mode (auto-reloads TypeScript)
npm run dev

# Run tests
npm test

# Build
npm run build
```

See [docs/local_install.md](./docs/local_install.md) for more development details.

## Troubleshooting

- **"Command not found" (claude):** Ensure the Claude CLI is installed. Run `claude --version` or check `~/.claude/local/claude`.
- **Poke login issues:** Run `npx poke login` manually to re-authenticate.
- **Port in use:** Set a different port with `PORT=3001 npm start`.
- **ESM/Import Errors:** Ensure you are using Node.js v20 or later.

## License

MIT
