# Wroom improvement plan (2026-10-16)

Status: option B approved by Tim 2026-10-16. Phase 1 (code) is implemented on branch `feat/wroom-v8`. Phase 0 and phase 2 change production and wait for Tim's decisions in section 12. Nothing is deployed and nothing in AWS is changed.

Wroom = `wrooom.webien.io`, the Haus image CDN: CloudFront, then API Gateway `4z37kj65dg` (eu-north-1, stage `/image`), then Lambda `ServerlessImageHandler-BackEndImageHandlerLambdaFu-8W9Z7VqvwHCx` (sharp). Requests are base64 JSON `{"imageUrl", "publicKey", "edits"}`; the Lambda downloads `imageUrl` with axios and resizes.

## 1. Sources

1. Slack DM Tim and Simon Cordts (D21P0L2F7), 2026-10-16 10:50: fork link, AWS docs (https://docs.aws.amazon.com/solutions/dynamic-image-transformation-for-amazon-cloudfront/), console link to `E1Q66FM2BSOEF2` (the demo UI, not the API), one screenshot (not reviewed, not readable through the Slack connector).
2. Merchamore review `merchamore/docs/research/2026-10-16-wroom-cache-review.md` and WeAreHausTech/merchamore#82.
3. Zendesk ticket 12354 (2025-01-28): AWS asks to upgrade from v6.3.2 or earlier (6.3.3 patch or 7.0.0+).
4. This repo: `main` head `453e741`, upstream tags up to v8.1.2 (2026-10-08).
5. Live AWS, read-only profile `wroom` (account 035230334169), 2026-10-16 12:00 UTC.
6. CloudFront access logs for `E3K100LLRITAXV`, 2026-10-09 12:00 to 2026-10-16 12:00 UTC: 4 380 files, 18 989 561 requests. Scripts in `docs/plans/wroom-tools/` (`dl.sh`, `analyze.py`, `analyze2.py`).

## 2. What the code is

1. Upstream base: v6.2.2 (`29fe1e7`). Fork diff (`git diff 29fe1e7 453e741`) is 10 files, +274/-8. The feature is `getOriginalImageFromUrl` and `parseImageUrl` in `source/image-handler/image-request.ts`.
2. `getOriginalImageFromUrl` (`source/image-handler/image-request.ts:232`): `axios.get(imageUrl)` with no timeout, no size limit, no content-type check, any scheme or address the URL parser accepts. Content type is hard-coded to `"image"` and cache-control to one year.
3. Any axios error becomes HTTP 500 (`image-request.ts:247-250`). A source 404 is returned as 500 with body `{"code":"ERR_BAD_REQUEST","message":"Request failed with status code 404"}` (confirmed live).
4. `axios` is not a dependency of `source/image-handler/package.json` (it is only in `source/constructs/package.json`). A clean checkout does not compile: 14 of 30 test suites fail with `TS2307: Cannot find module 'axios'`. With `axios@1.5.1` installed by hand: 29 of 30 suites pass, 250 of 257 tests; the 7 failures in `test/image-request/setup.spec.ts` are expectation drift (`imageUrl: null`, `headers: undefined` now on the result). There are no tests for the URL path. Toolchain: Node 22.22.2, npm 10.9.7.
5. Lambda runtime in the construct is `NODEJS_16_X` (`source/constructs/lib/back-end/back-end-construct.ts:91`), AWS SDK v2, sharp 0.32.6, Lambda timeout 15 minutes (API Gateway cuts at 29 s anyway; max observed duration 20.7 s).
6. Deployed code is not `main` head. Live Wroom answers `400 OriginAndSourceValidation::MissingPublicApiKey` when `publicKey` is missing. That check exists in `9df624a` and `319eb2f` and was removed by `453e741`. `319eb2f` does not compile (it defines `validateOriginAndSource` twice, TS2393), so the Lambda probably runs `9df624a` (v6.2.2 plus 9 Haus commits) or a tree that was never pushed. The `imageUrl: false` error text (`Missing required key 'Key' in params`, AWS SDK v2) fits that. Confirming needs `lambda:GetFunction` and `cloudformation:DescribeStacks` on the `wroom` policy.
7. AutoWebP is on in production: the same request without `toFormat` returns `image/webp` for `Accept: image/webp` and a JPEG labelled `content-type: image` for `Accept: */*` (tested live). So `Accept` must stay in the cache key, normalized.
8. CORS is off in production (no `Access-Control-Allow-Origin` in responses), so `Origin` in the cache key does nothing useful.

## 3. Live config (verified 2026-10-16)

1. Five distributions, all enabled. `E3K100LLRITAXV` (wrooom.webien.io, "DEFAULT - FREE") carries all traffic. `E2ORN50HS27NWG` (template), `E2JHR32BS7CHDN` (rko13a) and `E22NVK1ORAWBNK` (rlcaqk) had zero requests in the last 7 days, use `Managed-CachingOptimized` (no headers in key, so AutoWebP would serve a random format there) and have logging off. `E1Q66FM2BSOEF2` is the demo UI on S3.
2. `E3K100LLRITAXV` cache policy `ServerlessImageHandler-bb412e4b…`: headers `origin`, `accept`; gzip on, brotli off; query string `signature`; TTL 1 s / 1 day / 365 days. Origin request policy forwards the same. No CloudFront function.
3. Origin Shield off, PriceClass_All, origin read timeout 30 s, HTTP/2, IPv6, TLSv1.2_2021, viewer policy https-only.
4. Custom error caching: 500 to 504 cached 600 s. 404 not configured (CloudFront default 10 s).
5. WAF web ACL `---DEFAULT-FREE---` is attached with zero rules and default Allow. It costs the base fee plus about $0.60 per million requests (about 80 M requests a month now) and blocks nothing.
6. Hand-made changes that upstream CDK does not produce: alternate domain `wrooom.webien.io` with its ACM certificate, WAF, log prefix `wrooom.webien.io/`. A CloudFormation update of the old stack could revert them.
7. Access logs bucket `serverless-image-handler-logs-07b19942` (eu-north-1): 88.9 GB Standard, no lifecycle configuration, logs since 2022. The logs contain client IPs, so the retention question is also a GDPR question.
8. No CloudFront additional metrics, so no `CacheHitRate`. No dashboard or alarms found.
9. Lambda, 7 days: 530 780 invocations (63 to 84 k a day), 5 errors, 0 throttles, max concurrency 137, duration p50 290 ms, p90 715 ms, p99 1.7 s, max 20.7 s.

## 4. Traffic, last 7 days (`E3K100LLRITAXV`)

1. 18 989 561 requests, 276 GB out. Hit 7 848 719, Miss 477 812, Error 10 663 030 (56 %). 5xx 10 621 691, 4xx 10 118.
2. Hit ratio excluding errors: 94.3 %. Most WordPress sites are 95 to 99 %. Low: greydynamics.com 72.6 %, gavazzi.se 70.9 %, quintustechnologies.com 77.8 %, themantaresort.com 78.6 %, mamhomes.se 82.6 %.
3. Miss latency p50 0.37 to 0.98 s by site, p90 0.67 to 1.87 s (ehandel.hemglass.se slowest, large sources). Hit p50 2 to 9 ms.
4. 158 image source hosts, 220 referer hosts. Largest by requests (excluding BoV errors): hallarna.se 0.90 M, c4shopping.se 0.77 M, bergvik.se 0.66 M, avionshopping.se 0.57 M, valbokopcentrum.se 0.52 M, grandsamarkand.se 0.46 M, ehandel.hemglass.se 0.43 M (35 GB, largest by bytes), www.bad-varme.se 0.37 M.
5. Repeat misses: 477 812 misses but only 357 234 distinct request paths missed per day, so 120 578 misses (25 %) regenerated a path already generated that day. This counts both other edges (what Origin Shield fixes) and the same edge with another Accept, Accept-Encoding or Origin header (what the cache key change fixes; confirmed live: one path gave three separate misses at one POP for `*/*`, `*/*` plus gzip and `*/*` plus Origin). The split between the two is not measured; recompute with distinct (path, edge) pairs if needed.
6. `analyze.py` splits the path on `/`, so the 2.2 % of requests whose base64 contains `/` are counted as undecodable. Host counts are slightly low.
7. The 5xx share started rising on 2026-09-24. Daily 5xx rate since: 16 to 80 % on weekdays, 1 to 6 % on weekends. Worst day 2026-10-12: 6.2 M requests, 80 % 5xx.

## 5. Bad & Värme (BoV) error loop

1. 10 398 825 of the 10.6 M 5xx (98 %) are one image: `pim.bad-varme.se/assets/preview/97/85a465b7-1b7b-4f99-8287-fedf17274598__preview.jpg`. A further 48 902 are `assets/source/7c/85a465b7-….jpg` (the same asset's original, likely a fallback in the client) and about 39 000 two other `pim.bad-varme.se` previews.
2. Cause on the Wroom side: the source returns HTTP 404 (Vendure asset gone; checked 2026-10-16 12:02 UTC). The fork turns that into 500, CloudFront caches the 500 for 600 s per edge, and the client keeps asking.
3. Cause on the BoV side: every one of these requests has referer `https://www.bad-varme.se/` (start page). 326 client IPs, 29 of them above 1 000 requests. One IP sent 9.0 M of them (86 %), up to 8 365 a minute (about 140 a second). The pattern (office-hours weekdays, a few Chrome on Windows user agents, one dominant address) fits an image `onError` handler on the start page that retries or swaps `src` in a loop, left open on one or more screens behind one office NAT.
4. Note for the BoV team: (1) the start page references a deleted PIM asset; (2) the image error handler retries without limit; it should give up after one fallback and show a placeholder; (3) the fallback URL (`assets/source/…`) is also deleted.
5. Cost today is modest (CloudFront and WAF request fees on about 40 M extra requests a month, plus log volume) but the loop hides real errors in every metric.

## 6. Other error sources seen

1. `"imageUrl": false` from the WordPress plugin: 51 700 requests, all 500 (hallarna.se 16 095, bergvik.se 13 393, avionshopping.se 11 380, elinsesplanad.se 10 221). The fork then falls back to the S3 path and fails. Should be a 400, and the plugin should not emit the URL.
2. Missing WordPress uploads per site (prisonisland-ksa.com 9 365, kungsvaningen.se 5 750, hallarna.se 3 671, oncopeptides.com 2 984 …), all source 404s shown as 500. Some URLs contain a media query (`… [(max-width: 768px)]`), a plugin bug.
3. Livv: `ecom.livv.se` 3 089 errors (1 244 with referer `livv.fi.production.haus.se`, 1 844 without). Needs a closer look before go-live.
4. Local development sites (`*.hemglass.se.test`, `pilot-*.hemglass.se.test`) send `imageUrl` values like `http://127.0.0.1:20001/assets/…` to production Wroom. Today the Lambda tries to fetch its own loopback (live: `500 ECONNREFUSED 127.0.0.1:20001`, so the error text is passed through to the client). This is the SSRF surface in practice. By decision 2026-10-16 no blocking is added (section 9, phase 1 task 2); the most sensitive loopback target is the Lambda runtime API on `127.0.0.1:9001`.
5. Merchamore: small (`vendure.merchamore.haus.se`, under 3 000 requests a week). Haus staging hosts (`*.haus.se`) also use production Wroom.

## 7. Request shapes the new version must accept

1. All decoded requests have exactly `imageUrl`, `publicKey`, `edits`.
2. Edits used: `resize` (18.7 M), `webp` (12.95 M), `toFormat` (12.77 M), `blur` (1.6 M), `extract` (23 k). All are on the upstream v8.1.2 sharp allow list.
3. Width and height are strings in most WordPress requests (`"300"`). v8.1.2 `validateResizeInputs` coerces with `Number()`, so this still works. Width or height `<= 0` becomes 400 in v7+, which is new behaviour.
4. About 6 M requests a week have no `toFormat` and depend on AutoWebP and the Accept header.
5. Most used widths: 300 (11.7 M, mostly the BoV loop), 100, 150, 1200, 400, 140, 600, 2400, 900.
6. Hemglass sends `resize` with no width or height (`{"fit":"cover","withoutEnlargement":true,"position":"centre"}`). v8.1.2 accepts it (`image-handler.ts:251`); it must be in the tests and the replay.
7. `publicKey` is always the literal string `noKey`. The presence check protects nothing but is kept because it exists today.
8. The sampled hour had zero query strings. The v8.1.2 CloudFront function strips query strings outside its list, and `?width=`, `?format=` and similar would become edits in v8.1.2 (`parseQueryParamEdits`).

## 8. Options

### Option A: patch in place (6.2.2 fork plus 6.3.3 fixes)

1. Cherry-pick the 6.3.3 security changes (sharp operation allow list, custom-header deny list, content-type inference), fix the URL fetch (section 9, task 3), change the cache policy, add Origin Shield and the 404 error caching by hand in the old construct.
2. Effort: about 2 days. Leaves AWS SDK v2 (end of support), Node 16 or 18 runtime (deprecated), sharp 0.32 (several CVEs since), and every later upstream fix still to do.
3. Same deploy risk as option B (old stack has hand-made changes) for less gain.

### Option B: rebase the fork onto upstream v8.1.2, Lambda architecture (recommended)

1. Start a branch from tag `v8.1.2` and port the URL source as one new, tested module instead of the current edits inside `image-request.ts`. Keep the API Gateway plus Lambda architecture (v8 keeps it next to the new ECS one).
2. Gets: Node 24, AWS SDK v3, sharp 0.35.5, all 6.3.3 to 8.1.2 security fixes, the Accept normalizing CloudFront function, Origin Shield parameter, ops dashboard, option to deploy without a CloudFront distribution.
3. Effort: about 4 to 5 days including the replay comparison. Deployed as a new stack next to the old one (blue/green), so rollback is pointing the distribution back.

### Option C: move to the v8 ECS architecture

1. v8 ECS has external HTTPS origins and host mappings built in, but uses a different request format, runs Fargate tasks all the time and adds an admin UI and DynamoDB. Every customer URL format would need a translation layer.
2. Not recommended now. Revisit if Wroom needs per-customer policies.

### Recommendation

Option B, with the phase 0 items done first because they need no code.

## 9. Tasks

Every task lists acceptance criteria (AC) and verification (V). Commands assume `export AWS_PROFILE=wroom` for reads; writes need a deploy role Tim approves.

### Phase 0: no code, Tim decides (production changes, each needs Tim's OK)

1. **Tell BoV about the loop.** Send section 5 point 4 to the BoV team (Tim sends or approves the text).
   - AC: requests for `pim.bad-varme.se/…85a465b7…__preview.jpg` fall below 1 000 an hour.
   - V: `python3 -I docs/plans/wroom-tools/analyze.py <logdir> out.json` on the latest day, field `bov_5xx_by_day`; or CloudWatch `5xxErrorRate` for `E3K100LLRITAXV` below 5 % on a weekday.
2. **Empty WAF web ACL.** No blocking rules are added (decision 2026-10-16). Tim decides whether to keep it attached or detach it to save its request fee.
   - Rollback (if detached): attach `---DEFAULT-FREE---` again; save `aws cloudfront get-distribution-config --id E3K100LLRITAXV` first.
3. **Enable CloudFront additional metrics** on `E3K100LLRITAXV` (CacheHitRate, origin latency, error rates per code). About $3 a month.
   - AC: `CacheHitRate` visible in CloudWatch us-east-1.
   - V: `aws cloudwatch list-metrics --region us-east-1 --namespace AWS/CloudFront --metric-name CacheHitRate`.
4. **Lifecycle on the logs bucket.** Proposal: expire objects after 180 days (or move to Glacier Instant Retrieval after 30 days and expire after 400). Deletes data, so Tim decides the period. Before applying, copy the current (empty) lifecycle state and one month of logs aside if wanted.
   - AC: `get-bucket-lifecycle-configuration` returns the rule; bucket size falls over the following days.
   - V: `aws s3api get-bucket-lifecycle-configuration --bucket serverless-image-handler-logs-07b19942`; CloudWatch `BucketSizeBytes`.
   - The new stack (phase 2) creates its own CloudFront log bucket through a custom resource with versioning on and no lifecycle (v8.1.2 `custom-resource/index.ts:659-696`). The same rule, plus expiry of noncurrent versions, goes on that bucket.
   - `docs/plans/wroom-tools/analyze2.py` hashes client IPs before writing them; raw IPs never leave the log files.
5. **Extend the read-only policy** with `lambda:GetFunction`, `lambda:GetFunctionConfiguration`, `cloudformation:DescribeStacks`, `cloudformation:GetTemplate`, `cloudformation:DetectStackDrift`, `logs:FilterLogEvents` on the image handler log group.
   - AC: we can confirm the deployed commit, Lambda env (`AUTO_WEBP`, `CORS_ENABLED`, `SOURCE_BUCKETS`), runtime, and which resources the old stack still owns.

### Phase 1: code, on a branch `feat/wroom-v8` (local only until approved)

1. **Rebase base.** Branch from `v8.1.2`. Keep upstream files unchanged where possible; Haus code goes in new files.
   - AC: `cd source/image-handler && npm ci && npm test` green on a clean clone; `cd source/constructs && npm ci && npm test` green.
2. **URL source module** (`source/image-handler/url-image-source.ts`), used when the request has `imageUrl`:
   1. No new blocking (decision 2026-10-16): no host allow list, no address, scheme or redirect restrictions, no size cap. Every URL that is fetched today is still fetched, redirects are followed as today.
   2. Use Node 24 `fetch` (no axios dependency) with a 25 s timeout, just under API Gateway's 29 s, so a hanging source gives a clear 504 instead of the API Gateway timeout it gives today. No other limit.
   3. Never reject because of the source's content type (today the header is ignored). Set the response type from the header when it is a known image type (`ContentTypes`, including SVG), else from magic bytes, else from sharp's own format detection. Responses never say `content-type: image`. Upstream `inferImageType` (v8.1.2 `image-request.ts:493`) throws 500 for unknown types, so it is only used as one step, not as the gate.
   4. Map source status: 404 and 410 to 404, other 4xx to 400, 5xx and network errors to 502, timeout to 504. Do not pass the source's error text to the client (upstream v7 behaviour); log it.
   5. `imageUrl: false`, empty or invalid: 400 `ImageUrl::Missing` without falling back to S3 (unless a source bucket is configured on purpose).
   6. Keep today's rule that `publicKey` must be present (400 if missing), so existing behaviour does not change; real key checks are out of scope.
   - AC: unit tests for each case above (public host, redirect, timeout, 404 source, 500 source, `application/octet-stream` JPEG, `text/plain` PNG, SVG, BMP or ICO, animated GIF, `imageUrl: false`, string width `"300"`, `resize` without width or height, `webp` edit without `toFormat`). Coverage of the new file at least 90 %.
   - V: `npx jest test/url-image-source.spec.ts --coverage`.
3. **Cache key.**
   1. Use upstream's viewer-request CloudFront function: Accept normalized to `image/webp` or empty; query strings reduced to the allow list.
   2. Cache policy headers: `accept` only (AutoWebP on). Drop `origin` (CORS is off) and set gzip and brotli off (images are already compressed). Dropping `origin` is a patch to the upstream construct (v8.1.2 `back-end-construct.ts:182` always keeps it); list it under upstream deviations.
   3. Normalizing Accept to `image/webp` or empty is enough: AutoWebP is the only Accept-driven branch, a `webp` edit without `toFormat` gives WebP for both values, and AVIF is never produced automatically.
   4. Customer cache-buster query strings are dropped by the function. None were seen in the sampled hour; re-check on 7 days of logs before go-live.
   - AC: one image requested with Chrome, Safari, Firefox and curl `Accept` values gives at most 2 cache objects; `Accept-Encoding` and `Origin` variants hit the same object.
   - V: `curl -sI -H "Accept: <variant>" -H "Accept-Encoding: <variant>" https://<test-host>/<path> | grep -i x-cache` for each variant, second and later requests show `Hit`.
4. **Error caching.** 404 cached 120 s, 400 cached 60 s, 500 to 504 cached 60 s (today 600 s; upstream v8.1.2 also 600 s), via the distribution's error responses. Short 404 caching so an image requested before its upload or preview generation finished (WordPress srcset, Vendure previews, Merchamore deploys) appears within two minutes. These values deviate from upstream; list them under upstream deviations.
   - AC: a request for a missing source returns 404 with `x-cache: Error from cloudfront` on repeat; the same path returns 200 within 2 minutes after the source appears; a transient 502 clears within a minute.
5. **Origin Shield.** Region undecided: eu-central-1 (Frankfurt) or eu-west-2 (London, which the reviewer reads from AWS's recommended-region table for an eu-north-1 origin). Check the AWS table at deploy time and decide (section 12).
   - AC: `OriginShield.Enabled: true` on the origin; tasks 3 and 5 together cut Lambda invocations per million viewer requests by about 20 to 25 % within a week (section 4 point 5 measures both effects together).
   - V: `aws cloudfront get-distribution-config --id <id> --query 'DistributionConfig.Origins.Items[0].OriginShield'`; Lambda `Invocations` vs CloudFront `Requests` daily.
6. **Observability.** Keep upstream's ops dashboard; add alarms on Lambda `Errors`, throttles and p99 duration above 5 s (implemented in `source/constructs/lib/back-end/wroom-alarms.ts`, no actions yet). CloudFront `5xxErrorRate` exists only in us-east-1, so its alarm cannot live in the eu-north-1 stack; create it in us-east-1 together with the additional metrics (phase 0 task 3). Alarm target decided by Tim (email or Slack).
   - AC: alarms exist and fire in a test (set threshold low on the test stack).
7. **Replay comparison tool** (`docs/plans/wroom-tools/replay.py`): take 2 000 distinct real request paths from the logs, spread over all 158 hosts, and request each from old and new endpoints with `Accept: image/webp` and `Accept: */*`.
   - Sample must include: SVG, animated GIF, BMP or ICO sources, mislabelled content types, Hemglass `resize` without width or height, string widths, `blur`, `extract`.
   - AC: same status for at least 99 % (differences only where intended: 404, 400 or 502 instead of 500; 413 `TooLargeImageException` where today API Gateway gives 502 for outputs over 6 MB); for 200s, same output format and dimensions, byte size within 15 %. Animated GIF: v8.1.2 sets `animated` from the content type after the output format is chosen, so with `toFormat: webp` or AutoWebP the output is one frame, as in the 6.x fork. Only a GIF kept as GIF (no format change, `Accept: */*`) is now animated where the fork returned one frame.
   - V: the tool prints a summary and a CSV of differences.
   - Implemented: sampler `docs/plans/wroom-tools/sample_paths.py`, replay `source/image-handler/scripts/wroom-replay.ts` (live Wroom vs this code run locally through `index.handler`).
   - Result 2026-10-16 (570 paths over 115 image hosts plus 40 error shapes, each with `Accept: image/webp` and `*/*`, 1 140 pairs):
     1. 919 identical (status, format, dimensions, size within 15 %), 47 intended status changes (26 source 404 now 404, 12 non-images now 400 `InstantiationError`, 4 unreachable sources now 502, 3 refused now 400, 2 `imageUrl: false` now 400).
     2. 124 differ only in byte size (same format and dimensions): sharp 0.35 output is smaller for 92 and larger for 32, median 0.81 of today's size.
     3. 42 differ by 1 pixel on one side (`fit: outside` rounding in sharp 0.35, for example 450x300 becomes 451x300).
     4. 8 return 200 where live returns 500: 2 are a fix (`gym80.se` file names with `ä`, which axios refused with `ERR_UNESCAPED_CHARACTERS`); 6 are local-network artifacts (`*.haus.se` staging sources that answer 401 to the Lambda but not to the office network, and `hemglass.se.test`, which only resolves on a developer machine). From the Lambda these give 400 instead of 500.
     5. Content type: live answers `content-type: image` for every `*/*` response; the new code sends the real type (`image/jpeg`, `image/png`, `image/webp`).
   - Verdict: no unintended status or format change. The 15 % size rule is too strict across sharp versions; size is informational only.
8. **Stored result cache (finding 5): deferred.** With Origin Shield and a 365-day max TTL the expected gain is small (hit ratio already 94 %). Re-measure two weeks after go-live; if misses for already-seen paths stay above 10 %, add an S3 result cache keyed on the request path.

### Phase 2: deploy (staging first, production only with Tim's OK)

1. **Deploy a new stack** `wroom-v8` in eu-north-1 with its own CloudFront distribution and no custom domain (test URL is the `*.cloudfront.net` name). The old stack and `4z37kj65dg` stay untouched.
   - AC: stack `CREATE_COMPLETE`; replay comparison (phase 1 task 7) passes against the new distribution; Merchamore storefront works locally with `WROOM_URL` pointed at the test distribution.
2. **Prepare the alias move.** `E3K100LLRITAXV` is a resource of the old CDK stack (its origin id is CDK-generated), so changing its origin and later deleting the old stack would delete the production distribution. Moving the alias is the only switch path.
   1. Find who controls DNS for `webien.io` (not Loopia; haus.se is).
   2. Attach the existing ACM certificate (`arn:aws:acm:us-east-1:035230334169:certificate/d409347a…`) to the new distribution.
   3. Apply the hand-made settings to the new distribution: viewer policy https-only, log prefix, WAF web ACL if Tim keeps it (phase 0 task 2).
   4. Create the TXT record `_wrooom.webien.io` pointing at the new distribution's `*.cloudfront.net` name (required by `associate-alias`).
   5. Smoke test: `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' --resolve wrooom.webien.io:443:<IP of new distribution> https://wrooom.webien.io/<known path>` returns `200 image/webp`.
   - AC: all five steps done and the smoke test passes for 20 sampled paths.
3. **Switch**, at a low-traffic hour (Sunday 03:00 to 05:00 CET):
   1. Save `aws cloudfront get-distribution-config --id E3K100LLRITAXV > backup-E3K100LLRITAXV-<date>.json` and the new distribution's config, read both back.
   2. `aws cloudfront associate-alias --target-distribution-id <new id> --alias wrooom.webien.io`, then point the `wrooom.webien.io` DNS record at the new distribution if it is not an alias to CloudFront already.
   - AC: `curl -sI https://wrooom.webien.io/<known path>` returns 200 webp and `x-amz-cf-id` from the new distribution; 5xx rate under 2 % excluding known 404 sources for 24 h; Lambda concurrency stays under 400 during the cold-cache period (new cache key means every object is generated once more; about 50 k distinct paths a day).
   - Rollback: move the alias back (`associate-alias --target-distribution-id E3K100LLRITAXV`, TXT record pointed back) and restore DNS. 5 to 10 minutes to propagate. The old stack and distribution stay unchanged and running for 30 days.
4. **Template, rko13a, rlcaqk distributions**: zero traffic. Ask Tim whether to retire them; if they stay, move their aliases to new distributions the same way (their current managed policy ignores Accept).
5. **Old stack removal**: after 30 days without rollback, and only with Tim's OK (deletes resources). Before deleting, check which resources it owns (needs phase 0 task 5), and whether the logs bucket `serverless-image-handler-logs-07b19942` is retained or deleted with the stack; keep the logs Tim's retention decision requires.

## 10. Risks for existing customers

1. **WordPress sites** (hallarna, c4shopping, bergvik, avionshopping, valbokopcentrum, grandsamarkand, ingelstashopping, elinsesplanad, member24, birgerjarl, and more): rely on string widths, the `webp` edit without `toFormat`, `blur`, and AutoWebP. All covered by v8.1.2, verified by the replay. Missing images change from 500 to 404, which WordPress handles the same way.
2. **BoV**: the loop continues until their client is fixed; the new version returns a cached 404 instead of a cached 500, the request volume stays.
3. **Hemglass**: largest by bytes, sources are large (miss p90 1.9 s). Local `.test` sites using `127.0.0.1` sources keep failing as today (502 instead of 500, without the error text). Tell the Hemglass developers to use staging Wroom or a local image server.
4. **Livv**: 3 089 errors in the week on `ecom.livv.se`; find the cause before the switch so it is not blamed on the new version.
5. **Merchamore**: small volume, covered by the replay and a local storefront run. The storefront width fixes from the Merchamore review are separate work in that repo.
6. **Open proxy stays open by choice** (decision 2026-10-16): any URL is still fetched, including loopback and private addresses. Only the 25 s timeout and Lambda's memory bound the cost of one request. Watch Lambda invocations per day for abuse.
7. **Cold cache after switch**: changing the cache key empties the effective cache once. Expect about 1 day of higher latency on first views (miss p50 0.5 s) and higher Lambda load.
8. **Hand-made distribution settings** (alias, certificate, WAF, log prefix) could be reverted by a CloudFormation update of the old stack. Do not update the old stack; build the new one and move traffic.
9. **Animated GIFs** stay one frame when converted to WebP (as today). Only GIF to GIF requests without a format change become animated (see phase 1 task 7).

## 11. Upstream deviations (keep when rebasing onto later upstream versions)

1. `source/image-handler/url-image-source.ts` and its wiring in `image-request.ts` `setup()`: `imageUrl` requests fetched over HTTP, `publicKey` presence check, source status mapping, content type resolution, format-edit content type.
2. `lib/enums.ts`: `BAD_GATEWAY` 502 and `GATEWAY_TIMEOUT` 504. `lib/interfaces.ts`: `imageUrl`, `publicKey` on `DefaultImageRequest`.
3. Cache policy: `origin` removed from the cache key (`back-end-construct.ts`).
4. Error caching: 400 60 s, 404 120 s, 5xx 60 s (`api-gateway-architecture.ts`; upstream 5xx 600 s, no 4xx entries).
5. Lambda alarms (`wroom-alarms.ts`).

## 12. Open questions for Tim

1. OK for option B?
2. Who tells BoV, and with what text? (Draft can follow.)
3. Logs retention period (section 9, phase 0 task 4).
4. Keep, use or detach the empty WAF web ACL?
5. Retire `template`, `rko13a`, `rlcaqk` distributions?
6. Extend the `wroom` read-only policy (phase 0 task 5)?
7. Origin Shield region: eu-central-1 or eu-west-2 (phase 1 task 5)?
8. Who controls DNS for `webien.io` (phase 2 task 2)?
