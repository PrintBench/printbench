# Worker memory and large libraries

A larger Node heap can temporarily allow a workload to finish, but is not a
substitute for reducing retained data. Library size on disk alone does not
predict peak memory: file count, decompressed mesh complexity and overlapping
jobs matter too.

## Reproduced 3MF failure

The previous parser retained XML objects for every vertex and triangle before
copying their values into typed arrays. A generated 3MF with 250,000 triangles
and 750,000 vertices (about 2 MB compressed) exhausted a 128 MiB Node heap.
With a 1,024 MiB heap it completed at approximately 452 MiB peak RSS on Node
26/macOS. The updated parser completed the same fixture under the 128 MiB
heap limit at approximately 175 MiB peak RSS. RSS includes buffers and native
allocations outside the JavaScript heap; the heap limit is not an RSS limit.

Reproduce the workload from the repository root:

```sh
node --import tsx scripts/benchmark-mesh-memory.mts 250000 128
```

Fixture generation happens in a parent process. The reported memory belongs
only to a fresh child process parsing the fixture. The test suite also runs
this workload with the fixed heap limit. Results vary by Node/platform.

Geometry attributes now go directly into chunked typed arrays; the XML tree
retains only the object/component/build structure. The parser skips unrelated
ZIP contents such as slicer G-code and limits the combined expanded size of
geometry, root relationships and images to 256 MiB before extracting entries.
Compressed input retains its 512 MiB limit, now checked before opening files
with known sizes and continuously while reading, including stale size metadata.
Files exceeding a budget are reported as analysis/thumbnail failures rather
than intentionally attempting an allocation beyond the budget. Their original
files remain indexed and available to download.

These changes address a reproduced 3MF hotspot. They do not establish that
every reported NAS scan crash had that cause: the directory walk still builds
an in-memory tree, and other mesh formats have different allocation patterns.

## Diagnose a real workload

Set `WORKER_MEMORY_LOG=1` in `.env` and recreate the worker so Compose applies
the setting. It defaults to off. Run a deep scan and inspect worker logs for
`[worker-memory]` entries:

- Job start/end/error and 15-second samples include file/library IDs.
- Scan phase entries distinguish walking, grouping and reconciliation.
- RSS, heap, external buffers and the process lifetime peak RSS are in MiB.

Measurements are process-wide, not memory attributed to a single job. Multiple
jobs can overlap. Timers cannot sample during synchronous XML parsing, but
the OS peak RSS counter retains the high-water mark. A fatal out-of-memory
exit cannot emit an end/error entry; preceding job starts identify candidates.
For a reproducible crash, record the active file ID, format, compressed and
expanded sizes, scan phase and container memory limit before choosing a fix.

Disable the flag and recreate the worker after collecting logs. The diagnostics
log identifiers and counts, not filenames or file contents.
