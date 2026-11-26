type LogLevel = 'warn' | 'error'

function toText(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack ?? arg.message
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

function send(level: LogLevel, args: unknown[]): void {
  const write = window.petAPI?.log ?? window.settingsAPI?.log
  if (!write) return
  write(level, toText(args).slice(0, 2000))
}

/** 渲染进程告警：控制台照常输出，同时转给主进程写进 logs/pet.log */
export function logWarn(...args: unknown[]): void {
  console.warn(...args)
  send('warn', args)
}

/** 渲染进程错误：同上，按错误级别记录 */
export function logError(...args: unknown[]): void {
  console.error(...args)
  send('error', args)
}
