/**
 * Redis-backed Socket.IO adapter for cross-instance communication.
 *
 * Socket.IO v4 ships without a built-in Redis adapter. This implements
 * a minimal pub/sub bridge using ioredis that allows events broadcast
 * on one instance to reach clients connected to other instances.
 *
 * Architecture:
 *   - Each instance has a unique ID (PID-based)
 *   - All instances subscribe to a Redis pub/sub channel
 *   - When an instance broadcasts, it publishes to Redis
 *   - All instances (including the sender) receive and emit locally
 *
 * This is simpler than the full socket.io-redis adapter but covers
 * the application's needs: room-based broadcasting across instances.
 */

import { Server as IoServer, Socket } from 'socket.io';
import { getRedis, isRedisAvailable, closeRedis } from '../db/redis';
import { logger } from '../utils/logger';

const PUBSUB_CHANNEL = 'socket.io:events';
const INSTANCE_ID = `instance-${process.pid}-${Date.now()}`;

let io: IoServer | null = null;
let subscriber: ReturnType<typeof getRedis> | null = null;
let isListening = false;

/**
 * Initialize the Redis pub/sub adapter for Socket.IO.
 * Must be called after the Socket.IO server is created.
 */
export function createRedisIoAdapter(server: IoServer): void {
  io = server;

  io.on('connection', (socket: Socket) => {
    // Track connections per instance for debugging
    const clients = io!.sockets.sockets.size;
    logger.debug(`[SocketAdapter] Client connected (${socket.id}), total: ${clients}`);

    socket.on('disconnect', () => {
      const remaining = io!.sockets.sockets.size;
      logger.debug(`[SocketAdapter] Client disconnected (${socket.id}), total: ${remaining}`);
    });
  });

  startPubSubListener();
}

/**
 * Start listening on Redis pub/sub for cross-instance events.
 */
async function startPubSubListener(): Promise<void> {
  if (!(await isRedisAvailable())) {
    logger.warn('[SocketAdapter] Redis unavailable — cross-instance Socket.IO disabled');
    return;
  }

  try {
    subscriber = getRedis();
    await subscriber.subscribe(PUBSUB_CHANNEL);
    subscriber.on('message', (_ch: string, message: string) => {
      handleCrossInstanceMessage(message);
    });
    isListening = true;
    logger.info(`[SocketAdapter] Subscribed to ${PUBSUB_CHANNEL} (${INSTANCE_ID})`);
  } catch (err) {
    logger.error('[SocketAdapter] Failed to subscribe to Redis channel:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Handle a message received from Redis (originated from another instance).
 */
function handleCrossInstanceMessage(message: string): void {
  if (!io) return;

  try {
    const payload = JSON.parse(message);

    // Ignore messages from this instance (loopback prevention)
    if (payload.instanceId === INSTANCE_ID) return;

    // Re-emit the event locally
    if (payload.event && payload.data !== undefined) {
      io.to(payload.room || 'live').emit(payload.event, payload.data);
    }
  } catch {
    // Malformed message — ignore
  }
}

/**
 * Broadcast an event to a room, publishing to Redis for cross-instance delivery.
 */
export async function broadcastToRoom(room: string, event: string, data: unknown): Promise<void> {
  if (!io) return;

  // Emit locally
  io.to(room).emit(event, data);

  // Publish to Redis for other instances
  if (isListening && (await isRedisAvailable())) {
    try {
      const redis = getRedis();
      const payload = JSON.stringify({
        instanceId: INSTANCE_ID,
        room,
        event,
        data,
        timestamp: Date.now(),
      });
      await redis.publish(PUBSUB_CHANNEL, payload);
    } catch (err) {
      logger.warn('[SocketAdapter] Failed to publish to Redis:', err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Close the Socket.IO adapter and Redis subscriber.
 */
export function closeSocketServer(): void {
  if (io) {
    try {
      io.close();
      io = null;
    } catch {
      // ignore
    }
  }

  if (subscriber) {
    try {
      subscriber.unsubscribe(PUBSUB_CHANNEL);
      subscriber.disconnect();
      subscriber = null;
    } catch {
      // ignore
    }
    isListening = false;
  }

  logger.info('[SocketAdapter] Closed');
}
