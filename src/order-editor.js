import { applyManualOrder, queryLibrary } from './domain.js';
import { getTier } from './rarity.js';

export function bindOrderEditor({ dialog, getGames, onSave }) {
  const list = dialog.querySelector('#orderList');
  const search = dialog.querySelector('#orderSearch');
  const status = dialog.querySelector('#orderStatus');
  const save = dialog.querySelector('#saveOrder');
  let draft = [];

  function node(tag, className, text = '') {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  }

  function button(label, action, gameName, disabled = false) {
    const element = node('button', 'button button--secondary button--small', label);
    element.type = 'button';
    element.dataset.orderAction = action;
    element.setAttribute('aria-label', `${gameName}：${label}`);
    element.disabled = disabled;
    return element;
  }

  function render(focusId = '') {
    const fragment = document.createDocumentFragment();
    const games = new Map(getGames().map((game) => [game.id, game]));
    const query = search.value.trim().toLocaleLowerCase();
    let shown = 0;
    draft.forEach((id, index) => {
      const game = games.get(id);
      if (!game || (query && !game.name.toLocaleLowerCase().includes(query))) return;
      shown++;
      const row = node('li', 'order-row');
      row.dataset.gameId = id;
      row.dataset.place = String(index + 1);
      row.append(node('span', 'order-row__number', String(index + 1)));
      const details = node('div', 'order-row__details');
      details.append(node('strong', '', game.name), node('small', '', `${getTier(game) || '未定级'}${index < 3 ? ' · 殿堂展示' : ''}`));
      const controls = node('div', 'order-row__controls');
      const position = node('input', 'order-row__position');
      position.type = 'number';
      position.min = '1';
      position.max = String(draft.length);
      position.step = '1';
      position.value = String(index + 1);
      position.setAttribute('aria-label', `${game.name}的目标名次`);
      controls.append(button('↑', 'up', game.name, index === 0), button('↓', 'down', game.name, index === draft.length - 1),
        position, button('移动', 'move', game.name));
      row.append(details, controls);
      fragment.append(row);
    });
    if (!shown) fragment.append(node('li', 'order-empty', draft.length ? '没有匹配的游戏' : '还没有游戏可以排序'));
    list.replaceChildren(fragment);
    save.disabled = draft.length === 0;
    if (focusId) {
      const row = [...list.children].find((item) => item.dataset.gameId === focusId);
      row?.querySelector('input')?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: 'nearest' });
    }
  }

  function move(row, action) {
    const from = draft.indexOf(row.dataset.gameId);
    if (from < 0) return;
    const input = row.querySelector('input');
    if (action === 'move' && (!input.value || !input.reportValidity())) return;
    const to = action === 'up' ? from - 1 : action === 'down' ? from + 1 : Number(input.value) - 1;
    if (!Number.isInteger(to) || to < 0 || to >= draft.length || to === from) return;
    const [id] = draft.splice(from, 1);
    draft.splice(to, 0, id);
    render(id);
    status.textContent = `已移到第 ${to + 1} 位，点击「保存排序」生效。`;
  }

  list.addEventListener('click', (event) => {
    const target = event.target.closest('[data-order-action]');
    if (target) move(target.closest('.order-row'), target.dataset.orderAction);
  });
  list.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input')) {
      event.preventDefault();
      move(event.target.closest('.order-row'), 'move');
    }
  });
  search.addEventListener('input', () => render());
  save.addEventListener('click', () => {
    if (onSave(applyManualOrder(getGames(), draft))) dialog.close();
  });
  dialog.addEventListener('close', () => { draft = []; list.replaceChildren(); });

  return {
    open() {
      draft = queryLibrary(getGames(), { sort: 'manual' }).map((game) => game.id);
      search.value = '';
      status.textContent = `共 ${draft.length} 款游戏，修改后保存才会生效。`;
      render();
      dialog.showModal();
      search.focus();
    },
  };
}
