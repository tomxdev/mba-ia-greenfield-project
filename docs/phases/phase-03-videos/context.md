---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-23T15:08:12-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-17T21:19:25-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-06-23T15:08:12-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-06-23T15:08:12-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-06-23T15:08:12-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-06-23T15:08:12-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-06-23T15:08:12-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-23T15:08:12-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-06-23T15:08:12-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-06-23T15:08:12-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ Adicionalmente, o enunciado do desafio (`PLAN.md`) restringe esta execução da fase a backend apenas — nenhuma interface de vídeo (`next-frontend/`) faz parte do escopo desta rodada.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (todas as capacidades desta fase).

**Deferred subprojects:** `next-frontend/` — fora de escopo por decisão explícita do desafio (`PLAN.md`), não do `project-plan.md`.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta (depende de Fase 01)
- **Phase 04:** Gerenciamento de Vídeos e Canal (depende de Fase 02, Fase 03)

## Decisions Index

_(from decisions-reader — one row per TD across phase-scope + ad-hoc docs)_

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Tecnologia de fila de processamento em segundo plano | decided | A (BullMQ + Redis) | bullmq, @nestjs/bullmq |
| phase-03-videos/TD-02 | phase | Backend | Cliente de object storage e organização de buckets/chaves | decided | A (minio — cliente oficial) | minio |
| phase-03-videos/TD-03 | phase | Backend | Estratégia de upload de arquivos de até 10GB sem travar a API | decided | A (S3 Multipart Upload com URLs pré-assinadas por parte) | — |
| phase-03-videos/TD-04 | phase | Backend | Execução do worker e extração de metadados/thumbnail | decided | A (fluent-ffmpeg) | fluent-ffmpeg |
| phase-03-videos/TD-05 | phase | Backend | Estratégia de URL única e de streaming/download | decided | B (Redirect para URL pré-assinada de leitura) | — |
| phase-03-videos/TD-06 | phase | Backend | Ciclo de status do vídeo e tratamento de falha no processamento | decided | A (Enum de status + retries automáticos da fila com backoff) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** a integração oficial com NestJS, os retries/backoff nativos (que resolvem diretamente o requisito de tratamento de falha do TD-06) e a maturidade do ecossistema superam o custo de adicionar Redis ao Compose, que é uma única linha de serviço com imagem oficial leve. É o padrão de fato para este exato padrão (producer na API, consumer isolado em worker separado) no ecossistema Node/NestJS.
**Libraries:** bullmq, @nestjs/bullmq

### phase-03-videos/TD-02

**Recommendation:** a compatibilidade de presigned URLs comprovada com o MinIO local (que é onde todo o desenvolvimento e os testes de integração vão rodar) pesa mais do que a portabilidade teórica para S3 real, que hoje não existe neste projeto. O pacote `minio` documenta compatibilidade com S3 real também, então a troca futura de storage não fica bloqueada — só precisa ser revalidada quando (e se) a troca acontecer.
**Libraries:** minio

### phase-03-videos/TD-03

**Recommendation:** é a única opção que combina resumabilidade real, ausência de infraestrutura adicional (reaproveita o storage já decidido) e alinhamento direto com a sugestão do próprio enunciado do desafio.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** apesar do aviso de manutenção, é a opção que resolve diretamente extração de metadados + captura de frame com menos código novo no worker, e a extensa adoção da comunidade compensa a falta de manutenção ativa para os comandos padrão que esta fase precisa (não há uso de features exóticas do FFmpeg aqui). O binário `ffmpeg`/`ffprobe` é instalado na imagem Docker do worker via `apt`.
**Libraries:** fluent-ffmpeg

### phase-03-videos/TD-05

**Recommendation:** é a opção que confirma o desenho já presente no diagrama de arquitetura do projeto, evita reimplementar manualmente o suporte a `Range`/`206` (que o storage já resolve), e mantém a URL pública estável e controlada pela API (diferente da Option C), preparando o terreno para controle de visibilidade na Fase 04 sem exigir retrabalho nesta fase.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** usa diretamente o retry/backoff que já vem "de graça" com a fila escolhida em TD-01, resolvendo o requisito de "o que acontece em caso de falha" com o mínimo de código novo, e corresponde exatamente à granularidade de ciclo de status pedida no enunciado (rascunho → processando → pronto/erro), nem mais nem menos.
**Libraries:** —

