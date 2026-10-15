/**
 * @file Command-line interface: argument parsing, banner, watch mode and startup.
 *
 * Exposes `runCli(argv)` (used by the `mock-server` bin) plus the argument parser
 * for testing. Reloading swaps the underlying server behind a stable facade.
 */

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { watch } from 'node:fs';

import { normalizeConfig, MockConfigError } from './config.js';
import { loadConfigFile, resolveConfigPath, serve } from './node.js';
import type { NodeServer } from './node.js';
import { buildServer, routeLabels } from './server.js';
import { VERSION } from './version.js';
import type { MockServer, MockServerConfig } from './types.js';

/* -------------------------------------------------------------------------- */
/*  ANSI helpers                                                              */
/* -------------------------------------------------------------------------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (t: string) => paint('2', t);
const bold = (t: string) => paint('1', t);
const cyan = (t: string) => paint('36', t);
const green = (t: string) => paint('32', t);
const yellow = (t: string) => paint('33', t);
const red = (t: string) => paint('31', t);

/* -------------------------------------------------------------------------- */
/*  Argument parsing                                                          */
/* -------------------------------------------------------------------------- */

interface ParsedArgs {
  configPath?: string;
  port?: number;
  host?: string;
  basePath?: string;
  latency?: number;
  errorRate?: number;
  seed?: number;
  cors?: boolean;
  log?: string;
  json?: boolean;
  watch?: boolean;
  init?: string;
  help?: boolean;
  version?: boolean;
}

const HELP = `
${bold('mock-server')} ${dim(`v${VERSION}`)} — zero-config REST & GraphQL mocking

${bold('Usage')}
  mock-server [config] [options]

${bold('Options')}
  -p, --port <n>         Port to listen on                (default 4000)
  -H, --host <host>      Host/interface to bind           (default 0.0.0.0)
      --base-path <path> Prefix stripped before matching
      --latency <ms>     Fixed latency added to every response
      --error-rate <0-1> Fraction of requests that error
      --seed <n>         Deterministic seed for jitter/faker
      --no-cors          Disable CORS headers
      --log <level>      silent | error | info | debug     (default info)
      --json             Emit logs as JSON
  -w, --watch            Reload when the config file changes
      --init [file]      Write a starter config and exit  (default mock.config.json)
  -h, --help             Show this help
  -v, --version          Show the version

${bold('Examples')}
  mock-server                          ${dim('# zero-config demo API')}
  mock-server mock.config.ts           ${dim('# explicit config file')}
  mock-server --port 8080 --latency 200 --error-rate 0.1
  mock-server --init mock.config.ts    ${dim('# scaffold a config')}
`;

