const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const at = () => new Date().toISOString();

export const log = {
  info: (...a: unknown[]) => console.log(dim(`${at()} [hq]`), ...a),
  warn: (...a: unknown[]) => console.warn(`${at()} \x1b[33m[hq]\x1b[0m`, ...a),
  error: (...a: unknown[]) => console.error(`${at()} \x1b[31m[hq]\x1b[0m`, ...a),
};
