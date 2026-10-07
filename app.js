import * as db from './db.js';

// 마커 색 [바탕, 글자]. 태그를 만들 때마다 차례로 하나씩 붙는다.
const MARKERS = [
  ['#e58a9a', '#5a1f2a'],
  ['#6fbfae', '#0f3e35'],
  ['#f2b65a', '#5a3b06'],
  ['#8e9bd8', '#232b5c'],
  ['#ee9772', '#5c2410'],
  ['#7fb6e6', '#123a5e'],
  ['#b5c46b', '#3a4210'],
  ['#c9a2d6', '#47205a'],
];
const DEFAULT_TAGS = ['포즈', '손', '얼굴', '옷', '배경', '인물', '동물'];

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const uid = () => crypto.randomUUID();

// boxes: [{ id, name, createdAt }]  box: 지금 보고 있는 보관함 id
const state = { tab: 'idea', filter: null, items: [], tags: [], boxes: [], box: 'main' };

/* ---------- 태그 ---------- */

function tagVars(name) {
  const tag = state.tags.find((t) => t.name === name);
  if (!tag) return '';
  const [c, k] = MARKERS[tag.color % MARKERS.length];
  return `--c:${c};--k:${k}`;
}
const capHtml = (name, cls = '') =>
  `<span class="cap ${cls}" style="${tagVars(name)}">${esc(name)}</span>`;

async function addTag(name) {
  name = name.trim();
  if (!name || state.tags.some((t) => t.name === name)) return name;
  const color = state.tags.length ? Math.max(...state.tags.map((t) => t.color)) + 1 : 0;
  state.tags.push({ name, color });
  await db.setMeta('tags', state.tags);
  return name;
}

/* ---------- 사진 ---------- */

const urls = new Map();
async function imgUrl(id, size = 'thumb') {
  const key = `${id}:${size}`;
  if (urls.has(key)) return urls.get(key);
  const row = await db.get('images', id);
  if (!row) return '';
  const url = URL.createObjectURL(row[size]);
  urls.set(key, url);
  return url;
}
function forgetImage(id) {
  for (const size of ['thumb', 'full']) {
    const key = `${id}:${size}`;
    if (urls.has(key)) URL.revokeObjectURL(urls.get(key));
    urls.delete(key);
  }
}
// data-img 속성이 붙은 <img>에 실제 사진을 채운다.
function hydrate(root) {
  root.querySelectorAll('img[data-img]').forEach(async (img) => {
    img.src = await imgUrl(img.dataset.img, img.dataset.size || 'thumb');
  });
}

function toJpeg(bitmap, max, quality) {
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// 사진을 적당한 크기로 줄여 저장한다 (폰 공간 아끼기).
async function saveImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const [full, thumb] = [await toJpeg(bitmap, 2000, 0.88), await toJpeg(bitmap, 480, 0.8)];
  bitmap.close();
  const id = uid();
  await db.put('images', { id, full, thumb });
  return id;
}

async function deleteItem(item) {
  for (const id of item.images) {
    await db.remove('images', id);
    forgetImage(id);
  }
  await db.remove('items', item.id);
}

/* ---------- 목록 그리기 ---------- */

