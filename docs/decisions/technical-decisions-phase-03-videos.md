---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-17
scope_description: "Upload de vídeos até 10GB, fila de processamento em segundo plano, worker FFmpeg, object storage, URL única e streaming/download"
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — recebe o novo módulo de vídeos, a migration da tabela `videos`, o cliente de object storage, o produtor da fila e o worker (processo/container separado que consome os jobs e roda FFmpeg/ffprobe).
- `next-frontend/` — **fora de escopo nesta fase.** O enunciado do desafio (`PLAN.md`) restringe explicitamente a Fase 03 a um desafio de backend: "Há um frontend no repositório, mas a interface de vídeo não faz parte do escopo desta fase." Nenhuma TD deste documento cobre `next-frontend/`.

---

## TD-01: Tecnologia de fila de processamento em segundo plano

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/diagrams/software-arch.mermaid` marca a tecnologia da fila explicitamente como `"TBD"` — é a única peça de stack genuinamente em aberto no diagrama de arquitetura do projeto (o object storage já é dado como S3/MinIO). A fila é o contrato entre a API (produtora, ao concluir o upload) e o Video Worker (consumidor, que roda FFmpeg). O worker precisa rodar como processo/container separado (exigência explícita do desafio), então a tecnologia escolhida precisa suportar produtor e consumidor em processos Node distintos, comunicando-se através de infraestrutura real subindo via Docker Compose — não uma plataforma SaaS externa (isso descartaria opções gerenciadas como Inngest/Trigger.dev, que não "sobem via Docker Compose").

**Options:**

### Option A: BullMQ + Redis
- Fila baseada em Redis, com retries com backoff configurável, concorrência por worker, progresso de job, e dashboards de observabilidade (Bull Board). Possui integração oficial com NestJS (`@nestjs/bullmq`), com decorators para producer/consumer bem documentados.
- **Pros:** ecossistema maduro e o mais adotado no Node.js para este padrão; integração NestJS de primeira classe reduz boilerplate; retries/backoff nativos resolvem diretamente o requisito de "o que acontece em caso de falha no processamento"; fácil rodar via Docker Compose (`redis:alpine`).
- **Cons:** introduz Redis como nova peça de infraestrutura (nenhuma peça de cache/fila existe hoje no projeto); mais uma tecnologia a manter no Compose.

### Option B: RabbitMQ (message broker dedicado)
- Broker de mensagens tradicional, com filas duráveis, acknowledgements manuais e exchanges. Corresponde literalmente ao termo "Message Queue" do diagrama de arquitetura. Integração via `@nestjs/microservices` (transporte RMQ) ou `amqplib` diretamente.
- **Pros:** semântica de mensageria mais rica (exchanges, dead-letter queues nativas); desacopla completamente produtor/consumidor; adequado se o projeto crescer para múltiplos tipos de evento além de processamento de vídeo.
- **Cons:** curva de configuração maior que BullMQ para o caso de uso atual (só uma fila, um worker); a integração `@nestjs/microservices` para RMQ é mais verbosa que decorators do BullMQ; sem retries/backoff automáticos prontos — precisam ser implementados manualmente sobre acknowledgements.

### Option C: pg-boss (fila sobre PostgreSQL)
- Fila que usa o próprio Postgres (via `SELECT ... FOR UPDATE SKIP LOCKED`) como armazenamento de jobs, sem exigir infraestrutura nova. Garantias ACID por já compartilhar a transação com o banco existente.
- **Pros:** zero infraestrutura nova — reaproveita o Postgres 17 já presente no Compose, alinhado com "continuidade, não retrabalho"; simplifica o ambiente de testes de integração (mesma conexão de banco já usada nos testes existentes).
- **Cons:** sem integração oficial NestJS (integração manual); ecossistema e comunidade bem menores que BullMQ; throughput e trocas de contexto menos otimizados que um broker dedicado para cargas de processamento pesado como vídeo.

**Recommendation:** Option A (BullMQ + Redis) — a integração oficial com NestJS, os retries/backoff nativos (que resolvem diretamente o requisito de tratamento de falha do TD-06) e a maturidade do ecossistema superam o custo de adicionar Redis ao Compose, que é uma única linha de serviço com imagem oficial leve. É o padrão de fato para este exato padrão (producer na API, consumer isolado em worker separado) no ecossistema Node/NestJS.

**Decision:** A (BullMQ + Redis)
**Libraries:** bullmq, @nestjs/bullmq

---

## TD-02: Cliente de object storage e organização de buckets/chaves

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O object storage em si não é uma escolha em aberto — MinIO local (compatível com a API S3) é o storage definido, trocável por S3 real em produção. A decisão aqui é (1) qual biblioteca cliente usar para gerar URLs pré-assinadas e ler/escrever arquivos, e (2) como organizar buckets e chaves para vídeos e thumbnails. Essa biblioteca é usada de forma transversal: no fluxo de upload (TD-03, gerando URLs pré-assinadas de PUT), no worker (TD-04, lendo o vídeo original e escrevendo a thumbnail) e no streaming/download (TD-05, gerando URLs pré-assinadas de GET).

**Options:**

### Option A: `minio` (cliente oficial MinIO)
- SDK oficial do MinIO para Node.js, com métodos dedicados para presigned URLs (`presignedPutObject`, `presignedGetObject`) desenhados para funcionar corretamente contra um servidor MinIO.
- **Pros:** compatibilidade de URLs pré-assinadas com MinIO comprovada e sem gambiarras — issues conhecidas mostram que o AWS SDK v3 falha com `SignatureDoesNotMatch`/`AccessDenied` contra MinIO em certas operações de PUT; API simples e direta para o que a fase precisa.
- **Cons:** é uma biblioteca MinIO-first; embora declare compatibilidade S3, não é o SDK oficial da AWS — trocar para S3 real em produção exige validar que o mesmo client funciona sem ajustes (risco menor, mas existe).

### Option B: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (SDK oficial AWS v3)
- SDK oficial da AWS, usado apontando o endpoint para o MinIO local (`endpoint` customizado + `forcePathStyle: true`).
- **Pros:** é literalmente o SDK que será usado em produção contra S3 real — "trocar por S3 em produção" (linha do enunciado) fica trivial, só troca de endpoint/credenciais; maior familiaridade/ecosystem para quem já conhece AWS.
- **Cons:** issues documentadas de incompatibilidade de assinatura (SigV4) entre AWS SDK v3 e MinIO em presigned PUT (cabeçalhos não assinados) — contornável com configuração cuidadosa (`forcePathStyle`, desabilitar checksums automáticos), mas é um ponto de atrito conhecido a resolver na implementação.

**Bucket/key organization:** um único bucket `videos`, com chaves organizadas por prefixo por vídeo: `{videoId}/original.<ext>` para o arquivo enviado e `{videoId}/thumbnail.jpg` para a thumbnail gerada. Um único bucket com prefixos é mais simples de provisionar (uma criação de bucket no bootstrap) que dois buckets separados, e o prefixo por `videoId` já garante isolamento e facilita expiração/limpeza por vídeo se necessário no futuro.

**Recommendation:** Option A (`minio`) — a compatibilidade de presigned URLs comprovada com o MinIO local (que é onde todo o desenvolvimento e os testes de integração vão rodar) pesa mais do que a portabilidade teórica para S3 real, que hoje não existe neste projeto. O pacote `minio` documenta compatibilidade com S3 real também, então a troca futura de storage não fica bloqueada — só precisa ser revalidada quando (e se) a troca acontecer.

**Decision:** A (minio — cliente oficial)
**Libraries:** minio

---

## TD-03: Estratégia de upload de arquivos de até 10GB sem travar a API

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `docs/project-plan.md` (seção "Pontos de Atenção") exige explicitamente que o upload "permita retomar em caso de falha de conexão" — não é só "não travar a API", é resumabilidade real. Isso elimina qualquer estratégia de upload single-shot (um único PUT de 10GB não é retomável: uma queda de conexão a 95% obriga reenviar o arquivo inteiro). O próprio `PLAN.md` já aponta a direção: "upload direto ao storage via URL pré-assinada/multipart, em vez de passar o arquivo pela API".

**Options:**

### Option A: S3 Multipart Upload com URLs pré-assinadas por parte
- Fluxo: `POST /videos` cria o registro rascunho (TD-06) e inicia um Multipart Upload no storage (`CreateMultipartUpload`); a API devolve `videoId` + `uploadId` e o cliente solicita uma URL pré-assinada por parte (tipicamente 5–100MB cada) conforme envia; ao final, o cliente chama `POST /videos/{id}/complete` com as ETags de cada parte, e a API fecha o multipart upload no storage.
- **Pros:** é o padrão de facto da indústria para upload direto a S3-compatível; resumabilidade real — só a(s) parte(s) que falharam precisam ser reenviadas, não o arquivo inteiro; a API nunca recebe os bytes do vídeo, então nunca trava independente do tamanho do arquivo; funciona nativamente com o storage já decidido (MinIO/S3), sem infraestrutura adicional.
- **Cons:** exige orquestração de múltiplas chamadas (iniciar, pedir URL por parte, completar) — mais contratos de API que um upload single-shot.

### Option B: Protocolo tus (upload resumível via servidor dedicado)
- Protocolo HTTP padronizado para upload resumível byte a byte (POST cria recurso, PATCH envia chunks com `Upload-Offset`, HEAD consulta o offset atual após falha). Requer um servidor tus (ex.: `tus-node-server`) como componente adicional.
- **Pros:** resumabilidade byte-a-byte mais granular que partes de multipart; protocolo agnóstico de storage, com backends prontos para S3/GCS/disco.
- **Cons:** adiciona um componente de infraestrutura novo (servidor tus) além do que o worker já introduz; o arquivo tipicamente ainda precisa ser movido do storage temporário do tus para o bucket final — um hop a mais que o multipart direto não tem; não está sugerido no enunciado do desafio, que já aponta para pré-assinada/multipart.

### Option C: Upload single-shot via presigned PUT único
- Um único `PUT` pré-assinado para o arquivo inteiro, sem particionamento.
- **Pros:** o mais simples de implementar — uma URL, um upload.
- **Cons:** **não atende ao requisito de resumabilidade** do `project-plan.md`; uma falha de rede a qualquer momento do upload de um arquivo de até 10GB obriga reenviar tudo — inaceitável para o caso de uso descrito. Descartada.

**Recommendation:** Option A (S3 Multipart Upload com URLs pré-assinadas por parte) — é a única opção que combina resumabilidade real, ausência de infraestrutura adicional (reaproveita o storage já decidido) e alinhamento direto com a sugestão do próprio enunciado do desafio.

**Decision:** A (S3 Multipart Upload com URLs pré-assinadas por parte)

---

## TD-04: Execução do worker e extração de metadados/thumbnail

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O worker precisa rodar como processo/container Node separado da API (exigência explícita do desafio e do diagrama de arquitetura — container "Video Worker"), consumindo jobs da fila decidida em TD-01, lendo o vídeo do storage (TD-02), extraindo duração/metadados, gerando uma thumbnail a partir de um frame, salvando a thumbnail de volta no storage, e atualizando o registro do vídeo no banco.

**Options:**

### Option A: `fluent-ffmpeg` sobre o binário FFmpeg
- Wrapper Node.js mais usado historicamente para orquestrar comandos FFmpeg/ffprobe (extração de metadados via `ffprobe`, captura de frame via `ffmpeg -ss ... -vframes 1`) com API encadeável.
- **Pros:** API madura e amplamente documentada para exatamente este caso de uso (extrair metadados + gerar thumbnail de um frame); ~2M downloads semanais, cobre os cenários comuns sem atritos.
- **Cons:** o pacote está oficialmente sem manutenção ativa (mantainer sinaliza suporte encerrado) — funciona bem para casos comuns, mas edge cases não terão correção rápida. Ainda assim é a opção mais usada em produção para este padrão.

### Option B: `child_process.execFile` direto sobre `ffmpeg`/`ffprobe`
- Chamar os binários diretamente via `execFile`, parseando a saída JSON do `ffprobe` (`-print_format json`) e montando o comando de extração de frame manualmente.
- **Pros:** zero dependência de wrapper (menos uma lib para atualizar); controle total sobre os comandos, sem a camada de abstração do fluent-ffmpeg.
- **Cons:** reimplementa manualmente o que o fluent-ffmpeg já resolve (parsing de argumentos, escaping, tratamento de streams/erros do processo filho); mais código de baixo nível para manter no worker.

### Option C: `@ffmpeg/ffmpeg` (build WebAssembly)
- Build WASM do FFmpeg, roda sem depender do binário nativo instalado no container.
- **Pros:** não depende de instalar o binário FFmpeg na imagem Docker do worker.
- **Cons:** 5-15x mais lento que o binário nativo para as mesmas operações — inadequado para um worker que processa vídeos potencialmente grandes (até 10GB); a "vantagem" de não instalar o binário nativo não compensa, já que o worker roda em container Docker próprio onde instalar o pacote `ffmpeg` do sistema é trivial (`apt install ffmpeg`).

**Recommendation:** Option A (`fluent-ffmpeg`) — apesar do aviso de manutenção, é a opção que resolve diretamente extração de metadados + captura de frame com menos código novo no worker, e a extensa adoção da comunidade compensa a falta de manutenção ativa para os comandos padrão que esta fase precisa (não há uso de features exóticas do FFmpeg aqui). O binário `ffmpeg`/`ffprobe` é instalado na imagem Docker do worker via `apt`.

**Decision:** A (fluent-ffmpeg)
**Libraries:** fluent-ffmpeg

---

## TD-05: Estratégia de URL única e de streaming/download

**Scope:** Backend

**Capability:** Transversal — covers: "URL única por vídeo, sem conflito com outros vídeos", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** `docs/project-plan.md` (seção "Pontos de Atenção") exige explicitamente uma "URL **curta** e única" — isso descarta usar o UUID de 36 caracteres (já usado como PK em todas as entidades do projeto) diretamente na URL pública; um identificador curto adicional (`nanoid`, tipicamente 10–12 caracteres, alfabeto URL-safe) resolve isso sem alterar a convenção de PK UUID já estabelecida — é resolvido via biblioteca padrão (`nanoid`), não é uma decisão estratégica em si (critério (d) do guia de pesquisa: resolvido por convenção, sem múltiplas alternativas com trade-offs reais). A decisão estratégica real é **como a URL entrega os bytes**: proxiada pela API ou redirecionada direto ao storage. O diagrama de arquitetura (`software-arch.mermaid`) já mostra a relação `frontend → storage: "Streams" (HTTPS)` — evidência de que a arquitetura pretendida faz o cliente consumir o vídeo diretamente do storage, não através da API.

**Options:**

### Option A: Proxy — a API lê do storage e transmite ao cliente
- `GET /videos/{shortId}/stream` lê o `Range` header da requisição, abre um stream de leitura do objeto no storage a partir do offset pedido, e transmite (pipe) a resposta com `206 Partial Content` + `Content-Range`.
- **Pros:** URL verdadeiramente estável e opaca (nunca expira, nunca expõe detalhes do storage); controle total sobre autenticação por requisição (útil quando visibilidade público/unlisted existir na Fase 04).
- **Cons:** toda a banda do vídeo passa pela API — exatamente o gargalo que a Fase 03 tenta evitar no upload, agora reaparecendo no download/streaming; contradiz a relação `frontend → storage` do diagrama de arquitetura já definido para o projeto; reimplementa manualmente parsing de `Range`/`206` que o storage já resolve nativamente.

### Option B: Redirect para URL pré-assinada de leitura
- `GET /videos/{shortId}/stream` (e um endpoint de download equivalente com `response-content-disposition=attachment`) gera uma URL pré-assinada de GET de curta duração no storage e responde com `302 Found`/`Location`. O navegador segue o redirect e passa a negociar `Range`/`206` diretamente com o storage, que já suporta isso nativamente.
- **Pros:** alinhado com o diagrama de arquitetura já definido (`frontend → storage: Streams`); banda do vídeo nunca passa pela API; reaproveita o suporte nativo a `Range`/`206` do MinIO/S3 em vez de reimplementá-lo; o mesmo mecanismo cobre streaming e download só variando o parâmetro de content-disposition da URL pré-assinada.
- **Cons:** a URL final (pós-redirect) é temporária — mas isso é transparente ao usuário, que sempre acessa a URL curta e estável (`{shortId}`); qualquer controle de acesso por requisição (relevante a partir da Fase 04, com vídeos unlisted) precisa acontecer antes do redirect, no endpoint da API.

### Option C: Bucket público, URL direta sem assinatura
- Bucket configurado com política pública de leitura; a URL do vídeo aponta direto para o objeto no storage, sem passar pela API em nenhum momento.
- **Pros:** o mais simples de implementar — nenhuma lógica de redirecionamento ou assinatura.
- **Cons:** nenhum controle de acesso possível a partir da API — inviabiliza qualquer visibilidade não-pública (unlisted, da Fase 04) desde já; a "URL única" deixaria de ser um identificador controlado pela aplicação (é a chave do storage exposta diretamente), dificultando trocar a estratégia de armazenamento sem quebrar URLs já compartilhadas.

**Recommendation:** Option B (Redirect para URL pré-assinada) — é a opção que confirma o desenho já presente no diagrama de arquitetura do projeto, evita reimplementar manualmente o suporte a `Range`/`206` (que o storage já resolve), e mantém a URL pública estável e controlada pela API (diferente da Option C), preparando o terreno para controle de visibilidade na Fase 04 sem exigir retrabalho nesta fase.

**Decision:** B (Redirect para URL pré-assinada de leitura)

---

## TD-06: Ciclo de status do vídeo e tratamento de falha no processamento

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** O enunciado do desafio (`PLAN.md`, Critérios de Aceite) exige explicitamente "Ciclo de status do vídeo (rascunho → processando → pronto/erro) refletido no banco". O pré-cadastro como rascunho acontece no primeiro passo do fluxo de upload (TD-03: `POST /videos` cria o registro antes de qualquer byte ser enviado ao storage). A transição para "processando" acontece ao completar o multipart upload e enfileirar o job (TD-01); a transição final para "pronto" ou "erro" acontece no worker (TD-04), após extrair metadados/gerar thumbnail com sucesso ou falhar.

**Options:**

### Option A: Enum de status na própria tabela `videos` + retries automáticos da fila com backoff, status final `error` após esgotar tentativas
- Coluna `status` (`draft` | `processing` | `ready` | `error`) na entidade `Video`. O job de processamento usa os `attempts`/`backoff` nativos do BullMQ (TD-01); só após esgotar as tentativas configuradas o worker marca o vídeo como `error`, persistindo a última mensagem de erro em uma coluna dedicada (`processing_error`).
- **Pros:** aproveita diretamente o mecanismo de retry que já vem com a fila escolhida (TD-01), sem reimplementar lógica de tentativas; estado sempre consultável via uma única coluna, simples de indexar e filtrar; falhas transitórias (ex.: storage momentaneamente indisponível) se resolvem sozinhas sem intervenção.
- **Cons:** nenhum relevante para o escopo desta fase — falhas permanentes (ex.: arquivo corrompido, codec não suportado) ainda assim esgotam as tentativas e terminam em `error` corretamente, sem loop infinito.

### Option B: Status `error` imediato na primeira falha, sem retry automático
- Qualquer exceção no processamento marca o vídeo como `error` de imediato; reprocessamento só acontece via ação manual (endpoint de retry futuro, fora do escopo desta fase).
- **Pros:** mais simples — sem configuração de tentativas/backoff.
- **Cons:** trata falhas transitórias (ex.: uma reinicialização do storage durante o teste local) da mesma forma que falhas permanentes, gerando vídeos marcados como erro por instabilidade momentânea de infraestrutura — pior experiência sem ganho real de simplicidade, já que o backoff automático é praticamente gratuito com a fila escolhida.

### Option C: Máquina de estados com sub-status por etapa (`extracting_metadata`, `generating_thumbnail`, `uploading_thumbnail`, ...)
- Granularidade fina de status por etapa interna do processamento.
- **Pros:** visibilidade detalhada de em qual etapa exata um vídeo está.
- **Cons:** granularidade não pedida pelo enunciado (que define explicitamente só rascunho → processando → pronto/erro); mais estados para migrar, testar e manter sem benefício claro nesta fase — over-engineering para o escopo definido.

**Recommendation:** Option A — usa diretamente o retry/backoff que já vem "de graça" com a fila escolhida em TD-01, resolvendo o requisito de "o que acontece em caso de falha" com o mínimo de código novo, e corresponde exatamente à granularidade de ciclo de status pedida no enunciado (rascunho → processando → pronto/erro), nem mais nem menos.

**Decision:** A (Enum de status + retries automáticos da fila com backoff)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia de fila | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Backend | Cliente de object storage e organização de chaves | `minio` (cliente oficial), bucket único `videos` com prefixo por `videoId` | A (minio) |
| TD-03 | Backend | Estratégia de upload de até 10GB | S3 Multipart Upload com URLs pré-assinadas por parte | A (S3 Multipart Upload) |
| TD-04 | Backend | Execução do worker / extração de metadados e thumbnail | `fluent-ffmpeg` sobre binário FFmpeg no container do worker | A (fluent-ffmpeg) |
| TD-05 | Backend | URL única e entrega de streaming/download | Redirect para URL pré-assinada de leitura no storage | B (Redirect para URL pré-assinada) |
| TD-06 | Backend | Ciclo de status e tratamento de falha | Enum de status + retries automáticos da fila com backoff | A (Enum + retries automáticos) |
