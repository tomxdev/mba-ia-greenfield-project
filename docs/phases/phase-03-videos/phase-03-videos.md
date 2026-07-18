---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-17T21:21:03-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-18T00:08:28-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-17T21:19:25-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-06-23T15:08:12-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-06-23T15:08:12-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-06-23T15:08:12-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-06-23T15:08:12-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Implementar upload resumível de vídeos de até 10GB via multipart pré-assinado direto ao object storage, processamento assíncrono (extração de metadados e geração de thumbnail) via fila e worker dedicado, e entrega de streaming/download por URL única — entregando upload funcional, processamento automático do vídeo, streaming funcionando e URLs únicas geradas.

---

## Step Implementations

### SI-03.1 — Infra: object storage e fila no Compose + configs

**Description:** Provisiona a infraestrutura nova desta fase (MinIO como object storage, Redis para a fila BullMQ) no Docker Compose e cria os arquivos de configuração namespaced seguindo a convenção herdada de config do projeto.

**Technical actions:**

1. Adicionar os serviços `minio` e `redis` a `nestjs-project/compose.yaml`, com healthcheck, seguindo o padrão já usado pelo serviço `db` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` via `registerAs()`, seguindo a convenção herdada de configs namespaced _(from phase 02)_ (per `phase-01-configuracao-base/TD-03`)
3. Adicionar as novas chaves ao schema Joi de `src/config/env.validation.ts` e a `.env.example`: `STORAGE_ENDPOINT`, `STORAGE_PORT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `REDIS_HOST`, `REDIS_PORT` (per `phase-01-configuracao-base/TD-02`)
4. Instalar as dependências decididas: `minio`, `bullmq`, `@nestjs/bullmq`, `fluent-ffmpeg` (per `phase-03-videos/TD-01`, `TD-02`, `TD-04`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe os serviços `minio` e `redis` com status `healthy`
- `docker compose exec nestjs-api node -e "require('minio')"` e `require('bullmq')` resolvem sem erro
- `npx tsc --noEmit` passa com as novas configs adicionadas

### SI-03.2 — Migration: tabela `videos`

**Description:** Cria a tabela `videos` ligada a `channels`, com todos os campos definidos no Data Model desta fase.

**Technical actions:**

1. Criar `src/database/migrations/<timestamp>-CreateVideos.ts` com a tabela `videos` (campos e constraints per `### Data Model → Video` desta especificação), FK para `channels(id)`, e índice único em `short_id`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Migration `CreateVideos` | Integration: aplica e reverte a migration, confere colunas e constraints | `src/database/migrations.integration-spec.ts` (extensão do teste existente) |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas do Data Model
- `npm run migration:revert` remove a tabela `videos` sem afetar `channels`/`users`
- Constraint de unicidade em `short_id` é reforçada pelo banco (insert duplicado falha)

---

### SI-03.3 — Entidade Video + módulo + StorageService

**Description:** Cria a entidade `Video`, o relacionamento inverso em `Channel`, o módulo `VideosModule`, e o `StorageService` que encapsula o cliente `minio` para geração de URLs pré-assinadas.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` (campos per `### Data Model → Video`), com `@ManyToOne(() => Channel)` + `channel_id` explícito, seguindo a convenção herdada de FK explícita + relação bidirecional
2. Adicionar `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` em `src/channels/entities/channel.entity.ts`
3. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])`
4. Criar `src/storage/storage.service.ts` (novo módulo `StorageModule`) — cliente `minio` configurado via `storage.config.ts`, métodos `presignedPutObject`, `presignedGetObject` (com override `response-content-disposition`), geração de `short_id` via `nanoid` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` (entity) | Integration: constraints, defaults, unicidade de `short_id` | `src/videos/entities/video.entity.integration-spec.ts` |
| `StorageService` | Unit: real lib `minio` com config de teste (bucket local) | `src/storage/storage.service.spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `Video` persiste e carrega a relação com `Channel` corretamente
- `StorageService.presignedPutObject` retorna uma URL válida contra o MinIO real do Compose
- `StorageService.presignedGetObject` com override de `response-content-disposition` inclui o header na URL gerada

---

### SI-03.4 — Endpoint POST /videos (pré-cadastro + iniciar multipart upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`

