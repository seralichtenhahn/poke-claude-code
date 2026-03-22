# Local Development Setup

This guide is for developers who want to contribute or run the server from a cloned repository.

## Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/seralichtenhahn/poke-claude-code.git
   cd poke-claude-code
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```
   This automatically builds the project via the `prepare` script.

3. **Ensure Claude CLI is set up:**
   ```bash
   claude --dangerously-skip-permissions
   ```
   Follow the prompts to accept (one-time).

4. **Start the server:**
   ```bash
   npm start          # runs compiled dist/
   npm run dev        # runs TypeScript directly with tsx (auto-reloads)
   ```

## Development with `npm link`

To test the `poke-claude-code` CLI command locally:

```bash
npm link
```

After linking, running `poke-claude-code` anywhere will execute your local build. Rebuild with `npm run build` after changes.

## Project Structure

- `src/server.ts` — MCP server class with tool handlers (Claude CLI integration)
- `src/http-server.ts` — HTTP server entry point + Poke tunnel setup
- `dist/` — Compiled output (gitignored, built via `npm run build`)

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Local HTTP server port | `3000` |
| `POKE_NAME` | Display name for the tunnel in Poke | `claude-code-mcp` |
| `CLAUDE_CLI_NAME` | Custom Claude CLI binary name or absolute path | `claude` |
| `MCP_CLAUDE_DEBUG` | Enable verbose debug logging | `false` |

## Testing

```bash
npm test              # all tests
npm run test:unit     # unit tests only
npm run test:e2e      # e2e tests (with mocks)
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```

## Notes

- TypeScript source is in `src/`, compiled to `dist/` with `tsc`
- Node.js v20+ required
- The `prepare` script auto-builds on `npm install`
