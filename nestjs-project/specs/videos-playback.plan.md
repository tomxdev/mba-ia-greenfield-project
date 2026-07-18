---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-playback.e2e-spec.ts
---

# GET /videos/{id}, /stream e /download Test Plan

## Application Overview

Endpoints de consulta de detalhes do vídeo e de entrega via redirect (302) para uma URL pré-assinada de leitura no storage — cobrindo streaming (inline) e download (anexo, via `response-content-disposition`).

## Test Scenarios

### 1. Consulta e entrega de vídeo

**Setup:** truncar tabelas relevantes; registrar um usuário de teste com canal; levar um vídeo real através do fluxo completo de upload (`POST /videos` → `upload-parts` → `complete`) e aguardar o worker processá-lo até `status: "ready"`; criar um segundo vídeo que permanece em `processing` (não completar o upload) para o cenário negativo.

#### 1.1. stream-redireciona-para-storage

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. GET /videos/{shortId}/stream do vídeo `ready`, com `Authorization` válido
    - expect: status 302
    - expect: header `Location` presente, apontando para o host do storage (MinIO)

#### 1.2. download-redireciona-com-content-disposition

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. GET /videos/{shortId}/download do vídeo `ready`, com `Authorization` válido
    - expect: status 302
    - expect: header `Location` cuja query string inclui `response-content-disposition=attachment`

#### 1.3. stream-video-nao-pronto

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. GET /videos/{shortId}/stream do vídeo ainda em `processing`, com `Authorization` válido
    - expect: status 409
    - expect: body `errorCode: "VIDEO_NOT_READY"`

#### 1.4. get-video-inexistente-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-18T03:18:53Z

**Steps:**
  1. GET /videos/{id} com um `id` que não existe, com `Authorization` válido
    - expect: status 404
    - expect: body `errorCode: "VIDEO_NOT_FOUND"`
