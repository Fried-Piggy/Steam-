import {
  GENRES,
  CARD_THEMES,
  getCardTheme,
  extractAppId,
  gameFromSteam,
  getHonorGames,
  inferGenres,
  isPlaceholderGame,
  makeGameId,
  mergeLibraries,
  normalizeGame,
  parseVdfAppIds,
  queryLibrary,
  upsertGameInLibrary,
} from './domain.js';
import { RARITIES, getTier } from './rarity.js';
import {
  createLibraryBackup,
  loadLibrary,
  parseLibraryBackup,
  saveLibrary,
} from './storage.js';
import {
  getCoverCandidates,
  getOwnedSteamGames,
  getSteamAppDetails,
  searchSteam,
} from './steam.js?v=4.1.0';
import { bindCardEffects } from './card-effects.js?v=4.1.1';
import { applyCoverPalette } from './cover-palette.js?v=4.1.0';
import { getCoverAsset, loadCoverAssets } from './cover-assets.js';
import { createLocalBackup } from './local-backup.js';
import { bindOrderEditor } from './order-editor.js';

const elements = {
  adminToolbar: document.querySelector('#adminToolbar'),
  grid: document.querySelector('#gameGrid'),
  podium: document.querySelector('#podium'),
  pageStatus: document.querySelector('#pageStatus'),
  sheetNumber: document.querySelector('#sheetNumber'),
  previousPage: document.querySelector('#previousPage'),
  nextPage: document.querySelector('#nextPage'),
  honorMatches: document.querySelector('#honorMatches'),
  search: document.querySelector('#searchInput'),
  genre: document.querySelector('#genreFilter'),
  resultCount: document.querySelector('#resultCount'),
  sortOptions: document.querySelector('#sortOptions'),
  gameDialog: document.querySelector('#gameDialog'),
  gameForm: document.querySelector('#gameForm'),
  gameDialogTitle: document.querySelector('#gameDialogTitle'),
  saveGameButton: document.querySelector('#saveGameButton'),
  gameName: document.querySelector('#gameName'),
  gameGenre: document.querySelector('#gameGenre'),
  cardTheme: document.querySelector('#cardTheme'),
  gameReview: document.querySelector('#gameReview'),
  gameAppId: document.querySelector('#gameAppId'),
  coverInput: document.querySelector('#coverInput'),
  coverPreview: document.querySelector('#coverPreview'),
  tierPicker: document.querySelector('#tierPicker'),
  searchResults: document.querySelector('#steamSearchResults'),
  steamImportDialog: document.querySelector('#steamImportDialog'),
  jsonImportFile: document.querySelector('#jsonImportFile'),
  vdfInput: document.querySelector('#vdfFileInput'),
  vdfDropZone: document.querySelector('#vdfDropZone'),
  vdfProgress: document.querySelector('#vdfProgress'),
  vdfStatus: document.querySelector('#vdfStatus'),
  vdfProgressBar: document.querySelector('#vdfProgressBar'),
  vdfProgressValue: document.querySelector('#vdfProgressValue'),
  vdfLog: document.querySelector('#vdfLog'),
  steamApiForm: document.querySelector('#steamApiForm'),
  steamApiKey: document.querySelector('#steamApiKey'),
  steamId: document.querySelector('#steamId'),
  apiStatus: document.querySelector('#apiStatus'),
  resolveDialog: document.querySelector('#resolveDialog'),
  resolveForm: document.querySelector('#resolveForm'),
  resolveBody: document.querySelector('#resolveTableBody'),
  retryResolve: document.querySelector('#retryResolve'),
  toastRegion: document.querySelector('#toastRegion'),
};

const LOCAL_ADMIN_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const isAdminMode = LOCAL_ADMIN_HOSTS.has(window.location.hostname)
  && new URLSearchParams(window.location.search).get('admin') === '1';
elements.adminToolbar.hidden = !isAdminMode;

// Measure only when a comment's available size changes, never during card transforms.
const reviewLayoutObserver = !isAdminMode && typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      const lineHeight = parseFloat(getComputedStyle(target).lineHeight);
      if (lineHeight > 0) target.style.setProperty('--review-lines', String(Math.max(1, Math.floor(contentRect.height / lineHeight))));
    }
  }) : null;

const state = {
  games: [],
  editingId: null,
  sort: 'manual',
  searchTimer: null,
  searchController: null,
  resolving: false,
  page: 0,
  honorSignature: '',
};

