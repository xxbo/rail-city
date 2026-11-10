/* Presentation only: explicit state inputs; no DOM, storage or simulation writes. */
(function(root) {
  'use strict';
  const VM=typeof module!=='undefined'&&module.exports?require('./view-model'):root.RailViewModel;

  function create({
    num,
    esc
  }) {
    function shell(stationQuery, stationSort) {
      return `<header class="screen-header"><div><span>PASSENGER NETWORK</span><h1>车站候车</h1></div><button id="open-account-overview">财务 →</button><button id="close-stations" class="panel-close" aria-label="关闭车站候车">×</button></header><div class="stations-content"><div class="station-summary"><div><span>运营车站</span><strong id="station-count">0</strong></div><div><span>全网正在候车</span><strong id="station-waiting-total">0</strong></div><div><span>候车最多</span><strong id="busiest-station">—</strong></div></div><div class="station-filters"><input id="station-search" aria-label="搜索车站或线路" placeholder="搜索车站或线路" value="${esc(stationQuery)}"><select id="station-sort" aria-label="车站排序"><option value="waiting" ${stationSort==='waiting'?'selected':''}>候车人数最多</option><option value="name" ${stationSort==='name'?'selected':''}>车站名称</option></select><span id="station-results"></span></div><div class="station-list-scroll"><table class="station-menu-table"><thead><tr><th>车站</th><th>所属线路</th><th>站内 / 容量</th><th></th></tr></thead><tbody id="station-rows"></tbody></table></div><div id="stations-empty" hidden><h2>还没有运营车站</h2><p>在地图上自由设站并建成第一条线路后，这里会显示每个站的候车人数。</p><button id="station-build-first">返回地图建线</button></div></div>`;
    }

    function model(s, traffic, stationQuery, stationSort, counts) {
      const native=VM.query('stations',{state:{nodes:s.nodes,services:s.services},runtime:{outside:traffic.nativeView?.outside||traffic.outside},counts}), all=native.rows;
      const query = stationQuery.toLocaleLowerCase();
      const rows = all.filter(r => !query || (r.name + r.lines).toLocaleLowerCase().includes(query));
      rows.sort(stationSort === 'name' ? (a, b) => a.name.localeCompare(b.name, 'zh-CN') : (a, b) => b
        .waiting - a.waiting || a.id - b.id);
      return {...native,rows};
    }

    function row(r, today, entry) {
      const crowded = r.crowded;
      return `<tr data-station-row="${r.id}"><td><button data-station="${r.id}">${esc(r.name)}</button></td><td>${esc(r.lines)}</td><td data-wait-cell="${r.id}" class="${crowded?'crowded':''}"><b>${num(r.waiting)} / ${num(r.capacity)}</b><small class="queue-outside">站外 ${num(r.outside)} 人</small><small class="queue-outside">今日进站 ${num(today.entered)} · 上车 ${num(today.boarded)}</small><small class="queue-outside">预测进站 ${num(entry)} / 日</small></td><td><button data-station="${r.id}">查看 / 定位</button></td></tr>`;
    }

    return {
      shell,
      model,
      row
    };
  }
  const api = {
    create
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RailStationsView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
