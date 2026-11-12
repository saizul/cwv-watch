/** Remove API keys and bot tokens from strings before they reach logs or reports. */
export function redact(text: string, secrets: Iterable<string | undefined> = []): string {
  let out = text
    .replace(/([?&]key=)[^&#\s]+/gi, '$1REDACTED')
    .replace(/(api\.telegram\.org\/bot)[^/\s]+/gi, '$1REDACTED')
    .replace(/(hooks\.slack\.com\/services\/)[^\s"']+/gi, '$1REDACTED');
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('REDACTED');
  }
  return out;
}
