---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

Endpoint que cria um vídeo como rascunho para o canal do usuário autenticado e inicia um multipart upload no object storage, retornando o `uploadId` para o cliente prosseguir com o envio das partes.

## Test Scenarios

### 1. Criação de vídeo (rascunho + multipart upload)

**Setup:** truncar tabelas relevantes (`videos`, `channels`, `users`); registrar e confirmar um usuário de teste com canal; obter `access_token` via login.

#### 1.1. cria-video-com-sucesso

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. POST /videos com `Authorization: Bearer {access_token}` e body `{ title, fileName, fileSizeBytes }` válido
    - expect: status 201
    - expect: body contém `id` (uuid), `shortId` (string), `status: "draft"`, `uploadId` (string), `channelId` (uuid)

#### 1.2. rejeita-arquivo-acima-de-10gb

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. POST /videos com `fileSizeBytes` acima de 10.737.418.240 (10GB)
    - expect: status 413
    - expect: body `errorCode: "FILE_TOO_LARGE"`

#### 1.3. rejeita-sem-autenticacao

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. POST /videos sem header `Authorization`
    - expect: status 401

#### 1.4. rejeita-corpo-invalido

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. POST /videos com `Authorization` válido e body sem `title`
    - expect: status 400
