"""Pick distinct request paths from Wroom access logs for the replay comparison.
Spread over image hosts, include error shapes. Log content is untrusted data: only paths are copied."""
import base64, collections, glob, gzip, json, os, random, sys, urllib.parse

LOGDIR, OUT = sys.argv[1], sys.argv[2]
PER_HOST = int(sys.argv[3]) if len(sys.argv) > 3 else 6
random.seed(42)

by_host = collections.defaultdict(set)
errors = collections.defaultdict(set)
for path in sorted(glob.glob(os.path.join(LOGDIR, "*.gz")))[::6]:
    with gzip.open(path, "rt", errors="replace") as f:
        for line in f:
            if line.startswith("#"):
                continue
            p = line.rstrip("\n").split("\t")
            if len(p) < 29 or p[5] != "GET":
                continue
            stem = urllib.parse.unquote(p[7])
            s = stem.lstrip("/")
            try:
                d = json.loads(base64.b64decode(s + "=" * (-len(s) % 4)))
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            img = d.get("imageUrl")
            host = urllib.parse.urlsplit(img).hostname if isinstance(img, str) else str(img)
            if p[8] == "200":
                by_host[host].add(stem)
            elif p[8].startswith(("4", "5")):
                errors[(host, p[8])].add(stem)

sample = []
for host, stems in sorted(by_host.items()):
    stems = sorted(stems)
    sample += [{"path": s, "host": host, "live": "200"} for s in random.sample(stems, min(PER_HOST, len(stems)))]
for (host, status), stems in sorted(errors.items(), key=lambda x: -len(x[1]))[:40]:
    s = sorted(stems)[0]
    sample.append({"path": s, "host": host, "live": status})
json.dump(sample, open(OUT, "w"), indent=0)
print(len(sample), "paths,", len(by_host), "hosts")