function fmtDate(ms) {
  const d = new Date(ms);
  const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}년 ${md}`;
}

async function load() {
  state.items = (await db.getAll('items')).sort((a, b) => b.createdAt - a.createdAt);
}

// 예전에 담은 것(보관함이 하나뿐이던 때)은 기본 보관함 'main'에 들어 있는 것으로 본다.
const boxOf = (i) => i.boxId || 'main';
const inBox = (boxId = state.box) => state.items.filter((i) => boxOf(i) === boxId);
const inTab = () => inBox().filter((i) => i.kind === state.tab);
const visible = () => inTab().filter((i) => !state.filter || i.tags.includes(state.filter));

function render() {
  const box = state.boxes.find((b) => b.id === state.box);
  $('#box-title').textContent = box.name;
  document.title = box.name;
  document.querySelectorAll('[data-tab]').forEach((b) => {
    const n = inBox().filter((i) => i.kind === b.dataset.tab).length;
    b.setAttribute('aria-selected', b.dataset.tab === state.tab);
    b.textContent = `${b.dataset.tab === 'idea' ? '아이디어' : '자료'} ${n}`;
  });
  // 화살표는 지금 칸이 아닌 쪽 하나만 보인다. (목록 옆 빈 띠도 그쪽에만 생긴다)
  document.body.dataset.view = state.tab;
  $('#go-idea').hidden = state.tab === 'idea';
  $('#go-ref').hidden = state.tab === 'ref';

  const items = inTab();
  const used = state.tags.map((t) => t.name).filter((n) => items.some((i) => i.tags.includes(n)));
  if (state.filter && !used.includes(state.filter)) state.filter = null;

  const caps = $('#caps');
  caps.hidden = used.length === 0;
  caps.innerHTML = `<button class="cap all ${state.filter ? 'off' : 'on'}" data-filter="">전체</button>`
    + used.map((n) => {
      const cls = !state.filter ? '' : state.filter === n ? 'on' : 'off';
      return `<button class="cap ${cls}" style="${tagVars(n)}" data-filter="${esc(n)}">${esc(n)}</button>`;
    }).join('');

  const list = $('#list');
  const shown = visible();
  if (!shown.length) {
    list.innerHTML = state.tab === 'idea'
      ? '<div class="empty"><strong>떠오른 장면을 담아보세요</strong>길에서 본 풍경, 읽다가 꽂힌 문장, 뭐든 좋아요.</div>'
      : '<div class="empty"><strong>참고할 사진을 모아보세요</strong>포즈, 손, 옷 주름, 배경 사진을 태그별로 정리해요.</div>';
    return;
  }

  if (state.tab === 'idea') {
    list.innerHTML = `<div class="cards">${shown.map((i) => `
      <button class="card" data-id="${i.id}">
        <div class="inner">
          ${i.text ? `<p class="text">${esc(i.text)}</p>` : ''}
          ${i.images.length ? `<div class="thumbs">${i.images.slice(0, 4).map((id) => `<img data-img="${id}" alt="">`).join('')}</div>` : ''}
          <div class="meta"><span class="date">${fmtDate(i.createdAt)}</span>${i.tags.map((t) => capHtml(t, 'mini')).join('')}</div>
        </div>
        <span class="stripe" style="${tagVars(i.tags[0])}"></span>
      </button>`).join('')}</div>`;
  } else {
    list.innerHTML = `<div class="grid">${shown.map((i) => `
      <button class="tile" data-id="${i.id}" aria-label="${esc(i.tags.join(', ') || '자료 사진')}">
        <img data-img="${i.images[0]}" alt="">
        <span class="stripe" style="${tagVars(i.tags[0])}"></span>
      </button>`).join('')}</div>`;
  }
  hydrate(list);
}

/* ---------- 창 열고 닫기 (안드로이드 뒤로가기로도 닫힘) ---------- */

const stack = [];
function openModal(dialog) {
  dialog.showModal();
  stack.push(dialog);
  history.pushState({ modal: stack.length }, '');
}
function closeModal() {
  history.back();
}
window.addEventListener('popstate', () => {
  const dialog = stack.pop();
  if (dialog) dialog.close();
});
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeModal();
  });
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
});

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- 담기 / 수정 ---------- */

let draft;

function openSheet({ item = null, kind = state.tab, text = '', files = [] } = {}) {
  draft = {
    item,
    kind: item ? item.kind : kind,
    keep: item ? [...item.images] : [],
    removed: [],
    files: files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    tags: new Set(item ? item.tags : state.filter ? [state.filter] : []),
  };
  $('#sheet-title').textContent = item ? '수정' : '새로 담기';
  setSaveLabel(item ? '저장' : '담기');
  $('#kind-seg').hidden = !!item;
  $('#text').value = item ? item.text : text;
  $('#new-tag').value = '';
  $('#sheet-error').textContent = '';
  drawSheet();
  openModal($('#sheet'));
}

// 담기 버튼이 위·아래 두 곳에 있어서 같이 바꾼다.
const saveButtons = () => [$('#sheet-save'), $('#sheet-save-bottom')];
function setSaveLabel(text, disabled = false) {
  saveButtons().forEach((b) => {
    b.textContent = text;
    b.disabled = disabled;
  });
}

function drawSheet() {
  const isRef = draft.kind === 'ref';
  // 아이디어는 글만, 사진은 자료 칸에서만 담는다.
  $('#photo-field').hidden = !isRef;
  document.querySelectorAll('[data-kind]').forEach((b) =>
    b.setAttribute('aria-selected', b.dataset.kind === draft.kind));

  $('#text-label').textContent = isRef ? '메모 (없어도 돼요)' : '그리고 싶은 장면이나 문장';
  $('#text').placeholder = isRef ? '어디서 찾은 사진인지, 뭘 참고하려는지' : '비 오는 버스 정류장, 우산 없이 웃는 사람';
  $('#text').rows = isRef ? 2 : 4;

  // 자료는 사진 한 장이 카드 하나라서, 수정할 때는 사진을 바꾸지 않는다.
  const lockPhotos = isRef && draft.item;
  $('#pick').hidden = lockPhotos;
  const photos = $('#photos');
  photos.innerHTML = draft.keep.map((id) => `
      <div class="photo"><img data-img="${id}" alt="">
        ${lockPhotos ? '' : `<button type="button" data-keep="${id}" aria-label="사진 빼기">✕</button>`}</div>`).join('')
    + draft.files.map((f, n) => `
      <div class="photo"><img src="${f.url}" alt="">
        <button type="button" data-file="${n}" aria-label="사진 빼기">✕</button></div>`).join('');
  hydrate(photos);

  $('#photo-hint').textContent = isRef && !draft.item && draft.files.length > 1
    ? `사진 ${draft.files.length}장이 자료 ${draft.files.length}개로 하나씩 담겨요. 태그는 모두에게 똑같이 붙어요.`
    : '';

  $('#tag-pick').innerHTML = state.tags.map((t) => `
    <button type="button" class="cap ${draft.tags.has(t.name) ? 'on' : 'off'}"
      style="${tagVars(t.name)}" data-tag="${esc(t.name)}" aria-pressed="${draft.tags.has(t.name)}">${esc(t.name)}</button>`).join('');
}

$('#kind-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  draft.kind = b.dataset.kind;
  $('#sheet-error').textContent = '';
  drawSheet();
});

$('#file').addEventListener('change', (e) => {
  for (const file of e.target.files) draft.files.push({ file, url: URL.createObjectURL(file) });
  e.target.value = '';
  $('#sheet-error').textContent = '';
  drawSheet();
});

$('#photos').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.file !== undefined) {
    const [gone] = draft.files.splice(Number(b.dataset.file), 1);
    URL.revokeObjectURL(gone.url);
  } else {
    draft.keep = draft.keep.filter((id) => id !== b.dataset.keep);
    draft.removed.push(b.dataset.keep);
  }
  drawSheet();
});

$('#tag-pick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  const name = b.dataset.tag;
  if (draft.tags.has(name)) draft.tags.delete(name);
  else draft.tags.add(name);
  drawSheet();
});

async function addTagFromInput() {
  const name = await addTag($('#new-tag').value);
  if (!name) return;
  draft.tags.add(name);
  $('#new-tag').value = '';
  drawSheet();
}
$('#new-tag-btn').addEventListener('click', addTagFromInput);
$('#new-tag').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addTagFromInput();
  }
});

$('#sheet-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#text').value.trim();
  const isRef = draft.kind === 'ref';
  const err = $('#sheet-error');

  if (!isRef && !text) {
    err.textContent = '그리고 싶은 장면이나 문장을 적어주세요.';
    return;
  }
  if (isRef && !draft.keep.length && !draft.files.length) {
    err.textContent = '자료에는 사진이 하나 이상 필요해요.';
    return;
  }

  setSaveLabel('저장 중…', true);
  try {
    const tags = state.tags.map((t) => t.name).filter((n) => draft.tags.has(n));
    const now = Date.now();
    const newIds = [];
    if (isRef) for (const f of draft.files) newIds.push(await saveImage(f.file));

    if (draft.item) {
      for (const id of draft.removed) {
        await db.remove('images', id);
        forgetImage(id);
      }
      await db.put('items', { ...draft.item, text, tags, images: [...draft.keep, ...newIds], updatedAt: now });
    } else if (draft.kind === 'idea') {
      await db.put('items', {
        id: uid(), boxId: state.box, kind: 'idea', text, tags, images: newIds, createdAt: now, updatedAt: now,
      });
    } else {
      // 고른 순서대로 위에서부터 보이도록 시간을 조금씩 다르게 준다.
      await db.putMany('items', newIds.map((imgId, n) => ({
        id: uid(), boxId: state.box, kind: 'ref', text, tags, images: [imgId],
        createdAt: now + newIds.length - n, updatedAt: now,
      })));
    }
    navigator.storage?.persist?.();

    const wasEdit = !!draft.item;
    state.tab = draft.kind;
    draft.files.forEach((f) => URL.revokeObjectURL(f.url));
    await load();
    render();
    closeModal();
    refreshOpenViews();
    toast(wasEdit ? '저장했어요' : '담았어요');
  } catch (error) {
    console.error(error);
    err.textContent = '저장하지 못했어요. 사진 형식을 확인하고 다시 시도해주세요.';
  } finally {
    setSaveLabel(draft.item ? '저장' : '담기');
  }
});

/* ---------- 아이디어 자세히 ---------- */

let detailId = null;

function fillDetail() {
  const item = state.items.find((i) => i.id === detailId);
  if (!item) return false;
  const body = $('#detail-body');
  body.innerHTML = `
    ${item.text ? `<p class="text">${esc(item.text)}</p>` : ''}
    ${item.images.length ? `<div class="imgs">${item.images.map((id, n) =>
      `<button type="button" data-n="${n}" aria-label="사진 크게 보기"><img data-img="${id}" data-size="full" alt=""></button>`).join('')}</div>` : ''}
    <div class="meta"><span>${fmtDate(item.createdAt)}</span>${item.tags.map((t) => capHtml(t, 'mini')).join('')}</div>`;
  hydrate(body);
  return true;
}

function openDetail(id) {
  detailId = id;
  fillDetail();
  openModal($('#detail'));
}

$('#detail-body').addEventListener('click', (e) => {
  const b = e.target.closest('[data-n]');
  if (!b) return;
  const item = state.items.find((i) => i.id === detailId);
  openViewer(item.images.map((imgId) => ({ imgId })), Number(b.dataset.n));
});
$('#detail-edit').addEventListener('click', () => {
  openSheet({ item: state.items.find((i) => i.id === detailId) });
});
$('#detail-delete').addEventListener('click', async () => {
  const item = state.items.find((i) => i.id === detailId);
  if (!confirm('이 아이디어를 지울까요? 붙어 있는 사진도 함께 지워져요.')) return;
  await deleteItem(item);
  await load();
  render();
  closeModal();
  toast('지웠어요');
});

/* ---------- 사진 크게 보기 ---------- */

// list: [{ imgId, itemId? }]  itemId가 있으면 자료 카드라서 태그·수정·삭제를 보여준다.
const view = { list: [], index: 0 };
const zoom = { s: 1, x: 0, y: 0 };
const stage = $('#stage');
const vImg = $('#viewer-img');

function applyZoom() {
  vImg.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
}
function resetZoom() {
  Object.assign(zoom, { s: 1, x: 0, y: 0 });
  applyZoom();
}

async function showView() {
  const cur = view.list[view.index];
  resetZoom();
  vImg.src = await imgUrl(cur.imgId, 'full');
  $('#viewer-pos').textContent = view.list.length > 1 ? `${view.index + 1} / ${view.list.length}` : '';
  const item = cur.itemId && state.items.find((i) => i.id === cur.itemId);
  $('#viewer-foot').hidden = !item;
  if (item) {
    $('#viewer-tags').innerHTML = item.tags.map((t) => capHtml(t)).join('');
    $('#viewer-note').textContent = item.text;
  }
}

function openViewer(list, index) {
  view.list = list;
  view.index = index;
  $('#viewer').classList.remove('hide-ui');
  showView();
  openModal($('#viewer'));
}

function step(dir) {
  const next = view.index + dir;
  if (next < 0 || next >= view.list.length) return;
  view.index = next;
  showView();
}

// 수정·삭제 뒤에 열려 있는 창 내용을 새로 고친다.
function refreshOpenViews() {
  if ($('#detail').open) fillDetail();
  if ($('#viewer').open) {
    view.list = view.list.filter((v) => !v.itemId || state.items.some((i) => i.id === v.itemId));
    if (view.list.length) {
      view.index = Math.min(view.index, view.list.length - 1);
      showView();
    }
  }
}

$('#viewer-edit').addEventListener('click', () => {
  openSheet({ item: state.items.find((i) => i.id === view.list[view.index].itemId) });
});
$('#viewer-delete').addEventListener('click', async () => {
  const item = state.items.find((i) => i.id === view.list[view.index].itemId);
  if (!confirm('이 자료를 지울까요?')) return;
  await deleteItem(item);
  await load();
  render();
  view.list.splice(view.index, 1);
  if (!view.list.length) closeModal();
  else {
    view.index = Math.min(view.index, view.list.length - 1);
    showView();
  }
  toast('지웠어요');
});

// 손가락 두 개로 확대, 한 개로 이동, 좌우로 밀어 넘기기, 두 번 톡 = 확대/원래대로
const pointers = new Map();
let gesture = null;
let lastTap = 0;
let tapTimer;

function imgOrigin() {
  const r = stage.getBoundingClientRect();
  return { x: r.left + vImg.offsetLeft, y: r.top + vImg.offsetTop };
}

stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const pts = [...pointers.values()];
  if (pts.length === 2) {
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    gesture = { type: 'pinch', d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), mid, z0: { ...zoom } };
  } else if (pts.length === 1) {
    gesture = { type: 'pan', start: { x: e.clientX, y: e.clientY }, z0: { ...zoom }, t: Date.now(), moved: false };
  }
});

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const pts = [...pointers.values()];
  if (gesture?.type === 'pinch' && pts.length === 2) {
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const s = Math.min(6, Math.max(1, gesture.z0.s * (d / gesture.d0)));
    const o = imgOrigin();
    const px = (gesture.mid.x - o.x - gesture.z0.x) / gesture.z0.s;
    const py = (gesture.mid.y - o.y - gesture.z0.y) / gesture.z0.s;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    Object.assign(zoom, { s, x: mid.x - o.x - px * s, y: mid.y - o.y - py * s });
    applyZoom();
  } else if (gesture?.type === 'pan') {
    const dx = e.clientX - gesture.start.x;
    const dy = e.clientY - gesture.start.y;
    if (Math.hypot(dx, dy) > 8) gesture.moved = true;
    if (zoom.s > 1) {
      zoom.x = gesture.z0.x + dx;
      zoom.y = gesture.z0.y + dy;
      applyZoom();
    } else {
      vImg.style.transform = `translateX(${dx}px)`;
    }
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (gesture?.type === 'pinch') {
    if (zoom.s <= 1.02) resetZoom();
    gesture = null;
    return;
  }
  if (gesture?.type !== 'pan') return;
  const dx = e.clientX - gesture.start.x;
  const dy = e.clientY - gesture.start.y;
  const g = gesture;
  gesture = null;

  if (zoom.s === 1 && g.moved) {
    if (Math.abs(dx) > 60 && Math.abs(dy) < 100) step(dx < 0 ? 1 : -1);
    else applyZoom();
    return;
  }
  if (g.moved) return;

  // 톡 / 두 번 톡
  const now = Date.now();
  if (now - lastTap < 280) {
    clearTimeout(tapTimer);
    lastTap = 0;
    if (zoom.s > 1) resetZoom();
    else {
      const o = imgOrigin();
      const s = 2.5;
      Object.assign(zoom, { s, x: (e.clientX - o.x) * (1 - s), y: (e.clientY - o.y) * (1 - s) });
      applyZoom();
    }
  } else {
    lastTap = now;
    tapTimer = setTimeout(() => $('#viewer').classList.toggle('hide-ui'), 280);
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

/* ---------- 메뉴: 백업, 태그 지우기 ---------- */

async function openMenu() {
  const imgCount = state.items.reduce((n, i) => n + i.images.length, 0);
  let usage = `사진 ${imgCount}장`;
  const est = await navigator.storage?.estimate?.();
  if (est?.usage) usage += ` · 약 ${Math.max(1, Math.round(est.usage / 1024 / 1024))}MB 사용 중`;
  $('#usage').textContent = `${usage}. 보관함은 이 폰 안에만 있어요. 가끔 백업 파일로 내보내 두세요.`;
  drawTagManage();
  openModal($('#menu'));
}

// 아래에서 올라오는 창(메뉴, 보관함 목록, 이름 짓기)은 바깥 어두운 부분을 누르면 닫힌다.
document.querySelectorAll('dialog.sheet-up').forEach((d) => d.addEventListener('click', (e) => {
  if (e.target !== d) return;
  const r = d.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) closeModal();
}));

/* ---------- 여러 보관함 ---------- */

async function switchBox(id) {
  state.box = id;
  state.filter = null;
  await db.setMeta('currentBox', id);
  render();
  window.scrollTo(0, 0);
}

function drawBoxRows() {
  $('#box-rows').innerHTML = state.boxes.map((b) => {
    const n = inBox(b.id).length;
    return `<li>
      <button type="button" class="go ${b.id === state.box ? 'now' : ''}" data-go="${b.id}">
        <strong>${esc(b.name)}</strong><small>${n}개</small>
      </button>
      <button type="button" class="text-btn" data-rename="${b.id}">이름 바꾸기</button>
      ${state.boxes.length > 1 ? `<button type="button" class="text-btn danger" data-drop="${b.id}">지우기</button>` : ''}
    </li>`;
  }).join('');
}

$('#box-list-btn').addEventListener('click', () => {
  drawBoxRows();
  openModal($('#box-list'));
});

$('#box-rows').addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  const rename = e.target.closest('[data-rename]');
  const drop = e.target.closest('[data-drop]');
  if (go) {
    await switchBox(go.dataset.go);
    closeModal();
  } else if (rename) {
    openBoxName(state.boxes.find((b) => b.id === rename.dataset.rename));
  } else if (drop) {
    const box = state.boxes.find((b) => b.id === drop.dataset.drop);
    const items = inBox(box.id);
    const msg = items.length
      ? `'${box.name}' 보관함과 안에 든 ${items.length}개를 모두 지울까요? 되돌릴 수 없어요.`
      : `'${box.name}' 보관함을 지울까요?`;
    if (!confirm(msg)) return;
    for (const item of items) await deleteItem(item);
    state.boxes = state.boxes.filter((b) => b.id !== box.id);
    await db.setMeta('boxes', state.boxes);
    await load();
    if (state.box === box.id) await switchBox(state.boxes[0].id);
    else render();
    drawBoxRows();
    toast('지웠어요');
  }
});

// 이름 짓기 창: box가 있으면 이름 바꾸기, 없으면 새로 만들기
let naming = null;
function openBoxName(box = null) {
  naming = box;
  $('#box-name-title').textContent = box ? '이름 바꾸기' : '새 보관함';
  $('#box-name-save').textContent = box ? '바꾸기' : '만들기';
  $('#box-name-input').value = box ? box.name : '';
  $('#box-name-error').textContent = '';
  openModal($('#box-name'));
  $('#box-name-input').focus();
}

$('#box-add-btn').addEventListener('click', () => openBoxName());
$('#box-name-input').addEventListener('input', () => { $('#box-name-error').textContent = ''; });

$('#box-name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#box-name-input').value.trim();
  if (!name) {
    $('#box-name-error').textContent = '보관함 이름을 적어주세요.';
    return;
  }
  if (state.boxes.some((b) => b.name === name && b !== naming)) {
    $('#box-name-error').textContent = '같은 이름의 보관함이 이미 있어요. 다른 이름을 적어주세요.';
    return;
  }
  if (naming) {
    naming.name = name;
    await db.setMeta('boxes', state.boxes);
    render();
    drawBoxRows();
    closeModal();
    toast('이름을 바꿨어요');
  } else {
    const box = { id: uid(), name, createdAt: Date.now() };
    state.boxes.push(box);
    await db.setMeta('boxes', state.boxes);
    closeModal();
    await switchBox(box.id);
    toast(`'${name}' 보관함을 만들었어요`);
  }
});

// 화면 밝기: auto(폰 설정대로) / light / dark. 이 폰에만 기억해 둔다.
function readTheme() {
  try {
    return localStorage.getItem('theme') || 'auto';
  } catch {
    return 'auto';
  }
}
function applyTheme(pick) {
  const root = document.documentElement;
  if (pick === 'auto') delete root.dataset.theme;
  else root.dataset.theme = pick;
  try {
    localStorage.setItem('theme', pick);
  } catch {}
  document.querySelectorAll('[data-theme-pick]').forEach((b) =>
    b.setAttribute('aria-selected', b.dataset.themePick === pick));
  // 폰 맨 위 상태 표시줄 색도 바탕색에 맞춘다.
  const paper = getComputedStyle(root).getPropertyValue('--paper').trim();
  document.querySelector('meta[name="theme-color"]').content = paper;
}
$('#theme-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-pick]');
  if (b) applyTheme(b.dataset.themePick);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(readTheme()));
applyTheme(readTheme());

function drawTagManage() {
  $('#tag-manage').innerHTML = state.tags.map((t) =>
    `<button type="button" class="cap" style="${tagVars(t.name)}" data-tag="${esc(t.name)}" aria-label="${esc(t.name)} 태그 지우기">${esc(t.name)}</button>`).join('');
}

$('#tag-manage').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  const name = b.dataset.tag;
  if (!confirm(`'${name}' 태그를 지울까요? 아이디어와 사진은 그대로 남아요.`)) return;
  state.tags = state.tags.filter((t) => t.name !== name);
  await db.setMeta('tags', state.tags);
  const changed = state.items.filter((i) => i.tags.includes(name))
    .map((i) => ({ ...i, tags: i.tags.filter((t) => t !== name) }));
  if (changed.length) await db.putMany('items', changed);
  await load();
  render();
  drawTagManage();
});

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

$('#export-btn').addEventListener('click', async () => {
  const btn = $('#export-btn');
  btn.textContent = '백업 파일 만드는 중…';
  try {
    const images = [];
    for (const im of await db.getAll('images')) {
      images.push({ id: im.id, full: await blobToDataUrl(im.full), thumb: await blobToDataUrl(im.thumb) });
    }
    const data = {
      app: 'drawing-box', version: 1, exportedAt: new Date().toISOString(),
      tags: state.tags, boxes: state.boxes, items: await db.getAll('items'), images,
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `보관함-백업-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('백업 파일을 저장했어요');
  } catch (error) {
    console.error(error);
    toast('백업 파일을 만들지 못했어요');
  } finally {
    btn.textContent = '백업 파일로 내보내기';
  }
});

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'drawing-box') throw new Error('not a backup');
    const images = [];
    for (const im of data.images) {
      images.push({
        id: im.id,
        full: await (await fetch(im.full)).blob(),
        thumb: await (await fetch(im.thumb)).blob(),
      });
    }
    await db.putMany('images', images);
    await db.putMany('items', data.items);
    for (const t of data.tags) {
      if (!state.tags.some((x) => x.name === t.name)) state.tags.push(t);
    }
    await db.setMeta('tags', state.tags);
    for (const b of data.boxes || []) {
      if (!state.boxes.some((x) => x.id === b.id)) state.boxes.push(b);
    }
    await db.setMeta('boxes', state.boxes);
    await load();
    render();
    closeModal();
    toast(`${data.items.length}개를 불러왔어요`);
  } catch (error) {
    console.error(error);
    toast('보관함 백업 파일이 아니에요. 파일을 다시 골라주세요.');
  }
});

