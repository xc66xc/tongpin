import type { Seat } from '@tongpin/shared';

export function playerLabel(seat: Seat, selfSeat: Seat, playerCount: number): string {
  if (seat === selfSeat) return '你';
  return playerCount === 2 ? '对方' : `玩家 ${seat}`;
}
