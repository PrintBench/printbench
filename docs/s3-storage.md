# S3 and S3-compatible storage

Nothing in the application needs to be built, enabled or configured to use S3.
The backend is complete end to end — the storage adapter, presigned downloads,
multipart uploads, scanning, mesh analysis, thumbnails, ZIP downloads, sidecar
writes and the admin UI that collects the settings all handle a bucket the same
way they handle a folder. There is no environment variable that switches it on
and no code to add.

What _does_ need setting up is on the storage side: a bucket, a key pair scoped
to it, and — if you want the in-page 3D viewer to work — a CORS rule. That is
what this page covers.

S3 is configured **per library**, not globally. One installation can index a NAS
mount, a local folder and three buckets at once, and the rest of the app is
unaware of the difference.

---

## Before you start

| You need                  | Why                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| A bucket                  | AWS S3, MinIO, Backblaze B2, Wasabi, Cloudflare R2, Ceph RGW — any of them.                     |
| An access key and secret  | Or an instance role — see [Credentials](#step-2--credentials).                                  |
| A CORS rule on the bucket | Only for the 3D viewer. Downloads work without it. See [CORS](#step-3--cors-for-the-3d-viewer). |
| `BETTER_AUTH_SECRET` set  | The secret key is encrypted with it before it reaches the database.                             |

---

## Step 1 — create the bucket

Create it **private**, with public access blocked. Nothing is ever served from a
public URL: downloads are handed out as presigned links that expire after 15
minutes, so the bucket never needs to be readable by anyone but this
application.

Two layout choices:

- **One bucket per library** is the simplest thing that works.
- **One bucket, several libraries** works too, as long as each library uses a
  different prefix. The app enforces uniqueness on bucket _and_ prefix together,
  so two libraries pointed at the same pair are refused.

A prefix (`models/`, say) also lets a bucket hold things this application should
not index — only keys under the prefix are ever listed.

---

## Step 2 — credentials

### The minimum IAM policy

A **read-only library** (a bucket of files you already have) needs two actions.
`ListBucket` covers both the reachability check that runs before every scan and
the listing the scan itself does; `GetObject` covers downloads, mesh analysis
and thumbnail rendering.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::my-print-library"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::my-print-library/*"
    }
  ]
}
```

An **uploads library** (one the app writes into) needs three more.
`AbortMultipartUpload` is not optional: a failed upload aborts its multipart job
rather than leaving orphaned parts in the bucket accruing storage charges
forever, and without the permission that cleanup silently fails.

```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
  "Resource": "arn:aws:s3:::my-print-library/*"
}
```

If the library is scoped to a prefix, narrow the object resource to
`arn:aws:s3:::my-print-library/models/*` and add an `s3:prefix` condition to the
`ListBucket` statement.

### Or no credentials at all

Leave **Access key ID** and **Secret access key** blank and the AWS SDK's own
credential chain applies — an EC2 instance role, an ECS task role, IRSA on
Kubernetes, `AWS_*` environment variables, or a mounted `~/.aws/credentials`.
This is the better option wherever it is available, because nothing sensitive is
stored in the database at all.

Both the `web` and `worker` processes reach the bucket, so whichever mechanism
you choose has to apply to both.

### How the secret is stored

The secret access key is encrypted with AES-256-GCM under a key derived from
`BETTER_AUTH_SECRET` before it is written, so a database dump alone does not
hand over your bucket. Two consequences:

- `BETTER_AUTH_SECRET` must be set before you add an S3 library.
- **Rotating `BETTER_AUTH_SECRET` makes every stored key undecryptable.** The
  library then falls back to the SDK credential chain and typically starts
  failing with a permissions error. See
  [Rotating or fixing credentials](#rotating-or-fixing-credentials).

---

## Step 3 — CORS, for the 3D viewer

**Downloads do not need CORS.** A download is a plain navigation: the browser
follows the redirect to the presigned URL and saves the file, and no CORS rule is
involved.

**The in-page 3D viewer does.** It fetches the mesh with `fetch()` so it can
parse it in a Web Worker, that request follows the same redirect to the bucket,
and a cross-origin `fetch` without `Access-Control-Allow-Origin` on the response
is blocked. The symptom is specific and easy to misread: every download works,
thumbnails render, and only the interactive viewer fails to load.

For AWS, on the bucket's **Permissions → Cross-origin resource sharing**:

```json
[
  {
    "AllowedOrigins": ["https://prints.example.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-None-Match"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

`AllowedOrigins` must be the origin people actually browse to — the same value
as `APP_URL`, scheme included. `Range` matters because the viewer and resumable
downloads both use it.

For MinIO the same rules go in through `mc` or the console; Backblaze B2 takes
CORS rules per bucket in its own UI or via `b2 update-bucket`; Cloudflare R2
takes the identical JSON under the bucket's settings.

---

## Step 4 — add the library

**Admin → Libraries → New**, then three questions:

1. **Which kind** — files you already have (indexed, never modified) or somewhere
   to upload to (the app writes into it). This decides whether the library is
   read-only, and therefore which of the IAM policies above you need.
2. **Where** — choose **S3-compatible storage**.
3. **The bucket details:**

| Field                 | Notes                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Bucket**            | Required. Name only, no `s3://` and no URL.                                                                   |
| **Prefix**            | Optional. Only keys under it are indexed. Leading and trailing slashes are normalised away.                   |
| **Region**            | Blank means `us-east-1`. Getting this wrong on AWS produces a redirect error, not a hang.                     |
| **Endpoint**          | Blank for real AWS. Set it for anything self-hosted or third-party, with scheme: `https://minio.example.com`. |
| **Access key ID**     | Blank to use the server's own credentials (see above).                                                        |
| **Secret access key** | Encrypted before storage.                                                                                     |

Path-style addressing is switched on automatically whenever an endpoint is set,
because virtual-host addressing needs a wildcard DNS entry per bucket that
self-hosted gateways rarely have.

The next screen is a **dry run**: it checks the bucket is reachable, walks up to
20,000 keys and reports how many models the grouping rules would find, with 20
of them listed. Nothing has been written at that point — if the numbers look
wrong, change the grouping mode and preview again rather than creating the
library and fixing it afterwards.

Once created, run the first scan. Because an S3 library cannot be watched live
(below), give it a scan schedule on the library's row as well.

---

## Provider notes

| Provider          | Endpoint                                        | Region                         |
| ----------------- | ----------------------------------------------- | ------------------------------ |
| **AWS S3**        | Leave blank                                     | The bucket's real region       |
| **MinIO**         | `http://minio:9000` or your external address    | `us-east-1` unless configured  |
| **Backblaze B2**  | `https://s3.<region>.backblazeb2.com`           | e.g. `eu-central-003`          |
| **Wasabi**        | `https://s3.<region>.wasabisys.com`             | e.g. `eu-central-1`            |
| **Cloudflare R2** | `https://<account-id>.r2.cloudflarestorage.com` | `auto`                         |
| **Ceph RGW**      | Your gateway's address                          | Whatever the cluster is set to |

If the app runs in Docker alongside a MinIO container, the endpoint is the
container name on the shared network (`http://minio:9000`), not `localhost`.

---

## What changes once a library lives in a bucket

Most of it is invisible. These six things are not.

- **Downloads never touch the application.** An S3 library serves a presigned
  redirect and the bytes go straight from the bucket to the browser. This is the
  main reason S3 is worth it for a large library. The `FILE_DELIVERY` /
  `X-Accel-Redirect` machinery does not apply to S3 libraries — it still applies
  to local ones and to thumbnails.
- **Live watching is not available.** There is no filesystem for the watcher to
  subscribe to, so an S3 library depends on its scan schedule and on the scan
  that is triggered automatically after an upload. The watch toggle has no
  effect on it.
- **There are no empty folders.** A key is a string; a folder exists only because
  objects share a prefix. A scan of an S3 library can therefore never report an
  empty model folder.
- **Change detection uses ETags, not timestamps**, because `LastModified` changes
  whenever an object is rewritten even when the bytes are identical.
- **Thumbnails and derived assets stay on local disk**, under `DATA_DIR`. Moving
  a library to S3 does not remove the need for a persistent data volume.
- **Uploads are staged locally first.** A browser upload lands in
  `$DATA_DIR/uploads` via tus (resumable, 8 GB cap per file) and is only then
  streamed into the bucket as a multipart upload — 8 MB parts, four in flight, so
  peak memory is around 64 MB whatever the file's size. The data volume needs
  enough free space for the largest upload in progress.

### Where bytes still flow through the worker

Presigned redirects cover single-file downloads. These paths still read from the
bucket through the application, which on a metered provider means egress:

- mesh analysis and thumbnail rendering, once per file per scan;
- whole-model ZIP downloads, which are assembled by streaming each member;
- "open in slicer" links, which rewrite the file to 3MF on the way past and so
  can never be a redirect.

---

## Verifying a bucket works

`npm run verify:s3` exercises the whole S3 path against a real bucket —
multipart upload, presigned download, ZIP extraction, scanning, deletion and the
read-only guard. It defaults to the MinIO in `docker-compose.dev.yml`:

```bash
docker compose -f docker-compose.dev.yml --profile s3 up -d
```

```bash
npm run verify:s3
```

Point it at any other endpoint with `VERIFY_S3_ENDPOINT`, `VERIFY_S3_BUCKET`,
`VERIFY_S3_ACCESS_KEY` and `VERIFY_S3_SECRET_KEY`. It writes only under a
`verify-<timestamp>/` prefix and removes what it wrote.

---

## Rotating or fixing credentials

There is no UI yet for editing an existing library's bucket settings. To change a
key pair, delete the library and add it again with the same bucket and prefix.
**Deleting a library removes the index only** — nothing in the bucket is touched,
and the next scan rebuilds the index from the objects and their sidecar files.

The same applies after rotating `BETTER_AUTH_SECRET`: every stored secret key
becomes undecryptable and has to be entered again.

---

## Troubleshooting

The app translates SDK errors into plain statements. What each one means:

| Message                                                              | Cause                                                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The bucket "x" does not exist, or the endpoint points somewhere else | Typo in the bucket name, or an endpoint aimed at the wrong service.                    |
| That access key is not recognised                                    | Wrong or deleted access key ID.                                                        |
| The secret key does not match the access key                         | Mistyped secret — or `BETTER_AUTH_SECRET` was rotated after the library was added.     |
| The credentials are valid but not allowed to read "x"                | The policy is missing `ListBucket` on the bucket or `GetObject` on its objects.        |
| The bucket is in a different region from the one configured          | Set the region to the bucket's real one. AWS reports this as a redirect, not a 404.    |
| Could not resolve the storage endpoint                               | DNS. Inside Docker, use the container name rather than `localhost`.                    |
| The storage endpoint refused the connection                          | Wrong port, wrong scheme, or the gateway is not running.                               |
| That location is empty                                               | The preview found nothing under the prefix. Check for a leading slash or a typo in it. |
| A library already points at that bucket                              | Bucket and prefix together must be unique across libraries.                            |

Two symptoms that produce no message at all:

- **Downloads work but the 3D viewer never loads** — the CORS rule is missing, or
  its `AllowedOrigins` does not match `APP_URL` exactly.
- **Uploads fail near the end of a large file** — the key is missing
  `s3:AbortMultipartUpload`, or the data volume ran out of space while staging.
