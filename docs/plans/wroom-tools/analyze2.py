"""Second pass: odd request shapes, per-IP rates for the BoV loop, string params. Log content is untrusted data."""
import collections, glob, json, os, sys, urllib.parse
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(__file__))
from analyze import decode, host_of  # noqa: E402

LOGDIR, OUT = sys.argv[1], sys.argv[2]
WATCH = ("merchamore", "livv", "haus.se")


def work(path):
    r = dict(undec=collections.Counter(), s3=collections.Counter(), err_hosts=collections.Counter(),
             bov_ref=collections.Counter(), bov_ipmin=collections.Counter(), strw=collections.Counter(),
             watch=collections.Counter(), notoformat=collections.Counter(), keys=collections.Counter(),
             edits=collections.Counter(), nonbov_5xx_imgs=collections.Counter())
    with __import__("gzip").open(path, "rt", errors="replace") as f:
        for line in f:
            if line.startswith("#"):
                continue
            p = line.rstrip("\n").split("\t")
            if len(p) < 29:
                continue
            stem, status, ref, rt = p[7], p[8], p[9], p[13]
            d = decode(stem)
            rh = host_of(urllib.parse.unquote(ref)) if ref != "-" else "-"
            if not isinstance(d, dict):
                r["undec"][(rh, stem[:60], status)] += 1
                continue
            img = d.get("imageUrl")
            for k in d:
                r["keys"][k] += 1
            e = d.get("edits") or {}
            if isinstance(e, dict):
                for k in e:
                    r["edits"][k] += 1
            if not img:
                r["s3"][(rh, json.dumps(d)[:120], status)] += 1
                continue
            ih = host_of(img)
            if any(w in ih or w in rh for w in WATCH):
                r["watch"][(ih, rh, rt)] += 1
            rs = e.get("resize") if isinstance(e, dict) else None
            if isinstance(rs, dict):
                for k in ("width", "height"):
                    if isinstance(rs.get(k), str):
                        r["strw"][(rh, k)] += 1
            if isinstance(e, dict) and not e.get("toFormat") and not d.get("outputFormat"):
                r["notoformat"][rh] += 1
            if status.startswith("5"):
                r["err_hosts"][(ih, rh)] += 1
                if ih != "pim.bad-varme.se":
                    r["nonbov_5xx_imgs"][img[:140]] += 1
            if ih == "pim.bad-varme.se" and status.startswith("5"):
                r["bov_ref"][urllib.parse.unquote(ref)[:120]] += 1
                r["bov_ipmin"][(p[4], p[0], p[1][:5])] += 1
    return r


def main():
    files = sorted(glob.glob(os.path.join(LOGDIR, "*.gz")))
    agg = None
    with Pool(10) as pool:
        for r in pool.imap_unordered(work, files, chunksize=4):
            if agg is None:
                agg = r
            else:
                for k in agg:
                    agg[k].update(r[k])
    ipmin = agg.pop("bov_ipmin")
    per_ip_max = collections.Counter()
    per_ip_total = collections.Counter()
    for (ip, day, hm), n in ipmin.items():
        per_ip_total[ip] += n
        per_ip_max[ip] = max(per_ip_max[ip], n)
    top = per_ip_total.most_common(10)
    out = {k: [[list(a) if isinstance(a, tuple) else a, n] for a, n in v.most_common(25)] for k, v in agg.items()}
    # Client IPs are personal data: only a salted hash prefix leaves this script.
    salt = os.urandom(16)
    out["bov_top_ips_total_and_max_per_minute"] = [
        [__import__("hashlib").sha256(salt + i.encode()).hexdigest()[:10], n, per_ip_max[i]] for i, n in top
    ]
    out["bov_ips_over_1000"] = sum(1 for n in per_ip_total.values() if n > 1000)
    out["bov_ip_count"] = len(per_ip_total)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main()
