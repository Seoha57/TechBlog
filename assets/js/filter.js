document.addEventListener('DOMContentLoaded', () => {
  const links = [...document.querySelectorAll('[data-filter]')];
  const posts = [...document.querySelectorAll('[data-categories]')];
  const count = document.querySelector('[data-post-count]');
  const search = document.querySelector('[data-article-search]');
  const empty = document.querySelector('[data-search-empty]');
  const pagination = document.querySelector('[data-pagination]');
  const more = document.querySelector('[data-more]');
  const homeLimit = 6;
  const size = 12;
  const params = new URLSearchParams(location.search);
  let activeFilter = links.some(link => link.dataset.filter === params.get('c')) ? params.get('c') : 'all';
  let page = 1;
  if (search && params.get('q')) search.value = params.get('q');

  const pageList = (current, total) => {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const list = [1];
    const start = Math.max(2, current - 2);
    const end = Math.min(total - 1, current + 2);
    if (start > 2) list.push('…');
    for (let i = start; i <= end; i++) list.push(i);
    if (end < total - 1) list.push('…');
    list.push(total);
    return list;
  };

  const renderPagination = pages => {
    pagination.hidden = pages <= 1;
    const button = (label, target, attrs = '') => `<button type="button" data-page="${target}"${attrs}>${label}</button>`;
    pagination.innerHTML =
      button('이전', page - 1, page === 1 ? ' disabled' : '') +
      pageList(page, pages).map(p => p === '…'
        ? '<span class="pagination-gap">…</span>'
        : button(p, p, p === page ? ' aria-current="page"' : '')).join('') +
      button('다음', page + 1, page === pages ? ' disabled' : '');
    pagination.querySelectorAll('[data-page]').forEach(el => el.onclick = () => {
      page = Number(el.dataset.page);
      render();
      pagination.scrollIntoView({ block: 'nearest' });
    });
  };

  const render = () => {
    const query = search?.value.trim().toLocaleLowerCase('ko-KR') || '';
    const narrowed = query || activeFilter !== 'all';
    const matched = posts.filter(post => {
      const category = activeFilter === 'all' || post.dataset.categories.split(',').includes(activeFilter);
      const text = !query || (post.dataset.search || '').toLocaleLowerCase('ko-KR').includes(query);
      const latest = pagination || narrowed || post.dataset.latest !== 'false';
      return category && text && latest;
    });
    let shown = matched;
    if (pagination) {
      const pages = Math.max(1, Math.ceil(matched.length / size));
      page = Math.min(page, pages);
      shown = matched.slice((page - 1) * size, page * size);
      renderPagination(pages);
    } else {
      shown = matched.slice(0, homeLimit);
    }
    posts.forEach(post => post.hidden = !shown.includes(post));
    if (count) {
      const label = query ? '검색 결과' : activeFilter !== 'all' ? '카테고리 글' : '최신 글';
      count.textContent = pagination && !narrowed ? `전체 ${posts.length}개` : `${label} ${narrowed ? matched.length : shown.length}개 · 전체 ${posts.length}개`;
    }
    if (empty) empty.hidden = matched.length !== 0;
    if (more) {
      const next = new URLSearchParams();
      if (query) next.set('q', search.value.trim());
      if (activeFilter !== 'all') next.set('c', activeFilter);
      more.href = more.dataset.base + (next.toString() ? `?${next}` : '');
      more.firstChild.textContent = narrowed ? `${query ? '검색 결과' : '카테고리 글'} ${matched.length}개 모두 보기 ` : '전체 글 보기 ';
      more.hidden = narrowed ? matched.length <= homeLimit : posts.length <= homeLimit;
    }
  };

  links.forEach(link => {
    link.classList.toggle('active', link.dataset.filter === activeFilter);
    link.addEventListener('click', event => {
      event.preventDefault();
      activeFilter = link.dataset.filter;
      page = 1;
      links.forEach(item => item.classList.toggle('active', item === link));
      render();
    });
  });
  search?.addEventListener('input', () => { page = 1; render(); });
  render();
});
