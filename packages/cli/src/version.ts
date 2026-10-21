import pkg from '../package.json' with { type: 'json' }

declare const __ZETTA_VERSION__: string | undefined

/**
 * The CLI version. Release builds inject it with `--define __ZETTA_VERSION__=...`;
 * running from source falls back to the package version.
 */
export const VERSION: string =
  typeof __ZETTA_VERSION__ === 'string' ? __ZETTA_VERSION__ : pkg.version
