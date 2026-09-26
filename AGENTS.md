# AGENTS.md

两个自包含的静态证据画廊：`image/` 和 `video/`，一起部署到 GitHub Pages。

- 在画廊目录内运行命令；每个画廊的方法论见各自的 `METHODOLOGY.md`，证据清单是 `data/comparison.json`，每个样本都要有 `receipts/` 里的来源回执。
- 页面只陈列证据：每格一个样本，不加胜者、评分或排名。
- 托管策略只有一份：`docs/hosting-policy.md`，不要在画廊目录里复制第二份。加媒体前按其中的阈值核对体积。
- 校验：分别在 `image/` 和 `video/` 下跑 `node scripts/validate.mjs --mode authoring`、`node scripts/fixtures/smoke.mjs` 与 `python3 -m unittest discover -s test -p 'test_*.py'`（CI `check.yml` 同样如此）。
