Runtime notices shipped with both static build profiles:

- Dalton website portrait: `DALTON-WEBSITE.txt` (CC BY-SA 4.0);
  attribution and pinned source in `web/branding/NOTICE.txt`.
- Dalton: `assets/DALTON-LICENSE.txt`, from the repository root.
- xterm.js 5.5.0: `vendor/XTERM-LICENSE.txt`, from its pinned npm archive.
- Emscripten runtime: `EMSCRIPTEN.txt`, from the pinned SDK's LICENSE.
- musl libc: `MUSL.txt`, from the SDK's system/lib/libc/musl/COPYRIGHT.
- LLVM/Flang runtime and libc++: `LLVM.txt`, the Apache 2.0 with LLVM
  exceptions notice supplied in the SDK's system/lib/libcxx/LICENSE.TXT.
- OpenBLAS: `OPENBLAS.txt`, from the pinned OpenBLAS source (used only in
  the optimized profile).
- Optional math candidates: `BLIS.txt` (BSD-3-Clause), `LAPACK.txt`
  (modified BSD); pinned revisions in `dependencies.json`.
- Ketcher 3.18.0: `KETCHER.txt` and `KETCHER-NOTICE.txt` (Apache-2.0);
  third-party notices are retained beside its bundled JavaScript.
- OpenChemLib JS: `OPENCHEMLIB.txt` (BSD-3-Clause).
- JSmol: `JSMOL.txt` and `JSMOL-COPYRIGHT.txt` (LGPL-2.1-or-later).
  Versions, upstream source links and archive checksums are recorded in
  `browser/visualization-dependencies.json` and `web/vendor/NOTICE.txt`.

Compiler and dependency revisions are recorded in the build manifest,
`browser/dependencies.json`, and bootstrap/build recipes. Modified Dalton
sources and the browser portability layer are included in the source archive
created by `browser/scripts/package.py`.
