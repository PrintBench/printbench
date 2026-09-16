# Model packages

A package is a directory that owns shared files while keeping the printable
models below it separate. It is useful for creator bundles that contain common
instructions, licences, archives or images alongside multiple model folders.

Declare a package by placing `.printbench-package.json` in its root:

```text
TitanPals Cosmic Duo/
├── .printbench-package.json
├── Assembly Instructions.pdf
├── Complete Package.zip
├── preview.webp
├── Astro/
│   ├── .printbench.json
│   └── astro.stl
└── Rocket/
    ├── .printbench.json
    └── rocket.stl
```

The package page shows only files owned directly by the package (including
files in conventional image folders), followed by links to the child models.
Files inside `Astro` and `Rocket` remain attached to those models and are not
duplicated into the package.

The package sidecar uses the same versioned JSON fields as `.printbench.json`:

```json
{
  "version": 1,
  "name": "TitanPals Cosmic Duo",
  "creator": "TitanPals",
  "notes": "Two related assembly kits",
  "tags": ["kit", "space"],
  "previewFile": "preview.webp"
}
```

The distinction between the two sidecars is intentional:

- `.printbench.json` declares one model and absorbs its subtree.
- `.printbench-package.json` declares a package and preserves every model
  boundary below it.

Both files are metadata only. PrintBench continues to index the original
directory structure in place and does not move or duplicate creator files.
