(() => {
  const DEFAULT_API_BASE = window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1'
    || window.location.hostname === '::1'
    ? 'https://qbk-calendars-suite.onrender.com'
    : '';
  const els = {
    daysSelect: document.getElementById('days-select'),
    refreshBtn: document.getElementById('refresh-btn'),
    totalClicks: document.getElementById('total-clicks'),
    uniqueButtons: document.getElementById('unique-buttons'),
    topCategory: document.getElementById('top-category'),
    topType: document.getElementById('top-type'),
    topButtonsBody: document.getElementById('top-buttons-body'),
    typesBody: document.getElementById('types-body'),
    categoriesBody: document.getElementById('categories-body'),
    recentBody: document.getElementById('recent-body'),
  };

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderRows(target, rows, columns) {
    if (!target) return;
    if (!rows || !rows.length) {
      target.innerHTML = `<tr class="empty-row"><td colspan="${columns}">No click data yet.</td></tr>`;
      return;
    }
    target.innerHTML = rows.join('');
  }

  function formatStamp(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function load() {
    const days = encodeURIComponent(els.daysSelect?.value || '30');
    fetch(`${DEFAULT_API_BASE}/api/click-analytics?days=${days}&limit=20`, { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`Analytics request failed (${response.status})`);
        return response.json();
      })
      .then((data) => {
        els.totalClicks.textContent = String(data.total_clicks || 0);
        els.uniqueButtons.textContent = String(data.unique_buttons || 0);
        els.topCategory.textContent = data.categories?.[0]?.label || '-';
        els.topType.textContent = data.button_types?.[0]?.type || '-';

        renderRows(
          els.topButtonsBody,
          (data.top_buttons || []).map((item) => `<tr><td>${escapeHtml(item.label)}</td><td>${item.count}</td></tr>`),
          2,
        );
        renderRows(
          els.typesBody,
          (data.button_types || []).map((item) => `<tr><td>${escapeHtml(item.type)}</td><td>${item.count}</td></tr>`),
          2,
        );
        renderRows(
          els.categoriesBody,
          (data.categories || []).map((item) => `<tr><td>${escapeHtml(item.label)}</td><td>${item.count}</td></tr>`),
          2,
        );
        renderRows(
          els.recentBody,
          (data.recent_clicks || []).map((item) => `
            <tr>
              <td>${escapeHtml(formatStamp(item.server_received_at))}</td>
              <td>${escapeHtml(item.button_label)}</td>
              <td>${escapeHtml(item.button_type)}</td>
              <td>${escapeHtml(item.category || '-')}</td>
              <td>${escapeHtml(item.selected_date || '-')}</td>
            </tr>
          `),
          5,
        );
      })
      .catch((error) => {
        renderRows(els.topButtonsBody, [`<tr class="empty-row"><td colspan="2">${escapeHtml(error.message)}</td></tr>`], 2);
        renderRows(els.typesBody, [], 2);
        renderRows(els.categoriesBody, [], 2);
        renderRows(els.recentBody, [], 5);
      });
  }

  els.refreshBtn?.addEventListener('click', load);
  els.daysSelect?.addEventListener('change', load);
  load();
})();
