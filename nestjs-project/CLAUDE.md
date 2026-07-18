# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP test server, ports `1025` (SMTP) / `8025` (web UI)
- `minio` — S3-compatible object storage, ports `9000` (API) / `9001` (console), used for video files and thumbnails
- `redis` — BullMQ's job queue backend, port `6379`
- `video-worker` — standalone Node process (no HTTP server) that consumes the video-processing queue and runs FFmpeg; built from `Dockerfile.worker`, not `Dockerfile.dev`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Video Upload & Processing

The `videos/` module (`src/videos/`) handles video creation, multipart upload, and playback. It depends on `storage/` (MinIO client wrapper, `src/storage/storage.service.ts`) and a dedicated queue module (`src/videos/videos-queue.module.ts`), and hands off processing to a standalone worker process (`src/worker/`).

### Upload flow (client-driven multipart, never proxied through the API)

The API never receives the video bytes — the client uploads directly to MinIO using presigned URLs, so a 10GB upload never ties up an API request:

1. `POST /videos` — pre-registers the video as a `draft` owned by the caller's channel, calls `StorageService.initiateMultipartUpload` and returns the `uploadId`.
2. `POST /videos/:id/upload-parts` — given a list of part numbers, returns one presigned `PUT` URL per part (`StorageService.presignedUploadPartUrl`). The client `PUT`s each part directly to MinIO.
3. `POST /videos/:id/complete` — given `{ partNumber, etag }` pairs, calls `StorageService.completeMultipartUpload`, flips the video to `processing`, and enqueues a `process-video` job on the `video-processing` BullMQ queue (`VIDEO_PROCESSING_QUEUE` in `videos-queue.module.ts`).

Object keys are prefixed by the video's `short_id` (a nanoid, not the DB `id`), e.g. `{shortId}/original.mp4` and `{shortId}/thumbnail.jpg` — this avoids depending on the DB-generated `id` before the row exists.

### Worker (`src/worker/`)

A separate NestJS application context (`NestFactory.createApplicationContext(WorkerModule)`, entrypoint `src/worker/main.ts`), run by the `video-worker` Compose service (`Dockerfile.worker`, which installs the real `ffmpeg`/`ffprobe` binaries — `nestjs-api`'s image does not have them). `VideoProcessor` (`@Processor(VIDEO_PROCESSING_QUEUE)`, extends `WorkerHost`) consumes `process-video` jobs: downloads the original from storage, runs `ffprobe` for duration/metadata, generates a thumbnail via `fluent-ffmpeg`'s `.screenshots()`, uploads the thumbnail, and sets the video to `ready`. The queue's `defaultJobOptions` (`attempts: 8`, exponential backoff from 3s) apply; the `@OnWorkerEvent('failed')` handler only marks the video `error` (with `processing_error` populated) once `job.attemptsMade` reaches the configured attempt limit — earlier attempts are silently retried by BullMQ.

### Playback

`GET /videos/:id` returns video details (status, duration, processing error). `GET /videos/:shortId/stream` and `GET /videos/:shortId/download` both require `status: ready` (409 `VIDEO_NOT_READY` otherwise) and respond with a `302` redirect to a presigned MinIO read URL — `stream` with no override (inline playback, native `Range`/`206` support from MinIO), `download` with `response-content-disposition: attachment`. All three endpoints are open to any authenticated user, not just the video's owner.

### Status lifecycle

`draft → processing → ready | error`, stored on `Video.status` (`src/videos/entities/video.entity.ts`). Draft is set on `POST /videos`; processing on upload completion; ready/error is set exclusively by the worker.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