/* ---------- 첫 화면 ---------- */

// 아이디어(왼쪽) ↔ 자료(오른쪽) 칸 넘기기
function setTab(tab) {
  if (tab === state.tab) return;
  state.tab = tab;
  state.filter = null;
  render();
  window.scrollTo(0, 0);
  const list = $('#list');
  list.classList.remove('appear');
  void list.offsetWidth; // 움직임을 처음부터 다시 시작
  list.classList.add('appear');
}

$('.seg[role="tablist"]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});
document.querySelectorAll('[data-go-tab]').forEach((b) =>
  b.addEventListener('click', () => setTab(b.dataset.goTab)));

// 화면을 옆으로 밀어서 넘기기 (창이 열려 있거나, 태그 줄·글 입력칸에서는 무시)
let swipe = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  swipe = e.touches.length === 1 && !e.target.closest('dialog, .caps, input, textarea')
    ? { x: t.clientX, y: t.clientY, at: Date.now() }
    : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  const quick = Date.now() - swipe.at < 700;
  swipe = null;
  if (!quick || Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  setTab(dx < 0 ? 'ref' : 'idea');
}, { passive: true });

$('#caps').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.filter = b.dataset.filter || null;
  render();
});

$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  if (state.tab === 'idea') openDetail(b.dataset.id);
  else {
    const list = visible().map((i) => ({ imgId: i.images[0], itemId: i.id }));
    openViewer(list, list.findIndex((v) => v.itemId === b.dataset.id));
  }
});

