/** 'revealed' is retained for rooms created before automatic advancement. */
export type Phase = 'waiting' | 'playing' | 'revealed' | 'ended';
export type EndReason = 'matched' | 'consensus' | null;
export type Seat = 1 | 2;
export interface PlayerView {
  seat: Seat;
  online: boolean;
  submitted: boolean;
  /** Only the viewer's own word is populated before reveal. */
  word: string | null;
  raised: boolean;
  nextReady: boolean;
  rematchReady: boolean;
}
export interface RoundView {
  roundNumber: number;
  words: [string, string];
}
export interface RoomSnapshot {
  roomCode: string;
  /** Persistent, monotonically increasing version, including presence updates. */
  revision: number;
  phase: Phase;
  gameNumber: number;
  roundNumber: number;
  endReason: EndReason;
  self: PlayerView;
  opponent: PlayerView | null;
  history: RoundView[];
}
export interface Credentials { roomCode: string; token: string }
/** 'next' is a legacy command: the server now advances mismatched rounds itself. */
export type GameAction = 'submit' | 'next' | 'raise' | 'again';
export type Command =
  | { action: 'create' }
  | { action: 'join'; roomCode: string }
  | { action: 'resume'; roomCode: string; token: string }
  | { action: GameAction; gameNumber: number; roundNumber: number; word?: string };
export type Reply =
  | { ok: true; snapshot: RoomSnapshot; credentials?: Credentials }
  | { ok: false; error: { code: string; message: string } };
export interface ServerEvents {
  snapshot: (snapshot: RoomSnapshot) => void;
  expired: () => void;
}
export interface ClientEvents { command: (command: Command, reply: (result: Reply) => void) => void }
