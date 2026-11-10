/** One literal argument for a POSIX shell, including embedded single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
