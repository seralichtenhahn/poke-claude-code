import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as pathResolve } from 'node:path';
import * as path from 'path';
import { Poke } from 'poke';

// Server version - update this when releasing new versions
const SERVER_VERSION = "1.10.12";

// Base directory for repo name auto-discovery
const REPOS_BASE_DIR = process.env.REPOS_BASE_DIR || '';

// Define debugMode globally using const
const debugMode = process.env.MCP_CLAUDE_DEBUG === 'true';

// Track if this is the first tool use for version printing
let isFirstToolUse = true;

// Capture server startup time when the module loads
const serverStartupTime = new Date().toISOString();

// Cache CLI path at module level so it's resolved once
let cachedCliPath: string | null = null;
function getClaudeCli(): string {
  if (!cachedCliPath) {
    cachedCliPath = findClaudeCli();
    console.error(`[Setup] Using Claude CLI command/path: ${cachedCliPath}`);
  }
  return cachedCliPath;
}

// Poke client for delivering async results (lazy-init for testability)
let _poke: InstanceType<typeof Poke> | null = null;
function getPoke(): InstanceType<typeof Poke> {
  if (!_poke) _poke = new Poke();
  return _poke;
}

async function deliverViaPoke(message: string): Promise<void> {
  try {
    await getPoke().sendMessage(message);
  } catch (e) {
    console.error('sendMessage failed:', e);
  }
}

// Running tasks map for duplicate detection
const runningTasks = new Map<string, { id: string; startedAt: number }>();

function taskKey(prompt: string, cwd: string): string {
  return `${cwd}::${prompt}`;
}

export function runningTaskCount(): number {
  return runningTasks.size;
}

// Dedicated debug logging function
export function debugLog(message?: any, ...optionalParams: any[]): void {
  if (debugMode) {
    console.error(message, ...optionalParams);
  }
}

/**
 * Resolve a workFolder value.
 * - Absolute paths are returned as-is.
 * - Non-absolute strings are treated as repo names and looked up
 *   as subdirectories of REPOS_BASE_DIR.
 * Returns the resolved absolute path, or null if not found.
 */
function resolveWorkFolder(workFolder: string): string | null {
  if (isAbsolute(workFolder)) {
    return workFolder;
  }

  // Treat as repo name — look up in REPOS_BASE_DIR
  if (!REPOS_BASE_DIR) {
    debugLog(`[Warning] workFolder "${workFolder}" is not an absolute path and REPOS_BASE_DIR is not set`);
    return null;
  }

  const candidate = join(REPOS_BASE_DIR, workFolder);
  if (existsSync(candidate)) {
    debugLog(`[Debug] Resolved repo name "${workFolder}" to ${candidate}`);
    return candidate;
  }

  // Case-insensitive search through the base dir
  try {
    const entries = readdirSync(REPOS_BASE_DIR, { withFileTypes: true });
    const match = entries.find(
      (e) => e.isDirectory() && e.name.toLowerCase() === workFolder.toLowerCase()
    );
    if (match) {
      const resolved = join(REPOS_BASE_DIR, match.name);
      debugLog(`[Debug] Resolved repo name "${workFolder}" (case-insensitive) to ${resolved}`);
      return resolved;
    }
  } catch {
    debugLog(`[Warning] Could not read REPOS_BASE_DIR: ${REPOS_BASE_DIR}`);
  }

  debugLog(`[Warning] Repo "${workFolder}" not found in ${REPOS_BASE_DIR}`);
  return null;
}

/**
 * Determine the Claude CLI command/path.
 * 1. Checks for CLAUDE_CLI_NAME environment variable:
 *    - If absolute path, uses it directly
 *    - If relative path, throws error
 *    - If simple name, continues with path resolution
 * 2. Checks for Claude CLI at the local user path: ~/.claude/local/claude.
 * 3. If not found, defaults to the CLI name (or 'claude'), relying on the system's PATH for lookup.
 */
export function findClaudeCli(): string {
  debugLog('[Debug] Attempting to find Claude CLI...');

  // Check for custom CLI name from environment variable
  const customCliName = process.env.CLAUDE_CLI_NAME;
  if (customCliName) {
    debugLog(`[Debug] Using custom Claude CLI name from CLAUDE_CLI_NAME: ${customCliName}`);
    
    // If it's an absolute path, use it directly
    if (path.isAbsolute(customCliName)) {
      debugLog(`[Debug] CLAUDE_CLI_NAME is an absolute path: ${customCliName}`);
      return customCliName;
    }
    
    // If it starts with ~ or ./, reject as relative paths are not allowed
    if (customCliName.startsWith('./') || customCliName.startsWith('../') || customCliName.includes('/')) {
      throw new Error(`Invalid CLAUDE_CLI_NAME: Relative paths are not allowed. Use either a simple name (e.g., 'claude') or an absolute path (e.g., '/tmp/claude-test')`);
    }
  }
  
  const cliName = customCliName || 'claude';

  // Try local install path: ~/.claude/local/claude (using the original name for local installs)
  const userPath = join(homedir(), '.claude', 'local', 'claude');
  debugLog(`[Debug] Checking for Claude CLI at local user path: ${userPath}`);

  if (existsSync(userPath)) {
    debugLog(`[Debug] Found Claude CLI at local user path: ${userPath}. Using this path.`);
    return userPath;
  } else {
    debugLog(`[Debug] Claude CLI not found at local user path: ${userPath}.`);
  }

  // 3. Fallback to CLI name (PATH lookup)
  debugLog(`[Debug] Falling back to "${cliName}" command name, relying on spawn/PATH lookup.`);
  console.warn(`[Warning] Claude CLI not found at ~/.claude/local/claude. Falling back to "${cliName}" in PATH. Ensure it is installed and accessible.`);
  return cliName;
}