/** Parse `process.argv`-style arguments into structured CLI options. */
function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  const needValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) throw new MockConfigError(`Option ${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];

    if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg === '-v' || arg === '--version') args.version = true;
    else if (arg === '-w' || arg === '--watch') args.watch = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--no-cors') args.cors = false;
    else if (arg === '-p' || arg === '--port') args.port = Number(needValue(arg, next)), i++;
    else if (arg === '-H' || arg === '--host') args.host = needValue(arg, next), i++;
    else if (arg === '--base-path') args.basePath = needValue(arg, next), i++;
    else if (arg === '--latency') args.latency = Number(needValue(arg, next)), i++;
    else if (arg === '--error-rate') args.errorRate = Number(needValue(arg, next)), i++;
    else if (arg === '--seed') args.seed = Number(needValue(arg, next)), i++;
    else if (arg === '--log') args.log = needValue(arg, next), i++;
    else if (arg === '--init') {
      // Optional value: only consume the next token when it isn't a flag.
      if (next && !next.startsWith('-')) {
        args.init = next;
        i++;
      } else {
        args.init = 'mock.config.json';
      }
    } else if (arg.startsWith('--')) {
      throw new MockConfigError(`Unknown option: ${arg}`);
    } else if (!args.configPath) {
      args.configPath = arg;
    } else {
      throw new MockConfigError(`Unexpected argument: ${arg}`);
    }
  }

  return args;
}

function applyOverrides(config: MockServerConfig, args: ParsedArgs): void {
  if (args.port !== undefined) config.port = args.port;
  if (args.host !== undefined) config.host = args.host;
  if (args.basePath !== undefined) config.basePath = args.basePath;
  if (args.seed !== undefined) config.seed = args.seed;
  if (args.latency !== undefined) config.latency = { distribution: 'fixed', fixed: args.latency };
  if (args.errorRate !== undefined) config.errorRate = args.errorRate;
  if (args.cors === false) config.cors = false;
  if (args.log !== undefined) config.log = args.log as MockServerConfig['log'];
  if (args.json) config.logFormat = 'json';
}

/* -------------------------------------------------------------------------- */
/*  Starter config                                                            */
/* -------------------------------------------------------------------------- */

const STARTER_CONFIG = {
  name: 'my-mock-api',
  port: 4000,
  latency: { distribution: 'uniform', min: 20, max: 120 },
  errors: { rate: 0, statuses: [500, 503] },
  cors: true,
  routes: [
    {
      method: 'GET',
      path: '/users',
      body: [
        { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' },
        { id: 2, name: 'Alan Turing', email: 'alan@example.com' },
      ],
    },
    {
      method: 'GET',
      path: '/users/:id',
      body: { id: '{{ params.id }}', name: '{{ faker.fullName }}', email: '{{ faker.email }}' },
      rules: [
        {
          when: { query: { id: '999' } },
          status: 404,
          body: { error: 'Not Found', id: '{{ params.id }}' },
        },
      ],
    },
    {
      method: 'POST',
      path: '/users',
      status: 201,
      body: { id: '{{ faker.id }}', name: '{{ body.name }}', createdAt: '{{ now }}' },
    },
  ],
  graphql: {
    data: {
      users: [{ id: '1', name: 'Ada Lovelace' }],
      viewer: { id: '1', name: 'Ada Lovelace' },
    },
  },
};

async function runInit(file: string): Promise<void> {
  const target = path.resolve(process.cwd(), file);
  if (existsSync(target)) {
    console.error(red(`✗ ${path.basename(target)} already exists — not overwriting.`));
    process.exitCode = 1;
    return;
  }
  await writeFile(target, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, 'utf8');
  console.log(`${green('✓')} Created ${cyan(path.relative(process.cwd(), target) || file)}`);
  console.log(dim(`  Start it with: mock-server ${file}`));
}

/* -------------------------------------------------------------------------- */
/*  Banner                                                                    */
/* -------------------------------------------------------------------------- */

function printBanner(server: MockServer, url: string, configPath: string | null, isDemo: boolean): void {
  const { config } = server;
  const lines: string[] = [];

  lines.push('');
  lines.push(`  ${bold('mock-server')} ${dim(`v${VERSION}`)}  ${cyan(config.name)}`);
  lines.push(`  ${green('●')} ${bold(url)}`);
  if (isDemo) {
    lines.push(`  ${yellow('no config found')} ${dim('— running the built-in demo API')}`);
    lines.push(`  ${dim('scaffold one with:')} mock-server --init`);
  } else if (configPath) {
    lines.push(`  ${dim('config:')} ${configPath}`);
  }
  lines.push(`  ${dim(`latency: ${describeLatency(config.latency)}${config.errors ? ` · errors: ${Math.round(config.errors.rate * 100)}%` : ''} · seed: ${config.seed}`)}`);
  lines.push('');

  const labels = routeLabels(server);
  if (labels.length === 0) {
    lines.push(dim('  (no routes declared)'));
  } else {
    lines.push(dim('  routes'));
    for (const label of labels) {
      const [methods, routePath] = label.split(' ');
      lines.push(`    ${green((methods ?? '').padEnd(12))} ${routePath}`);
    }
  }
  lines.push('');
  console.log(lines.join('\n'));
}

function describeLatency(latency: MockServer['config']['latency']): string {
  if (latency.distribution === 'uniform') return `${latency.min ?? 0}-${latency.max ?? 0}ms`;
  if (latency.distribution === 'normal') return `~${latency.mean ?? 0}ms`;
  if (latency.distribution === 'exponential') return `~${latency.mean ?? 0}ms (exp)`;
  return `${latency.fixed ?? 0}ms`;
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

/** Run the CLI to completion: handle help/version/init, otherwise serve. */
export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }
  if (args.init) {
    await runInit(args.init);
    return;
  }

  const loaded = await loadConfigFile(args.configPath);
  applyOverrides(loaded.config, args);

  let current = buildServer(normalizeConfig(loaded.config));

  // A stable facade so config reloads can swap the underlying server in place.
  const facade: MockServer = {
    get config() {
      return current.config;
    },
    get routes() {
      return current.routes;
    },
    get state() {
      return current.state;
    },
    handler: (request) => current.handler(request),
    reset: () => current.reset(),
  };

  const nodeServer = await serve(facade, {
    onReady: ({ url }) => printBanner(facade, url, loaded.path, loaded.isDemo),
  });

  let watcher: ReturnType<typeof watch> | undefined;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;

  if (args.watch && loaded.path) {
    const configPath = loaded.path;
    watcher = watch(configPath, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        void (async () => {
          try {
            const fresh = await loadConfigFile(configPath);
            applyOverrides(fresh.config, args);
            current = buildServer(normalizeConfig(fresh.config));
            console.log(`${green('↻')} reloaded ${dim(path.basename(configPath))}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`${red('✗')} reload failed: ${message}`);
          }
        })();
      }, 100);
    });
    console.log(dim(`  watching ${path.basename(configPath)} for changes\n`));
  } else if (args.watch) {
    console.log(dim('  --watch ignored: no config file to watch\n'));
  }

  const shutdown = () => {
    void (async () => {
      watcher?.close();
      if (reloadTimer) clearTimeout(reloadTimer);
      await closeServer(nodeServer);
      process.exit(0);
    })();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function closeServer(server: NodeServer): Promise<void> {
  await server.close();
}

export { parseArgs, resolveConfigPath };
