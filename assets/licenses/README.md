Runtime notices shipped with both static build profiles:

- Dalton: `assets/DALTON-LICENSE.txt`, from the repository root.
- xterm.js 5.5.0: `vendor/XTERM-LICENSE.txt`, from its pinned npm archive.
- Emscripten runtime: `EMSCRIPTEN.txt`, from the pinned SDK's LICENSE.
- musl libc: `MUSL.txt`, from the SDK's system/lib/libc/musl/COPYRIGHT.
- LLVM/Flang runtime and libc++: `LLVM.txt`, the Apache 2.0 with LLVM
  exceptions notice supplied in the SDK's system/lib/libcxx/LICENSE.TXT.
- OpenBLAS: `OPENBLAS.txt`, from the pinned OpenBLAS source (used only in
  the optimized profile).

Compiler and dependency revisions are recorded in the build manifest,
`browser/dependencies.json`, and bootstrap/build recipes. Modified Dalton
sources and the browser portability layer are included in the source archive
created by `browser/scripts/package.py`.
