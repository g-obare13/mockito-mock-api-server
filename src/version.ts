/**
 * @file Single source of truth for the package version.
 *
 * Kept as a runtime constant (rather than reading `package.json`) so the CLI and
 * library can report a version without filesystem access, which keeps the core
 * bundle portable across runtimes.
 */

/** The published package version, mirrored in `package.json`. */
export const VERSION = '0.1.0';
