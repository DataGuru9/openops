import {
  createRedisClient,
  exceptionHandler,
  JobStatus,
  logger,
  memoryLock,
  QueueName,
  rejectedPromiseHandler,
} from '@openops/server-shared';
import { assertNotNullOrUndefined, isNil } from '@openops/shared';
import { Job, Worker } from 'bullmq';
import { ConsumerManager } from '../consumer/consumer-manager';
import { redisRateLimiter } from './redis-rate-limiter';

const consumer: Record<string, Worker> = {};

export const redisConsumer: ConsumerManager = {
  async poll(jobType, { token }) {
    let lock;
    try {
      lock = await memoryLock.acquire(`poll-${jobType}`, 15000);
      const worker = await ensureWorkerExists(jobType);
      assertNotNullOrUndefined(worker, 'Queue not found');
      // The worker.getNextJob() method holds the connection until a job is available, but it can only be called once at a time.
      // To handle multiple workers, we are storing them in memory while waiting for a job to become available.
      const job = await worker.getNextJob(token);
      if (isNil(job)) {
        return null;
      }
      return {
        id: job.id!,
        data: job.data,
      };
    } catch (e) {
      if (memoryLock.isTimeoutError(e)) {
        return null;
      }
      exceptionHandler.handle(e);
      throw e;
    } finally {
      if (lock) {
        await lock.release();
      }
    }
  },
  async update({
    queueName,
    executionCorrelationId,
    status,
    message,
    token,
  }): Promise<void> {
    const worker = await ensureWorkerExists(queueName);
    const job = await Job.fromId(worker, executionCorrelationId);

    if (!job) {
      logger.debug('Job is null or undefined', {
        queueName,
        executionCorrelationId,
        status,
      });
      return;
    }

    assertNotNullOrUndefined(token, 'Token not found');
    rejectedPromiseHandler(
      redisRateLimiter.onCompleteOrFailedJob(queueName, job),
    );
    switch (status) {
      case JobStatus.COMPLETED:
        await job.moveToCompleted({}, token, false);
        break;
      case JobStatus.FAILED:
        await job.moveToFailed(new Error(message), token, false);
        break;
    }
  },
  async init(): Promise<void> {
    const sharedConsumers = Object.values(QueueName).map((queueName) =>
      ensureWorkerExists(queueName),
    );
    await Promise.all(sharedConsumers);
  },
  async close(): Promise<void> {
    const promises = Object.values(consumer).map((consumer) =>
      consumer.close(),
    );
    await Promise.all(promises);
  },
};

async function ensureWorkerExists(queueName: QueueName): Promise<Worker> {
  if (!isNil(consumer[queueName])) {
    return consumer[queueName];
  }
  const lockDuration = getLockDurationInMs(queueName);
  consumer[queueName] = new Worker(queueName, null, {
    connection: createRedisClient(),
    lockDuration,
    maxStalledCount: 5,
    drainDelay: 5,
    stalledInterval: 30000,
  });

  await consumer[queueName].waitUntilReady();
  await consumer[queueName].startStalledCheckTimer();
  return consumer[queueName];
}

function getLockDurationInMs(queueName: QueueName): number {
  switch (queueName) {
    case QueueName.WEBHOOK:
      return (60 + 60 * 3) * 1000;
    case QueueName.ONE_TIME:
      return (600 + 60 * 3) * 1000;
    case QueueName.SCHEDULED:
      return (60 + 60 * 3) * 1000;
  }
}
