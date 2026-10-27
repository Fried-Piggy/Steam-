// One source for the editor, card labels, ranking and legacy-score conversion.
export const RARITIES = Object.freeze({
  UR: Object.freeze({ order: 7, name: '人生级作品', description: '对我的游戏审美产生了深远影响' }),
  SSR: Object.freeze({ order: 6, name: '挚爱神作', description: '极其喜欢，有不可替代的体验' }),
  SR: Object.freeze({ order: 5, name: '非常优秀', description: '有明显亮点，留下了深刻印象' }),
  R: Object.freeze({ order: 4, name: '优秀', description: '玩得很开心，整体体验出色' }),
  N: Object.freeze({ order: 3, name: '不错', description: '值得玩，但没有特别强烈的感情' }),
  C: Object.freeze({ order: 2, name: '一般', description: '有优点，也有明显的不满' }),
  F: Object.freeze({ order: 1, name: '不喜欢', description: '不值得我投入的时间' }),
});

export function tierFromLegacyRating(value) {
  const rating = Number(value);
  if (!Number.isFinite(rating) || rating <= 0) return '';
  if (rating >= 9.5) return 'UR';
  if (rating >= 9) return 'SSR';
  if (rating >= 8) return 'SR';
  if (rating >= 7) return 'R';
  if (rating >= 6) return 'N';
  if (rating >= 4) return 'C';
  return 'F';
}

export function getTier(game) {
  // An explicitly cleared tier must not be repopulated from the archived score.
  if (game.tier === '' || Object.hasOwn(RARITIES, game.tier)) return game.tier;
  return tierFromLegacyRating(game.rating);
}

export function compareTiers(a, b) {
  return (RARITIES[getTier(b)]?.order ?? 0) - (RARITIES[getTier(a)]?.order ?? 0);
}
