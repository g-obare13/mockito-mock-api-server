/**
 * @file Node.js adapter: HTTP server, config discovery/loading and file bodies.
 *
 * Wraps the runtime-agnostic core in a `node:http` server and provides
 * `loadConfig`/`loadConfigFile` for JSON and TS/JS config files. This is the only
 * module that touches Node built-ins, keeping the core portable.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { MockConfigError, demoConfig, normalizeConfig } from './config.js';
import { CONNECTION_CONTROL, buildResponse } from './response.js';
import type { WithConnection } from './response.js';
import { buildServer } from './server.js';
import type { MockServer, MockServerConfig, NormalizedConfig, RouteConfig } from './types.js';

/* -------------------------------------------------------------------------- */
/*  Config loading                                                            */
/* -------------------------------------------------------------------------- */

const CONFIG_CANDIDATES = [
  'mock.config.ts',
  'mock.config.mts',
  'mock.config.js',
  'mock.config.mjs',
  'mock.config.cjs',
  'mock.config.json',
  'mock-server.config.ts',
  'mock-server.config.js',
  'mock-server.config.json',
  '.mockrc.json',
  '.mockrc',
];

export interface LoadedConfig {
  config: MockServerConfig;
  /** Absolute path of the loaded file, or `null` when the demo config is used. */
  path: string | null;
  /** Directory used to resolve relative `file` bodies. */
  dir: string;
  /** True when no config file was found and the built-in demo was used. */
  isDemo: boolean;
}

/** Find the first config file in `cwd`, or `null`. */
export function resolveConfigPath(cwd: string = process.cwd()): string | null {
  for (const candidate of CONFIG_CANDIDATES) {
    const full = path.resolve(cwd, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

async function importModule(file: string): Promise<unknown> {
  const url = `${pathToFileURL(file).href}?mtime=${Date.now()}`;
  try {
    const mod = (await import(url)) as { default?: unknown } & Record<string, unknown>;
    return mod.default ?? mod;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new MockConfigError(
        `Cannot load "${path.basename(file)}": this Node version needs type stripping for .ts configs.\n` +
          `Run with "node --experimental-strip-types" or use Node 22.18+/24+, or switch to a .js/.json config.`,
      );
    }
    throw error;
  }
}

async function loadRaw(file: string): Promise<MockServerConfig> {
  if (file.endsWith('.json') || path.basename(file) === '.mockrc') {
    const text = await readFile(file, 'utf8');
    try {
      return JSON.parse(text) as MockServerConfig;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MockConfigError(`Failed to parse JSON config "${file}": ${message}`);
    }
  }

  const loaded = await importModule(file);
  if (typeof loaded === 'function') {
    return (await (loaded as () => MockServerConfig | Promise<MockServerConfig>)());
  }
  return (loaded ?? {}) as MockServerConfig;
}

const TEXT_EXTENSIONS = new Set([
  '.json', '.txt', '.text', '.csv', '.md', '.markdown', '.html', '.htm',
  '.xml', '.svg', '.css', '.js', '.ts', '.yaml', '.yml',
]);

/** Read an external `file` body for a route (relative to the config directory). */
async function resolveFileBody(route: RouteConfig, dir: string): Promise<void> {
  if (!route.file || route.body !== undefined) return;
  const target = path.resolve(dir, route.file);
  try {
    const ext = path.extname(target).toLowerCase();
    if (ext === '.json') {
      const text = await readFile(target, 'utf8');
      route.body = JSON.parse(text);
    } else if (TEXT_EXTENSIONS.has(ext)) {
      route.body = await readFile(target, 'utf8');
    } else {
      // Binary file (images, PDF, audio, zip, etc.)
      const buf = await readFile(target);
      route.body = new Uint8Array(buf);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MockConfigError(`Route "${route.path}" could not read file "${route.file}": ${message}`);
  }
}

/** Load a raw config (without normalization) plus its resolved path. */
export async function loadConfigFile(configPath?: string, cwd: string = process.cwd()): Promise<LoadedConfig> {
  const resolved = configPath ? path.resolve(cwd, configPath) : resolveConfigPath(cwd);

  if (!resolved) {
    return { config: demoConfig(), path: null, dir: cwd, isDemo: true };
  }
  if (!existsSync(resolved)) {
    throw new MockConfigError(`Config file not found: ${resolved}`);
  }

  const config = await loadRaw(resolved);
  const dir = path.dirname(resolved);

  for (const route of config.routes ?? []) {
    await resolveFileBody(route, dir);
  }

  return { config, path: resolved, dir, isDemo: false };
}

/** Load and fully normalize a config, falling back to the demo config. */
export async function loadConfig(configPath?: string, cwd: string = process.cwd()): Promise<NormalizedConfig> {
  const { config } = await loadConfigFile(configPath, cwd);
  return normalizeConfig(config);
}

/* -------------------------------------------------------------------------- */
/*  Node HTTP adapter                                                         */
/* -------------------------------------------------------------------------- */

export interface ServeOptions {
  port?: number;
  host?: string;
  /** Called once the server is listening. */
  onReady?: (info: { url: string; port: number; host: string }) => void;
  /** Called after every request (useful for tests/metrics). */
  onResponse?: (info: { method: string; path: string; status: number }) => void;
}

export interface NodeServer {
  server: Server;
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

function toDisplayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '' ? 'localhost' : host;
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toWebRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(req.url ?? '/', origin);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const method = (req.method ?? 'GET').toUpperCase();
  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const buffer = await readRequestBody(req);
    if (buffer.length > 0) body = buffer;
  }

  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (body) {
    init.body = body as unknown as BodyInit;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function writeWebResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
): Promise<void> {
  const control = (response as unknown as WithConnection)[CONNECTION_CONTROL];

  if (control === 'reset') {
    res.socket?.destroy();
    return;
  }
  if (control === 'close') {
    res.socket?.end();
    return;
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    try {
      res.setHeader(key, value);
    } catch {
      // Ignore invalid header names produced by user config.
    }
  });

  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'HEAD' || response.status === 204 || response.status === 304) {
    res.end();
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

/** Start a Node `http` server backed by a mock server's Web handler. */
export function serve(server: MockServer, options: ServeOptions = {}): Promise<NodeServer> {
  const port = options.port ?? server.config.port;
  const host = options.host ?? server.config.host;

  const httpServer = createServer((req, res) => {
    void (async () => {
      const origin = `http://${req.headers.host ?? `${host}:${port}`}`;
      try {
        const request = await toWebRequest(req, origin);
        const response = await server.handler(request);
        await writeWebResponse(req, res, response);
        options.onResponse?.({
          method: req.method ?? 'GET',
          path: new URL(request.url).pathname,
          status: response.status,
        });
      } catch (error) {
        if (res.headersSent || res.writableEnded) return;
        const message = error instanceof Error ? error.message : String(error);
        const fallback = buildResponse({
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: { error: 'Internal Mock Server Error', message },
        });
        await writeWebResponse(req, res, fallback);
      }
    })();
  });

  return new Promise<NodeServer>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const url = `http://${toDisplayHost(host)}:${actualPort}`;
      options.onReady?.({ url, port: actualPort, host });
      resolve({
        server: httpServer,
        url,
        port: actualPort,
        host,
        close: () =>
          new Promise<void>((done) => {
            httpServer.close(() => done());
            httpServer.closeAllConnections?.();
          }),
      });
    });
  });
}

export { MockConfigError } from './config.js';
export { buildServer } from './server.js';
export type { MockServer, MockServerConfig, NormalizedConfig } from './types.js';