const PAGE_SIZE = 12;
const cardEffects = bindCardEffects(document.querySelector('#library'));
const backupStatus = document.querySelector('#localBackupStatus');
backupStatus.hidden = !isAdminMode;
const disabledBackup = { save() {}, flush() {}, dispose() {} };
const localBackup = isAdminMode ? createLocalBackup({
  onStatus(status, result) {
    backupStatus.textContent = status === 'saved'
      ? `已自动备份到本机 · ${result.count} 款游戏 · ${new Date(result.savedAt).toLocaleTimeString('zh-CN')}`
      : status === 'error' ? '本机备份暂未成功，稍后自动重试；浏览器中的数据仍保留。'
        : '正在备份游戏库到本机…';
    backupStatus.title = '备份保存在项目 data/backups 文件夹；不同浏览器分别留档，可通过「导入备份」恢复。';
  },
}) : disabledBackup;
if (isAdminMode) {
  window.addEventListener('online', () => localBackup.flush());
  document.addEventListener('visibilitychange', () => { localBackup.flush(); });
}
const orderEditor = bindOrderEditor({
  dialog: document.querySelector('#orderDialog'),
  getGames: () => state.games,
  onSave(games) {
    try {
      const saved = saveLibrary(games);
      state.games = saved;
      localBackup.save(saved);
      state.sort = 'manual';
      state.page = 0;
      for (const option of elements.sortOptions.querySelectorAll('[data-sort]')) {
        option.classList.toggle('is-active', option.dataset.sort === 'manual');
      }
      render();
      showToast('排序已保存，前三款已更新到殿堂。', 'success');
      return true;
    } catch (error) {
      showToast(`排序保存失败：${error.message}`, 'error');
      return false;
    }
  },
});

