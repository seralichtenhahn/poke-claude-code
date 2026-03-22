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
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as pathResolve } from 'node:path';
import { readdirSync } from 'node:fs';
import * as path from 'path';

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
        name: 'claude_code',
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
          name: 'claude_code',
          description: `Claude Code Agent: Your versatile multi-modal assistant for code, file, Git, and terminal operations via Claude CLI. Use \`workFolder\` for contextual execution.

• File ops: Create, read, (fuzzy) edit, move, copy, delete, list files, analyze/ocr images, file content analysis
    └─ e.g., "Create /tmp/log.txt with 'system boot'", "Edit main.py to replace 'debug_mode = True' with 'debug_mode = False'", "List files in /src", "Move a specific section somewhere else"

• Code: Generate / analyse / refactor / fix
    └─ e.g. "Generate Python to parse CSV→JSON", "Find bugs in my_script.py"

• Git: Stage ▸ commit ▸ push ▸ tag (any workflow)
    └─ "Commit '/workspace/src/main.java' with 'feat: user auth' to develop."

• Terminal: Run any CLI cmd or open URLs
    └─ "npm run build", "Open https://developer.mozilla.org"

• Web search + summarise content on-the-fly

• Multi-step workflows  (Version bumps, changelog updates, release tagging, etc.)

• GitHub integration  Create PRs, check CI status

• Confused or stuck on an issue? Ask Claude Code for a second opinion, it might surprise you!

**Prompt tips**

1. Be concise, explicit & step-by-step for complex tasks. No need for niceties, this is a tool to get things done.
2. For multi-line text, write it to a temporary file in the project root, use that file, then delete it.
3. If you get a timeout, split the task into smaller steps.
4. **Seeking a second opinion/analysis**: If you're stuck or want advice, you can ask \`claude_code\` to analyze a problem and suggest solutions. Clearly state in your prompt that you are looking for analysis only and no actual file modifications should be made.
5. If workFolder is set to the project path, there is no need to repeat that path in the prompt and you can use relative paths for files.
6. Claude Code is really good at complex multi-step file operations and refactorings and faster than your native edit features.
7. Combine file operations, README updates, and Git commands in a sequence.
8. Claude can do much more, just ask it!

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
      if (toolName !== 'claude_code') {
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
      console.error(`▶ [${cwdLabel}] ${promptPreview}`);

      const startTime = Date.now();

      try {
        debugLog(`[Debug] Attempting to execute Claude CLI with prompt: "${prompt}" in CWD: "${effectiveCwd}"`);

        // Print tool info on first use
        if (isFirstToolUse) {
          const versionInfo = `claude_code v${SERVER_VERSION} started at ${serverStartupTime}`;
          console.error(versionInfo);
          isFirstToolUse = false;
        }

        const claudeProcessArgs = ['--dangerously-skip-permissions', '-p', prompt];
        debugLog(`[Debug] Invoking Claude CLI: ${this.claudeCliPath} ${claudeProcessArgs.join(' ')}`);

        const { stdout, stderr } = await spawnAsync(
          this.claudeCliPath, // Run the Claude CLI directly
          claudeProcessArgs, // Pass the arguments
          { timeout: executionTimeoutMs, cwd: effectiveCwd }
        );

        debugLog('[Debug] Claude CLI stdout:', stdout.trim());
        if (stderr) {
          debugLog('[Debug] Claude CLI stderr:', stderr.trim());
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const outputLen = stdout.length;
        console.error(`✓ [${cwdLabel}] done in ${duration}s (${outputLen} chars)`);

        // Return stdout content, even if there was stderr, as claude-cli might output main result to stdout.
        return { content: [{ type: 'text', text: stdout }] };

      } catch (error: any) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`✗ [${cwdLabel}] failed after ${duration}s — ${error.message || 'Unknown error'}`);
        debugLog('[Error] Error executing Claude CLI:', error);

        let errorMessage = error.message || 'Unknown error';
        // Attempt to include stderr and stdout from the error object if spawnAsync attached them
        if (error.stderr) {
          errorMessage += `\nStderr: ${error.stderr}`;
        }
        if (error.stdout) {
          errorMessage += `\nStdout: ${error.stdout}`;
        }

        if (error.signal === 'SIGTERM' || (error.message && error.message.includes('ETIMEDOUT')) || (error.code === 'ETIMEDOUT')) {
          throw new McpError(ErrorCode.InternalError, `Claude CLI command timed out after ${executionTimeoutMs / 1000}s. Details: ${errorMessage}`);
        }
        throw new McpError(ErrorCode.InternalError, `Claude CLI execution failed: ${errorMessage}`);
      }
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