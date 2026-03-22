import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Mock dependencies
vi.mock('node:child_process');
vi.mock('node:fs');
vi.mock('node:os');
vi.mock('poke', () => ({
  Poke: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
  })),
}));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn()
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema: { name: 'listTools' },
  CallToolRequestSchema: { name: 'callTool' },
  ErrorCode: { 
    InternalError: 'InternalError',
    MethodNotFound: 'MethodNotFound'
  },
  McpError: vi.fn().mockImplementation((code, message) => {
    const error = new Error(message);
    (error as any).code = code;
    return error;
  })
}));

const mockExistsSync = vi.mocked(existsSync);
const mockSpawn = vi.mocked(spawn);
const mockHomedir = vi.mocked(homedir);

describe('Error Handling Tests', () => {
  let consoleErrorSpy: any;
  let originalEnv: any;
  let errorHandler: any = null;

  function setupServerMock() {
    errorHandler = null;
    vi.mocked(Server).mockImplementation(() => {
      const instance = {
        setRequestHandler: vi.fn(),
        connect: vi.fn(),
        close: vi.fn(),
        onerror: null
      } as any;
      Object.defineProperty(instance, 'onerror', {
        get() { return errorHandler; },
        set(handler) { errorHandler = handler; },
        enumerable: true,
        configurable: true
      });
      return instance;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalEnv = { ...process.env };
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.env = originalEnv;
  });

  describe('CallToolRequest Error Cases', () => {
    it('should throw error for unknown tool name', async () => {
      mockHomedir.mockReturnValue('/home/user');
      mockExistsSync.mockReturnValue(true);
      
      // Set up Server mock before importing the module
      setupServerMock();
      
      const module = await import('../server.js');
      // @ts-ignore
      const { ClaudeCodeServer } = module;
      
      const server = new ClaudeCodeServer();
      const mockServerInstance = vi.mocked(Server).mock.results[0].value;
      
      const callToolCall = mockServerInstance.setRequestHandler.mock.calls.find(
        (call: any[]) => call[0].name === 'callTool'
      );
      
      const handler = callToolCall[1];
      
      await expect(
        handler({
          params: {
            name: 'unknown_tool',
            arguments: {}
          }
        })
      ).rejects.toThrow('Tool unknown_tool not found');
    });

    it('should return task accepted for valid requests (async execution)', async () => {
      mockHomedir.mockReturnValue('/home/user');
      mockExistsSync.mockReturnValue(true);
      setupServerMock();

      const module = await import('../server.js');
      // @ts-ignore
      const { ClaudeCodeServer } = module;

      const server = new ClaudeCodeServer();
      const mockServerInstance = vi.mocked(Server).mock.results[0].value;

      let callToolHandler: any;
      for (const call of mockServerInstance.setRequestHandler.mock.calls) {
        if (call[0].name === 'callTool') {
          callToolHandler = call[1];
          break;
        }
      }

      // Mock spawn
      mockSpawn.mockImplementation(() => {
        const mockProcess = new EventEmitter() as any;
        mockProcess.stdout = new EventEmitter();
        mockProcess.stderr = new EventEmitter();
        mockProcess.stdout.on = vi.fn();
        mockProcess.stderr.on = vi.fn();
        return mockProcess;
      });

      // Handler should return immediately with task accepted
      const result = await callToolHandler({
        params: {
          name: 'claude_code',
          arguments: {
            prompt: 'test timeout',
            workFolder: '/tmp'
          }
        }
      });

      expect(result.content[0].text).toMatch(/^Task ID: [0-9a-f-]{36}\n/);
      expect(result.content[0].text).toMatch(/Task accepted/);
    });

    it('should handle invalid argument types', async () => {
      mockHomedir.mockReturnValue('/home/user');
      mockExistsSync.mockReturnValue(true);
      setupServerMock();
      const module = await import('../server.js');
      // @ts-ignore
      const { ClaudeCodeServer } = module;

      const server = new ClaudeCodeServer();
      const mockServerInstance = vi.mocked(Server).mock.results[0].value;

      const callToolCall = mockServerInstance.setRequestHandler.mock.calls.find(
        (call: any[]) => call[0].name === 'callTool'
      );

      const handler = callToolCall[1];

      await expect(
        handler({
          params: {
            name: 'claude_code',
            arguments: 'invalid-should-be-object'
          }
        })
      ).rejects.toThrow();
    });
  });

  describe('Process Spawn Error Cases', () => {
    it('should handle spawn ENOENT error', async () => {
      const module = await import('../server.js');
      // @ts-ignore
      const { spawnAsync } = module;
      
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.stdout.on = vi.fn();
      mockProcess.stderr.on = vi.fn();
      
      mockSpawn.mockReturnValue(mockProcess);
      
      const promise = spawnAsync('nonexistent-command', []);
      
      // Simulate ENOENT error
      setTimeout(() => {
        const error: any = new Error('spawn ENOENT');
        error.code = 'ENOENT';
        error.path = 'nonexistent-command';
        error.syscall = 'spawn';
        mockProcess.emit('error', error);
      }, 10);
      
      await expect(promise).rejects.toThrow('Spawn error');
      await expect(promise).rejects.toThrow('nonexistent-command');
    });

    it('should handle generic spawn errors', async () => {
      const module = await import('../server.js');
      // @ts-ignore
      const { spawnAsync } = module;
      
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.stdout.on = vi.fn();
      mockProcess.stderr.on = vi.fn();
      
      mockSpawn.mockReturnValue(mockProcess);
      
      const promise = spawnAsync('test', []);
      
      // Simulate generic error
      setTimeout(() => {
        mockProcess.emit('error', new Error('Generic spawn error'));
      }, 10);
      
      await expect(promise).rejects.toThrow('Generic spawn error');
    });

    it('should accumulate stderr output before error', async () => {
      const module = await import('../server.js');
      // @ts-ignore
      const { spawnAsync } = module;
      
      const mockProcess = new EventEmitter() as any;
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      let stderrHandler: any;
      
      mockProcess.stdout.on = vi.fn();
      mockProcess.stderr.on = vi.fn((event, handler) => {
        if (event === 'data') stderrHandler = handler;
      });
      
      mockSpawn.mockReturnValue(mockProcess);
      
      const promise = spawnAsync('test', []);
      
      // Simulate stderr data then error
      setTimeout(() => {
        stderrHandler('error line 1\n');
        stderrHandler('error line 2\n');
        mockProcess.emit('error', new Error('Command failed'));
      }, 10);
      
      await expect(promise).rejects.toThrow('error line 1\nerror line 2');
    });
  });

  describe('Server Initialization Errors', () => {
    it('should handle CLI path not found gracefully', async () => {
      // Mock no CLI found anywhere
      mockHomedir.mockReturnValue('/home/user');
      mockExistsSync.mockReturnValue(false);
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setupServerMock();
      
      const module = await import('../server.js');
      // @ts-ignore
      const { ClaudeCodeServer } = module;
      
      const server = new ClaudeCodeServer();
      
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Claude CLI not found')
      );
      
      consoleWarnSpy.mockRestore();
    });

    it('should handle server connection errors', async () => {
      mockHomedir.mockReturnValue('/home/user');
      mockExistsSync.mockReturnValue(true);
      setupServerMock();
      const module = await import('../server.js');
      // @ts-ignore
      const { ClaudeCodeServer } = module;
      
      const server = new ClaudeCodeServer();
      
      // Mock connection failure  
      const mockServerInstance = vi.mocked(Server).mock.results[0].value;
      mockServerInstance.connect.mockRejectedValue(new Error('Connection failed'));
      
      const mockTransport = { start: vi.fn(), close: vi.fn(), send: vi.fn() } as any;
      await expect(server.run(mockTransport)).rejects.toThrow('Connection failed');
    });
  });
});