**Description:** Implementa o endpoint que cria o vídeo como rascunho e inicia o multipart upload no storage, retornando o `uploadId` para o cliente prosseguir com o envio das partes.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` (`title`, `fileName`, `fileSizeBytes` — validação per `#### Validation Rules → Video`)
2. Criar `src/videos/videos.controller.ts` com `POST /videos`, protegido pelo guard JWT global (sem `@Public()`)
3. Implementar `VideosService.create` — resolve o canal do usuário autenticado, gera `short_id` único (retry em colisão, seguindo o padrão de `ChannelsService.createChannel`), persiste o vídeo em `draft`, inicia o multipart upload via `StorageService`, persiste `upload_id`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `POST /videos` | E2E: cria rascunho, valida DTO, valida 413 acima de 10GB, valida 401 sem token | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `id`, `shortId`, `status: "draft"`, `uploadId`
- `POST /videos` com `fileSizeBytes` acima de 10GB retorna `413` com `errorCode: "FILE_TOO_LARGE"`
- `POST /videos` sem token de autenticação retorna `401`
- `POST /videos` com corpo inválido (título ausente) retorna `400`

---

### SI-03.5 — Endpoints de partes do upload + fila de processamento

**Route:** POST /videos/{id}/upload-parts, POST /videos/{id}/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`

**Description:** Implementa os endpoints que assinam URLs por parte do multipart upload e completam o upload, enfileirando o job de processamento do vídeo ao finalizar.

**Technical actions:**

1. Criar `src/videos/dto/upload-parts.dto.ts` e `src/videos/dto/complete-upload.dto.ts`
2. Implementar `POST /videos/:id/upload-parts` — valida ownership e status `draft`, retorna URLs pré-assinadas por parte (per `phase-03-videos/TD-03`)
3. Implementar `POST /videos/:id/complete` — valida ownership e status `draft`, completa o multipart upload no storage, transiciona `status` para `processing`, enfileira o job `video.process` (per `phase-03-videos/TD-01`, `TD-06`)
4. Criar `src/videos/videos-queue.module.ts` — `BullModule.registerQueueAsync` para a fila `video-processing`, com `defaultJobOptions` de retry/backoff (per `phase-03-videos/TD-01`, `TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `POST /videos/:id/upload-parts`, `POST /videos/:id/complete` | E2E: fluxo completo de upload-parts + complete contra MinIO/Redis reais, valida 403/404/409 | `test/videos-upload.e2e-spec.ts` (extensão) |

**Dependencies:** SI-03.1, SI-03.4

**Acceptance criteria:**

- `POST /videos/:id/upload-parts` de outro usuário (não dono) retorna `403`
- `POST /videos/:id/complete` com ETags válidas transiciona o vídeo para `status: "processing"` e enfileira o job
- `POST /videos/:id/complete` de um vídeo já `processing` retorna `409` com `errorCode: "INVALID_VIDEO_STATE"`

---

### SI-03.6 — Worker: processamento de vídeo (metadados + thumbnail)

**Description:** Implementa o worker de vídeo como processo/container separado, consumindo o job `video.process`: extrai duração/metadados via `ffprobe`, gera thumbnail via `fluent-ffmpeg`, salva a thumbnail no storage e atualiza o status do vídeo.

**Technical actions:**

1. Criar `src/worker/worker.module.ts` + `src/worker/main.ts` — bootstrap Nest standalone para o processo do worker (per `phase-03-videos/TD-01` — worker roda separado da API)
2. Criar `src/worker/video-processor.ts` (`@Processor('video-processing')`, `extends WorkerHost`) — baixa o original do storage para um path temporário, roda `ffprobe` (duração/metadados), gera thumbnail via `.screenshots()`, envia a thumbnail ao storage, atualiza `Video` para `status: "ready"` (per `phase-03-videos/TD-04`)
3. Tratar falha do job: ao esgotar as tentativas configuradas em SI-03.5, atualizar `Video` para `status: "error"` com `processing_error` preenchido (per `phase-03-videos/TD-06`)
4. Criar `nestjs-project/Dockerfile.worker` — instala `ffmpeg` via `apt`
5. Adicionar o serviço `video-worker` a `compose.yaml`, apontando para `Dockerfile.worker`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: processa um vídeo de teste real via fila/storage/worker do Compose, confere `duration_seconds`, `thumbnail_key`, `status: "ready"` | `src/worker/video-processor.integration-spec.ts` |
| `VideoProcessor` | Integration: job que falha repetidamente esgota tentativas e transiciona para `status: "error"` com `processing_error` preenchido | `src/worker/video-processor.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.5

**Acceptance criteria:**

- Um vídeo enviado via multipart upload é processado automaticamente e transiciona para `status: "ready"` com `duration_seconds` e `thumbnail_key` preenchidos
- A thumbnail gerada existe no storage na chave esperada (`{videoId}/thumbnail.jpg`)
- Um vídeo cujo processamento falha repetidamente (arquivo corrompido) transiciona para `status: "error"` após esgotar as tentativas, com `processing_error` não nulo

---

### SI-03.7 — Endpoints de detalhes, streaming e download

**Route:** GET /videos/{id}, GET /videos/{shortId}/stream, GET /videos/{shortId}/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`

