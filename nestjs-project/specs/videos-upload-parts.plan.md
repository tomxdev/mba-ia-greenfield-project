---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-upload-parts.e2e-spec.ts
---

# POST /videos/{id}/upload-parts e /complete Test Plan

## Application Overview

Endpoints que assinam URLs pré-assinadas por parte do multipart upload e completam o upload, transicionando o vídeo para `processing` e enfileirando o job de processamento na fila real (BullMQ/Redis).

## Test Scenarios

### 1. Upload de partes e finalização

**Setup:** truncar tabelas relevantes; registrar dois usuários de teste (dono e outro usuário) com canais; criar um vídeo em `draft` para o usuário dono via `POST /videos` (fluxo real, não fixture direta no banco).

#### 1.1. rejeita-upload-parts-de-outro-usuario

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. POST /videos/{id}/upload-parts com `Authorization` do usuário que NÃO é dono do vídeo, body `{ partNumbers: [1] }`
    - expect: status 403
    - expect: body `errorCode: "VIDEO_FORBIDDEN"`

#### 1.2. completa-upload-transiciona-para-processing

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. POST /videos/{id}/upload-parts com `Authorization` do dono, body `{ partNumbers: [1] }`
    - expect: status 200
    - expect: body `urls` contém uma URL pré-assinada para a parte 1
  2. Fazer upload real da parte via PUT na URL pré-assinada retornada (arquivo de teste pequeno)
    - expect: resposta do storage com um `ETag`
  3. POST /videos/{id}/complete com `Authorization` do dono, body `{ parts: [{ partNumber: 1, etag: "<etag-da-etapa-2>" }] }`
    - expect: status 200
    - expect: body `status: "processing"`
    - expect: um job é enfileirado na fila `video-processing` (verificável via BullMQ real do Compose)

#### 1.3. rejeita-complete-de-video-ja-processando

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. Reexecutar POST /videos/{id}/complete no mesmo vídeo já transicionado para `processing` no cenário 1.2
    - expect: status 409
    - expect: body `errorCode: "INVALID_VIDEO_STATE"`