$('#add-btn').addEventListener('click', () => openSheet());
$('#menu-btn').addEventListener('click', openMenu);

// 다른 앱에서 "공유 → 보관함"으로 들어온 경우
async function takeShared() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  const box = await db.get('inbox', 'share');
  if (!box) return;
  await db.remove('inbox', 'share');
  openSheet({ kind: box.files.length ? 'ref' : 'idea', text: box.text, files: box.files });
}

async function start() {
  let tags = await db.getMeta('tags', null);
  if (!tags) {
    tags = DEFAULT_TAGS.map((name, color) => ({ name, color }));
    await db.setMeta('tags', tags);
  }
  state.tags = tags;

  let boxes = await db.getMeta('boxes', null);
  if (!boxes) {
    boxes = [{ id: 'main', name: '보관함', createdAt: Date.now() }];
    await db.setMeta('boxes', boxes);
  }
  state.boxes = boxes;
  const current = await db.getMeta('currentBox', 'main');
  state.box = boxes.some((b) => b.id === current) ? current : boxes[0].id;

  await load();
  render();
  await takeShared();
}

if ('serviceWorker' in navigator) {
  // 새 버전이 도착하면 한 번 새로고침해서 바로 바꿔 쓴다.
  // 처음 설치할 때나, 뭔가 적고 있는 창이 열려 있을 때는 건드리지 않는다.
  const hadVersion = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadVersion && !stack.length) location.reload();
  });
  navigator.serviceWorker.register('./sw.js');
}
start();