## Inherited Decisions Detail

_(inherited TDs from prior phases — from phases-reader — plus TDs from correlator-confirmed ad-hoc docs, dedupe applied; no overlap found between the two sources)_

### phase-01-configuracao-base/TD-01

**Recommendation:** @nestjs/config — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** @nestjs/config@^4.x

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request.
**Libraries:** joi@^17.x

### phase-01-configuracao-base/TD-03

**Recommendation:** Namespaced/grouped config with `registerAs` — o roadmap do projeto já prevê auth, email e storage em fases futuras. Configs namespaced dão limites de arquivo claros por domínio, injeção tipada via `ConfigType<typeof databaseConfig>`, e escalabilidade natural. A factory `registerAs()` é dual-purpose: DI token dentro do NestJS e função simples importável para `data-source.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Shared registerAs factory — consequência natural de escolher `@nestjs/config` com `registerAs`. A factory já é chamável por design. `data-source.ts` importa, chama `dotenv.config()`, então chama a factory. Zero duplicação.
**Libraries:** dotenv (transitive via @nestjs/config)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — Para um projeto greenfield em 2026, Argon2id é a escolha recomendada pela OWASP. A dependência de build nativa é um custo único de setup do Docker. O projeto não tem restrições legadas favorecendo bcrypt.
**Libraries:** argon2@^0.41.x

### phase-02-auth/TD-02

**Recommendation:** @nestjs/passport — O plano do projeto inclui apenas email/senha por enquanto, mas a arquitetura de plugin custa pouco e fases futuras podem adicionar login social.
**Libraries:** @nestjs/jwt@^11.0.0

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation — Fornece o modelo de segurança mais forte com detecção automática de roubo de token. O overhead de escrita no DB é aceitável para uma plataforma de vídeo (refresh de auth é infrequente comparado a operações de vídeo). PostgreSQL já está no stack, sem infra nova necessária.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random Opaque Tokens em DB — Revogabilidade é importante: quando um usuário solicita novo reset de senha, tokens anteriores devem ser invalidados. A tabela de DB é trivial de implementar.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** @nestjs-modules/mailer — Melhor integração NestJS com boilerplate mínimo. Suporta SMTP (alinhado com o diagrama de arquitetura), funciona com Mailpit para desenvolvimento local.
**Libraries:** @nestjs-modules/mailer@^2.x, handlebars@^4.x

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — Este é um projeto backend-only (sem schemas compartilhados com frontend), então a vantagem de fonte única do Zod é menos impactante. class-validator é a abordagem documentada do NestJS.
**Libraries:** class-validator@^0.14.x, class-transformer@^0.5.x

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — Fornece códigos de erro legíveis por máquina que o frontend Next.js pode usar em switch, sem o overhead do sistema de tipos baseado em URI do RFC 9457.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** @nestjs/throttler — Integração nativa NestJS é decisiva: o sistema de guards permite escopar rate limiting só ao `AuthModule` via `APP_GUARD` a nível de módulo, com `@SkipThrottle()` para isenções.
**Libraries:** @nestjs/throttler@^6.x

### phase-02-auth/TD-09

**Recommendation:** Opaque — Já que a consulta ao DB é obrigatória (TD-03), a assinatura JWT não adiciona valor de segurança. Tokens opacos são mais curtos e mais simples de gerar.
**Libraries:** @nestjs/jwt@^11.0.0

### phase-02-auth/TD-10

**Recommendation:** Allowlist estrita `[a-z0-9_]` — A plataforma é um serviço de compartilhamento de vídeo com handles de canal baseados em URL. É a escolha mais simples e portável: sem dependências extras, sem edge cases sobre posicionamento de hífen.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Sessão baseada em cookie (custom, sem Auth.js) — o modelo strict-BFF já nomeia o Route Handler como único chamador do NestJS; sessões baseadas em cookie são o par natural, e o framework do Auth.js adiciona camadas entre o BFF e o cookie que não trazem benefício porque o backend é a autoridade de auth.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** iron-session — defesa em profundidade sobre o conteúdo do cookie (`httpOnly` bloqueia JS, criptografia bloqueia inspeção acidental em log/proxy); cookie único simplifica logout; espaço para carregar metadados mínimos do usuário permitindo que RSC renderize o chrome autenticado sem round-trip.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** Single-flight refresh no helper server-side desde o dia um, testado via MSW com asserção de "duas chamadas upstream concorrentes interceptadas; um refresh esperado".
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** react-hook-form + Zod — desacoplado de qual mecanismo de mutação é usado; alinhado com a primitiva canônica de formulário do shadcn; ergonomia Zod-first já usada na validação de env do FE.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Route Handlers como única superfície de mutação — alinhamento com o modelo strict-BFF; scaffold de teste já existe para Route-Handlers-como-funções; superfície de mutação única evita inconsistência de idioma por mutação.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Sessão entregue via RSC + Client Provider hidratado — sem flicker no primeiro render, sem round-trip; sem novo endpoint BFF, o cookie é a fonte da verdade.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** RSC-first-paint-correct — usuário vê o resultado correto no primeiro paint; padrão único de integração entre os fluxos de confirmação e reset ("RSC dono do token, Client Component dono do input").
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Ambos (Runtime UI + artefato estático) — o custo marginal sobre runtime-only é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Apenas em dev/staging via env flag — alinha com a postura defensiva já estabelecida na fase 02 e não compromete consumidores legítimos (o `openapi.json` commitado cumpre o papel de "spec consultável fora da UI").
**Libraries:** —

### next-frontend-config-base/TD-01

**Recommendation:** Zod 4 — inferência de tipos casa com a cultura TS estrita do FE; gravidade de ecossistema no Next.js/React 19; habilita diretamente `@t3-oss/env-nextjs`.
**Libraries:** zod

### next-frontend-config-base/TD-02

**Recommendation:** `@t3-oss/env-nextjs` — única opção que combina aplicação de prefixo `NEXT_PUBLIC_` em nível de tipo, detecção de vazamento via Proxy em runtime, e ergonomia de consumidor single-file.
**Libraries:** @t3-oss/env-nextjs

### next-frontend-config-base/TD-03

**Recommendation:** Strict BFF — chave única server-only `API_URL` — alinhado com a estratégia de teste BFF já documentada no `next-frontend/CLAUDE.md`; elimina CORS, elimina exposição pública da URL do backend.
**Libraries:** —

### next-frontend-msw-foundation/TD-01

**Recommendation:** Módulos por domínio + barrel (`mocks/handlers/<domain>.ts`) — é a recomendação oficial do MSW; ownership de domínio acompanha a organização do código, não o plano do projeto; crescimento append-only com mínimo conflito de merge.
**Libraries:** —

### next-frontend-msw-foundation/TD-02

**Recommendation:** Apenas `setupServer` (teste) na fundação — o worker de browser é uma capacidade futura sem consumidor documentado atual; adicioná-lo agora é investimento especulativo.
**Libraries:** —

### next-frontend-msw-foundation/TD-03

**Recommendation:** Defaults hand-written como padrão + faker seedado opt-in para builders de coleção em massa — o determinismo e legibilidade da Option B é a linha de base certa; casos de coleção em massa vão chegar e listas hand-written de 20+ itens são tediosas.
**Libraries:** —

### next-frontend-msw-foundation/TD-04

**Recommendation:** Conjunto universal de handlers + overrides via `server.use(...)` + `onUnhandledRequest: "error"` — padrão canônico do MSW v2; zero complexidade de setupFiles por fase.
**Libraries:** —

### next-frontend-openapi-typing/TD-01

**Recommendation:** `openapi-typescript` + `openapi-fetch` — BFF estrito torna a superfície de SDK sem valor no cliente; abordagem type-first casa com o resto da fundação FE; tipagem MSW resolvida pelo mesmo símbolo `paths`.
**Libraries:** openapi-typescript, openapi-fetch

### next-frontend-openapi-typing/TD-02

**Recommendation:** Cópia local commitada + script de sync no repo-root — preserva a independência dos stacks Compose; drift eliminado estruturalmente quando combinado com a checagem de frescor de CI da TD-03.
**Libraries:** —

### next-frontend-openapi-typing/TD-03

**Recommendation:** Commitado + checagem de frescor de CI (híbrido) — única opção que torna a mudança de contrato visível (diff em PR) e impossível de mergear com drift acidental.
**Libraries:** —

### next-frontend-openapi-typing/TD-04

**Recommendation:** Barrel único `lib/api/contracts.ts` com aliases explícitos — única opção que lida com pass-through e reshape com o mesmo mecanismo, dando um único alvo de grep para "que forma o BFF expõe".
**Libraries:** —

### next-frontend-openapi-typing/TD-05

**Recommendation:** Handlers MSW hand-written, tipados via `paths` — determinismo sobre auto-geração; testes de integração BFF fazem asserção sobre valores específicos; coerência com a recomendação da TD-01.
**Libraries:** —

## Inherited Conventions

_(from phases-reader — compact list; sourced from prior phases in phase mode)_

- Backend config usa `@nestjs/config` com factories `registerAs(name, () => ({...}))` namespaced — um arquivo por domínio em `src/config/`. _(from phase 02)_
- Env variables são validadas por um schema Joi em `src/config/env.validation.ts`, passado ao `ConfigModule.forRoot({ validationSchema, ... })`. _(from phase 02)_
- Config é injetado nos módulos via `ConfigType<typeof xxxConfig>` e `@Inject(xxxConfig.KEY)`; a mesma factory é importável como função simples. _(from phase 02)_
- `data-source.ts` carrega `.env` via `import 'dotenv/config'` no topo, depois importa `databaseConfig` e o chama como função simples. _(from phase 02)_
- Parâmetros de conexão do banco são vindos de uma única factory `databaseConfig` — nunca duplicados entre `AppModule` e `data-source.ts`. _(from phase 02)_
- `TypeOrmModule.forRootAsync` é usado (não `forRoot`), com `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` retornando as opções. _(from phase 02)_

## Inherited Deferred Capabilities

_(from phases-reader — informational-only; plan-validate does NOT fire issues based on unaddressed entries)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| "Telas de frontend" | deferred | phase-01-configuracao-base | `next-frontend/` não é inicializado nesta fase; superfícies de UI começam em fase posterior. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth | `next-frontend/` não é inicializado nesta fase; superfícies de UI começam em fase posterior. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | Tela de confirmação de conta adiada para fase futura; lado backend inalterado em `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | Botão de logout vive dentro do chrome autenticado (tipicamente Fase 04). |
| "Recuperação de senha (tela de destino / definir nova senha)" | deferred | phase-02-auth-frontend | `/forgot-password` envia o e-mail nesta fase; a tela de destino do reset está ausente do Figma. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | Bullet guarda-chuva depende das telas de confirmação e reset-password ainda ausentes. |

## Non-UI / Deferred Capabilities

_(empty on first assembly — plan-resolve appends rows as user marks capabilities)_

_None._

## Testing Requirements

_(from testing-guide-nestjs-project skill, § 3 — Feature Implementation Checklist)_

### nestjs-project

| Artifact type | Required layers |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (queue, storage) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service or local adapter — CLAUDE.md rule "não mocke o que dá para testar de verdade com a infra do Compose" aplica diretamente ao storage/fila real desta fase |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to framework) | E2E only |
| Exception Filter | Unit + E2E |

Notas específicas da fase (do guia, § "Worth testing"): "Service-to-external-system contracts — local storage uploads, SMTP sends via Mailpit, queue publishing" e "Race conditions — concurrent video uploads, duplicate likes/subscriptions" já antecipam explicitamente os cenários de storage/fila/upload concorrente desta fase. "Module with configured imports (`BullModule.registerQueue()`)" já antecipa o módulo de fila (TD-01).
