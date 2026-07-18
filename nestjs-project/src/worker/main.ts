import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // Standalone application context — the worker has no HTTP surface,
  // it only consumes jobs from the video-processing queue.
  await NestFactory.createApplicationContext(WorkerModule);
}
void bootstrap();