**Description:** Implementa os endpoints de consulta de detalhes do vídeo e de entrega via redirect para URL pré-assinada, cobrindo streaming (inline) e download (anexo).

**Technical actions:**

1. Implementar `GET /videos/:id` — retorna os detalhes do vídeo (status, duração, erro de processamento)
2. Implementar `GET /videos/:shortId/stream` — valida `status: "ready"`, redireciona (`302`) para uma URL pré-assinada de leitura sem override de disposition (per `phase-03-videos/TD-05`)
3. Implementar `GET /videos/:shortId/download` — valida `status: "ready"`, redireciona (`302`) para uma URL pré-assinada com `response-content-disposition: attachment` (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `GET /videos/:id`, `GET /videos/:shortId/stream`, `GET /videos/:shortId/download` | E2E: fluxo completo upload → processamento → stream/download contra um vídeo real processado pelo worker; valida 404, 409 `VIDEO_NOT_READY` | `test/videos-playback.e2e-spec.ts` |

**Dependencies:** SI-03.3, SI-03.6

**Acceptance criteria:**

- `GET /videos/:shortId/stream` de um vídeo `ready` retorna `302` com `Location` apontando para o storage
- `GET /videos/:shortId/download` de um vídeo `ready` retorna `302` com `Location` cuja URL inclui `response-content-disposition=attachment`
- `GET /videos/:shortId/stream` de um vídeo `processing` retorna `409` com `errorCode: "VIDEO_NOT_READY"`
- `GET /videos/:id` de um `shortId`/`id` inexistente retorna `404`

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → channels(id), not null |
| short_id | varchar(12) | unique, not null |
| title | varchar(255) | not null |
| status | enum(draft, processing, ready, error) | not null, default 'draft' |
| processing_error | text | nullable |
| storage_key | varchar(512) | not null |
| thumbnail_key | varchar(512) | nullable |
| duration_seconds | numeric | nullable |
| upload_id | varchar(255) | nullable |
| file_size_bytes | bigint | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), on update now() |

**Relations:** `Video` belongs to `Channel` (many-to-one via `channel_id`); `Channel` ganha o lado inverso (one-to-many) para `Video`.
**Indexes:** unique em `short_id` (per phase-03-videos/TD-05 — URL única sem conflito); index em `channel_id`.

### API Contracts

#### POST /videos (SI-03.X)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, required — título inicial do vídeo
- fileName: string, required — nome original do arquivo enviado
- fileSizeBytes: number, required — tamanho declarado do arquivo, em bytes

**Response 201:**
- id: string (uuid)
- shortId: string
- status: string ("draft")
- uploadId: string — id do multipart upload no storage (per phase-03-videos/TD-03)
- channelId: string (uuid)

**Error responses:**
- 400 validation error: quando o corpo da requisição falha na validação
- 413 FILE_TOO_LARGE: quando `fileSizeBytes` excede 10GB
- 401 unauthorized: quando o token de acesso é ausente/inválido

---

#### POST /videos/{id}/upload-parts (SI-03.X)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- partNumbers: number[], required — números das partes do multipart upload a assinar

**Response 200:**
- urls: object — mapa `{ [partNumber]: string }` de URLs pré-assinadas de PUT por parte (per phase-03-videos/TD-02, TD-03)

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o vídeo não existe
- 403 VIDEO_FORBIDDEN: quando o usuário autenticado não é o dono do canal do vídeo
- 409 INVALID_VIDEO_STATE: quando o vídeo não está em status `draft`

---

#### POST /videos/{id}/complete (SI-03.X)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array, required — lista de `{ partNumber: number, etag: string }` de cada parte enviada

**Response 200:**
- id: string (uuid)
- status: string ("processing")

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 403 VIDEO_FORBIDDEN
- 409 INVALID_VIDEO_STATE: quando o vídeo não está em status `draft`
- 400 MULTIPART_COMPLETE_FAILED: quando o storage rejeita a finalização (ETags inválidas/incompletas)

