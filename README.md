# Poke Claude Code

An MCP server that runs Claude Code via a [Poke](https://poke.com) tunnel. Start the server once, and your Poke agent gets access to Claude Code's full capabilities — file editing, git, terminal commands, and more.

## How It Works

The server starts a local HTTP MCP endpoint and connects it to Poke via a tunnel. Poke forwards requests from your agent to the local server, which executes them through the Claude CLI with `--dangerously-skip-permissions`.

**Async execution model:** Tool calls return immediately with a Task ID (UUID). The actual work runs in the background, and results are delivered asynchronously via Poke's `sendMessage`. If the same prompt + workFolder is submitted while a task is still running, the server returns a duplicate-request response instead of starting a second run.

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

### 3. Configure environment

Copy the example `.env` file and edit it:

```bash
cp .env.example .env
```

The server loads `.env` automatically at startup via [dotenv](https://www.npmjs.com/package/dotenv). See [Configuration](#configuration) for all available variables.

### 4. Start the server

```bash
npm start
```

On first run, a browser window opens for Poke login. After that, the server starts the HTTP endpoint and connects the Poke tunnel. You'll see output like:

```
server listening on http://127.0.0.1:3000/mcp
tunnel connected
  remote: https://...
  local:  http://127.0.0.1:3000/mcp
```

## Configuration

The server is configured via environment variables. You can set them in a `.env` file (loaded automatically) or pass them directly.

### `.env.example`

```env
POKE_NAME=computer
TOOL_NAME=do_something
PORT=3000
POKE_API_KEY=
REPOS_BASE_DIR=
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Local HTTP server port | `3000` |
| `POKE_NAME` | Display name for the Poke tunnel and MCP server | `claude-code-mcp` |
| `TOOL_NAME` | Name of the MCP tool exposed by the server | `do_something` |
| `REPOS_BASE_DIR` | Base directory for resolving relative `workFolder` values. When set, a `workFolder` like `"my-repo"` is resolved to `REPOS_BASE_DIR/my-repo` (case-insensitive). Also used as the default working directory when no `workFolder` is provided. | _(none)_ |
| `POKE_API_KEY` | Poke API key (passed to the Poke SDK) | _(none)_ |
| `CLAUDE_CLI_NAME` | Custom Claude CLI binary name or absolute path. Relative paths are not allowed. | `claude` |
| `MCP_CLAUDE_DEBUG` | Set to `true` for verbose debug logging | `false` |

Example:

```bash
PORT=8080 POKE_NAME="my-claude" TOOL_NAME="code_agent" npm start
```

## Tool

The server exposes a single MCP tool (name set by `TOOL_NAME`, default `do_something`).

### Arguments

- **`prompt`** (string, required): The prompt to send to Claude Code.
- **`workFolder`** (string, optional): Working directory for the execution. Can be an absolute path or a repository name that will be resolved against `REPOS_BASE_DIR`. Defaults to `REPOS_BASE_DIR` if set, otherwise the user's home directory.

### Response format

Every response starts with a `Task ID:` line containing a UUID, followed by a status message:

```
Task ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
Task accepted. Running in background — result will be delivered via message when complete.
```

When the task completes, the result is delivered as a Poke message with the same Task ID, the directory, prompt preview, and the full CLI output.

### Example

```json
{
  "toolName": "do_something",
  "arguments": {
    "prompt": "Refactor the function foo in main.py to be async.",
    "workFolder": "/path/to/project"
  }
}
```

### Capabilities

- File operations: create, read, edit, move, copy, delete, list, analyze
- Code generation, analysis, refactoring, and fixes
- Git: stage, commit, push, tag, create PRs
- Terminal: run any CLI command
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
