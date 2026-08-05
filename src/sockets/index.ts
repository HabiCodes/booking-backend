import { Server as IoServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { config } from '../config';

let io: IoServer | null = null;

export function initSocketServer(httpServer: HttpServer): IoServer {
  io = new IoServer(httpServer, {
    cors: {
      origin: config.corsOrigin,
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    // All clients join the 'live' room for booking count updates
    socket.join('live');
  });

  return io;
}

export function getIo(): IoServer {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

export function broadcastBookingCount(eventId: number, booked: number, capacity: number) {
  if (!io) return;
  io.to('live').emit('event:booking-count', { eventId, booked, capacity });
}

export function broadcastNewBooking(payload: any) {
  if (!io) return;
  io.to('live').emit('event:new-booking', payload);
}
