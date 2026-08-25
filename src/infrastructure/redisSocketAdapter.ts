/**
 * Socket.IO Redis Adapter — official @socket.io/redis-adapter integration.
 *
 * Public API (unchanged from the previous custom implementation):
 *   - createRedisIoAdapter(server)
 *   - broadcastToRoom(room, event, data, io)
 *   - closeSocketServer()
 */

import { Server as IoServer } from 'socket.io';
import { createAdapter, RedisAdapter } from '@socket.io/redis-adapter';
import { getRedis } from '../db/redis';
import { logger } from '../utils/logger';

let adapterInstance: RedisAdapter | null = null;

/**
 * Attach the official Redis adapter to the default Socket.IO namespace.
 *
 * createAdapter(pubClient, subClient) returns a factory function that
 * accepts a namespace and produces an adapter instance.  We call that
 * factory with server.of('/') and assign the resulting instance.
 */
export function createRedisIoAdapter(server: IoServer): void {
  const pubClient = getRedis();

  // ioredis duplicate() shares the connection pool but creates an
  // independent client — exactly what the adapter needs for separate
  // pub / sub channels on the same physical Redis connection.
  const subClient = pubClient.duplicate();

  // createAdapter returns (nsp) => new RedisAdapter(nsp, pubClient, subClient)
  const createFn = createAdapter(pubClient, subClient);

  // Create the adapter instance for the default namespace and assign it.
  adapterInstance = createFn(server.of('/'));
  (server.of('/') as unknown as { adapter: RedisAdapter }).adapter = adapterInstance;

  logger.info('[SocketAdapter] Official @socket.io/redis-adapter attached (namespace /)');
}

/**
 * Broadcast an event to a room across all API instances.
 *
 * With the official adapter installed on the server, io.to(room).emit()
 * automatically publishes to Redis and delivers to every connected
 * instance's local sockets in that room.  No manual pub/sub needed.
 *
 * @param io - the Socket.IO server (passed in to avoid circular imports)
 */
export async function broadcastToRoom(
  room: string,
  event: string,
  data: unknown,
  io: IoServer,
): Promise<void> {
  if (!io) return;
  io.to(room).emit(event, data);
}

/**
 * Gracefully close the Socket.IO Redis adapter.
 * Unsubscribes from Redis channels and releases the subscriber client.
 */
export async function closeSocketServer(): Promise<void> {
  if (adapterInstance && typeof adapterInstance.close === 'function') {
    try {
      await adapterInstance.close();
    } catch {
      // ignore
    }
    adapterInstance = null;
  }
}
