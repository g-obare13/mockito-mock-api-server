import type { Rng } from './random.js';

/**
 * A tiny, dependency-free generator library used by the `{{ faker.* }}`
 * template helper. Not a full Faker.js replacement — just the ~50 generators
 * that cover the overwhelming majority of mock-data needs, with a registry so
 * consumers can add their own.
 */

export type FakerFn = (rng: Rng, args: string[]) => unknown;

const FIRST_NAMES = [
  'Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken',
  'Radia', 'Tim', 'Katherine', 'Guido', 'Anita', 'Bjarne', 'Jean', 'Donald',
  'Adele', 'Frida', 'Ingrid', 'Mateo', 'Yuki', 'Amara', 'Noor', 'Sofia',
];

const LAST_NAMES = [
  'Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov',
  'Thompson', 'Perlman', 'Berners-Lee', 'Johnson', 'Rossum', 'Borg', 'Stroustrup',
  'Knuth', 'Okafor', 'Nakamura', 'Fernandez', 'Kaur', 'Novak', 'Mbeki', 'Larsen',
];

const CITIES = [
  'Lagos', 'Nairobi', 'Accra', 'Tokyo', 'Berlin', 'Lisbon', 'Toronto', 'Austin',
  'Oslo', 'Seoul', 'Cairo', 'Lima', 'Dublin', 'Prague', 'Mumbai', 'Sydney',
];

const COUNTRIES: Array<[string, string]> = [
  ['Nigeria', 'NG'], ['Kenya', 'KE'], ['Ghana', 'GH'], ['Japan', 'JP'],
  ['Germany', 'DE'], ['Portugal', 'PT'], ['Canada', 'CA'], ['United States', 'US'],
  ['Norway', 'NO'], ['South Korea', 'KR'], ['Egypt', 'EG'], ['Peru', 'PE'],
  ['Ireland', 'IE'], ['Czechia', 'CZ'], ['India', 'IN'], ['Australia', 'AU'],
];

const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
  'yankee', 'zulu', 'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur',
];

const COMPANY_SUFFIX = ['Labs', 'Systems', 'Group', 'Works', 'Industries', 'Digital', 'Collective'];
const STREET_SUFFIX = ['Street', 'Avenue', 'Road', 'Boulevard', 'Lane', 'Way'];
const DOMAINS = ['example.com', 'test.dev', 'mock.io', 'acme.co', 'sample.net'];
const JOB_TITLES = [
  'Software Engineer', 'Product Manager', 'Designer', 'Data Scientist',
  'DevOps Engineer', 'Engineering Manager', 'QA Engineer', 'Solutions Architect',
];

const HEX = '0123456789abcdef';

function hex(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += HEX[Math.floor(rng() * 16)];
  return out;
}

