import { Server as IoServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { config } from '../config';
import { logger } from '../utils/logger';
import { createRedisIoAdapter, broadcastToRoom, closeSocketServer as closeAdapter } from '../infrastructure/redisSocketAdapter';

let io: IoServer | null = null;

export function initSocketServer(httpServer: HttpServer): IoServer {
  io = new IoServer(httpServer, {
    cors: {
      origin: config.corsOrigin,
      methods: ['GET', 'POST'],
    },
    // Reduce overhead — don't buffer packets
    perMessageDeflate: false,
    // Clean up stale connections
    pingTimeout: 60000,
    pingInterval: 25000,
    // Limit transport upgrades
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    // All clients join the 'live' room for booking count updates
    socket.join('live');

    // Clean up on disconnect
    socket.on('disconnect', (reason) => {
      logger.debug(`[Socket] Client ${socket.id} disconnected: ${reason}`);
    });

    // Log reconnection attempts
    socket.on('reconnect_attempt', (attempt) => {
      logger.debug(`[Socket] Client ${socket.id} reconnection attempt ${attempt}`);
    });
  });

  // Initialize Redis-backed cross-instance adapter (official @socket.io/redis-adapter)
  createRedisIoAdapter(io);

  return io;
}

export function getIo(): IoServer {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

export async function broadcastBookingCount(eventId: number, booked: number, capacity: number) {
  if (!io) return;
  await broadcastToRoom('live', 'event:booking-count', { eventId, booked, capacity }, io);
}

export async function broadcastNewBooking(payload: unknown) {
  if (!io) return;
  await broadcastToRoom('live', 'event:new-booking', payload, io);
}

export async function closeSocketServer(): Promise<void> {
  await closeAdapter();
  if (io) {
    try {
      io.close();
    } catch {
      // ignore
    }
    io = null;
  }
}
