import { io } from 'socket.io-client';

// Single shared Socket.IO connection. In dev the Vite proxy forwards /socket.io
// to the backend; in production the client is served from the same origin.
// `auth` is a callback so a token entered in the AuthGate is picked up on the
// next (re)connect without a page reload.
export const socket = io({
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 1000,
  transports: ['websocket', 'polling'],
  auth: (cb) => cb({ token: localStorage.getItem('tc.authToken') || '' })
});

/** Reconnect with the latest token (call after the user unlocks). */
export function reconnectSocket() {
  socket.disconnect();
  socket.connect();
}