function createElement(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function createButton(text, className, action) {
  const button = createElement('button', className, text);
  button.type = 'button';
  if (action) button.dataset.action = action;
  return button;
}

function showToast(message, type = 'info') {
  const toast = createElement('div', `toast toast--${type}`, message);
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function persist() {
  try {
    state.games = saveLibrary(state.games);
    localBackup.save(state.games);
    return true;
  } catch (error) {
    showToast(`无法保存本地数据：${error.message}`, 'error');
    return false;
  }
}

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function createCover(appId, alt, className = '', { rank = 0 } = {}) {
  const wrapper = createElement('div', className);
  const fallback = createElement('span', 'cover-fallback', '🎮');
  fallback.setAttribute('aria-hidden', 'true');
  wrapper.append(fallback);

  const candidates = getCoverCandidates(appId);
  if (candidates.length === 0) return wrapper;

  const artwork = document.createElement('img');
  artwork.className = 'cover-art';
  artwork.draggable = false;
  artwork.alt = alt;
  artwork.loading = rank ? 'eager' : 'lazy';
  artwork.decoding = 'async';
  artwork.fetchPriority = rank === 1 ? 'high' : rank ? 'auto' : 'low';
  artwork.width = 460;
  artwork.height = 215;
  const asset = getCoverAsset(appId);
  if (asset?.palette) wrapper.style.setProperty('--cover-tint', asset.palette.primary.join(' '));
  if (asset) {
    artwork.sizes = '(max-width: 520px) 46vw, (max-width: 760px) 42vw, 340px';
    artwork.srcset = `./assets/covers/${asset.small} 320w, ./assets/covers/${asset.large} 460w`;
  }
  artwork.dataset.coverIndex = '0';
  artwork.addEventListener('load', () => wrapper.classList.add('is-loaded'));
  artwork.addEventListener('error', () => {
    artwork.removeAttribute('srcset');
    const nextIndex = Number(artwork.dataset.coverIndex) + 1;
    if (nextIndex < candidates.length) {
      artwork.dataset.coverIndex = String(nextIndex);
      artwork.src = candidates[nextIndex];
    } else {
      artwork.remove();
    }
  });
  artwork.src = candidates[0];
  wrapper.append(artwork);
  return wrapper;
}

function renderGenreOptions() {
  const selected = elements.genre.value;
  const counts = new Map();
  for (const game of state.games) {
    for (const genre of game.genres) counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }

  const fragment = document.createDocumentFragment();
  fragment.append(new Option('全部类型', ''));
  for (const genre of GENRES) {
    const count = counts.get(genre);
    if (count) fragment.append(new Option(`${genre} (${count})`, genre));
  }
  elements.genre.replaceChildren(fragment);
  elements.genre.value = counts.has(selected) ? selected : '';
}

function createGameCard(game, { rank = 0, serial = 1 } = {}) {
  const slot = createElement('div', rank ? `card-slot card-slot--honor rank-${rank}` : 'card-slot');
  const card = createElement('article', isAdminMode ? 'game-card' : 'game-card game-card--public');
  card.dataset.gameId = game.id;
  const theme = getCardTheme(game.genres, game.cardTheme);
  if (!rank && theme) card.dataset.theme = CARD_THEMES[theme];
  const tier = getTier(game);
  card.dataset.tier = tier || 'unset';
  const tierName = tier ? `${tier} · ${RARITIES[tier].name}` : '未定级';
  card.setAttribute('aria-label', `${rank ? `第 ${rank} 名：` : ''}${game.name}，${tierName}`);
  const edition = createElement('div', 'card-edition');
  edition.append(
    createElement('span', '', rank ? ['','GOLD / 金藏','SILVER / 银藏','BRONZE / 铜藏'][rank] : 'HOLOGRAPHIC / 闪卡'),
    createElement('span', '', rank ? `NO. 0${rank}` : `#${String(serial).padStart(3, '0')}`),
  );

  const cover = createCover(game.appId, `${game.name} 封面`, 'game-card__cover', { rank });
  const artwork = cover.querySelector('.cover-art');
  if (artwork && !rank) {
    const updateFoil = () => {
      const index = Number(artwork.dataset.coverIndex);
      applyCoverPalette(card, game.appId, index === 0 ? 'auto' : index - 1, artwork);
    };
    artwork.addEventListener('load', updateFoil);
    if (artwork.complete && artwork.naturalWidth) updateFoil();
    if (getCoverAsset(game.appId)) queueMicrotask(updateFoil);
  }
  const badge = createElement('div', 'rarity-badge');
  badge.dataset.tier = tier || 'unset';
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', tierName);
  badge.title = tier ? `${tierName}：${RARITIES[tier].description}` : '尚未选择珍藏档次';
  const letters = createElement('span', 'rarity-badge__letters', tier || '未定级');
  const shadow = createElement('span', 'rarity-badge__shadow', tier || '未定级');
  const stars = createElement('span', 'rarity-badge__stars', tier === 'UR' ? '✦ ✧ ✦' : tier === 'SSR' ? '✧ ✦' : tier === 'SR' ? '✧' : '');
  for (const part of [letters, shadow, stars]) part.setAttribute('aria-hidden', 'true');
  badge.append(stars, shadow, letters);

  const body = createElement('div', 'game-card__body');
  const title = createElement('h2', 'game-card__title', game.name);
  const genres = createElement('div', 'genre-tags');
  for (const genre of game.genres) genres.append(createElement('span', 'genre-tag', genre));
  const review = createElement('p', 'game-card__review', game.review || '暂无短评');
  review.title = game.review || '暂无短评';
  if (!game.review) review.classList.add('is-empty');

  body.append(title, genres, review);
  if (isAdminMode) {
    const actions = createElement('div', 'game-card__actions');
    actions.append(
      createButton('查看 / 编辑', 'button button--secondary button--small', 'edit'),
      createButton('删除', 'button button--danger button--small', 'delete'),
    );
    body.append(actions);
  }
  const seal = createElement('div', 'card-seal');
  seal.append(createElement('span', '', '✧ PERSONAL COLLECTION'), createElement('span', '', game.appId || 'ORIGINAL'));
  const foil = createElement('div', 'card-foil');
  const glare = createElement('div', 'card-glare');
  foil.setAttribute('aria-hidden', 'true');
  glare.setAttribute('aria-hidden', 'true');
  card.append(edition, cover, body, seal, foil, glare, badge);
  slot.append(card);
  return slot;
}

function renderPodium(honors) {
  const signature = JSON.stringify(honors);
  if (signature === state.honorSignature) return;
  state.honorSignature = signature;
  const fragment = document.createDocumentFragment();
  honors.forEach((game, index) => {
    const rank = index + 1;
    const exhibit = createElement('div', `exhibit exhibit--${rank}`);
    const crown = createElement('div', 'exhibit__crown', rank === 1 ? '✦' : '✧');
    crown.setAttribute('aria-hidden', 'true');
    const label = createElement('div', 'exhibit__plaque');
    label.append(createElement('span', 'exhibit__place', ['I', 'II', 'III'][index]));
    exhibit.append(crown, createGameCard(game, { rank }), label);
    fragment.append(exhibit);
  });
  if (!honors.length) {
    const empty = createElement('div', 'honors-empty');
    empty.append(createElement('span', '', '✧'), createElement('h3', '', '等待你的第一份珍藏'),
      createElement('p', '', '选择珍藏档次，或通过「管理排序」指定你的前三款珍藏。'));
    fragment.append(empty);
  }
  elements.podium.replaceChildren(fragment);
}

function renderGrid(filtered, honorMatchCount = 0) {
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  elements.previousPage.disabled = state.page === 0;
  elements.nextPage.disabled = state.page >= pages - 1;
  elements.pageStatus.textContent = `第 ${state.page + 1} / ${pages} 页 · ${filtered.length} 张收藏卡`;
  elements.sheetNumber.textContent = `SHEET ${String(state.page + 1).padStart(2, '0')}`;
  if (filtered.length === 0) {
    const empty = createElement('div', 'empty-state');
    empty.append(createElement('span', 'empty-state__icon', state.games.length ? '⌕' : '🎮'));
    empty.append(createElement('h2', '', honorMatchCount ? '珍藏已在殿堂展出' : state.games.length ? '没有匹配的收藏卡' : '卡册的故事，从这里开始'));
    empty.append(createElement('p', '', honorMatchCount ? '匹配的游戏位于上方荣誉展台，不在卡册中重复收录。' : state.games.length ? '换一个关键词或筛选条件试试。' : '从 Steam 导入，或先手动添加一款游戏。'));
    if (state.games.length === 0 && isAdminMode) {
      empty.append(createButton('从 Steam 导入', 'button button--accent', 'open-import'));
    }
    elements.grid.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const start = state.page * PAGE_SIZE;
  for (const [index, game] of filtered.slice(start, start + PAGE_SIZE).entries()) {
    fragment.append(createGameCard(game, { serial: start + index + 1 }));
  }
  // Empty pockets preserve the silhouette of a physical album on the final page.
  for (let index = Math.min(PAGE_SIZE, filtered.length - start); index < PAGE_SIZE; index++) {
    const pocket = createElement('div', 'empty-pocket', '✧');
    pocket.setAttribute('aria-hidden', 'true');
    fragment.append(pocket);
  }
  elements.grid.replaceChildren(fragment);
}

function render() {
  cardEffects.reset();
  renderGenreOptions();
  const filtered = queryLibrary(state.games, {
    search: elements.search.value,
    genre: elements.genre.value,
    sort: state.sort,
  });
  const honors = getHonorGames(state.games);
  renderPodium(honors);
  const honorIds = new Set(honors.map((game) => game.id));
  const matchedHonors = filtered.filter((game) => honorIds.has(game.id));
  const isFiltering = Boolean(elements.search.value.trim() || elements.genre.value);
  elements.honorMatches.hidden = !isFiltering || !matchedHonors.length;
  elements.honorMatches.textContent = matchedHonors.length
    ? `上方殿堂中另有 ${matchedHonors.length} 款匹配：${matchedHonors.map((game) => game.name).join('、')}` : '';
  renderGrid(filtered.filter((game) => !honorIds.has(game.id)), matchedHonors.length);
  elements.resultCount.textContent = filtered.length === state.games.length
    ? `${state.games.length} 款游戏`
    : `显示 ${filtered.length} / ${state.games.length} 款`;
  reviewLayoutObserver?.disconnect();
  document.querySelectorAll('.game-card--public .game-card__review').forEach((review) => reviewLayoutObserver?.observe(review));
}

function initializeTierPicker() {
  for (const [tier, info] of [...Object.entries(RARITIES), ['', { name: '暂不定级', description: '还没玩，或还没决定它的位置' }]]) {
    const label = createElement('label', 'tier-choice');
    label.dataset.tier = tier || 'unset';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'tier';
    input.value = tier;
    input.defaultChecked = tier === '';
    const panel = createElement('span', 'tier-choice__panel');
    const code = createElement('strong', 'tier-choice__code', tier || '—');
    const details = createElement('span', 'tier-choice__details');
    details.append(createElement('strong', '', info.name), createElement('small', '', info.description));
    panel.append(code, details);
    label.append(input, panel);
    elements.tierPicker.append(label);
  }
}

function setCoverPreview(appId, alt = '游戏封面') {
  const candidates = getCoverCandidates(appId);
  if (candidates.length === 0) {
    elements.coverPreview.replaceChildren(createElement('span', '', '封面预览'));
    return;
  }
  const cover = createCover(appId, alt);
  elements.coverPreview.replaceChildren(...cover.childNodes);
}

function hideSteamSearch() {
  elements.searchResults.hidden = true;
  elements.searchResults.replaceChildren();
}

function selectedGenres() {
  return [...elements.gameGenre.querySelectorAll('input:checked')].map((input) => input.value);
}

function renderThemeOptions(preferred = elements.cardTheme.value) {
  const genres = selectedGenres();
  const choices = genres.filter((genre) => Object.hasOwn(CARD_THEMES, genre));
  elements.cardTheme.replaceChildren(...(choices.length
    ? choices.map((genre) => new Option(genre, genre))
    : [new Option('默认透明', '')]));
  elements.cardTheme.value = getCardTheme(genres, preferred);
  elements.cardTheme.disabled = choices.length < 2;
}

function initializeGenrePicker() {
  for (const genre of GENRES) {
    const label = createElement('label', 'genre-choice');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'genres';
    input.value = genre;
    const caption = createElement('span', '', genre);
    if (Object.hasOwn(CARD_THEMES, genre)) label.dataset.theme = CARD_THEMES[genre];
    label.append(input, caption);
    elements.gameGenre.append(label);
  }
  elements.gameGenre.addEventListener('change', (event) => {
    const input = event.target;
    if (input.checked) {
      for (const other of elements.gameGenre.querySelectorAll('input')) {
        if (other !== input && (input.value === '其他' || other.value === '其他')) other.checked = false;
      }
    }
    renderThemeOptions();
  });
}

function openGameEditor(gameId = null) {
  state.editingId = gameId;
  elements.gameForm.reset();
  elements.gameAppId.value = '';
  hideSteamSearch();

  const game = gameId ? state.games.find((item) => item.id === gameId) : null;
  elements.gameDialogTitle.textContent = game ? '编辑游戏' : '添加游戏';
  elements.saveGameButton.textContent = game ? '保存修改' : '添加到陈列库';

  if (game) {
    elements.gameName.value = isPlaceholderGame(game) ? '' : game.name;
    for (const input of elements.gameGenre.querySelectorAll('input')) input.checked = game.genres.includes(input.value);
    elements.gameReview.value = game.review;
    elements.gameAppId.value = game.appId;
    elements.coverInput.value = game.appId ? `https://store.steampowered.com/app/${game.appId}/` : '';
    setCoverPreview(game.appId, game.name);
  } else {
    setCoverPreview('');
  }
  renderThemeOptions(game?.cardTheme ?? '');
  for (const input of elements.tierPicker.querySelectorAll('input')) input.checked = input.value === (game ? getTier(game) : '');
  openDialog(elements.gameDialog);
  window.setTimeout(() => elements.gameName.focus(), 0);
}

function saveGameFromForm() {
  const appId = elements.gameAppId.value.trim();
  const duplicate = appId && state.games.some((game) => game.appId === appId && game.id !== state.editingId);
  if (duplicate) {
    showToast('这个 Steam App ID 已经在陈列库中。', 'error');
    return;
  }

  const previous = state.editingId ? state.games.find((game) => game.id === state.editingId) : null;
  const game = normalizeGame({
    ...previous,
    id: previous?.id ?? makeGameId(appId),
    name: elements.gameName.value,
    appId,
    genres: selectedGenres(),
    cardTheme: elements.cardTheme.value,
    tier: elements.tierPicker.querySelector('input:checked')?.value ?? '',
    review: elements.gameReview.value,
    addedAt: previous?.addedAt ?? Date.now(),
  });
  if (!game) {
    showToast('请填写游戏名称。', 'error');
    return;
  }

  const before = state.games;
  state.games = upsertGameInLibrary(state.games, game);
  if (!persist()) {
    state.games = before;
    return;
  }
  closeDialog(elements.gameDialog);
  render();
  const tierChanged = previous && getTier(previous) !== getTier(game);
  showToast(tierChanged ? '档次已更新，已自动调整到相应位置。' : previous ? '游戏信息已更新。' : '游戏已添加到陈列库。', 'success');
}

function deleteGame(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game || !window.confirm(`确定删除「${game.name}」吗？`)) return;
  state.games = state.games.filter((item) => item.id !== gameId);
  persist();
  render();
  showToast(`已删除「${game.name}」。`, 'success');
}

function showSearchMessage(message) {
  elements.searchResults.replaceChildren(createElement('div', 'search-message', message));
  elements.searchResults.hidden = false;
}

async function runSteamSearch(query) {
  state.searchController?.abort();
  state.searchController = new AbortController();
  showSearchMessage('正在搜索 Steam…');

  try {
    const results = await searchSteam(query, state.searchController.signal);
    if (results.length === 0) {
      showSearchMessage('没有找到匹配结果；也可以直接粘贴商店链接。');
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const result of results.slice(0, 8)) {
      const appId = String(result.appid ?? '');
      const name = String(result.name ?? '').trim();
      if (!/^\d{1,10}$/.test(appId) || !name) continue;
      const option = createButton('', 'search-result', 'select-search-result');
      option.dataset.appId = appId;
      option.dataset.gameName = name;
      const image = document.createElement('img');
      image.src = getCoverCandidates(appId)[0];
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => image.remove());
      option.append(image, createElement('span', '', name), createElement('small', '', `App ${appId}`));
      fragment.append(option);
    }
    elements.searchResults.replaceChildren(fragment);
    elements.searchResults.hidden = elements.searchResults.childElementCount === 0;
  } catch (error) {
    if (error.name !== 'AbortError') showSearchMessage('Steam 搜索暂时不可用；仍可粘贴商店链接或 App ID。');
  }
}

function onCoverInput() {
  window.clearTimeout(state.searchTimer);
  const value = elements.coverInput.value.trim();
  const appId = extractAppId(value);
  if (appId) {
    elements.gameAppId.value = appId;
    setCoverPreview(appId, elements.gameName.value || '游戏封面');
    hideSteamSearch();
    return;
  }

  elements.gameAppId.value = '';
  setCoverPreview('');
  if (value.length < 2) {
    hideSteamSearch();
    return;
  }
  state.searchTimer = window.setTimeout(() => runSteamSearch(value), 350);
}

function selectSearchResult(button) {
  const { appId, gameName } = button.dataset;
  elements.coverInput.value = `https://store.steampowered.com/app/${appId}/`;
  elements.gameAppId.value = appId;
  if (!elements.gameName.value.trim()) elements.gameName.value = gameName;
  setCoverPreview(appId, gameName);
  hideSteamSearch();
}

function exportLibrary() {
  const backup = createLibraryBackup(state.games);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  const localDate = new Date().toLocaleDateString('sv-SE');
  link.href = URL.createObjectURL(blob);
  link.download = `steam-library-${localDate}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  showToast('备份文件已导出。', 'success');
}

async function importLibraryFile(file) {
  if (!file) return;
  try {
    const incoming = parseLibraryBackup(await file.text());
    const merged = mergeLibraries(state.games, incoming);
    state.games = merged.games;
    persist();
    render();
    showToast(`导入完成：新增 ${merged.addedCount} 款，跳过 ${merged.skippedCount} 款。`, 'success');
  } catch (error) {
    showToast(`导入失败：${error.message}`, 'error');
  } finally {
    elements.jsonImportFile.value = '';
  }
}

function updateVdfProgress(value, status) {
  const normalized = Math.max(0, Math.min(100, Math.round(value)));
  elements.vdfProgress.hidden = false;
  elements.vdfProgressBar.value = normalized;
  elements.vdfProgressValue.textContent = `${normalized}%`;
  elements.vdfStatus.textContent = status;
}

function appendVdfLog(message, type = '') {
  const line = createElement('p', type ? `log-${type}` : '', message);
  elements.vdfLog.append(line);
  elements.vdfLog.scrollTop = elements.vdfLog.scrollHeight;
}

async function resolveGameNames(appIds, onProgress = () => {}) {
  if (state.resolving || appIds.length === 0) return { resolved: 0, failed: 0 };
  state.resolving = true;
  let cursor = 0;
  let processed = 0;
  let resolved = 0;
  let failed = 0;

  async function worker() {
    while (cursor < appIds.length) {
      const appId = appIds[cursor++];
      try {
        const details = await getSteamAppDetails(appId);
        const game = state.games.find((item) => item.appId === appId);
        if (game && details?.name && isPlaceholderGame(game)) {
          game.name = String(details.name).slice(0, 120);
          game.genres = inferGenres(details);
          game.cardTheme = getCardTheme(game.genres);
          resolved += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      } finally {
        processed += 1;
        onProgress(processed, appIds.length, resolved, failed);
      }
    }
  }

  try {
    const workerCount = Math.min(3, appIds.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    persist();
    render();
    return { resolved, failed };
  } finally {
    state.resolving = false;
  }
}

async function importVdfFile(file) {
  if (!file) return;
  elements.vdfLog.replaceChildren();
  updateVdfProgress(8, '正在读取 VDF 文件…');
  try {
    const appIds = parseVdfAppIds(await file.text());
    appendVdfLog(`文件：${file.name}`);
    appendVdfLog(`识别到 ${appIds.length} 个 App ID`);
    if (appIds.length === 0) throw new Error('没有在 Apps 节点中找到游戏 App ID');

    const existing = new Set(state.games.map((game) => game.appId).filter(Boolean));
    const newIds = appIds.filter((appId) => !existing.has(appId));
    const placeholders = newIds.map((appId, index) => normalizeGame({
      id: `steam_${appId}`,
      name: `Game ${appId}`,
      appId,
      genre: '其他',
      tier: '',
      review: '',
      addedAt: Date.now() + index,
    }));
    const merged = mergeLibraries(state.games, placeholders);
    state.games = merged.games;
    persist();
    render();

    appendVdfLog(`新增 ${merged.addedCount} 款，跳过 ${appIds.length - newIds.length} 款已有游戏`, 'success');
    if (newIds.length === 0) {
      updateVdfProgress(100, '所有游戏都已在陈列库中');
      return;
    }

    updateVdfProgress(45, '正在从 Steam 获取游戏名称…');
    const result = await resolveGameNames(newIds, (processed, total, resolved) => {
      updateVdfProgress(45 + (processed / total) * 55, `正在补全名称 · ${processed}/${total}`);
      if (processed === total || processed % 5 === 0) appendVdfLog(`已处理 ${processed}/${total}，成功 ${resolved} 款`);
    });
    appendVdfLog(`名称查询完成：成功 ${result.resolved}，待手动补全 ${result.failed}`, result.failed ? 'warning' : 'success');
    updateVdfProgress(100, `导入完成 · 新增 ${merged.addedCount} 款`);
    showToast(`已从 VDF 导入 ${merged.addedCount} 款游戏。`, 'success');
  } catch (error) {
    updateVdfProgress(100, '导入失败');
    appendVdfLog(error.message, 'error');
    showToast(`VDF 导入失败：${error.message}`, 'error');
  } finally {
    elements.vdfInput.value = '';
  }
}

async function importOwnedGames() {
  const apiKey = elements.steamApiKey.value.trim();
  const steamId = elements.steamId.value.trim();
  const submit = elements.steamApiForm.querySelector('button[type="submit"]');
  elements.apiStatus.textContent = '正在连接 Steam 官方 API…';
  submit.disabled = true;

  try {
    const ownedGames = await getOwnedSteamGames(apiKey, steamId);
    const timestamp = Date.now();
    const incoming = ownedGames.map((game, index) => gameFromSteam(game, timestamp + index)).filter(Boolean);
    const merged = mergeLibraries(state.games, incoming);
    state.games = merged.games;
    persist();
    render();
    elements.apiStatus.textContent = `同步完成：Steam 返回 ${ownedGames.length} 款，新增 ${merged.addedCount} 款。`;
    showToast(`Steam 同步完成，新增 ${merged.addedCount} 款。`, 'success');
  } catch (error) {
    elements.apiStatus.textContent = `同步失败：${error.message}`;
    showToast(`Steam 同步失败：${error.message}`, 'error');
  } finally {
    elements.steamApiKey.value = '';
    submit.disabled = false;
  }
}

function getUnresolvedGames() {
  return state.games.filter(isPlaceholderGame);
}

function renderResolveTable() {
  const fragment = document.createDocumentFragment();
  for (const game of getUnresolvedGames()) {
    const row = document.createElement('tr');
    row.dataset.gameId = game.id;

    const coverCell = document.createElement('td');
    const candidates = getCoverCandidates(game.appId);
    if (candidates[0]) {
      const image = document.createElement('img');
      image.src = candidates[0];
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => image.remove());
      coverCell.append(image);
    }
    const appIdCell = createElement('td', '', game.appId);
    const inputCell = document.createElement('td');
    const input = document.createElement('input');
    input.placeholder = '输入游戏名称';
    input.maxLength = 120;
    inputCell.append(input);
    row.append(coverCell, appIdCell, inputCell);
    fragment.append(row);
  }
  elements.resolveBody.replaceChildren(fragment);
}

function openResolveDialog() {
  const unresolved = getUnresolvedGames();
  if (unresolved.length === 0) {
    showToast('所有游戏名称都已补全。', 'success');
    return;
  }
  renderResolveTable();
  openDialog(elements.resolveDialog);
}

function saveResolvedNames() {
  let updated = 0;
  for (const row of elements.resolveBody.rows) {
    const name = row.querySelector('input').value.trim();
    if (!name) continue;
    const game = state.games.find((item) => item.id === row.dataset.gameId);
    if (game) {
      game.name = name.slice(0, 120);
      updated += 1;
    }
  }
  persist();
  render();
  closeDialog(elements.resolveDialog);
  showToast(updated ? `已补全 ${updated} 款游戏名称。` : '没有填写新的名称。', updated ? 'success' : 'info');
}

function switchImportTab(tabName) {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  document.querySelector('#vdfPanel').hidden = tabName !== 'vdf';
  document.querySelector('#apiPanel').hidden = tabName !== 'api';
}

function bindEvents() {
  document.querySelector('#openOrderEditor').addEventListener('click', () => orderEditor.open());
  document.querySelector('#openAddGame').addEventListener('click', () => openGameEditor());
  document.querySelector('#openSteamImport').addEventListener('click', () => openDialog(elements.steamImportDialog));
  document.querySelector('#exportLibrary').addEventListener('click', exportLibrary);
  document.querySelector('#chooseJsonImport').addEventListener('click', () => elements.jsonImportFile.click());
  elements.jsonImportFile.addEventListener('change', () => importLibraryFile(elements.jsonImportFile.files[0]));

  const resetPageAndRender = () => { state.page = 0; render(); };
  elements.search.addEventListener('input', resetPageAndRender);
  elements.genre.addEventListener('change', resetPageAndRender);
  const turnPage = (direction) => {
    state.page += direction;
    render();
    elements.sheetNumber.focus({ preventScroll: true });
    document.querySelector('#album').scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  };
  elements.previousPage.addEventListener('click', () => turnPage(-1));
  elements.nextPage.addEventListener('click', () => turnPage(1));
  elements.sortOptions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-sort]');
    if (!button) return;
    state.sort = button.dataset.sort;
    for (const option of elements.sortOptions.querySelectorAll('[data-sort]')) {
      option.classList.toggle('is-active', option === button);
    }
    resetPageAndRender();
  });

  document.querySelector('#library').addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (!action || !isAdminMode) return;
    if (action.dataset.action === 'open-import') openDialog(elements.steamImportDialog);
    const card = action.closest('[data-game-id]');
    if (!card) return;
    if (action.dataset.action === 'edit') openGameEditor(card.dataset.gameId);
    if (action.dataset.action === 'delete') deleteGame(card.dataset.gameId);
  });

  elements.gameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (elements.gameForm.reportValidity()) saveGameFromForm();
  });
  elements.coverInput.addEventListener('input', onCoverInput);
  elements.searchResults.addEventListener('click', (event) => {
    const result = event.target.closest('[data-action="select-search-result"]');
    if (result) selectSearchResult(result);
  });

  document.addEventListener('click', (event) => {
    if (!elements.coverInput.contains(event.target) && !elements.searchResults.contains(event.target)) hideSteamSearch();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault();
      elements.search.focus();
    }
  });

  document.addEventListener('click', (event) => {
    const closeButton = event.target.closest('[data-close-dialog]');
    if (closeButton) closeDialog(document.querySelector(`#${closeButton.dataset.closeDialog}`));
    const tab = event.target.closest('[data-tab]');
    if (tab) switchImportTab(tab.dataset.tab);
  });
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      if (!inside) dialog.close();
    });
  }
  elements.gameDialog.addEventListener('close', () => {
    state.editingId = null;
    state.searchController?.abort();
    hideSteamSearch();
  });

  elements.vdfDropZone.addEventListener('click', () => elements.vdfInput.click());
  elements.vdfInput.addEventListener('change', () => importVdfFile(elements.vdfInput.files[0]));
  for (const eventName of ['dragenter', 'dragover']) {
    elements.vdfDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.vdfDropZone.classList.add('is-dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    elements.vdfDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.vdfDropZone.classList.remove('is-dragging');
    });
  }
  elements.vdfDropZone.addEventListener('drop', (event) => importVdfFile(event.dataTransfer.files[0]));
  elements.steamApiForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (elements.steamApiForm.reportValidity()) importOwnedGames();
  });

  elements.resolveForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveResolvedNames();
  });
  elements.retryResolve.addEventListener('click', async () => {
    if (state.resolving) return;
    const appIds = getUnresolvedGames().map((game) => game.appId);
    elements.retryResolve.disabled = true;
    elements.retryResolve.textContent = '查询中…';
    const result = await resolveGameNames(appIds);
    elements.retryResolve.disabled = false;
    elements.retryResolve.textContent = '重新自动查询';
    renderResolveTable();
    showToast(`自动查询完成：成功 ${result.resolved}，仍待处理 ${result.failed}。`, result.failed ? 'info' : 'success');
    if (getUnresolvedGames().length === 0) closeDialog(elements.resolveDialog);
  });
}

async function loadDefaultLibrary() {
  const response = await fetch('./data/default-library.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

async function initialize() {
  initializeGenrePicker();
  initializeTierPicker();
  bindEvents();

  let defaults = [];
  try {
    [defaults] = await Promise.all([
      loadDefaultLibrary(),
      isAdminMode ? Promise.resolve() : loadCoverAssets().catch(() => {}),
    ]);
  } catch (error) {
    showToast(`默认游戏库加载失败：${error.message}`, 'error');
  }

  if (!isAdminMode) {
    state.games = defaults.map((game) => normalizeGame(game)).filter(Boolean);
  } else {
    try {
      const loaded = loadLibrary(defaults);
      state.games = loaded.games;
      if (loaded.warning) showToast(loaded.warning, 'error');
      if (!loaded.warning) localBackup.save(state.games);
    } catch (error) {
      state.games = defaults.map((game) => normalizeGame(game)).filter(Boolean);
      showToast(`浏览器存储不可用：${error.message}`, 'error');
    }
  }
  render();
}

initialize();
