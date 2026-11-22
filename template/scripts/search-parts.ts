import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CONCURRENCY = 4;
const MAX_LINES_PER_QUERY = 12;

interface SearchResult {
  query: string;
  output: string;
  ok: boolean;
}

async function searchPart(query: string): Promise<SearchResult> {
  try {
    const { stdout, stderr } = await execFileAsync("tscircuit-cli", ["search", query], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    const lines = (stdout || stderr)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(0, MAX_LINES_PER_QUERY);

    return { query, output: lines.join("\n") || "(no matches)", ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { query, output: `ERROR: ${message}`, ok: false };
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

async function main(): Promise<void> {
  const queries = process.argv.slice(2).filter((q) => q.trim().length > 0);
  if (queries.length === 0) {
    console.error("Usage: just search <query1> [query2 ...]");
    process.exit(1);
  }

  const results = await mapConcurrent(queries, MAX_CONCURRENCY, searchPart);
  let failed = 0;

  for (const result of results) {
    console.log(`\n### ${result.query}`);
    console.log(result.output);
    if (!result.ok) failed += 1;
  }

  if (failed > 0) process.exit(1);
}

await main();
