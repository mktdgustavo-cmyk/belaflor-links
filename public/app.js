'use strict';
(() => {
  const app = document.getElementById('app');
  const COLORS = ['#b0306a', '#2f7ed8', '#1f9d63', '#e0912b', '#7b61ff', '#0aa5a5', '#d9534f', '#6c757d', '#c2a000', '#8e5ea2'];
  const UTM = [
    ['utm_source', 'Source', 'ex: instagram, google, facebook'],
    ['utm_medium', 'Medium', 'ex: cpc, organico, bio, stories'],
    ['utm_campaign', 'Campaign', 'ex: black-friday-2026'],
    ['utm_content', 'Content', 'ex: criativo-01, video-depoimento'],
    ['utm_term', 'Term', 'ex: palavra-chave, publico'],
    ['src', 'src', 'parâmetro src (ex: Hotmart/Kiwify)'],
    ['sck', 'sck', 'parâmetro sck (ex: Hotmart/Kiwify)'],
    ['coupon', 'Cupom Hubla', 'código do cupom (ex: BELAFLOR10)'],
  ];
  const PERIODS = [[1, 'Hoje'], [7, '7 dias'], [30, '30 dias'], [90, '90 dias'], [0, 'Tudo']];
  let BASE = location.origin;
  const WA_VARS = [['codigo', 'código do lead'], ['comercial', 'nome do comercial'], ['utm_source', 'source'], ['utm_medium', 'medium'], ['utm_campaign', 'campaign'], ['utm_content', 'content'], ['utm_term', 'term'], ['cupom', 'cupom']];
  const UTM_TABS = [['combo', 'Source / Medium / Campaign'], ['utm_source', 'Source'], ['utm_medium', 'Medium'], ['utm_campaign', 'Campaign'], ['utm_content', 'Content'], ['utm_term', 'Term'], ['src', 'src'], ['sck', 'sck'], ['coupon', 'Cupom']];
  const state = { utmTab: 'combo', listFilter: 'all', search: '', days: Number(localStorageGet('bf_days') ?? 30) };

  // ------------------------------------------------------------- utils
  function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
  const pct = (n, d = 1) => `${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
  const shortUrl = (slug) => `${BASE}/${slug}`;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function toast(msg, err = false) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {} ta.remove();
    }
    toast('Link copiado: ' + text);
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401 && path !== '/api/login') { renderLogin(); throw new Error('auth'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
    return data;
  }
  function normalizeUrl(s) {
    s = String(s || '').trim();
    if (!s) return '';
    const digits = s.replace(/[\s()+\-.]/g, '');
    if (/^\d{10,15}$/.test(digits) && !/[a-z]/i.test(s)) return `https://wa.me/${digits}`;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    return s;
  }
  function buildUrl(base, utm) {
    try {
      const u = new URL(normalizeUrl(base));
      for (const [k] of UTM) if (utm[k]) u.searchParams.set(k, utm[k]);
      return u.toString();
    } catch { return ''; }
  }
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { e.preventDefault(); copy(c.dataset.copy); }
  });

  // ------------------------------------------------------------- shell
  function shell(inner) {
    app.innerHTML = `
      <header class="topbar"><div class="inner">
        <a href="#/" class="brand"><span class="dot">🌸</span> Bela Flor Links</a>
        <nav>
          <a class="btn btn-ghost btn-sm" href="#/">Links</a>
          <a class="btn btn-primary btn-sm" href="#/novo">+ Novo link</a>
          <button class="btn btn-ghost btn-sm" id="logout">Sair</button>
        </nav>
      </div></header>
      <main class="container">${inner}</main>`;
    $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); renderLogin(); };
  }
  const loading = () => shell('<div class="spinner"></div>');

  // ------------------------------------------------------------- login
  function renderLogin() {
    app.innerHTML = `
      <div class="login-wrap"><form class="card login-card" id="lf">
        <div class="brand"><span class="dot">🌸</span> Bela Flor Links</div>
        <div class="field"><label for="pw">Senha de acesso</label>
          <input type="password" id="pw" autocomplete="current-password" autofocus required></div>
        <button class="btn btn-primary" style="width:100%">Entrar</button>
        <div class="error" id="le"></div>
      </form></div>`;
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      $('#le').textContent = '';
      try {
        await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
        await boot();
      } catch (err) { $('#le').textContent = err.message; }
    };
  }

  // ------------------------------------------------------------- list
  async function renderList() {
    loading();
    const { summary, links } = await api('/api/links');
    const draw = () => {
      const term = state.search.toLowerCase();
      const rows = links.filter((l) =>
        (state.listFilter === 'all' || (state.listFilter === 'rotator') === (l.type === 'rotator')) &&
        (!term || `${l.name} ${l.slug} ${l.target_url || ''} ${l.utm.utm_campaign}`.toLowerCase().includes(term)));
      $('#tbody').innerHTML = rows.length ? rows.map((l) => `
        <tr>
          <td>
            <a class="link-name" href="#/link/${l.id}">${esc(l.name)}</a>
            <div class="short mono"><a href="${esc(shortUrl(l.slug))}" target="_blank" rel="noopener" class="muted">${esc(shortUrl(l.slug).replace(/^https?:\/\//, ''))}</a>
              <button class="btn btn-ghost btn-icon btn-sm" title="Copiar" data-copy="${esc(shortUrl(l.slug))}">⧉</button></div>
          </td>
          <td>${l.type === 'rotator' ? `<span class="badge badge-rot">Rotação · ${l.dest_count}</span>` : `<span class="badge badge-utm">Link${Object.values(l.utm).some(Boolean) ? ' + UTM' : ''}</span>`}</td>
          <td class="num">${fmt(l.clicks_today)}</td>
          <td class="num">${fmt(l.clicks_7d)}</td>
          <td class="num"><b>${fmt(l.clicks)}</b></td>
          <td class="num">${fmt(l.uniques)}</td>
          <td><span class="badge ${l.active ? 'badge-on' : 'badge-off'}">${l.active ? 'Ativo' : 'Pausado'}</span></td>
          <td class="right nowrap">
            <a class="btn btn-sm" href="#/link/${l.id}">Análise</a>
            <a class="btn btn-sm btn-ghost" href="#/link/${l.id}/editar">Editar</a>
          </td>
        </tr>`).join('') : `<tr><td colspan="8"><div class="empty">${links.length ? 'Nenhum link encontrado com esse filtro.' : '<h3>Nenhum link ainda</h3>Crie seu primeiro link de rotação ou link com UTM.<br><br><a class="btn btn-primary" href="#/novo">+ Novo link</a>'}</div></td></tr>`;
    };
    shell(`
      <div class="page-head"><div><h1>Links</h1><div class="sub muted">Cliques de robôs/prévias (WhatsApp, Facebook…) não entram na contagem.</div></div>
        <div class="toolbar">
          <form id="lookup" class="toolbar" style="gap:6px"><input type="search" id="code" placeholder="Código do lead (ex: K7Q3X)" style="width:210px" autocomplete="off"><button class="btn">Buscar</button></form>
          <a class="btn" href="/api/leads.csv" title="Todos os leads de todos os links: código, comercial e UTMs">Exportar todos os leads</a>
        </div>
      </div>
      <div id="lookup-result"></div>
      <div class="grid grid-4">
        <div class="card stat"><div class="label">Cliques hoje</div><div class="value">${fmt(summary.today)}</div></div>
        <div class="card stat"><div class="label">Últimos 7 dias</div><div class="value">${fmt(summary.d7)}</div></div>
        <div class="card stat"><div class="label">Últimos 30 dias</div><div class="value">${fmt(summary.d30)}</div></div>
        <div class="card stat"><div class="label">Pessoas únicas (30d)</div><div class="value">${fmt(summary.uniques_30d)}</div><div class="hint">${fmt(summary.links)} links criados</div></div>
      </div>
      <div class="card">
        <div class="card-pad" style="padding-bottom:12px">
          <div class="toolbar">
            <div class="segmented" id="seg">
              <button data-f="all">Todos</button><button data-f="rotator">Rotação</button><button data-f="simple">Links / UTM</button>
            </div>
            <input type="search" id="q" placeholder="Buscar por nome, slug, campanha…" value="${esc(state.search)}">
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Link</th><th>Tipo</th><th class="num">Hoje</th><th class="num">7 dias</th><th class="num">Total</th><th class="num">Únicos</th><th>Status</th><th></th></tr></thead>
          <tbody id="tbody"></tbody>
        </table></div>
      </div>`);
    const seg = () => $$('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.f === state.listFilter));
    $$('#seg button').forEach((b) => b.onclick = () => { state.listFilter = b.dataset.f; seg(); draw(); });
    $('#q').oninput = (e) => { state.search = e.target.value; draw(); };
    $('#lookup').onsubmit = async (e) => {
      e.preventDefault();
      const code = $('#code').value.trim();
      if (!code) return;
      const box = $('#lookup-result');
      try {
        const r = await api(`/api/lookup?code=${encodeURIComponent(code)}`);
        box.innerHTML = `<div class="card card-pad" style="margin-bottom:16px">
          <div class="card-head" style="margin-bottom:8px"><h2>Lead <span class="mono">${esc(r.lead_code)}</span></h2>
            <button class="btn btn-ghost btn-sm" id="lk-close">Fechar</button></div>
          <div class="grid grid-4" style="gap:12px">
            <div><div class="muted small">Comercial</div><b>${esc(r.dest_label || '—')}</b></div>
            <div><div class="muted small">Link</div><a href="#/link/${r.link_id}">${esc(r.link_name)}</a></div>
            <div><div class="muted small">Primeiro acesso</div>${esc(r.first.split(' ')[0].split('-').reverse().join('/'))} ${esc(r.first.split(' ')[1])}</div>
            <div><div class="muted small">Cliques</div>${fmt(r.clicks)}</div>
          </div>
          <div style="margin-top:12px">${utmBadges(r) || '<span class="muted small">Chegou sem UTM.</span>'}</div>
        </div>`;
        $('#lk-close').onclick = () => { box.innerHTML = ''; };
      } catch (err) { if (err.message !== 'auth') { box.innerHTML = ''; toast(err.message, true); } }
    };
    seg(); draw();
  }

  // ------------------------------------------------------------- form
  async function renderForm(id) {
    loading();
    let link = {
      type: 'rotator', name: '', slug: '', target_url: '', sticky: true, forward_params: true, active: true,
      wa_message: 'Olá! Vim pelo link da Bela Flor e gostaria de mais informações. (Código: {codigo})',
      utm: Object.fromEntries(UTM.map(([k]) => [k, ''])),
      destinations: [1, 2, 3, 4, 5].map((n) => ({ label: `Comercial ${n}`, url: '', weight: 20, active: true })),
    };
    if (id) {
      link = await api(`/api/links/${id}`);
      if (link.type !== 'rotator') link.destinations = [1, 2].map((n) => ({ label: `Comercial ${n}`, url: '', weight: 50, active: true }));
    }
    const isNew = !id;
    const baseLabel = BASE.replace(/^https?:\/\//, '') + '/';

    shell(`
      <div class="page-head"><div><h1>${isNew ? 'Novo link' : 'Editar link'}</h1>
        ${!isNew ? `<div class="sub mono muted">${esc(shortUrl(link.slug))}</div>` : ''}</div>
        ${!isNew ? `<a class="btn" href="#/link/${id}">← Voltar para análise</a>` : ''}
      </div>
      <form id="lf" autocomplete="off">
        <div class="card card-pad">
          ${isNew ? `<div class="type-cards">
            <button type="button" class="type-card" data-type="rotator"><div class="t">🔄 Rotação de comerciais</div><div class="d">Um link só que distribui as pessoas entre vários destinos (ex: WhatsApp de cada vendedor) pelo percentual que você definir.</div></button>
            <button type="button" class="type-card" data-type="simple"><div class="t">🔗 Link encurtado com UTM</div><div class="d">Encurta uma URL e adiciona source, medium, campaign, content, term, src, sck e cupom (coupon) automaticamente.</div></button>
          </div>` : ''}
          <div class="form-grid">
            <div class="field"><label for="f-name">Nome do link</label>
              <input type="text" id="f-name" value="${esc(link.name)}" placeholder="ex: Rotação comercial — Campanha Dia das Mães"></div>
            <div class="field"><label for="f-slug">Link curto <span class="opt">(deixe vazio para gerar)</span></label>
              <div class="input-prefix"><span title="${esc(baseLabel)}">${esc(baseLabel)}</span><input type="text" id="f-slug" value="${esc(link.slug)}" placeholder="comercial" pattern="[A-Za-z0-9_\\-]+"></div></div>
          </div>
          <div class="field simple-only"><label for="f-target">URL de destino</label>
            <input type="text" id="f-target" value="${esc(link.target_url || '')}" placeholder="https://belaflor.com.br/pagina">
          </div>
        </div>

        <div class="card card-pad rotator-only">
          <div class="card-head"><div><h2>Destinos da rotação</h2>
            <div class="muted small">Pode colar só o número de WhatsApp (ex: 5511999999999) que vira link wa.me automaticamente.</div></div>
            <div class="toolbar"><button type="button" class="btn btn-sm" id="equal">Distribuir igualmente</button>
            <button type="button" class="btn btn-sm btn-primary" id="add-dest">+ Adicionar destino</button></div>
          </div>
          <div class="dest-row dest-head"><span></span><span>Nome</span><span class="url-cell">URL / WhatsApp</span><span class="right">Tráfego</span><span>Ativo</span><span></span></div>
          <div id="dests"></div>
          <div class="sumbar"><div class="dist-bar" id="distbar"></div><span id="sum" class="small"></span></div>
          <div style="margin-top:18px">
            <label class="check"><input type="checkbox" id="f-sticky" ${link.sticky ? 'checked' : ''}>
              <span><b>Manter a mesma pessoa no mesmo comercial</b><br><span class="muted small">Se o lead clicar de novo (no mesmo aparelho), cai no mesmo vendedor e não consome a vez de outro.</span></span></label>
          </div>
        </div>

        <div class="card card-pad">
          <div class="card-head"><div><h2>Mensagem automática no WhatsApp <span class="muted" style="font-weight:400">(opcional)</span></h2>
            <div class="muted small">Quando o destino é um link de WhatsApp, o lead já abre a conversa com esta mensagem escrita.
            Use <span class="mono">{codigo}</span> para identificar o lead depois na exportação (código → comercial → UTM).</div></div></div>
          <textarea id="f-wa" rows="3" placeholder="Deixe vazio para não alterar a mensagem">${esc(link.wa_message || '')}</textarea>
          <div class="toolbar" style="gap:6px;margin-top:8px"><span class="muted small">Inserir:</span>
            ${WA_VARS.map(([k, t]) => `<button type="button" class="chip" data-var="${k}" title="${esc(t)}">{${k}}</button>`).join('')}</div>
          <div class="field" style="margin:12px 0 0"><label>Prévia (exemplo)</label><div class="preview" id="wa-preview"></div></div>
        </div>

        <div class="card card-pad">
          <div class="card-head"><div><h2>Parâmetros UTM e cupom <span class="muted" style="font-weight:400">(opcional)</span></h2>
            <div class="muted small">Adicionados automaticamente na URL de destino.</div></div></div>
          <div class="form-grid">
            ${UTM.map(([k, label, ph]) => `<div class="field"><label for="u-${k}">${label} <span class="opt mono">${k}</span></label>
              <input type="text" id="u-${k}" data-utm="${k}" value="${esc(link.utm[k] || '')}" placeholder="${esc(ph)}"></div>`).join('')}
          </div>
          <label class="check"><input type="checkbox" id="f-forward" ${link.forward_params ? 'checked' : ''}>
            <span><b>Repassar parâmetros recebidos</b><br><span class="muted small">Se alguém acessar <span class="mono">/${esc(link.slug || 'slug')}?fbclid=…</span> ou com outras UTMs, elas são repassadas ao destino (as UTMs fixas acima têm prioridade).</span></span></label>
          <div class="field simple-only" style="margin-top:12px"><label>Prévia da URL final</label><div class="preview mono" id="preview"></div></div>
        </div>

        <div class="card card-pad" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <label class="check" style="margin:0"><input type="checkbox" id="f-active" ${link.active ? 'checked' : ''}><span><b>Link ativo</b></span></label>
          <div class="toolbar">
            ${!isNew ? `<button type="button" class="btn btn-danger" id="del">Excluir link</button>` : ''}
            <a class="btn" href="${isNew ? '#/' : `#/link/${id}`}">Cancelar</a>
            <button class="btn btn-primary" id="save">${isNew ? 'Criar link' : 'Salvar alterações'}</button>
          </div>
        </div>
      </form>`);

    let dests = link.destinations.map((d) => ({ ...d }));
    let type = link.type;

    const setType = (t) => {
      type = t;
      $$('.type-card').forEach((c) => c.classList.toggle('on', c.dataset.type === t));
      $$('.rotator-only').forEach((el) => el.classList.toggle('hidden', t !== 'rotator'));
      $$('.simple-only').forEach((el) => el.classList.toggle('hidden', t !== 'simple'));
    };
    $$('.type-card').forEach((c) => c.onclick = () => setType(c.dataset.type));

    const drawSum = () => {
      const act = dests.filter((d) => d.active && Number(d.weight) > 0);
      const sum = act.reduce((s, d) => s + Number(d.weight || 0), 0);
      $('#distbar').innerHTML = act.map((d) => `<div style="width:${sum ? (d.weight / sum) * 100 : 0}%;background:${COLORS[dests.indexOf(d) % COLORS.length]}" title="${esc(d.label)}"></div>`).join('');
      const ok = Math.abs(sum - 100) < 0.01;
      $('#sum').innerHTML = ok ? `<span class="badge badge-on">Total 100%</span>`
        : `<span class="badge badge-warn">Total ${pct(sum, 0)}</span> <span class="muted">será proporcionalizado (${act.map((d) => `${esc(d.label)}: ${pct(sum ? d.weight / sum * 100 : 0)}`).join(' · ')})</span>`;
    };
    const drawDests = () => {
      $('#dests').innerHTML = dests.map((d, i) => `
        <div class="dest-row" data-i="${i}">
          <span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>
          <input type="text" data-k="label" value="${esc(d.label)}" placeholder="Comercial ${i + 1}">
          <input type="text" class="url-cell" data-k="url" value="${esc(d.url)}" placeholder="https://wa.me/5511999999999 ou 5511999999999">
          <div class="pct-input"><input type="number" data-k="weight" min="0" max="100" step="any" value="${esc(d.weight)}"></div>
          <label class="switch" title="Ativo"><input type="checkbox" data-k="active" ${d.active ? 'checked' : ''}><span></span></label>
          <button type="button" class="btn btn-ghost btn-icon btn-danger" data-rm="${i}" title="Remover">✕</button>
        </div>`).join('');
      $$('#dests input').forEach((inp) => {
        const i = Number(inp.closest('.dest-row').dataset.i), k = inp.dataset.k;
        inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => {
          dests[i][k] = inp.type === 'checkbox' ? inp.checked : (k === 'weight' ? Number(inp.value) : inp.value);
          drawSum();
        });
        if (k === 'url') inp.addEventListener('blur', () => { if (inp.value.trim()) { inp.value = normalizeUrl(inp.value); dests[i].url = inp.value; } });
      });
      $$('[data-rm]').forEach((b) => b.onclick = () => {
        if (dests.length <= 1) return toast('A rotação precisa de pelo menos um destino.', true);
        dests.splice(Number(b.dataset.rm), 1); drawDests();
      });
      drawSum();
    };
    $('#add-dest').onclick = () => { dests.push({ label: `Comercial ${dests.length + 1}`, url: '', weight: 0, active: true }); drawDests(); };
    $('#equal').onclick = () => {
      const act = dests.filter((d) => d.active);
      const each = Math.floor((100 / act.length) * 100) / 100;
      act.forEach((d, i) => { d.weight = i === act.length - 1 ? Math.round((100 - each * (act.length - 1)) * 100) / 100 : each; });
      dests.filter((d) => !d.active).forEach((d) => { d.weight = 0; });
      drawDests();
    };

    const utmVals = () => Object.fromEntries($$('[data-utm]').map((i) => [i.dataset.utm, i.value.trim()]));
    const drawPreview = () => {
      const t = $('#f-target').value.trim();
      $('#preview').textContent = t ? (buildUrl(t, utmVals()) || 'URL inválida') : 'Informe a URL de destino…';
    };
    $$('[data-utm]').forEach((i) => i.addEventListener('input', drawPreview));
    $('#f-target').addEventListener('input', drawPreview);
    $('#f-target').addEventListener('blur', (e) => { if (e.target.value.trim()) { e.target.value = normalizeUrl(e.target.value); drawPreview(); } });

    if (!isNew) {
      $('#del').onclick = async () => {
        if (!confirm(`Excluir o link "${link.name}" e TODO o histórico de cliques? Isso não pode ser desfeito.\n\nDica: para só parar o link, desmarque "Link ativo".`)) return;
        await api(`/api/links/${id}`, { method: 'DELETE' });
        toast('Link excluído'); location.hash = '#/';
      };
    }

    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        type, name: $('#f-name').value, slug: $('#f-slug').value,
        target_url: $('#f-target').value,
        utm: utmVals(),
        sticky: $('#f-sticky').checked, forward_params: $('#f-forward').checked, active: $('#f-active').checked,
        wa_message: $('#f-wa').value,
        destinations: type === 'rotator' ? dests.map((d) => ({ id: d.id, label: d.label, url: d.url, weight: Number(d.weight) || 0, active: !!d.active })) : undefined,
      };
      if (type === 'rotator' && !isNew && link.type === 'rotator' &&
        !confirm('Ao salvar, o balanceamento da rotação recomeça do zero com os percentuais atuais (o histórico de cliques é mantido). Continuar?')) return;
      $('#save').disabled = true;
      try {
        const saved = await api(isNew ? '/api/links' : `/api/links/${id}`, { method: isNew ? 'POST' : 'PUT', body });
        toast(isNew ? 'Link criado!' : 'Alterações salvas');
        location.hash = `#/link/${saved.id}`;
      } catch (err) { if (err.message !== 'auth') toast(err.message, true); $('#save').disabled = false; }
    };

    const drawWa = () => {
      const u = utmVals();
      const sample = { codigo: 'K7Q3X', comercial: (type === 'rotator' ? dests.find((d) => d.active)?.label : '') || 'Comercial 1', cupom: u.coupon || '', ...u };
      const txt = $('#f-wa').value.replace(/\{\s*([a-z_]+)\s*\}/gi, (m, k) => (k.toLowerCase() in sample ? sample[k.toLowerCase()] || (k.toLowerCase().startsWith('utm_') ? `[${k}]` : '') : m)).trim();
      $('#wa-preview').textContent = txt || '(sem mensagem automática)';
    };
    $('#f-wa').addEventListener('input', drawWa);
    $$('[data-utm]').forEach((i) => i.addEventListener('input', drawWa));
    $$('[data-var]').forEach((b) => b.onclick = () => {
      const ta = $('#f-wa'), ins = `{${b.dataset.var}}`;
      const a = ta.selectionStart ?? ta.value.length, z = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, a) + ins + ta.value.slice(z);
      ta.focus(); ta.selectionStart = ta.selectionEnd = a + ins.length; drawWa();
    });

    setType(type); drawDests(); drawPreview(); drawWa();
  }

  // ------------------------------------------------------------- stats
  function barChart(series, dests) {
    const W = 900, H = 230, P = { l: 36, r: 8, t: 10, b: 26 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const max = Math.max(1, ...series.map((s) => s.clicks));
    const nice = (() => { const m = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / m) * m; })();
    const bw = iw / series.length;
    const gap = Math.min(4, bw * 0.25);
    const y = (v) => P.t + ih - (v / nice) * ih;
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (nice / 4) * i, yy = y(v);
      g += `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${yy}" y2="${yy}"/><text class="axis" x="${P.l - 6}" y="${yy + 3}" text-anchor="end">${fmt(Math.round(v))}</text>`;
    }
    const every = Math.ceil(series.length / 12);
    series.forEach((s, i) => {
      const x = P.l + i * bw + gap / 2, w = Math.max(1, bw - gap);
      const tip = `${s.day.split('-').reverse().join('/')}: ${fmt(s.clicks)} cliques · ${fmt(s.uniques)} pessoas`;
      if (dests && dests.length) {
        let acc = 0;
        dests.forEach((d) => {
          const n = s.byDest[d.id] || 0; if (!n) return;
          const y0 = y(acc), y1 = y(acc + n); acc += n;
          g += `<rect x="${x}" y="${y1}" width="${w}" height="${Math.max(0, y0 - y1)}" fill="${d.color}"><title>${esc(tip)}\n${esc(d.label)}: ${fmt(n)}</title></rect>`;
        });
      } else if (s.clicks) {
        g += `<rect x="${x}" y="${y(s.clicks)}" width="${w}" height="${ih + P.t - y(s.clicks)}" rx="2" fill="${COLORS[0]}"><title>${esc(tip)}</title></rect>`;
      }
      g += `<rect x="${P.l + i * bw}" y="${P.t}" width="${bw}" height="${ih}" fill="transparent"><title>${esc(tip)}</title></rect>`;
      if (i % every === 0) {
        const [, mo, d] = s.day.split('-');
        g += `<text class="axis" x="${P.l + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${d}/${mo}</text>`;
      }
    });
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cliques por dia">${g}</svg></div>`;
  }
  function hoursChart(hours) {
    const W = 900, H = 120, P = { l: 8, r: 8, t: 8, b: 22 };
    const max = Math.max(1, ...hours), bw = (W - P.l - P.r) / 24, ih = H - P.t - P.b;
    let g = '';
    hours.forEach((n, h) => {
      const bh = (n / max) * ih;
      g += `<rect x="${P.l + h * bw + 2}" y="${P.t + ih - bh}" width="${bw - 4}" height="${bh}" rx="2" fill="${COLORS[1]}" opacity=".85"><title>${h}h: ${fmt(n)} cliques</title></rect>`;
      if (h % 3 === 0) g += `<text class="axis" x="${P.l + h * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${h}h</text>`;
    });
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}">${g}</svg></div>`;
  }
  function utmBadges(r) {
    const short = { utm_source: 'source', utm_medium: 'medium', utm_campaign: 'campaign', utm_content: 'content', utm_term: 'term', src: 'src', sck: 'sck', coupon: 'cupom' };
    return Object.keys(short).filter((k) => r[k]).map((k) => `<span class="badge badge-utm" style="margin:1px 2px 1px 0">${short[k]}: ${esc(r[k])}</span>`).join('');
  }
  function listRows(items, labelKey, total) {
    if (!items.length) return '<div class="muted small">Sem dados no período.</div>';
    const max = Math.max(...items.map((i) => i.n));
    return `<div class="list-rows">${items.map((i) => `
      <div class="row"><div style="flex:1;min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i[labelKey])}</div>
        <div class="bar"><div style="width:${(i.n / max) * 100}%"></div></div></div>
        <div class="num nowrap"><b>${fmt(i.n)}</b> <span class="muted small">${pct(total ? i.n / total * 100 : 0)}</span></div></div>`).join('')}</div>`;
  }

  async function renderStats(id) {
    loading();
    const s = await api(`/api/links/${id}/stats?days=${state.days}`);
    const l = s.link;
    const url = shortUrl(l.slug);
    const total = s.totals.clicks;
    const dests = s.destinations.map((d, i) => ({ ...d, color: COLORS[i % COLORS.length] }));
    const devLabel = { mobile: 'Celular', desktop: 'Computador', tablet: 'Tablet' };
    const finalUrl = l.type === 'simple' ? buildUrl(l.target_url, l.utm) : '';
    const utmSet = Object.entries(l.utm).filter(([, v]) => v);

    shell(`
      <div class="page-head">
        <div>
          <div class="toolbar" style="gap:8px;margin-bottom:4px">
            ${l.type === 'rotator' ? '<span class="badge badge-rot">Rotação</span>' : '<span class="badge badge-utm">Link + UTM</span>'}
            <span class="badge ${l.active ? 'badge-on' : 'badge-off'}">${l.active ? 'Ativo' : 'Pausado'}</span>
          </div>
          <h1>${esc(l.name)}</h1>
          <div class="sub short mono"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>
            <button class="btn btn-sm" data-copy="${esc(url)}">Copiar</button></div>
        </div>
        <div class="toolbar">
          <div class="segmented" id="period">${PERIODS.map(([d, t]) => `<button data-d="${d}" class="${d === state.days ? 'on' : ''}">${t}</button>`).join('')}</div>
          <button class="btn" id="toggle">${l.active ? 'Pausar' : 'Ativar'}</button>
          <a class="btn" href="/api/links/${l.id}/leads.csv" title="Uma linha por lead: código, comercial e UTMs">Exportar leads</a>
          <a class="btn btn-ghost" href="/api/links/${l.id}/clicks.csv" title="Todos os cliques, um por linha">CSV de cliques</a>
          <a class="btn btn-primary" href="#/link/${l.id}/editar">Editar</a>
        </div>
      </div>

      <div class="grid grid-4">
        <div class="card stat"><div class="label">Cliques</div><div class="value">${fmt(total)}</div><div class="hint">acessos válidos no período</div></div>
        <div class="card stat"><div class="label">Pessoas únicas</div><div class="value">${fmt(s.totals.uniques)}</div><div class="hint">${s.totals.uniques ? (total / s.totals.uniques).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : 0} cliques por pessoa</div></div>
        ${l.type === 'rotator'
          ? `<div class="card stat"><div class="label">Voltaram ao mesmo comercial</div><div class="value">${fmt(s.totals.sticky_hits)}</div><div class="hint">cliques repetidos que não consumiram a vez</div></div>`
          : `<div class="card stat"><div class="label">Hoje</div><div class="value">${fmt(s.series.at(-1)?.clicks || 0)}</div><div class="hint">${fmt(s.series.at(-1)?.uniques || 0)} pessoas</div></div>`}
        <div class="card stat"><div class="label">Robôs / prévias</div><div class="value">${fmt(s.totals.bots)}</div><div class="hint">ignorados (WhatsApp, Facebook…)</div></div>
      </div>

      ${l.type === 'rotator' ? `
      <div class="card">
        <div class="card-pad" style="padding-bottom:8px"><div class="card-head" style="margin:0"><div><h2>Distribuição por comercial</h2>
          <div class="muted small">A linha vertical indica a meta (%) configurada. A rotação segue a meta em sequência, não por sorteio.</div></div></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Destino</th><th class="num">Meta</th><th class="num">Real</th><th style="min-width:180px">Real × meta</th><th class="num">Cliques</th><th class="num">Pessoas</th></tr></thead>
          <tbody>${dests.length ? dests.map((d) => {
            const real = total ? (d.clicks / total) * 100 : 0;
            return `<tr>
              <td><div class="toolbar" style="gap:8px"><span class="swatch" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${d.color}"></span>
                <b>${esc(d.label)}</b>${d.deleted ? ' <span class="badge badge-off">removido</span>' : !d.active ? ' <span class="badge badge-off">pausado</span>' : ''}</div>
                <div class="muted small mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.url)}</div></td>
              <td class="num">${pct(d.target_pct)}</td>
              <td class="num"><b>${pct(real)}</b></td>
              <td><div class="hbar"><div class="track"><div class="fill" style="width:${Math.min(100, real)}%;background:${d.color}"></div>${d.target_pct ? `<div class="target" style="left:${Math.min(100, d.target_pct)}%"></div>` : ''}</div></div></td>
              <td class="num">${fmt(d.clicks)}</td>
              <td class="num">${fmt(d.uniques)}</td>
            </tr>`;
          }).join('') : '<tr><td colspan="6" class="muted">Nenhum destino.</td></tr>'}</tbody>
        </table></div>
      </div>` : `
      <div class="card card-pad">
        <div class="card-head" style="margin-bottom:8px"><h2>Destino</h2></div>
        <div class="preview mono">${esc(finalUrl)}</div>
        ${utmSet.length ? `<div class="toolbar" style="margin-top:10px;gap:6px">${utmSet.map(([k, v]) => `<span class="badge badge-utm">${esc(k)}=${esc(v)}</span>`).join('')}</div>` : ''}
      </div>`}

      <div class="card">
        <div class="card-pad" style="padding-bottom:10px">
          <div class="card-head" style="margin-bottom:10px"><div><h2>UTMs recebidas</h2>
            <div class="muted small">Parâmetros que vieram no link acessado (ex: <span class="mono">/${esc(l.slug)}?utm_source=facebook&amp;utm_campaign=…</span>). ${fmt(s.utm_tagged)} de ${fmt(total)} cliques (${pct(total ? s.utm_tagged / total * 100 : 0)}) chegaram com UTM.</div></div></div>
          <div class="segmented" id="utmtabs">${UTM_TABS.map(([k, t]) => `<button data-k="${k}" class="${k === state.utmTab ? 'on' : ''}">${t}</button>`).join('')}</div>
        </div>
        <div class="table-wrap" id="utmtable"></div>
      </div>

      <div class="card card-pad">
        <div class="card-head"><h2>Cliques por dia</h2></div>
        ${barChart(s.series, l.type === 'rotator' ? dests : null)}
        ${l.type === 'rotator' && dests.length ? `<div class="legend">${dests.map((d) => `<span><i style="background:${d.color}"></i>${esc(d.label)}</span>`).join('')}</div>` : ''}
      </div>

      <div class="grid grid-2" style="margin-top:16px">
        <div class="card card-pad"><div class="card-head"><h2>Origem (referência)</h2></div>${listRows(s.referers, 'ref', total)}</div>
        <div class="card card-pad"><div class="card-head"><h2>Dispositivo</h2></div>${listRows(s.devices.map((d) => ({ ...d, label: devLabel[d.device] || d.device })), 'label', total)}
          <div class="card-head" style="margin-top:18px"><h2>Horário dos cliques</h2></div>${hoursChart(s.hours)}</div>
      </div>

      <div class="card">
        <div class="card-pad" style="padding-bottom:8px"><h2>Últimos acessos</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Quando</th><th>Código</th>${l.type === 'rotator' ? '<th>Destino</th>' : ''}<th>Dispositivo</th><th>Origem</th><th>UTMs recebidas</th><th></th></tr></thead>
          <tbody>${s.recent.length ? s.recent.map((r) => `<tr>
            <td class="nowrap">${esc(r.when.split(' ')[0].split('-').reverse().join('/'))} ${esc(r.when.split(' ')[1])}</td>
            <td class="mono nowrap">${r.lead_code ? `<b>${esc(r.lead_code)}</b>` : '<span class="muted">—</span>'}</td>
            ${l.type === 'rotator' ? `<td>${esc(dests.find((d) => d.id === r.destination_id)?.label || '—')}</td>` : ''}
            <td>${esc(devLabel[r.device] || r.device || '—')}</td>
            <td>${esc(r.referer || '(direto / app)')}</td>
            <td class="small" title="${esc(r.query || '')}">${utmBadges(r) || `<span class="muted">${r.query ? esc(r.query.slice(0, 60)) : '—'}</span>`}</td>
            <td>${r.is_bot ? '<span class="badge badge-off">robô/prévia</span>' : r.sticky_hit ? '<span class="badge badge-rot">retorno</span>' : ''}</td>
          </tr>`).join('') : `<tr><td colspan="7"><div class="empty">Nenhum acesso ainda. Compartilhe o link: <span class="mono">${esc(url)}</span></div></td></tr>`}</tbody>
        </table></div>
      </div>`);

    $$('#period button').forEach((b) => b.onclick = () => { state.days = Number(b.dataset.d); localStorageSet('bf_days', state.days); renderStats(id); });
    const drawUtm = () => {
      $$('#utmtabs button').forEach((b) => b.classList.toggle('on', b.dataset.k === state.utmTab));
      const rows = s.utm[state.utmTab] || [];
      const rot = l.type === 'rotator' && dests.length;
      const label = (v) => {
        if (state.utmTab === 'combo') return v.split(' / ').map((x) => x ? esc(x) : '<span class="muted">—</span>').join(' <span class="muted">/</span> ');
        return v ? esc(v) : '<span class="muted"><i>(sem UTM)</i></span>';
      };
      const anyTagged = rows.some((r) => state.utmTab === 'combo' ? r.v !== ' /  / ' : r.v);
      $('#utmtable').innerHTML = !rows.length || !anyTagged
        ? `<div class="empty" style="padding:28px">Nenhum clique com ${state.utmTab === 'combo' ? 'UTM' : `<span class="mono">${esc(state.utmTab)}</span>`} no período.<br><span class="small">Exemplo: <span class="mono">${esc(url)}?utm_source=instagram&amp;utm_medium=stories&amp;utm_campaign=bf26</span></span></div>`
        : `<table><thead><tr><th>${esc(UTM_TABS.find(([k]) => k === state.utmTab)[1])}</th><th class="num">Cliques</th><th class="num">%</th><th class="num">Pessoas</th>
            ${rot ? dests.map((d) => `<th class="num nowrap"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${d.color};margin-right:4px"></i>${esc(d.label)}</th>`).join('') : ''}</tr></thead>
          <tbody>${rows.map((r) => `<tr><td style="max-width:420px;word-break:break-word">${label(r.v)}</td>
            <td class="num"><b>${fmt(r.clicks)}</b></td><td class="num muted">${pct(total ? r.clicks / total * 100 : 0)}</td><td class="num">${fmt(r.uniques)}</td>
            ${rot ? dests.map((d) => `<td class="num">${r.byDest && r.byDest[d.id] ? fmt(r.byDest[d.id]) : '<span class="muted">0</span>'}</td>`).join('') : ''}</tr>`).join('')}</tbody></table>`;
    };
    $$('#utmtabs button').forEach((b) => b.onclick = () => { state.utmTab = b.dataset.k; drawUtm(); });
    drawUtm();

    $('#toggle').onclick = async () => { await api(`/api/links/${id}/toggle`, { method: 'POST' }); toast(l.active ? 'Link pausado' : 'Link ativado'); renderStats(id); };
  }

  // ------------------------------------------------------------- router
  async function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    let m;
    try {
      if (h === '/') return await renderList();
      if (h === '/novo') return await renderForm(null);
      if ((m = h.match(/^\/link\/(\d+)\/editar$/))) return await renderForm(Number(m[1]));
      if ((m = h.match(/^\/link\/(\d+)$/))) return await renderStats(Number(m[1]));
      location.hash = '#/';
    } catch (e) {
      if (e.message === 'auth') return;
      shell(`<div class="card card-pad"><h2>Ops</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Voltar</a></div>`);
    }
  }
  async function boot() {
    try {
      const me = await api('/api/me');
      BASE = me.base_url || location.origin;
      route();
    } catch (e) { if (e.message !== 'auth') renderLogin(); }
  }
  window.addEventListener('hashchange', () => { if (app.querySelector('.topbar')) route(); });
  boot();
})();
