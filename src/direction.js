/** Legacy journals without a side are long. Quantities are always unsigned. */
export const sideOf = position => position.side ?? 'BUY';
export const directionOf = position => sideOf(position) === 'SELL' ? -1 : 1;
export const exitSideOf = position => directionOf(position) === 1 ? 'SELL' : 'BUY';
export const plannedRisk = position => Math.max(0, directionOf(position) * (position.entry - position.stop)) * position.quantity;
export const markedProfit = position => directionOf(position) * ((position.last ?? position.entry) - position.entry) * position.quantity - (position.entry_fee || 0);
