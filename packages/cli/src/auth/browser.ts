import { spawn } from 'node:child_process'

/** Opens a URL in the default browser. Resolves false when no browser could be started. */
export function openBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]]
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args as string[], { stdio: 'ignore', detached: true })
      child.on('error', () => resolve(false))
      child.on('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}