---

#### GET /videos/{id} (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- id: string (uuid)
- shortId: string
- title: string
- status: string (draft | processing | ready | error)
- durationSeconds: number, nullable
- processingError: string, nullable
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 401 unauthorized

---

#### GET /videos/{shortId}/stream (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:** Redireciona (`Location` header) para uma URL pré-assinada de leitura no storage, sem override de `response-content-disposition` — o navegador reproduz o vídeo inline com suporte nativo a `Range`/`206` do storage (per phase-03-videos/TD-05).

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: quando o status do vídeo não é `ready`
- 401 unauthorized

---

#### GET /videos/{shortId}/download (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:** Redireciona (`Location` header) para uma URL pré-assinada de leitura no storage, com `response-content-disposition: attachment` — força o download em vez de reprodução inline (per phase-03-videos/TD-05).

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY
- 401 unauthorized

---

#### Validation Rules — Video

- `title`: required, string, max 255 caracteres
- `fileName`: required, string
- `fileSizeBytes`: required, number, máximo 10.737.418.240 bytes (10GB) — per phase-03-videos/TD-03
- `partNumbers`: required, array de inteiros positivos
- `parts`: required, array não vazio de `{ partNumber: inteiro positivo, etag: string não vazia }`

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|----------------|-------|
| POST /videos | ✗ | ✗ | ✓ |
| POST /videos/:id/upload-parts | ✗ | ✗ | ✓ |
| POST /videos/:id/complete | ✗ | ✗ | ✓ |
| GET /videos/:id | ✗ | ✓ | ✓ |
| GET /videos/:shortId/stream | ✗ | ✓ | ✓ |
| GET /videos/:shortId/download | ✗ | ✓ | ✓ |

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Vídeo não existe ou id/shortId inválido |
| VIDEO_FORBIDDEN | 403 | Usuário autenticado não é o dono do canal do vídeo |
| FILE_TOO_LARGE | 413 | Tamanho declarado do arquivo (`fileSizeBytes`) excede 10GB |
| INVALID_VIDEO_STATE | 409 | Operação não permitida no status atual do vídeo (ex.: completar upload de vídeo que não está em `draft`) |
| MULTIPART_COMPLETE_FAILED | 400 | Storage rejeitou a finalização do multipart upload (ETags inválidas/incompletas) |
| VIDEO_NOT_READY | 409 | Streaming/download solicitado para vídeo cujo status não é `ready` |

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per phase-03-videos/TD-01), ao completar com sucesso o multipart upload em `POST /videos/{id}/complete`
**Consumer:** `VideoProcessorWorker` (per phase-03-videos/TD-04), processo/container separado
**Trigger:** Upload multipart concluído com sucesso — vídeo transita de `draft` para `processing`
**Delivery semantics:** at-least-once, com retries automáticos e backoff exponencial — até 8 tentativas antes do vídeo transitar para `error` (per phase-03-videos/TD-06)

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root — infra: storage/fila/deps)
SI-03.2 (root — migration videos)
SI-03.3 — depends on SI-03.1, SI-03.2 (entidade + módulo + StorageService)
└── SI-03.4 — depends on SI-03.3 (POST /videos)
    └── SI-03.5 — depends on SI-03.1, SI-03.4 (upload-parts + complete + fila)
        └── SI-03.6 — depends on SI-03.1, SI-03.5 (worker de processamento)
            └── SI-03.7 — depends on SI-03.3, SI-03.6 (detalhes + streaming + download)
```

Ordem linearizada de implementação: SI-03.1, SI-03.2 (paralelas) → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7.

---

## Deliverables

- [ ] SI-03.1 — Infra: object storage e fila no Compose + configs
- [ ] SI-03.2 — Migration: tabela `videos`
- [ ] SI-03.3 — Entidade Video + módulo + StorageService
- [ ] SI-03.4 — Endpoint POST /videos (pré-cadastro + iniciar multipart upload)
- [ ] SI-03.5 — Endpoints de partes do upload + fila de processamento
- [ ] SI-03.6 — Worker: processamento de vídeo (metadados + thumbnail)
- [ ] SI-03.7 — Endpoints de detalhes, streaming e download

**Full test suites:**

- [ ] Testes unit + integration passam (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes E2E passam (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Object storage (MinIO), fila (Redis) e worker sobem via `docker compose up -d` junto com a API
