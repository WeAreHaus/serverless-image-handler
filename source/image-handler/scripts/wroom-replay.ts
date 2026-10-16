// Haus (Wroom): replay comparison between live Wroom and this code run locally.
// Usage (from source/image-handler):
//   npx ts-node scripts/wroom-replay.ts <sample.json> <out-dir> [live-base-url]
// sample.json comes from docs/plans/wroom-tools/sample_paths.py. Each path is requested twice (Accept image/webp and
// */*) from live Wroom and from the local handler, then status, format, dimensions and size are compared.

import fs from "fs";
import path from "path";
import sharp from "sharp";

process.env.AUTO_WEBP = "Yes";
process.env.SOURCE_BUCKETS = process.env.SOURCE_BUCKETS ?? "wroom-replay-no-bucket";

// eslint-disable-next-line import/first
import { handler } from "../index";
// eslint-disable-next-line import/first
import { ImageHandlerExecutionResult } from "../lib";

type Sample = { path: string; host: string; live: string };
type Side = {
  status: number;
  contentType: string;
  format?: string;
  width?: number;
  height?: number;
  bytes: number;
  code?: string;
};

const ACCEPTS = ["image/webp", "*/*"];

async function describe(status: number, contentType: string, body: Buffer): Promise<Side> {
  const side: Side = { status, contentType, bytes: body.length };
  if (status === 200) {
    try {
      const m = await sharp(body).metadata();
      Object.assign(side, { format: m.format, width: m.width, height: m.height });
    } catch {
      side.format = "unreadable";
    }
  } else {
    try {
      side.code = JSON.parse(body.toString()).code;
    } catch {
      side.code = "-";
    }
  }
  return side;
}

async function live(base: string, p: string, accept: string): Promise<Side> {
  const res = await fetch(base + p, { headers: { Accept: accept }, signal: AbortSignal.timeout(40_000) });
  return describe(res.status, res.headers.get("content-type") ?? "", Buffer.from(await res.arrayBuffer()));
}

async function local(p: string, accept: string): Promise<Side> {
  const result = (await handler({
    path: p,
    headers: { Accept: accept },
    requestContext: {},
  } as never)) as ImageHandlerExecutionResult;
  const body = result.isBase64Encoded ? Buffer.from(result.body as string, "base64") : Buffer.from(String(result.body));
  return describe(result.statusCode, String(result.headers?.["Content-Type"] ?? ""), body);
}

function verdict(l: Side, n: Side): string {
  if (l.status === 200 && n.status === 200) {
    if (l.format !== n.format) return "format";
    if (l.width !== n.width || l.height !== n.height) return "dimensions";
    if (Math.abs(n.bytes - l.bytes) / Math.max(1, l.bytes) > 0.15) return "size";
    return "same";
  }
  if (l.status === n.status) return "same";
  // Intended: the 6.x fork answered 500 for source and request problems.
  if (l.status === 500 && [400, 404, 413, 502, 504].includes(n.status)) return "intended";
  if (l.status === 502 && n.status === 413) return "intended";
  return "status";
}

async function main() {
  const [sampleFile, outDir, base = "https://wrooom.webien.io"] = process.argv.slice(2);
  const samples: Sample[] = JSON.parse(fs.readFileSync(sampleFile, "utf8"));
  fs.mkdirSync(outDir, { recursive: true });
  const rows: string[] = [
    "path,host,accept,verdict,live_status,new_status,live_type,new_type,live_format,new_format,live_wh,new_wh,live_bytes,new_bytes,new_code",
  ];
  const counts: Record<string, number> = {};
  const jobs = samples.flatMap((s) => ACCEPTS.map((a) => ({ s, a })));
  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const { s, a } = jobs[next++];
      let l: Side, n: Side;
      try {
        [l, n] = await Promise.all([live(base, s.path, a), local(s.path, a)]);
      } catch (error) {
        counts.error = (counts.error ?? 0) + 1;
        rows.push([s.path, s.host, a, "error", String(error).replace(/,/g, ";")].join(","));
        continue;
      }
      const v = verdict(l, n);
      counts[v] = (counts[v] ?? 0) + 1;
      rows.push(
        [
          s.path,
          s.host,
          a,
          v,
          l.status,
          n.status,
          l.contentType,
          n.contentType,
          l.format ?? "",
          n.format ?? "",
          `${l.width ?? ""}x${l.height ?? ""}`,
          `${n.width ?? ""}x${n.height ?? ""}`,
          l.bytes,
          n.bytes,
          n.code ?? "",
        ].join(",")
      );
    }
  }

  const log = console.info;
  console.info = () => undefined;
  console.error = () => undefined;
  console.warn = () => undefined;
  await Promise.all(Array.from({ length: 8 }, worker));
  console.info = log;

  fs.writeFileSync(path.join(outDir, "replay.csv"), rows.join("\n") + "\n");
  const total = jobs.length;
  const ok = (counts.same ?? 0) + (counts.intended ?? 0);
  const summary = { total, ...counts, ok_ratio: Number((ok / total).toFixed(4)) };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  log(JSON.stringify(summary));
}

main().catch((error) => {
  process.stderr.write(`${error}\n`);
  process.exit(1);
});