/**
 * Interface for Claude Code tool arguments
 */
interface ClaudeCodeArgs {
  prompt: string;
  workFolder?: string;
}

// Ensure spawnAsync is defined correctly *before* the class
export async function spawnAsync(command: string, args: string[], options?: { timeout?: number, cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    debugLog(`[Spawn] Running command: ${command} ${args.join(' ')}`);
    const process = spawn(command, args, {
      shell: false, // Reverted to false
      timeout: options?.timeout,
      cwd: options?.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => { stdout += data.toString(); });
    process.stderr.on('data', (data) => {
      stderr += data.toString();
      debugLog(`[Spawn Stderr Chunk] ${data.toString()}`);
    });

    process.on('error', (error: NodeJS.ErrnoException) => {
      debugLog(`[Spawn Error Event] Full error object:`, error);
      let errorMessage = `Spawn error: ${error.message}`;
      if (error.path) {
        errorMessage += ` | Path: ${error.path}`;
      }
      if (error.syscall) {
        errorMessage += ` | Syscall: ${error.syscall}`;
      }
      errorMessage += `\nStderr: ${stderr.trim()}`;
      reject(new Error(errorMessage));
    });

    process.on('close', (code) => {
      debugLog(`[Spawn Close] Exit code: ${code}`);
      debugLog(`[Spawn Stderr Full] ${stderr.trim()}`);
      debugLog(`[Spawn Stdout Full] ${stdout.trim()}`);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`));
      }
    });
  });
}

/**
 * MCP Server for Claude Code
 * Provides a simple MCP tool to run Claude CLI in one-shot mode
 */
export class ClaudeCodeServer {
  private server: Server;
  private claudeCliPath: string; // This now holds either a full path or just 'claude'
  private packageVersion: string; // Add packageVersion property

  constructor() {
    this.claudeCliPath = getClaudeCli();
    this.packageVersion = SERVER_VERSION;

    this.server = new Server(
      {
        name: process.env.MCP_NAME || 'Computer',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[Error]', error);
  }

  /**
   * Set up the MCP tool handlers
   */
  private setupToolHandlers(): void {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: process.env.TOOL_NAME || 'do something',
          description: `Claude Code Agent: Run Claude CLI for code, file, Git, and terminal operations. **This tool is async** — it returns immediately with a task ID, and the result is delivered later as a message.

**IMPORTANT: Async execution model**
- This tool returns instantly with "Task [id] accepted".
- The actual work runs in the background.
- When complete, the result is sent as a separate message (not as the tool response).
- Do NOT wait for or poll the tool response for results. Move on and process the result when the message arrives.
- If you send the same prompt + workFolder while a task is still running, you'll get a "duplicate request" response.

**Capabilities**
- File ops: create, read, edit, move, copy, delete, list, analyze
- Code: generate, analyse, refactor, fix
- Git: stage, commit, push, tag, create PRs
- Terminal: run any CLI command
- Multi-step workflows (version bumps, changelog updates, releases)

**Tips**
1. Be concise and explicit. Step-by-step for complex tasks.
2. Set \`workFolder\` to the repo name or absolute path so Claude runs in the right directory.
3. Claude Code handles complex multi-step file operations and refactorings well.
4. Combine file operations, README updates, and Git commands in a single prompt.

        `,
          inputSchema: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'The detailed natural language prompt for Claude to execute.',
              },
              workFolder: {
                type: 'string',
                description: 'The working directory for the Claude CLI execution. Can be an absolute path or a repository name (auto-resolved from REPOS_BASE_DIR). Defaults to REPOS_BASE_DIR if set, otherwise the user\'s home directory.',
              },
            },
            required: ['prompt'],
          },
        }
      ],
    }));

    // Handle tool calls
    const executionTimeoutMs = 1800000; // 30 minutes timeout

    this.server.setRequestHandler(CallToolRequestSchema, async (args, call): Promise<ServerResult> => {
      debugLog('[Debug] Handling CallToolRequest:', args);

      // Correctly access toolName from args.params.name
      const toolName = args.params.name;
      if (toolName !== (process.env.TOOL_NAME || 'do something')) {
        // ErrorCode.ToolNotFound should be ErrorCode.MethodNotFound as per SDK for tools
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${toolName} not found`);
      }

      // Robustly access prompt from args.params.arguments
      const toolArguments = args.params.arguments;
      let prompt: string;

      if (
        toolArguments &&
        typeof toolArguments === 'object' &&
        'prompt' in toolArguments &&
        typeof toolArguments.prompt === 'string'
      ) {
        prompt = toolArguments.prompt;
      } else {
        throw new McpError(ErrorCode.InvalidParams, 'Missing or invalid required parameter: prompt (must be an object with a string "prompt" property) for claude_code tool');
      }

      // Determine the working directory
      let effectiveCwd = REPOS_BASE_DIR || homedir();

      // Check if workFolder is provided in the tool arguments
      if (toolArguments.workFolder && typeof toolArguments.workFolder === 'string') {
        const resolved = resolveWorkFolder(toolArguments.workFolder);
        if (resolved) {
          const resolvedCwd = pathResolve(resolved);
          debugLog(`[Debug] Specified workFolder: ${toolArguments.workFolder}, Resolved to: ${resolvedCwd}`);
          if (existsSync(resolvedCwd)) {
            effectiveCwd = resolvedCwd;
            debugLog(`[Debug] Using workFolder as CWD: ${effectiveCwd}`);
          } else {
            debugLog(`[Warning] Specified workFolder does not exist: ${resolvedCwd}. Using default: ${effectiveCwd}`);
          }
        } else {
          debugLog(`[Warning] Could not resolve workFolder: ${toolArguments.workFolder}. Using default: ${effectiveCwd}`);
        }
      } else {
        debugLog(`[Debug] No workFolder provided, using default CWD: ${effectiveCwd}`);
      }

      // Truncate prompt for display
      const promptPreview = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
      const cwdLabel = path.basename(effectiveCwd);

      // Duplicate detection
      const key = taskKey(prompt, effectiveCwd);
      const existing = runningTasks.get(key);
      if (existing) {
        const elapsed = Math.round((Date.now() - existing.startedAt) / 1000);
        console.error(`⊘ [${cwdLabel}] duplicate request (task ${existing.id.slice(0, 8)}, running for ${elapsed}s)`);
        return {
          content: [{ type: 'text', text: `Task ID: ${existing.id}\nDuplicate request — already running for ${elapsed}s. Result will be delivered via message when complete.` }],
        };
      }

      // Generate task ID and register
      const taskId = randomUUID();
      runningTasks.set(key, { id: taskId, startedAt: Date.now() });

      console.error(`▶ [${cwdLabel}] task ${taskId.slice(0, 8)} accepted — ${promptPreview}`);

      // Print tool info on first use
      if (isFirstToolUse) {
        console.error(`claude_code v${SERVER_VERSION} started at ${serverStartupTime}`);
        isFirstToolUse = false;
      }

      // Fire-and-forget: run Claude CLI in background, deliver result via Poke sendMessage
      const cliPath = this.claudeCliPath;
      const claudeProcessArgs = ['--dangerously-skip-permissions', '-p', prompt];

      (async () => {
        const startTime = Date.now();
        try {
          debugLog(`[Debug] Invoking Claude CLI: ${cliPath} ${claudeProcessArgs.join(' ')}`);

          const { stdout, stderr } = await spawnAsync(
            cliPath,
            claudeProcessArgs,
            { timeout: executionTimeoutMs, cwd: effectiveCwd }
          );

          debugLog('[Debug] Claude CLI stdout:', stdout.trim());
          if (stderr) {
            debugLog('[Debug] Claude CLI stderr:', stderr.trim());
          }

          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          console.error(`✓ [${cwdLabel}] task ${taskId.slice(0, 8)} done in ${duration}s (${stdout.length} chars)`);

          // Deliver result via Poke
          const message = `Task ID: ${taskId}\n[Task ${taskId.slice(0, 8)} complete]\nDirectory: ${effectiveCwd}\nPrompt: ${promptPreview}\n---\n${stdout}`;
          await deliverViaPoke(message);

        } catch (error: any) {
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          console.error(`✗ [${cwdLabel}] task ${taskId.slice(0, 8)} failed after ${duration}s — ${error.message || 'Unknown error'}`);

          let errorMessage = error.message || 'Unknown error';
          if (error.stderr) errorMessage += `\nStderr: ${error.stderr}`;
          if (error.stdout) errorMessage += `\nStdout: ${error.stdout}`;

          // Deliver error via Poke
          const message = `Task ID: ${taskId}\n[Task ${taskId.slice(0, 8)} failed]\nDirectory: ${effectiveCwd}\nPrompt: ${promptPreview}\n---\n${errorMessage}`;
          await deliverViaPoke(message);

        } finally {
          runningTasks.delete(key);
        }
      })();

      // Return immediately
      return {
        content: [{ type: 'text', text: `Task ID: ${taskId}\nTask accepted. Running in background — result will be delivered via message when complete.` }],
      };
    });
  }

  /**
   * Connect the MCP server to the given transport
   */
  async run(transport: Transport): Promise<void> {
    await this.server.connect(transport);
    debugLog('[Debug] MCP session connected');
  }
}