function num(args: string[], index: number, fallback: number): number {
  const raw = args[index];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pickArgs(rng: Rng, args: string[], fallback: readonly string[]): string {
  if (args.length > 0) return args[Math.floor(rng() * args.length)]!;
  return rng.pick(fallback);
}

function words(rng: Rng, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(rng.pick(WORDS));
  return out;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Built-in generators. Keys are matched case-insensitively and hyphen-insensitively. */
export const builtinFakers: Record<string, FakerFn> = {
  firstName: (rng) => rng.pick(FIRST_NAMES),
  lastName: (rng) => rng.pick(LAST_NAMES),
  fullName: (rng, args) => `${pickArgs(rng, args, FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
  name: (rng, args) => `${pickArgs(rng, args, FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
  email: (rng) =>
    `${rng.pick(FIRST_NAMES).toLowerCase()}.${rng.pick(LAST_NAMES).toLowerCase().replace(/[^a-z]/g, '')}@${rng.pick(DOMAINS)}`.toLowerCase(),
  username: (rng) => `${rng.pick(FIRST_NAMES).toLowerCase()}${rng.int(1, 999)}`,
  phone: (rng) => `+${rng.int(1, 99)} ${rng.int(100, 999)} ${rng.int(100, 999)} ${rng.int(1000, 9999)}`,

  uuid: (rng) => {
    const bytes = Array.from({ length: 16 }, () => rng.int(0, 255));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const h = bytes.map((b) => b.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
  },
  id: (rng, args) => rng.int(num(args, 0, 1), num(args, 1, 100000)),
  int: (rng, args) => rng.int(num(args, 0, 0), num(args, 1, 1000)),
  number: (rng, args) => rng.int(num(args, 0, 0), num(args, 1, 1000)),
  float: (rng, args) => Number(rng.float(num(args, 0, 0), num(args, 1, 1)).toFixed(4)),
  decimal: (rng, args) => Number(rng.float(num(args, 0, 0), num(args, 1, 1000)).toFixed(num(args, 2, 2))),
  bool: (rng) => rng.bool(),
  boolean: (rng) => rng.bool(),
  price: (rng, args) => Number(rng.float(num(args, 0, 1), num(args, 1, 999)).toFixed(2)),

  date: (rng, args) => {
    const from = args[0] ? Date.parse(args[0]) : Date.now() - 1000 * 60 * 60 * 24 * 365;
    const to = args[1] ? Date.parse(args[1]) : Date.now();
    const ts = Number.isFinite(from) && Number.isFinite(to) ? rng.int(from, to) : Date.now();
    return new Date(ts).toISOString().slice(0, 10);
  },
  isoDate: (rng) => new Date(rng.int(Date.now() - 31536000000, Date.now())).toISOString(),
  time: (rng) => new Date(rng.int(0, 86399999)).toISOString().slice(11, 19),
  timestamp: (rng) => rng.int(Date.now() - 31536000000, Date.now()),

  url: (rng) => `https://${rng.pick(DOMAINS)}/${rng.pick(WORDS)}`,
  domain: (rng) => rng.pick(DOMAINS),
  ipv4: (rng) => `${rng.int(1, 254)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
  ipv6: (rng) => Array.from({ length: 8 }, () => hex(rng, 4)).join(':'),
  mac: (rng) => Array.from({ length: 6 }, () => hex(rng, 2)).join(':'),

  city: (rng) => rng.pick(CITIES),
  country: (rng) => rng.pick(COUNTRIES)[0],
  countryCode: (rng) => rng.pick(COUNTRIES)[1],
  zip: (rng) => String(rng.int(10000, 99999)),
  postalCode: (rng) => String(rng.int(10000, 99999)),
  street: (rng) => `${rng.int(1, 999)} ${capitalize(rng.pick(WORDS))} ${rng.pick(STREET_SUFFIX)}`,
  address: (rng) => `${rng.int(1, 999)} ${capitalize(rng.pick(WORDS))} ${rng.pick(STREET_SUFFIX)}, ${rng.pick(CITIES)}`,
  latitude: (rng) => Number(rng.float(-90, 90).toFixed(6)),
  longitude: (rng) => Number(rng.float(-180, 180).toFixed(6)),

  company: (rng) => `${capitalize(rng.pick(WORDS))} ${rng.pick(COMPANY_SUFFIX)}`,
  jobTitle: (rng) => rng.pick(JOB_TITLES),
  slug: (rng) => words(rng, rng.int(2, 4)).join('-'),
  word: (rng) => rng.pick(WORDS),
  words: (rng, args) => words(rng, num(args, 0, rng.int(3, 8))).join(' '),
  sentence: (rng) => `${capitalize(words(rng, rng.int(6, 12)).join(' '))}.`,
  paragraph: (rng, args) => {
    const count = num(args, 0, rng.int(2, 4));
    return Array.from({ length: count }, () => `${capitalize(words(rng, rng.int(6, 12)).join(' '))}.`).join(' ');
  },

  color: (rng) => `#${hex(rng, 6)}`,
  hexColor: (rng) => `#${hex(rng, 6)}`,
  avatar: (rng) => `https://i.pravatar.cc/150?u=${hex(rng, 8)}`,
  image: (rng, args) => `https://picsum.photos/${num(args, 0, 640)}/${num(args, 1, 480)}?random=${rng.int(1, 10000)}`,
  token: (rng) => hex(rng, 32),
  password: (rng) => `${capitalize(rng.pick(WORDS))}${rng.int(1000, 9999)}!`,
  currency: (rng) => rng.pick(['USD', 'EUR', 'GBP', 'NGN', 'KES', 'JPY']),
  pick: (rng, args) => (args.length ? args[Math.floor(rng() * args.length)] : null),
  random: (rng) => rng(),
  now: () => new Date().toISOString(),
};

const registry: Record<string, FakerFn> = { ...builtinFakers };

/** Normalise `my-generator` / `MyGenerator` to a consistent lookup key. */
function normalizeKey(name: string): string {
  return name.replace(/[-_\s]/g, '').toLowerCase();
}

const lookup: Map<string, FakerFn> = new Map(
  Object.entries(registry).map(([key, fn]) => [normalizeKey(key), fn]),
);

/** Register (or replace) a custom generator usable as `{{ faker.yourName(...) }}`. */
export function registerFaker(name: string, fn: FakerFn): void {
  registry[name] = fn;
  lookup.set(normalizeKey(name), fn);
}

/** `true` when a generator with this name is registered. */
export function hasFaker(name: string): boolean {
  return lookup.has(normalizeKey(name));
}

/** Resolve a generator by name and invoke it with the given raw string args. */
export function fakerValue(name: string, args: string[], rng: Rng): unknown {
  const fn = lookup.get(normalizeKey(name));
  if (!fn) return undefined;
  return fn(rng, args);
}

/** Reset the faker registry back to the built-in generators. */
export function resetFakers(): void {
  for (const key of Object.keys(registry)) {
    if (!(key in builtinFakers)) delete registry[key];
  }
  lookup.clear();
  for (const [key, fn] of Object.entries(builtinFakers)) {
    registry[key] = fn;
    lookup.set(normalizeKey(key), fn);
  }
}

/** List all registered generator names, sorted. */
export function listFakers(): string[] {
  return Object.keys(registry).sort();
}
