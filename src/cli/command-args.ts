/**
 * The arguments of `/review-bot`. pi hands a command the text after its name
 * as one string, so the launcher quotes each argument and the command splits
 * them again (F-3, R-1a step 3). The rules are a small subset of the POSIX
 * shell's, enough to round-trip any argument: whitespace separates, single
 * quotes take everything literally, double quotes and a backslash outside
 * quotes escape `\` and `"`. Nothing is expanded or executed.
 */

export class CommandArgsError extends Error {
  override name = "CommandArgsError";
}

/** One argument for `/review-bot`, quoted when it needs to be. */
export function quoteCommandArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function quoteCommandArgs(args: readonly string[]): string {
  return args.map(quoteCommandArg).join(" ");
}

/** Split `/review-bot`'s argument text into arguments. Throws `CommandArgsError` on an unclosed quote. */
export function splitCommandArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let inArg = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (inArg) out.push(current);
      current = "";
      inArg = false;
      continue;
    }
    inArg = true;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new CommandArgsError("unclosed ' in the arguments");
      current += text.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && (text[j + 1] === '"' || text[j + 1] === "\\")) j++;
        current += text[j];
      }
      if (j >= text.length) throw new CommandArgsError('unclosed " in the arguments');
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= text.length) throw new CommandArgsError("a trailing \\ in the arguments");
      current += text[++i];
    } else {
      current += c;
    }
  }
  if (inArg) out.push(current);
  return out;
}
