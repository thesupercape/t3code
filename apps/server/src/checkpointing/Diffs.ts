export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Parse Git's unified patch output without depending on a renderer parser. */
export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const files: TurnDiffFileSummary[] = [];
  let current: TurnDiffFileSummary | undefined;
  let additions = 0;
  let deletions = 0;
  let sawHunk = false;

  const finish = () => {
    if (current !== undefined) {
      files.push({ ...current, additions, deletions });
    }
    current = undefined;
    additions = 0;
    deletions = 0;
    sawHunk = false;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finish();
      const path = line.slice("diff --git ".length).split(" ").at(-1)?.replace(/^b\//, "");
      current = path === undefined ? undefined : { path, additions: 0, deletions: 0 };
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("rename to ")) {
      current = { ...current, path: line.slice("rename to ".length) };
      continue;
    }
    if (line.startsWith("+++ ") && !sawHunk) {
      const path = line.slice(4).replace(/^b\//, "");
      if (path !== "/dev/null") current = { ...current, path };
      continue;
    }
    if (line.startsWith("@@ ")) {
      sawHunk = true;
      continue;
    }
    if (!sawHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  finish();
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

/** Reads Git's NUL-delimited numstat output without decoding display paths. */
export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;

    let path = record.slice(counts[0].length);
    if (path.length === 0) {
      // Renames and copies use two more records: the source and destination.
      path = records[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;

    files.push({
      path,
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}
