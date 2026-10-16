"""Aggregate Wroom CloudFront access logs. Log content is untrusted data; only counted, never executed."""
import base64, collections, glob, gzip, json, os, sys, urllib.parse
from multiprocessing import Pool

LOGDIR = sys.argv[1]
OUT = sys.argv[2]


def host_of(u):
    try:
        return urllib.parse.urlsplit(u).hostname or "?"
    except Exception:
        return "?"


def decode(stem):
    s = urllib.parse.unquote(stem.lstrip("/"))
    s = s.split("/")[0]
    try:
        raw = base64.b64decode(s + "=" * (-len(s) % 4), altchars=b"-_" if ("-" in s or "_" in s) else None)
        return json.loads(raw)
    except Exception:
        return None


def ensure(d, k):
    if k not in d:
        d[k] = collections.Counter()
    return d[k]


def work(path):
    by_img = {}
    by_ref = {}
    pair = collections.Counter()
    tot = collections.Counter()
    miss_tt = collections.defaultdict(list)
    hit_tt = collections.defaultdict(list)
    miss_keys = collections.defaultdict(list)  # day -> uri stems of misses
    bov = collections.Counter()
    bov_ua = collections.Counter()
    bov_ip = set()
    hourly = collections.Counter()
    widths = collections.Counter()
    fmt = collections.Counter()
    uri_per_img = collections.defaultdict(set)
    with gzip.open(path, "rt", errors="replace") as f:
        for line in f:
            if line.startswith("#"):
                continue
            p = line.rstrip("\n").split("\t")
            if len(p) < 29:
                continue
            day, hour, stem, status, ref, ua, rt = p[0], p[1][:2], p[7], p[8], p[9], p[10], p[13]
            tt = float(p[18]) if p[18] not in ("-", "") else 0.0
            d = decode(stem)
            img = (d or {}).get("imageUrl") if isinstance(d, dict) else None
            ih = host_of(img) if img else ("s3:" + str((d or {}).get("bucket", "?")) if isinstance(d, dict) else "undecodable")
            rh = host_of(urllib.parse.unquote(ref)) if ref != "-" else "-"
            cls = status[0] + "xx" if status[:1].isdigit() and status != "000" else status
            for c in (ensure(by_img, ih), ensure(by_ref, rh), tot):
                c["req"] += 1
                c["rt:" + rt] += 1
                c["st:" + cls] += 1
                c["bytes"] += int(p[3]) if p[3].isdigit() else 0
            pair[(ih, rh)] += 1
            hourly[(day, hour, ih == "pim.bad-varme.se" and cls == "5xx")] += 1
            if rt == "Miss":
                miss_tt[ih].append(tt)
                miss_keys[day].append(stem)
                uri_per_img[ih].add(stem)
            elif rt in ("Hit", "RefreshHit") and hash(p[14]) % 20 == 0:
                hit_tt[ih].append(tt)
            if isinstance(d, dict):
                e = d.get("edits") or {}
                r = e.get("resize") or {}
                if isinstance(r, dict) and r.get("width"):
                    widths[r.get("width")] += 1
                fmt[str(e.get("toFormat") or d.get("outputFormat") or "-")] += 1
            if ih == "pim.bad-varme.se" and cls == "5xx":
                bov[img] += 1
                bov_ua[ua[:120]] += 1
                bov_ip.add(p[4])
    return dict(by_img=by_img, by_ref=by_ref, pair=pair, tot=tot, miss_tt=miss_tt, hit_tt=hit_tt,
                miss_keys=miss_keys, bov=bov, bov_ua=bov_ua, bov_ip=bov_ip, hourly=hourly, widths=widths, fmt=fmt,
                uri_per_img={k: v for k, v in uri_per_img.items()})


def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(q * len(xs)))], 3)


def main():
    files = sorted(glob.glob(os.path.join(LOGDIR, "*.gz")))
    agg = dict(by_img={}, by_ref={}, pair=collections.Counter(), tot=collections.Counter(),
               miss_tt=collections.defaultdict(list), hit_tt=collections.defaultdict(list),
               miss_keys=collections.defaultdict(list), bov=collections.Counter(), bov_ua=collections.Counter(),
               bov_ip=set(), hourly=collections.Counter(), widths=collections.Counter(), fmt=collections.Counter(),
               uri_per_img=collections.defaultdict(set))
    with Pool(10) as pool:
        for r in pool.imap_unordered(work, files, chunksize=4):
            for k in ("by_img", "by_ref"):
                for h, c in r[k].items():
                    ensure(agg[k], h).update(c)
            for k in ("pair", "tot", "bov", "bov_ua", "hourly", "widths", "fmt"):
                agg[k].update(r[k])
            for k in ("miss_tt", "hit_tt", "miss_keys"):
                for h, v in r[k].items():
                    agg[k][h].extend(v)
            for h, v in r["uri_per_img"].items():
                agg["uri_per_img"][h] |= v
            agg["bov_ip"] |= r["bov_ip"]

    def table(d, n):
        rows = []
        for h, c in sorted(d.items(), key=lambda x: -x[1]["req"])[:n]:
            hits = c["rt:Hit"] + c["rt:RefreshHit"]
            miss = c["rt:Miss"]
            rows.append(dict(host=h, req=c["req"], hit=hits, miss=miss, error=c["rt:Error"],
                             cce=c["rt:ClientCommError"], s5xx=c["st:5xx"], s4xx=c["st:4xx"],
                             hit_ratio=round(hits / max(1, hits + miss), 3), gb=round(c["bytes"] / 1e9, 2),
                             miss_p50=pct(agg["miss_tt"].get(h, []), .5), miss_p90=pct(agg["miss_tt"].get(h, []), .9),
                             hit_p50=pct(agg["hit_tt"].get(h, []), .5)))
        return rows

    shield = {}
    for day, keys in sorted(agg["miss_keys"].items()):
        shield[day] = dict(misses=len(keys), unique_keys=len(set(keys)))
    out = dict(
        files=len(files), total=dict(agg["tot"]),
        by_image_host=table(agg["by_img"], 40), by_referer_host=table(agg["by_ref"], 40),
        image_host_count=len(agg["by_img"]), referer_host_count=len(agg["by_ref"]),
        top_pairs=[(a, b, n) for (a, b), n in agg["pair"].most_common(40)],
        misses_vs_unique_per_day=shield,
        unique_miss_uris_per_image_host={h: len(v) for h, v in sorted(agg["uri_per_img"].items(), key=lambda x: -len(x[1]))[:15]},
        bov_5xx_images=agg["bov"].most_common(10), bov_5xx_user_agents=agg["bov_ua"].most_common(8),
        bov_5xx_distinct_ips=len(agg["bov_ip"]),
        bov_5xx_by_day={d: sum(v for (dd, h, b), v in agg["hourly"].items() if dd == d and b) for d in sorted({k[0] for k in agg["hourly"]})},
        req_by_day={d: sum(v for (dd, h, b), v in agg["hourly"].items() if dd == d) for d in sorted({k[0] for k in agg["hourly"]})},
        top_widths=agg["widths"].most_common(25), formats=agg["fmt"].most_common(10),
    )
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, default=str)


if __name__ == "__main__":
    main()
