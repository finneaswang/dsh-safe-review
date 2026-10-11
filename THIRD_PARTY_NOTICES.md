# Third-party notices

## NanmiCoder/dsh-auto-mode

Source: https://github.com/NanmiCoder/dsh-auto-mode/tree/907d663b7d65e3fcd9f328c598dee03772cac18b

Version: 0.2.0. License: MIT, reproduced in `licenses/NanmiCoder-MIT.txt`.

The following files were copied into `src/vendor`: paths.ts, shell.ts, patch.ts, policy.ts, artifacts.ts, types.ts, classifier.ts, dsh-classifier.ts. Corresponding paths, patch, shell and policy tests are retained. The upstream automatic-allow assessor remains only as internal upstream code and a regression-test subject; this plugin calls its hard-denial helpers and uses its own stricter policy for grants. dsh-classifier.ts adds an optional systemPrompt override so the advisory reviewer uses this project's human-confirmation policy. Compiled copies are in lib/vendor.

The plugin entry, strict policy, reviewer integration, admission guard, source checking, integration tests, packaging scripts and documentation were authored for this distribution. This is an independent local derivative, not an official DeepSeek or NanmiCoder release.

## DeepSeek Harness

Official packages are external peer/development dependencies, pinned to 0.2.0-rc.2. Cordis is pinned to 4.0.4. Their own package licenses continue to apply. The source audit uses official commit 639ed015397290b3745d163aafe02ffee4aa3f84. No host source was patched.

## PerryLink/dsh-auto-review

Reviewed as a reference at commit 2b931b8375f9ee9ebe20e80ef336c69804e1aac0. No source code was copied, bundled or used as a runtime dependency.
