import { io } from 'socket.io-client';

// Single shared Socket.IO connection. In dev the Vite proxy forwards /socket.io
// to the backend; in production the client is served from the same origin.
export const socket = io({
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 1000,
  transports: ['websocket', 'polling']
});
