# phase-03-videos — Progress

**Status:** completed
**SIs:** 7/7 completed

### Final verification
- Unit + integration suite: 158/158 passing (`docker compose exec nestjs-api npm test -- --runInBand`)
- E2E suite: 63/63 passing (`docker compose exec nestjs-api npm run test:e2e`)
- Type-check: `npx tsc --noEmit` exits 0
- Lint: `npm run lint` — 181 pre-existing errors remain (documented debt from Fases 01-02, none introduced by phase-03-videos scope; see "Regression found and fixed" below for the one real production-code lint error that was fixed)
- `docker compose ps`: db, mailpit, minio, redis all `healthy`; nestjs-api and video-worker both `Up`

### Regression found and fixed during final verification
- Adding `@OneToMany(() => Video, ...)` to `Channel` (SI-03.3) broke TypeORM metadata building for every Fase 01-02 test file that builds its own local `ALL_ENTITIES` array without `Video` — TypeORM requires every entity reachable via a relation to be registered in the DataSource's `entities` list, even when the test doesn't touch `Video` directly. Fixed by adding `Video` to the `ALL_ENTITIES`/entity-list constant in 10 files: `channels/entities/channel.entity.integration-spec.ts`, `channels/channels.service.integration-spec.ts`, `channels/channels.module.spec.ts`, `auth/auth.module.spec.ts`, `auth/auth.service.integration-spec.ts`, `auth/entities/refresh-token.entity.integration-spec.ts`, `auth/entities/verification-token.entity.integration-spec.ts`, `users/users.module.spec.ts`, `users/users.service.integration-spec.ts`, `users/entities/user.entity.integration-spec.ts`, and `database/migrations.integration-spec.ts`.
- `src/worker/video-processor.ts`'s `ffprobe` promise wrapper rejected with fluent-ffmpeg's untyped callback `err` directly, tripping `@typescript-eslint/prefer-promise-reject-errors` (the type isn't provably `Error`). Fixed with an `err instanceof Error ? err : new Error(String(err))` guard — behavior-neutral, satisfies the rule.

### SI-03.1 — Infra: object storage e fila no Compose + configs
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:** none

### SI-03.2 — Migration: tabela videos
- **Status:** completed
- **Tests:** 3 passing
- **Observations:** none

### SI-03.3 — Entidade Video + módulo + StorageService
- **Status:** completed
- **Tests:** 11 passing
- **Observations:**
  - `initiateNewMultipartUpload`/`completeMultipartUpload` do cliente `minio` estão sob `src/internal/` no pacote (não documentados na página pública de docs), mas confirmados como métodos públicos reais via probe em runtime e via `TypedClient` nos `.d.ts` — usados diretamente, sem workaround.
  - Testes de `StorageService` nomeados `*.integration-spec.ts` (não `*.spec.ts` como o plano original sugeria), pois fazem I/O real contra o MinIO — segue a convenção do projeto (`*.spec.ts` proíbe I/O externo).
  - `nanoid` fixado em `^3` (não `^5+`) porque o pacote é ESM-only a partir da v5 e este projeto roda em CommonJS — v3 mantém `require()` síncrono.
  - Adicionado método `presignedPutObject` (whole-object) além dos métodos de multipart, para casar com a AC original do SI que citava esse nome especificamente.

### SI-03.4 — Endpoint POST /videos
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - Adicionado `ChannelsService.findByUserId` (não existia) — necessário para resolver o canal do usuário autenticado; mantém a lógica de canal dentro de `ChannelsModule` (single responsibility).
  - `test/jest-e2e.json` ganhou `testTimeout: 30000` (era o default 5000ms do Jest) — o `beforeAll` que compila `AppModule` agora conecta a um MinIO real via `StorageService.onModuleInit`, e o timeout padrão não era suficiente. Afeta todos os specs E2E (mudança de config compartilhada), não só este.
  - Segui a regra de `phase-b.md` "Tests entries — drop E2E rows for SIs com **Test Specs:**": a tabela Tests original do SI citava `test/videos-upload.e2e-spec.ts` (linha E2E inline), mas como este SI tem `**Test Specs:**`, a cobertura E2E real veio inteiramente do spec-derived file (`test/videos-create.e2e-spec.ts`, via `/plan-test-specs`) — não criei o arquivo inline separado para evitar teste duplicado/conflitante.
  - `short_id` (não o `id` interno) é usado como prefixo da chave de storage (`{shortId}/original.<ext>`) — evita o problema de "ovo e galinha" de precisar do `id` gerado pelo banco antes do insert.

### SI-03.5 — Endpoints de partes do upload + fila
- **Status:** completed
- **Tests:** 3 passing
- **Observations:**
  - `BullModule.forRootAsync` (conexão Redis compartilhada) adicionado ao `AppModule`; `VideosQueueModule` registra a fila `video-processing` via `BullModule.registerQueue` com `defaultJobOptions` (attempts: 8, backoff exponencial) per TD-01/TD-06.
  - Mesmo padrão da SI-03.4 aplicado: só o arquivo E2E derivado do spec (`test/videos-upload-parts.e2e-spec.ts`) foi criado, sem duplicar com a linha inline da tabela Tests original.

### SI-03.6 — Worker: processamento de vídeo
- **Status:** completed
- **Tests:** 2 passing
- **Observations:**
  - Bug real encontrado e corrigido durante verificação manual do container: `WorkerModule` usava `autoLoadEntities: true`, mas só registrava `Video` via `forFeature`. Como `Video → Channel → User` é uma cadeia de relações, faltavam `ChannelsModule` e `UsersModule` na árvore de imports do worker — sem eles, o TypeORM falhava ao construir os metadados das relações inversas (`Entity metadata for Channel#user was not found`). Corrigido importando ambos os módulos.
  - Fixture de vídeo de teste (`test/fixtures/sample.mp4`, 1s, 64x64, gerado via `ffmpeg lavfi`) criada usando o próprio `ffmpeg` do container `video-worker`, já que o host não tem `ffmpeg` instalado e `nestjs-api` também não (só o worker precisa dele).
  - Teste de falha usa override per-job de `attempts`/`backoff` (2 tentativas, 200ms) em vez da config de produção (8 tentativas, backoff exponencial) — testar o caminho real de esgotamento de retries com a config de produção levaria ~6 minutos.
  - `short_id` (não o `id` interno) também usado como prefixo da chave da thumbnail, consistente com a decisão já tomada em SI-03.4 para a chave do arquivo original.

### SI-03.7 — Endpoints de detalhes, streaming e download
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - Usado `@Redirect()` dinâmico do NestJS (retorno `{ url, statusCode: HttpStatus.FOUND }` do handler) em vez de manipular `@Res()` diretamente — padrão idiomático do framework para redirects com URL calculada em runtime.
  - `GET /videos/:id`, `/stream` e `/download` não fazem checagem de ownership (per Authorization Matrix do plano: coluna Owner e Authenticated ambas ✓ para esses 3 endpoints — qualquer usuário autenticado pode consultar/reproduzir/baixar, não só o dono do canal).
  - Teste E2E do fluxo `ready` leva um vídeo real pelo pipeline completo (`POST /videos` → `upload-parts` → PUT real no MinIO com `test/fixtures/sample.mp4` → `complete`) e faz polling no banco até o worker (container `video-worker`, já rodando via Compose) processar o vídeo até `status: ready` — sem mocks, testa a integração real ponta a ponta.
