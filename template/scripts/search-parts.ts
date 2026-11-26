import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadSpec } from "../checks/index";

const execFileAsync = promisify(execFile);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.PARTS_SEARCH_CONCURRENCY) || 1);
const MAX_LINES_PER_QUERY = 12;

interface SearchResult {
  query: string;
  output: string;
  ok: boolean;
}

interface JlcComponent {
  lcsc: number;
  mfr?: string;
  package?: string;
  description?: string;
  is_basic?: boolean;
  stock?: number | null;
  price?: number | null;
}

async function searchLcscDirect(code: string): Promise<SearchResult | null> {
  try {
    const res = await fetch(
      `https://jlcsearch.tscircuit.com/api/search?q=${encodeURIComponent(code)}&limit=5`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { components?: JlcComponent[] };
    const comps = data.components ?? [];
    if (comps.length === 0) return { query: code, output: "(no matches)", ok: true };

    const lines = comps.slice(0, MAX_LINES_PER_QUERY).map((c) => {
      const tier = c.is_basic ? "Basic" : "Extended";
      const stock = typeof c.stock === "number" ? `${c.stock} in stock` : "stock unknown";
      const price = typeof c.price === "number" ? `$${c.price}` : "price n/a";
      return `C${c.lcsc} | ${c.mfr ?? "?"} | ${c.package ?? "?"} | ${tier} | ${price} | ${stock} | ${c.description ?? ""}`.trim();
    });
    return { query: code, output: lines.join("\n"), ok: true };
  } catch {
    return null;
  }
}

async function searchPart(query: string): Promise<SearchResult> {
  if (/^C\d+$/i.test(query.trim())) {
    const direct = await searchLcscDirect(query.trim().toUpperCase());
    if (direct) return direct;
  }

  try {
    const existingNodeOpts = process.env.NODE_OPTIONS ?? "";
    const nodeOptions = existingNodeOpts.includes("--max-old-space-size")
      ? existingNodeOpts
      : `${existingNodeOpts} --max-old-space-size=1024`.trim();

    const { stdout, stderr } = await execFileAsync("tscircuit-cli", ["search", query], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    });

    const lines = (stdout || stderr)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(0, MAX_LINES_PER_QUERY);

    return { query, output: lines.join("\n") || "(no matches)", ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr =
      typeof err === "object" && err !== null && "stderr" in err ? String(err.stderr ?? "") : "";
    const combined = `${message}\n${stderr}`;

    // Upstream `@tscircuit/cli search` crashes when a raw LCSC C-number has null stock.
    if (combined.includes("toLocaleString") && /^C\d+$/i.test(query.trim())) {
      return {
        query,
        output: `(tsci search hit upstream null-stock bug for ${query}; use \`tsci import "${query}"\` directly)`,
        ok: true,
      };
    }

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

async function verifyBom(specPath = "specs/board.spec.json"): Promise<void> {
  const spec = loadSpec(specPath);
  const entries = Object.entries(spec.budget.bomCosts);
  if (entries.length === 0) {
    console.log("No entries in specs/board.spec.json -> budget.bomCosts.");
    return;
  }

  let issues = 0;
  const lcscToDesignators = new Map<string, string[]>();

  for (const [designator, entry] of entries) {
    if (!entry.mpn) {
      console.warn(`[WARN] ${designator}: missing MPN`);
      issues += 1;
    }
    if (!entry.lcsc) {
      console.warn(`[WARN] ${designator}: missing LCSC part number`);
      issues += 1;
    } else if (!/^C\d+$/i.test(entry.lcsc.trim())) {
      console.warn(
        `[WARN] ${designator}: malformed LCSC part number "${entry.lcsc}" (expected C<digits>)`,
      );
      issues += 1;
    } else {
      const code = entry.lcsc.trim().toUpperCase();
      const list = lcscToDesignators.get(code) ?? [];
      list.push(designator);
      lcscToDesignators.set(code, list);
    }
  }

  const uniqueCodes = [...lcscToDesignators.keys()];
  console.log(
    `[PARTS] Auditing ${entries.length} BOM designator(s), ${uniqueCodes.length} unique LCSC part(s)...`,
  );

  if (uniqueCodes.length > 0) {
    const results = await mapConcurrent(uniqueCodes, MAX_CONCURRENCY, searchPart);
    for (const result of results) {
      const refs = lcscToDesignators.get(result.query)?.join(", ") ?? "";
      console.log(`\n### ${result.query} (${refs})`);
      console.log(result.output);
      if (!result.ok || result.output === "(no matches)") issues += 1;
    }
  }

  if (issues > 0) {
    console.error(`\n[PARTS] BOM verification completed with ${issues} issue(s).`);
    process.exit(1);
  }
  console.log("\n[PARTS] BOM verification passed.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((q) => q.trim().length > 0);
  if (args[0] === "--check-bom") {
    await verifyBom(args[1] ?? "specs/board.spec.json");
    return;
  }

  if (args.length === 0) {
    console.error("Usage: just parts-search <query1> [query2 ...] | just parts-verify");
    process.exit(1);
  }

  const results = await mapConcurrent(args, MAX_CONCURRENCY, searchPart);
  let failed = 0;

  for (const result of results) {
    console.log(`\n### ${result.query}`);
    console.log(result.output);
    if (!result.ok) failed += 1;
  }

  if (failed > 0) process.exit(1);
}

await main();
