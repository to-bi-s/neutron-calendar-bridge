## Notice

This package contains vendored code derived from Proton open-source projects and bundled third-party runtimes.

Top-level package license:
- this extracted package is distributed as `GPL-3.0-only`

Local license metadata in the source checkout (WebClients at the commit in `vendor/manifest.json`) indicates:
- Proton `WebClients` root repo: `GPL-3.0`
- vendored `@proton/shared`: `GPL-3.0`
- vendored `@proton/key-transparency`: `MIT`
- vendored `@proton/sanitize`: no package-specific `license` field; repo-wide `GPL-3.0`
- vendored `@proton/utils`: no package-specific `license` field or `LICENSE` file found; repo-wide `GPL-3.0` is the relevant local license signal

Proton's crypto code is no longer vendored: it comes from npm as `@protontech/crypto` (`GPL-3.0`; it brings Proton's OpenPGP.js fork `@protontech/openpgp`, `LGPL-3.0-or-later`, installed under the name `openpgp`).

The vendored components keep their upstream notices, and the package itself is intended to be released as open source under GPL-3.0-only because the extracted runtime includes GPL-licensed Proton code.

Vendored source locations:
- `vendor/@proton/...`
