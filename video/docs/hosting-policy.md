# Free-hosting growth policy

This is the single canonical hosting policy for both public galleries:

- [oldwinter/official-prompt-video-gallery](https://github.com/oldwinter/official-prompt-video-gallery)
- [oldwinter/official-prompt-image-gallery](https://github.com/oldwinter/official-prompt-image-gallery)

Both sites deploy as static GitHub Pages trees from the repository root. This document records measured bytes, documented platform limits, local review thresholds, and the rule for when originals may leave Pages. It does not migrate hosting.

Canonical URL after this file is on `main`:

`https://github.com/oldwinter/official-prompt-video-gallery/blob/main/docs/hosting-policy.md`

The image repository must point at that exact URL after merge. Do not copy a second policy into the image tree.

## Current measurements

Measured on 2026-08-30T22:23:10Z from the video evidence-correction
commit `0e8f592d7f0decb27948f12ff5894b7ac618f66e` and the sibling image
gallery final main `3749f57942874bf32cb3a0c89524ad27f168b47f`. One mebibyte is
1,048,576 bytes. The policy-only commit after the video measurement changes
only this document; re-run the commands below before any threshold decision.

| Gallery | HEAD | Tracked working tree | Admitted media | Largest tracked file |
| --- | --- | --- | --- | --- |
| Video | `0e8f592` | 3,033,185 B (2.89 MiB) | 2,865,000 B (2.73 MiB), 4 files | 2,007,401 B (1.91 MiB) `media/xai-official-01--minimax-h3.mp4` |
| Image | `3749f57` | 1,424,765 B (1.36 MiB) | 1,262,070 B (1.20 MiB), 2 files | 839,822 B (0.80 MiB) `media/xai-official-01--codex-image.webp` |

All-history blob bytes (every blob reachable from `--all`): video 7,381,620 B
(7.04 MiB); image 2,553,017 B (2.43 MiB). This includes withdrawn candidate
assets retained in Git history. The image checkout also tracks a 1-byte
`media/.gitkeep`, which is not admitted media.

Admitted video files: `media/xai-official-01--minimax-h3.mp4` 2,007,401 B; `media/minimax-official-01--minimax-h3.mp4` 810,733 B; posters 27,288 B and 19,578 B. Admitted image files: `media/xai-official-01--codex-image.webp` 839,822 B; `media/openai-official-01--codex-image.webp` 422,248 B.

Re-run from either repository root:

```console
git rev-parse HEAD
git ls-files -z | xargs -0 wc -c
git ls-files -z -- media | xargs -0 wc -c
git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | awk '$1=="blob" { n++; s+=$3 } END { print n, s }'
```

Tracked working-tree bytes are the Pages payload proxy: `pages.yml` uploads the repository root. History blob bytes are git storage, not the published site.

## Documented platform limits

These figures come from current official documentation. They are not this repository's local thresholds.

| Limit | Documented value | Kind | Source |
| --- | --- | --- | --- |
| GitHub web UI file add | 25 MiB per file | Hard for browser uploads | [Adding a file to a repository](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository) |
| Git push warning | > 50 MiB per file | Warning | [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) |
| Git push block | > 100 MiB per file | Hard | [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) |
| Recommended repository size | ideally < 1 GB; < 5 GB strongly recommended | Recommendation | [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) |
| GitHub Pages source repository | recommended 1 GB | Recommendation | [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| Published GitHub Pages site | no larger than 1 GB | Hard | [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| GitHub Pages bandwidth | 100 GB per month | Soft | [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| GitHub Pages builds | 10 builds per hour | Soft; does not apply to custom Actions workflows | [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| GitHub Pages deploy timeout | 10 minutes | Hard | [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| Git LFS on Pages | cannot be used with GitHub Pages sites | Hard exclusion | [About Git Large File Storage](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage) |
| Git LFS free quota (GitHub Free) | 10 GiB bandwidth and 10 GiB storage per billing cycle | Allowance | [Git Large File Storage billing](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-storage-and-bandwidth-usage) |
| Release asset count | 1000 assets per release | Hard | [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) |
| Release asset size | each file under 2 GiB; no documented total-size or bandwidth cap | Hard per file | [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) |
| Cloudflare R2 Standard free tier | 10 GB-month storage, 1 million Class A, 10 million Class B, free egress | Monthly allowance | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Cloudflare R2 Standard paid rates | $0.015 / GB-month storage; $4.50 / million Class A; $0.36 / million Class B; $0 egress | List price | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |

GitHub Pages limits do not state a distinct per-file byte cap for published assets. The 25 MiB figure in this project is GitHub's documented browser-upload limit, adopted locally as a hard admission guard so every public file remains addable through the web UI and stays well below the 50 MiB git warning. GitHub's Pages docs say that exceeding quotas may lead GitHub to stop serving the site or to suggest a third-party CDN, Releases, or another host.

## Local review thresholds

Local numbers are policy, not GitHub or Cloudflare enforcement.

| Guardrail | Value | Kind |
| --- | --- | --- |
| Public browser asset (MP4, WebP, or other admitted media) | strictly < 25 MiB (26,214,400 bytes) | Hard local. Matches `MAX_FILE_BYTES` in `scripts/validate.mjs`. |
| Tracked working tree (Pages payload proxy) | 1 GB published-site cap | Hard platform, never approach. |
| Any tracked public asset ≥ 10 MiB | 10,485,760 bytes | Warning. Owner re-measures both galleries before admitting more cells. |
| Tracked working tree ≥ 200 MiB | ~20% of the 1 GB published-site cap | Warning. |
| Estimated or observed Pages bandwidth ≥ 20 GB in a month | 20% of the 100 GB soft cap | Warning. |
| A reviewed original cannot be admitted under 25 MiB, or tracked working tree ≥ 400 MiB, or published-site estimate ≥ 500 MiB, or Pages bandwidth ≥ 50 GB in a month | migrate-threshold | Originals may leave Pages. Browser derivatives that stay under 25 MiB remain on Pages. |

Current measured trees (2.89 MiB video, 1.36 MiB image) sit far below every
warning. Stay on GitHub Pages.

## Owner action and no-migration-before-threshold

| Item | Rule |
| --- | --- |
| Owner | Maintainer of both galleries. Re-run the measurement commands in this file before admitting a file ≥ 10 MiB or adding cells that would grow `media/`. |
| Warning action | Open an issue with the new byte counts. Prefer a browser derivative already described in `METHODOLOGY.md`. Do not change hosting. |
| Migrate-threshold action | Open a dedicated hosting issue. Keep HTML, CSS, JS, and < 25 MiB derivatives on Pages. Offload originals using the decision rule below. Do not migrate in the same change that first records the threshold. |
| **No-migration-before-threshold** | Do not move originals to GitHub Releases, Cloudflare R2, or any other origin until at least one migrate-threshold row is actually crossed and recorded. Planning is allowed. Performing the move is not. |

## Pages versus Releases versus R2

Generation already happens outside Pages. The public question is only where admitted bytes are served.

**GitHub Pages (current, required until a migrate-threshold).** Zero extra product cost while the site stays inside the documented 1 GB / 100 GB-month quotas. The whole static tree is the site, including media. Cacheability is that of a static GitHub Pages deployment: files are public URLs until the next deploy. GitHub does not document a Cache-Control setting for these project sites. Bandwidth still counts against the 100 GB/month soft cap whether or not a CDN edge serves the bytes. Git LFS cannot carry Pages media.

**GitHub Releases (first offload after a migrate-threshold).** GitHub documents no cap on total release size or bandwidth, and a 2 GiB per-file cap. That fits archival originals and download-on-demand. Releases are not a website origin: they do not replace Pages, they do not provide documented site-style cache control, and inline playback would depend on hotlinking a distribution artifact. Use Releases when the need is to keep a large original downloadable without growing the Pages tree.

**Cloudflare R2 (second offload, only if the gallery must hotlink or stream large originals).** R2 has no egress fee. The Standard free tier (10 GB-month, 1 million Class A, 10 million Class B) covers the current galleries with margin. Paid Standard storage is $0.015 per GB-month after the free tier. Public buckets can sit on a custom domain and use Cloudflare Cache; default cache file types do not cover every media type, so a Cache Everything rule is required to cache all objects ([Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)). R2 adds an external account, DNS, and credentials, which this project otherwise refuses to put in the public tree. It is the only option of the three with operator-controlled caching, and the only one with a non-zero list price after free usage.

**Cost assumptions (not invoices).** At the measured sizes, Pages, Releases, and the R2 free tier would all bill $0 for storage. Pages remains cheapest in operations because it needs no second origin. R2 becomes the bandwidth hedge if monthly Pages traffic approaches 50 GB or if originals must be hotlinked above 25 MiB. Releases remain the zero-egress-cap archive without turning GitHub into a streaming CDN. These dollar figures are Cloudflare list prices and GitHub documented allowances, not a forecast of this project's traffic.

## Decision rule

1. Admit only derivatives or originals that are strictly smaller than 25 MiB into the public tree.
2. Keep serving from GitHub Pages while every local warning is untriggered.
3. After a warning: re-measure, record bytes in an issue, and keep Pages.
4. After a migrate-threshold: Pages keeps the site shell and any < 25 MiB browser assets; originals go to Releases unless the public page must stream those originals, in which case R2 on a custom domain is the hot origin.
5. Never introduce Git LFS as a Pages media path.
6. Never migrate because a future cell *might* be large.

## Cacheability

| Origin | What is documented | What this project assumes |
| --- | --- | --- |
| GitHub Pages | Static hosting with a published-site cap and a soft bandwidth cap. | Public, cacheable-as-static URLs. No operator Cache-Control. Count bandwidth against 100 GB/month. |
| GitHub Releases | Distribution of binaries; no bandwidth cap. | Not a site cache. Fine for downloads; not the default playback origin. |
| R2 + custom domain | Cloudflare Cache; Cache Everything to cache all file types; `r2.dev` is non-production and has no WAF/cache product surface. | Best cache control of the three, at the cost of a second origin. |

## Bound

This policy applies to both galleries. Changing it requires a documentation change in this file on `official-prompt-video-gallery` `main`. The image gallery links here; it does not fork the numbers.
