const PREFIX = '[Pug SDK]'

const safeConsole =
  (method: 'warn' | 'error' | 'debug') =>
  (msg: string, ...args: unknown[]): void => {
    if (typeof console !== 'undefined' && typeof console[method] === 'function') {
      console[method](`${PREFIX} ${msg}`, ...args)
    }
  }

export const log = {
  warn: safeConsole('warn'),
  error: safeConsole('error'),
  debug: safeConsole('debug'),
}
