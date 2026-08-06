"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSocketServer = initSocketServer;
exports.getIo = getIo;
exports.broadcastBookingCount = broadcastBookingCount;
exports.broadcastNewBooking = broadcastNewBooking;
const socket_io_1 = require("socket.io");
const config_1 = require("../config");
let io = null;
function initSocketServer(httpServer) {
    io = new socket_io_1.Server(httpServer, {
        cors: {
            origin: config_1.config.corsOrigin,
            methods: ['GET', 'POST'],
        },
    });
    io.on('connection', (socket) => {
        // All clients join the 'live' room for booking count updates
        socket.join('live');
    });
    return io;
}
function getIo() {
    if (!io)
        throw new Error('Socket.IO not initialized');
    return io;
}
function broadcastBookingCount(eventId, booked, capacity) {
    if (!io)
        return;
    io.to('live').emit('event:booking-count', { eventId, booked, capacity });
}
function broadcastNewBooking(payload) {
    if (!io)
        return;
    io.to('live').emit('event:new-booking', payload);
}
