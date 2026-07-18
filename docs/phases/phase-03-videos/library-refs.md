---
libs:
  bullmq:
    version: "^5.x (latest at implementation time — pin exact version in package.json when installed)"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-18T03:08:00Z"
  "@nestjs/bullmq":
    version: "^11.x (peer of @nestjs/core ^11 already installed — pin exact version when installed)"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-18T03:08:00Z"
  minio:
    version: "^8.x (latest at implementation time — pin exact version in package.json when installed)"
    context7_id: "/minio/minio-js"
    fetched_at: "2026-07-18T03:08:00Z"
  fluent-ffmpeg:
    version: "^2.1.x (npm package name stays 'fluent-ffmpeg'; docs sourced from the actively-maintained fork thedave42/node-fluent-ffmpeg per TD-04's note that the original repo lacks active maintenance)"
    context7_id: "/thedave42/node-fluent-ffmpeg"
    fetched_at: "2026-07-18T03:08:00Z"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-17T21:19:25-03:00"
---

# phase-03-videos — Library References

Documentação distilada via Context7, focada nas superfícies que as TDs desta fase realmente usam (TD-01/TD-06 para BullMQ, TD-02/TD-03/TD-05 para minio, TD-04 para fluent-ffmpeg).

## bullmq

**Source:** `/taskforcesh/bullmq`

### Conexão Redis (Queue e Worker em processos separados)

Relevante para o worker rodar como container/processo Node separado da API (arquitetura já definida). Queue (produtor, na API) e Worker (consumidor, no worker) cada um abre sua própria conexão Redis:

```typescript
import { Queue, Worker } from 'bullmq';

// Na API (produtor)
const videoQueue = new Queue('video-processing', {
  connection: { host: 'redis', port: 6379 }, // nome do serviço Compose, nunca localhost
});

// No worker (consumidor, processo separado)
const worker = new Worker(
  'video-processing',
  async job => {
    console.log(job.data);
  },
  { connection: { host: 'redis', port: 6379 } },
);
```

### Retries com backoff exponencial (usado por TD-06)

```typescript
await videoQueue.add(
  'process-video',
  { videoId },
  {
    attempts: 8,
    backoff: {
      type: 'exponential',
      delay: 3000,
      jitter: 0.5,
    },
  },
);
```

`defaultJobOptions` na criação da `Queue` também aceita esse mesmo formato para aplicar a todos os jobs sem repetir por chamada.

## @nestjs/bullmq

**Source:** `/nestjs/bull` (repositório cobre tanto `@nestjs/bull` quanto `@nestjs/bullmq` — mesmo monorepo)

### Registro do módulo + injeção da fila

```typescript
BullModule.registerQueueAsync({
  name: 'video-processing',
  useFactory: () => ({
    connection: { host: 'redis', port: 6379 },
  }),
})
```

### Processor via WorkerHost (consumidor)

```typescript
@Processor('video-processing')
class VideoProcessor extends WorkerHost {
  async process(job: Job<any, any, string>): Promise<any> {
    // extrai metadados, gera thumbnail, atualiza status
  }

  @OnWorkerEvent('completed')
  onCompleted() {
    // marcar vídeo como 'ready'
  }
}
```

### Injetar a fila para enfileirar jobs (na API, após completar o multipart upload)

```typescript
const queue = moduleRef.get<Queue>(getQueueToken('video-processing'));
await queue.add('process-video', { videoId });
```

**Nota de instalação:** `npm i --save @nestjs/bullmq bullmq` (o pacote `@nestjs/bull` clássico usa Bull; para BullMQ o pacote correto é `@nestjs/bullmq`, decidido em TD-01).

## minio

**Source:** `/minio/minio-js`

### Presigned PUT (upload direto ao storage — usado por TD-03, upload multipart)

```typescript
// URL válida por 24h — usada por parte do multipart upload
const uploadUrl = await minioClient.presignedPutObject('videos', `${videoId}/original.mp4`, 24 * 60 * 60);
```

### Presigned GET com override de content-disposition (usado por TD-05, streaming vs download)

```typescript
// Streaming: sem override, o navegador reproduz inline
const streamUrl = await minioClient.presignedGetObject('videos', `${videoId}/original.mp4`, 3600);

// Download: força o navegador a baixar como anexo
const downloadUrl = await minioClient.presignedGetObject('videos', `${videoId}/original.mp4`, 3600, {
  'response-content-disposition': `attachment; filename="video.mp4"`,
});
```

Isso confirma a recomendação de TD-05: o mesmo mecanismo de URL pré-assinada cobre streaming e download, variando só o parâmetro `response-content-disposition`.

### Multipart upload (usado por TD-03)

O client baixo-nível expõe `initiateNewMultipartUpload` (retorna o `uploadId`) e `presignedUrl` genérico, que aceita `reqParams` para gerar URLs pré-assinadas por operação — incluindo por parte do multipart (`PUT ?uploadId=X&partNumber=Y`) e para completar o upload (`POST ?uploadId=X`). O fluxo do TD-03 (criar upload → pedir URL por parte → completar com ETags) mapeia diretamente para essas operações do SDK.

## fluent-ffmpeg

**Source:** `/thedave42/node-fluent-ffmpeg` (fork ativamente mantido; pacote npm continua `fluent-ffmpeg`)

### Extração de metadados via ffprobe (usado por TD-04)

```javascript
ffmpeg.ffprobe('/path/to/file.mp4', function (err, metadata) {
  // metadata.format.duration → duração do vídeo
  // metadata.streams[0] → codec, largura, altura do stream de vídeo
});
```

A duração do vídeo vem de `metadata.format.duration` (string, em segundos).

### Geração de thumbnail a partir de um frame (usado por TD-04)

```javascript
ffmpeg('/path/to/video.mp4')
  .on('end', function () {
    console.log('Screenshot gerado');
  })
  .screenshots({
    timestamps: ['10%'], // frame a 10% da duração do vídeo
    filename: `${videoId}-thumbnail.png`,
    folder: '/tmp',
    size: '640x360',
  });
```

**Nota:** `.screenshots()` não funciona com streams de entrada — o worker precisa baixar o arquivo original do storage para um caminho local temporário antes de chamar `ffprobe`/`screenshots`, depois enviar a thumbnail gerada de volta ao storage (TD-02).
