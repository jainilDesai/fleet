/**
 * Parses a CLI's JSON output, ignoring anything printed before or after it
 * (a CLI can add a notice, e.g. about an update, to the same output). Null when
 * there's no valid JSON object in it.
 */
export function parseCliJson<T>(text: string): T | null {
  // An object or an array, whichever starts first.
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i !== -1);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = text.lastIndexOf(text[start] === "{" ? "}" : "]");
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

