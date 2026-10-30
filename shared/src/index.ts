export * from './constants.js';
export * from './types.js';
export * from './maps.js';
export * from './movement.js';
export * from './schemas.js';
export * from './achievements.js';

/** Client -> server socket event names. */
export const C2S = {
  createRoom: 'room:create', joinRoom: 'room:join', matchmake: 'room:matchmake', leave: 'room:leave',
  settings: 'room:settings', ready: 'room:ready', profile: 'room:profile', start: 'room:start', rematch: 'room:rematch',
  chat: 'chat:send', move: 'input:move',
  missionStart: 'mission:start', missionSubmit: 'mission:submit', missionCancel: 'mission:cancel',
  ability: 'ability:use', sabotage: 'sabotage:trigger', repair: 'repair:start', repairCancel: 'repair:cancel',
  report: 'meeting:report', emergency: 'meeting:emergency', vote: 'meeting:vote',
} as const;

/** Server -> client socket event names. */
export const S2C = {
  roomState: 'room:state', snapshot: 'game:snapshot', event: 'game:event', chat: 'chat:message', kicked: 'room:closed',
} as const;
