"use strict";
/* Coleta de Campo — lógica do app (versão em nuvem, multiusuário).
   Antes os dados ficavam só no celular (localStorage); agora tudo passa
   pela API do servidor, então toda a equipe vê os mesmos registros. */

let CURRENT_USER = null;
let ENTRIES = [];
let CIDADES = [];
let RUAS = []; // ruas da cidade selecionada em "+ Registro" (cadastradas só pelo admin)
let SERVICOS = []; // serviços cadastrados (aba Serviços) — {id, nome, unidade}
let METAS = {};
let CONFIG = {};
let fotoAntesData = null, fotoDepoisData = null;

// Unidade de medida de um serviço pelo nome (usada em "+ Registro" e nas
// Metas). "R$" é tratado como custo fixo mensal (mostra só o campo Valor);
// qualquer outra unidade usa o formulário de extensão/largura/lados.
function unidadeDoServico(nome){
  const s = SERVICOS.find(s=>s.nome===nome);
  return s ? s.unidade : '';
}
// Um registro já salvo guarda sua própria unidade (denormalizada no momento
// da criação); registros antigos (antes dessa mudança) não têm esse campo,
// então caímos de volta na regra antiga (só "Equipe Padrão" era valor fixo).
function entryIsValorFixo(e){
  return (e.unidade || (e.servico === 'Equipe Padrão' ? 'R$' : 'm²')) === 'R$';
}

// ------------------------------- API ---------------------------------
async function api(method, path, body){
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if(body !== undefined){
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch(e){ /* sem corpo */ }
  if(!res.ok){
    const msg = (data && data.erro) ? data.erro : ('Erro ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function hoje(){ return new Date().toISOString().slice(0,10); }

// Monta "Rua X, nº 123 - Bairro" a partir dos campos denormalizados no
// registro (vindos da rua cadastrada no momento em que o registro foi criado).
function enderecoCompleto(e){
  let s = e.rua || '';
  if(e.numero) s += ', nº ' + e.numero;
  if(e.bairro) s += ' - ' + e.bairro;
  return s;
}

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 1800);
}

// Modal de confirmação próprio (não depende de window.confirm, que em
// alguns navegadores de celular/apps não funciona direito).
function confirmarAcao(msg, onConfirm){
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-overlay').classList.remove('hidden');
  const btnConfirm = document.getElementById('modal-confirm');
  const btnCancel = document.getElementById('modal-cancel');
  function fechar(){
    document.getElementById('modal-overlay').classList.add('hidden');
    btnConfirm.removeEventListener('click', onOk);
    btnCancel.removeEventListener('click', onCancel);
  }
  function onOk(){ fechar(); onConfirm(); }
  function onCancel(){ fechar(); }
  btnConfirm.addEventListener('click', onOk);
  btnCancel.addEventListener('click', onCancel);
}

// ------------------------------ Login ----------------------------------
async function checarSessao(){
  try{
    CURRENT_USER = await api('GET', '/api/me');
    await entrarNoApp();
  }catch(e){
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app-root').classList.add('hidden');
  }
}

async function fazerLogin(){
  const usuario = document.getElementById('login-usuario').value.trim();
  const senha = document.getElementById('login-senha').value;
  const erroEl = document.getElementById('login-erro');
  erroEl.textContent = '';
  if(!usuario || !senha){ erroEl.textContent = 'Preencha usuário e senha.'; return; }
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Entrando...';
  try{
    CURRENT_USER = await api('POST', '/api/login', { usuario, senha });
    document.getElementById('login-senha').value = '';
    await entrarNoApp();
  }catch(e){
    erroEl.textContent = e.message || 'Não foi possível entrar.';
  }finally{
    btn.disabled = false; btn.textContent = 'Entrar';
  }
}

async function fazerLogout(){
  try{ await api('POST', '/api/logout'); }catch(e){}
  CURRENT_USER = null;
  document.getElementById('app-root').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

function souAdmin(){ return CURRENT_USER && CURRENT_USER.role === 'admin'; }

async function entrarNoApp(){
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-root').classList.remove('hidden');
  document.getElementById('quem-nome').textContent = 'Olá, ' + CURRENT_USER.nome;
  document.getElementById('tab-usuarios').classList.toggle('hidden', !souAdmin());
  document.getElementById('tab-cidades').classList.toggle('hidden', !souAdmin());
  document.getElementById('tab-servicos').classList.toggle('hidden', !souAdmin());
  document.getElementById('nota-add-cidade').classList.toggle('hidden', !souAdmin());
  document.getElementById('f-data').value = hoje();
  await refreshConfig();
  // Identificação da empresa: só o administrador edita.
  ['cfg-empresa','cfg-cnpj','cfg-contrato'].forEach(id=>{
    document.getElementById(id).readOnly = !souAdmin();
  });
  if(souAdmin()){
    await refreshCidades();
  }
  await refreshServicos(); // todo mundo escolhe serviço em "+ Registro", não só o admin
  popularSelectCidade();
  popularSelectServico();
  renderLista();
}

// ------------------------------ Dados ------------------------------------
async function refreshEntries(){ ENTRIES = await api('GET', '/api/entries'); }
async function refreshCidades(){ CIDADES = await api('GET', '/api/cidades'); }
async function refreshServicos(){ SERVICOS = await api('GET', '/api/servicos'); }
async function refreshMetas(){ METAS = await api('GET', '/api/metas'); }
async function refreshConfig(){
  CONFIG = await api('GET', '/api/config');
  document.getElementById('cfg-empresa').value = CONFIG.empresa || '';
  document.getElementById('cfg-cnpj').value = CONFIG.cnpj || '';
  document.getElementById('cfg-contrato').value = CONFIG.contrato || '';
}

// Administrador escolhe a cidade em cada registro; encarregado só tem a
// própria cidade (fixa, atribuída pelo administrador na aba Usuários).
function popularSelectCidade(){
  const sel = document.getElementById('f-cidade');
  const aviso = document.getElementById('sem-cidade-aviso');
  if(souAdmin()){
    const atual = sel.value;
    const nomes = CIDADES.map(c=>c.nome);
    sel.innerHTML = '<option value="">Selecione a cidade...</option>' + nomes.map(n=>`<option value="${n}">${n}</option>`).join('');
    if(nomes.includes(atual)) sel.value = atual;
    sel.disabled = false;
    aviso.classList.add('hidden');
  } else if(CURRENT_USER.cidadeNome){
    sel.innerHTML = `<option value="${CURRENT_USER.cidadeNome}">${CURRENT_USER.cidadeNome}</option>`;
    sel.value = CURRENT_USER.cidadeNome;
    sel.disabled = true;
    aviso.classList.add('hidden');
  } else {
    sel.innerHTML = '<option value="">Nenhuma cidade atribuída</option>';
    sel.disabled = true;
    aviso.classList.remove('hidden');
  }
  atualizarBotaoSalvar();
  atualizarRuasPelaCidade();
}

let ultimoEquipeSugerida = ''; // último valor preenchido automaticamente, para não sobrescrever o que a pessoa digitou

// Cada cidade já tem um "Responsável / encarregado fixo" cadastrado na aba
// Cidades — ao escolher a cidade em "+ Registro", sugerimos esse nome no
// campo "Equipe / Encarregado" sozinho, sem precisar digitar de novo. Se a
// pessoa alterar o campo manualmente, a sugestão não mexe mais nele.
function sugerirEquipe(){
  const nomeCidade = document.getElementById('f-cidade').value;
  let responsavel = '';
  if(nomeCidade){
    if(souAdmin()){
      const c = CIDADES.find(c=>c.nome === nomeCidade);
      responsavel = (c && c.responsavel) ? c.responsavel : '';
    } else {
      responsavel = CURRENT_USER.cidadeResponsavel || '';
    }
  }
  const campo = document.getElementById('f-equipe');
  if(campo.value.trim() === '' || campo.value === ultimoEquipeSugerida){
    campo.value = responsavel;
    ultimoEquipeSugerida = responsavel;
  }
}

// A rua é sempre escolhida de uma lista já cadastrada pelo administrador
// (aba Cidades) — nunca digitada livremente, para manter os endereços
// padronizados. Aqui buscamos as ruas da cidade selecionada no formulário.
async function atualizarRuasPelaCidade(){
  sugerirEquipe();
  const nomeCidade = document.getElementById('f-cidade').value;
  if(!nomeCidade){
    RUAS = [];
    popularSelectRua();
    return;
  }
  let cidadeId = null;
  if(souAdmin()){
    const c = CIDADES.find(c=>c.nome === nomeCidade);
    cidadeId = c ? c.id : null;
  } else {
    cidadeId = CURRENT_USER.cidadeId || null;
  }
  try{
    RUAS = cidadeId ? await api('GET', '/api/ruas?cidadeId=' + encodeURIComponent(cidadeId)) : [];
  }catch(e){
    RUAS = [];
  }
  popularSelectRua();
}

function popularSelectRua(){
  const selCidade = document.getElementById('f-cidade');
  const sel = document.getElementById('f-rua');
  const aviso = document.getElementById('sem-rua-aviso');
  if(!selCidade.value){
    sel.innerHTML = '<option value="">Selecione a cidade primeiro...</option>';
    sel.disabled = true;
    aviso.classList.add('hidden');
  } else if(RUAS.length === 0){
    sel.innerHTML = '<option value="">Nenhuma rua cadastrada</option>';
    sel.disabled = true;
    aviso.classList.remove('hidden');
  } else {
    const atual = sel.value;
    sel.innerHTML = '<option value="">Selecione a rua...</option>' + RUAS.map(r=>`<option value="${r.id}">${r.nome}${r.bairro ? ' - ' + r.bairro : ''}</option>`).join('');
    if(RUAS.some(r=>r.id===atual)) sel.value = atual;
    sel.disabled = false;
    aviso.classList.add('hidden');
  }
  atualizarBotaoSalvar();
}

function popularSelectServico(){
  const sel = document.getElementById('f-servico');
  const aviso = document.getElementById('sem-servico-aviso');
  if(SERVICOS.length === 0){
    sel.innerHTML = '<option value="">Nenhum serviço cadastrado</option>';
    sel.disabled = true;
    aviso.classList.remove('hidden');
  } else {
    const atual = sel.value;
    sel.innerHTML = '<option value="">Selecione...</option>' + SERVICOS.map(s=>`<option value="${s.nome}">${s.nome}</option>`).join('');
    if(SERVICOS.some(s=>s.nome===atual)) sel.value = atual;
    sel.disabled = false;
    aviso.classList.add('hidden');
  }
  atualizarBotaoSalvar();
  toggleServicoFields();
}

function atualizarBotaoSalvar(){
  const btn = document.getElementById('btn-salvar');
  const semCidade = !document.getElementById('sem-cidade-aviso').classList.contains('hidden');
  const semRua = !document.getElementById('sem-rua-aviso').classList.contains('hidden');
  const semServico = !document.getElementById('sem-servico-aviso').classList.contains('hidden');
  btn.disabled = semCidade || semRua || semServico;
}

// ------------------------------- Tabs ------------------------------------
document.addEventListener('DOMContentLoaded', ()=>{
  document.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click', async ()=>{
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('view-'+tab.dataset.tab).classList.add('active');
      if(tab.dataset.tab === 'lista') await renderLista();
      if(tab.dataset.tab === 'metas') await renderMetas();
      if(tab.dataset.tab === 'cidades' && souAdmin()) await renderCidades();
      if(tab.dataset.tab === 'servicos' && souAdmin()) await renderServicos();
      if(tab.dataset.tab === 'usuarios' && souAdmin()) await renderUsuarios();
      if(tab.dataset.tab === 'exportar') await renderFiltrosExport();
    });
  });

  setupPhotoInput('f-antes','preview-antes', v=>fotoAntesData=v);
  setupPhotoInput('f-depois','preview-depois', v=>fotoDepoisData=v);

  checarSessao();
});

// ---------------------- Fotos (captura no celular) ------------------------
function setupPhotoInput(inputId, previewId, setter){
  const input = document.getElementById(inputId);
  input.addEventListener('change', ()=>{
    const file = input.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = e=>{
      setter(e.target.result);
      document.getElementById(previewId).innerHTML = '<img src="'+e.target.result+'">';
    };
    reader.readAsDataURL(file);
  });
}

// Serviços com unidade "R$" (cadastrados na aba Serviços) são custo mensal
// de valor fixo, não medida por extensão/largura/lados — o formulário troca
// um grupo de campos pelo outro. Serviços em "m" (comprimento linear, como
// meio-fio) não usam largura — só extensão × lados.
function toggleServicoFields(){
  const servico = document.getElementById('f-servico').value;
  const unidade = unidadeDoServico(servico);
  const isValorFixo = unidade === 'R$';
  const isLinear = unidade === 'm';
  document.getElementById('grp-medidas').style.display = isValorFixo ? 'none' : '';
  document.getElementById('grp-valor').style.display = isValorFixo ? '' : 'none';
  document.getElementById('grp-largura').style.display = isLinear ? 'none' : '';
}

function resetForm(){
  ['f-extensao','f-largura','f-valor','f-equipe','f-obs'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('f-cidade').value='';
  document.getElementById('f-servico').value='';
  document.getElementById('f-lados').value='1';
  document.getElementById('f-data').value = hoje();
  fotoAntesData = null; fotoDepoisData = null;
  document.getElementById('preview-antes').innerHTML = '<span>📷 Antes</span>';
  document.getElementById('preview-depois').innerHTML = '<span>📷 Depois</span>';
  document.getElementById('f-antes').value = '';
  document.getElementById('f-depois').value = '';
  toggleServicoFields();
  popularSelectCidade(); // repõe a cidade (fixa p/ encarregado) e já recarrega as ruas dela
}

async function salvarRegistro(){
  const cidade = document.getElementById('f-cidade').value.trim();
  const ruaId = document.getElementById('f-rua').value;
  const servico = document.getElementById('f-servico').value;
  const unidadeServico = unidadeDoServico(servico);
  const isValorFixo = unidadeServico === 'R$';
  const isLinear = unidadeServico === 'm';
  const extensao = isValorFixo ? '' : document.getElementById('f-extensao').value;
  const largura = (isValorFixo || isLinear) ? '' : document.getElementById('f-largura').value;
  const lados = isValorFixo ? '' : (document.getElementById('f-lados').value || '1');
  const valor = isValorFixo ? document.getElementById('f-valor').value : '';
  const equipe = document.getElementById('f-equipe').value.trim();
  const data = document.getElementById('f-data').value;
  const obs = document.getElementById('f-obs').value.trim();

  if(!cidade || !ruaId || !servico || !data){
    alert('Preencha ao menos Cidade, Rua, Serviço e Data.');
    return;
  }
  if(isValorFixo && !valor){
    alert('Informe o Valor (R$) do custo mensal dessa cidade.');
    return;
  }

  const btn = document.getElementById('btn-salvar');
  btn.disabled = true; btn.textContent = 'Salvando...';
  try{
    await api('POST', '/api/entries', {
      cidade, ruaId, extensao, largura, lados, valor, servico, equipe, data, obs,
      fotoAntes: fotoAntesData, fotoDepois: fotoDepoisData
    });
    toast('Registro salvo ✓');
    resetForm();
  }catch(e){
    alert('Não consegui salvar o registro. ' + e.message);
  }finally{
    btn.disabled = false; btn.textContent = 'Salvar Registro';
  }
}

function excluirRegistro(id){
  confirmarAcao('Excluir este registro?', async ()=>{
    try{
      await api('DELETE', '/api/entries/' + encodeURIComponent(id));
      toast('Registro excluído ✓');
      await renderLista();
    }catch(e){
      alert('Não consegui excluir. ' + e.message);
    }
  });
}

function mesRef(dataStr){
  if(!dataStr) return '';
  const [y,m] = dataStr.split('-');
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return meses[parseInt(m,10)-1] + '/' + y;
}
function mesKey(dataStr){
  if(!dataStr) return '';
  const [y,m] = dataStr.split('-');
  return y+'-'+m;
}

function popularFiltros(){
  const meses = [...new Set(ENTRIES.map(e=>mesKey(e.data)))].sort().reverse();
  const cidadesEntries = [...new Set(ENTRIES.map(e=>e.cidade))].sort((a,b)=>a.localeCompare(b,'pt-BR'));

  const fMes = document.getElementById('filtro-mes');
  const valorMes = fMes.value;
  fMes.innerHTML = '<option value="">Todos os meses</option>' + meses.map(m=>`<option value="${m}">${mesRef(m+'-01')}</option>`).join('');
  if(meses.includes(valorMes)) fMes.value = valorMes;

  const fCidade = document.getElementById('filtro-cidade');
  const valorCidade = fCidade.value;
  fCidade.innerHTML = '<option value="">Todas as cidades</option>' + cidadesEntries.map(c=>`<option value="${c}">${c}</option>`).join('');
  if(cidadesEntries.includes(valorCidade)) fCidade.value = valorCidade;

  const expMes = document.getElementById('exp-mes');
  expMes.innerHTML = meses.map(m=>`<option value="${m}">${mesRef(m+'-01')}</option>`).join('') || '<option value="">Sem registros</option>';

  const expCidade = document.getElementById('exp-cidade');
  const valorExpCidade = expCidade.value;
  expCidade.innerHTML = '<option value="">Todas as cidades</option>' + cidadesEntries.map(c=>`<option value="${c}">${c}</option>`).join('');
  if(cidadesEntries.includes(valorExpCidade)) expCidade.value = valorExpCidade;

  popularSelectCidade();
}

async function renderLista(){
  await refreshEntries();
  popularFiltros();
  const entries = [...ENTRIES].sort((a,b)=> b.data.localeCompare(a.data) || (b.criadoEm||'').localeCompare(a.criadoEm||''));
  const fMes = document.getElementById('filtro-mes').value;
  const fCidade = document.getElementById('filtro-cidade').value;

  document.getElementById('filtro-mes').onchange = renderLista;
  document.getElementById('filtro-cidade').onchange = renderLista;

  const filtered = entries.filter(e=>
    (!fMes || mesKey(e.data)===fMes) && (!fCidade || e.cidade===fCidade)
  );

  document.getElementById('st-total').textContent = filtered.length;
  // Só dá pra somar a "medida" quando todos os registros do filtro usam a
  // mesma unidade (m², m ou ha) — misturar unidades num total só não faz
  // sentido, então nesse caso mostramos um rótulo genérico.
  const medidos = filtered.filter(e=>!entryIsValorFixo(e));
  const unidadesPresentes = new Set(medidos.map(e=>e.unidade || 'm²'));
  document.getElementById('st-ext').textContent = medidos.reduce((s,e)=>s+(areaTotal(e)||0),0).toLocaleString('pt-BR');
  document.getElementById('st-ext-label').textContent = unidadesPresentes.size === 1
    ? [...unidadesPresentes][0] + ' medidos no mês'
    : unidadesPresentes.size === 0
      ? 'medidos no mês'
      : 'medidos no mês (unidades variadas)';
  document.getElementById('st-cidades').textContent = new Set(filtered.map(e=>e.cidade)).size;

  const totalValorFixo = filtered.filter(e=>entryIsValorFixo(e)).reduce((s,e)=>s+(parseFloat(e.valor)||0),0);
  const valorBox = document.getElementById('st-valor-box');
  if(totalValorFixo > 0){
    valorBox.style.display = '';
    document.getElementById('st-valor').textContent = formatMoeda(totalValorFixo);
  } else {
    valorBox.style.display = 'none';
  }

  const container = document.getElementById('lista-registros');
  if(filtered.length===0){
    container.innerHTML = '<div class="empty">Nenhum registro ainda.<br>Vá em "+ Registro" para adicionar o primeiro.</div>';
    return;
  }
  container.innerHTML = filtered.map(e=>`
    <div class="entry">
      <div class="entry-top">
        <div>
          <div class="entry-title">${enderecoCompleto(e)}</div>
          <div class="entry-sub">${e.cidade} · ${e.data.split('-').reverse().join('/')}${e.criadoPor?' · lançado por '+e.criadoPor:''}</div>
          <span class="badge">${e.servico}</span>
        </div>
      </div>
      <div class="entry-sub" style="margin-top:8px;">${formatMedida(e)?formatMedida(e)+' · ':''}${e.equipe||''}</div>
      ${e.obs?`<div class="entry-sub" style="margin-top:4px;">${e.obs}</div>`:''}
      ${(e.fotoAntes||e.fotoDepois)?`<div class="entry-photos">
        ${e.fotoAntes?`<img src="${e.fotoAntes}">`:''}
        ${e.fotoDepois?`<img src="${e.fotoDepois}">`:''}
      </div>`:''}
      <div class="entry-actions">
        <button class="del" onclick="excluirRegistro('${e.id}')">Excluir</button>
      </div>
    </div>
  `).join('');
}

// Quantidade medida do registro, na unidade do próprio serviço (denormalizada
// no registro): "m" é só Extensão x Lados (sem largura, ex: meio-fio);
// "m²" é Extensão x Largura x Lados; "ha" é a mesma conta de área, convertida
// de m² para hectare (1 ha = 10.000 m²).
function areaTotal(e){
  const ext = parseFloat(e.extensao);
  const larg = parseFloat(e.largura);
  const lados = parseFloat(e.lados) || 1;
  const unidade = e.unidade || 'm²';
  if(unidade === 'm'){
    if(!ext) return null;
    return ext * lados;
  }
  if(!ext || !larg) return null;
  const areaM2 = ext * larg * lados;
  return unidade === 'ha' ? areaM2 / 10000 : areaM2;
}

function formatMoeda(v){
  return (parseFloat(v)||0).toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
}

function formatMedida(e){
  if(entryIsValorFixo(e)){
    return e.valor ? 'Custo mensal fixo: ' + formatMoeda(e.valor) : '';
  }
  if(!e.extensao) return '';
  let parts = [e.extensao + ' m'];
  if(e.largura) parts.push(e.largura + ' m largura');
  parts.push((e.lados||1) + ' lado(s)');
  let s = parts.join(' × ');
  const area = areaTotal(e);
  if(area !== null) s += ' = ' + area.toLocaleString('pt-BR') + ' ' + (e.unidade || 'm²') + ' medidos';
  return s;
}

// ------------------------------- Metas ------------------------------------
function weekRangeFromDate(dataStr){
  const d = new Date(dataStr + 'T00:00:00Z');
  const dayNum = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - dayNum);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = x => x.toISOString().slice(0,10);
  return { inicio: fmt(monday), fim: fmt(sunday) };
}
function formatPeriodoSemana(inicio, fim){
  const fmt = s => s.split('-').reverse().join('/');
  return fmt(inicio) + ' a ' + fmt(fim);
}
function mudarSemana(delta){
  const input = document.getElementById('metas-data');
  const cur = input.value || hoje();
  const d = new Date(cur + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta*7);
  input.value = d.toISOString().slice(0,10);
  renderMetas();
}

async function salvarMeta(servico, valor){
  try{
    METAS = await api('PUT', '/api/metas', { servico, valor });
  }catch(e){
    alert('Não consegui salvar a meta. ' + e.message);
  }
  renderMetas();
}

async function renderMetas(){
  await Promise.all([refreshEntries(), refreshMetas(), refreshServicos()]);
  const dataInput = document.getElementById('metas-data');
  if(!dataInput.value) dataInput.value = hoje();
  const { inicio, fim } = weekRangeFromDate(dataInput.value);
  document.getElementById('metas-periodo').textContent = 'Semana: ' + formatPeriodoSemana(inicio, fim);

  const entries = ENTRIES.filter(e => e.data >= inicio && e.data <= fim);

  if(SERVICOS.length === 0){
    document.getElementById('metas-lista').innerHTML = '<div class="empty">Nenhum serviço cadastrado ainda.<br>Cadastre na aba "Serviços" para acompanhar metas.</div>';
    return;
  }

  document.getElementById('metas-lista').innerHTML = SERVICOS.map(s=>{
    const servico = s.nome;
    const unidade = s.unidade;
    const isValorFixo = unidade === 'R$';
    const feitos = entries.filter(e => e.servico === servico);
    const quantidade = isValorFixo
      ? feitos.reduce((sum,e)=>sum+(parseFloat(e.valor)||0), 0)
      : feitos.reduce((sum,e)=>sum+(areaTotal(e)||0), 0);
    const metaVal = METAS[servico] || 0;
    const pct = metaVal > 0 ? Math.min(100, (quantidade/metaVal)*100) : 0;
    const atingiu = metaVal > 0 && quantidade >= metaVal;
    const quantFmt = isValorFixo ? formatMoeda(quantidade) : quantidade.toLocaleString('pt-BR') + ' ' + unidade;
    const metaFmt = isValorFixo ? formatMoeda(metaVal) : metaVal.toLocaleString('pt-BR') + ' ' + unidade;

    return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <b>${servico}</b>
        ${atingiu ? '<span class="badge">✓ meta atingida</span>' : ''}
      </div>
      ${metaVal > 0 ? `
        <div class="meta-bar-bg"><div class="meta-bar-fill" style="width:${pct}%;${atingiu?'background:var(--accent)':''}"></div></div>
        <div class="entry-sub">${quantFmt} de ${metaFmt} (${pct.toFixed(0)}%)</div>
      ` : `
        <div class="entry-sub" style="margin-top:8px;">Feito na semana: ${quantFmt} · nenhuma meta definida</div>
      `}
      ${souAdmin() ? `
      <label style="margin-top:10px;">Meta semanal (${unidade})</label>
      <input type="number" min="0" step="${isValorFixo?'0.01':'1'}" value="${metaVal || ''}" placeholder="${isValorFixo?'Ex: 1500':'Ex: 3000'}" onchange="salvarMeta('${servico}', this.value)">
      ` : ''}
    </div>`;
  }).join('');
}

// ------------------------------ Cidades ------------------------------------
async function adicionarCidade(){
  const input = document.getElementById('nova-cidade');
  const nome = input.value.trim();
  if(!nome) return;
  const contrato = document.getElementById('nova-cidade-contrato').value.trim();
  const responsavel = document.getElementById('nova-cidade-responsavel').value.trim();
  const telefone = document.getElementById('nova-cidade-telefone').value.trim();
  try{
    CIDADES = await api('POST', '/api/cidades', { nome, contrato, responsavel, telefone });
    input.value = '';
    document.getElementById('nova-cidade-contrato').value = '';
    document.getElementById('nova-cidade-responsavel').value = '';
    document.getElementById('nova-cidade-telefone').value = '';
    cidadeSelecionadaId = CIDADES.length ? CIDADES[CIDADES.length-1].id : null; // mostra a cidade recém-criada
    await renderCidades();
    popularSelectCidade();
    toast('Cidade adicionada ✓');
  }catch(e){
    toast(e.message || 'Não consegui adicionar a cidade.');
  }
}

// Salva a edição de um campo (contrato/responsável/telefone) direto na lista.
async function atualizarCidade(id, campo, valor){
  try{
    CIDADES = await api('PUT', '/api/cidades/' + encodeURIComponent(id), { [campo]: valor });
    toast('Salvo ✓');
  }catch(e){
    toast(e.message || 'Não consegui salvar.');
  }
}

function removerCidade(id, nome){
  confirmarAcao('Remover "'+nome+'" da lista de cidades cadastradas? Os registros já salvos com essa cidade não são apagados.', async ()=>{
    CIDADES = await api('DELETE', '/api/cidades/' + encodeURIComponent(id));
    await renderCidades();
    popularSelectCidade();
  });
}

function formatDataHora(iso){
  if(!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR');
}

function renderDocumentosCidade(c){
  const docs = c.documentos || [];
  const lista = docs.length===0
    ? '<div class="entry-sub" style="margin:4px 0 8px;">Nenhum documento anexado ainda.</div>'
    : docs.map(d=>`
      <div class="entry" style="padding:10px 12px;margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div>
            <span class="badge" style="margin-top:0;">${d.tipo==='aditivo'?'Aditivo':'Contrato'}</span>
            <div style="font-size:13px;font-weight:700;margin-top:4px;">${d.titulo || (d.tipo==='aditivo'?'Aditivo de contrato':'Contrato')}</div>
            <div class="entry-sub">${formatDataHora(d.criadoEm)}${d.criadoPor?' · anexado por '+d.criadoPor:''}</div>
          </div>
          <div style="display:flex;gap:6px;flex:none;">
            <a href="${d.url}" target="_blank" rel="noopener" style="display:inline-block;padding:8px 10px;font-size:12px;border-radius:7px;border:1px solid var(--border);background:#fff;color:var(--text);font-weight:700;text-decoration:none;">Ver</a>
            <button onclick="removerDocumento('${c.id}','${d.id}')" style="padding:8px 10px;font-size:12px;border-radius:7px;border:1px solid #F1D1CC;background:#fff;color:var(--danger);font-weight:700;">Remover</button>
          </div>
        </div>
      </div>
    `).join('');

  return `
    <label style="margin-top:14px;">Documentos (Contrato e Aditivos)</label>
    ${lista}
    <div class="row2" style="margin-top:4px;">
      <div>
        <select id="doc-tipo-${c.id}">
          <option value="contrato">Contrato</option>
          <option value="aditivo">Aditivo de contrato</option>
        </select>
      </div>
      <div>
        <input type="text" id="doc-titulo-${c.id}" placeholder="Título (opcional)">
      </div>
    </div>
    <input type="file" accept="application/pdf,image/*" id="doc-arquivo-${c.id}" style="margin-top:8px;">
    <button class="btn btn-outline" style="margin-top:8px;" onclick="anexarDocumento('${c.id}')">📎 Anexar</button>
  `;
}

function renderRuasCidade(c, ruas){
  const semRuas = ruas.length === 0;
  const options = semRuas
    ? '<option value="">Nenhuma rua cadastrada</option>'
    : ruas.map(r=>`<option value="${r.id}" data-nome="${r.nome.replace(/"/g,'&quot;')}">${r.nome}${r.bairro?' - '+r.bairro:''}${r.numero?' (nº '+r.numero+')':''}</option>`).join('');

  return `
    <label style="margin-top:14px;">Ruas cadastradas</label>
    <select id="rua-select-${c.id}" ${semRuas?'disabled':''}>${options}</select>
    <button onclick="removerRuaSelecionada('${c.id}')" ${semRuas?'disabled':''} style="width:100%;padding:11px;border-radius:9px;border:1px solid #F1D1CC;background:#fff;color:var(--danger);font-weight:700;margin-top:8px;cursor:pointer;">Remover rua selecionada</button>

    <div class="row2" style="margin-top:14px;">
      <div>
        <input type="text" id="rua-nome-${c.id}" placeholder="Nome da rua">
      </div>
      <div>
        <input type="text" id="rua-numero-${c.id}" placeholder="Número (opcional)">
      </div>
    </div>
    <input type="text" id="rua-bairro-${c.id}" placeholder="Bairro (opcional)" style="margin-top:8px;" onkeydown="if(event.key==='Enter'){event.preventDefault();adicionarRua('${c.id}');}">
    <button class="btn btn-outline" style="margin-top:8px;" onclick="adicionarRua('${c.id}')">+ Adicionar rua</button>
    <div class="note" style="margin-top:6px;">As ruas cadastradas aqui aparecem para o encarregado escolher em "+ Registro" — ele só seleciona, não digita, para manter a lista padronizada.</div>
  `;
}

async function adicionarRua(cidadeId){
  const nomeInput = document.getElementById('rua-nome-'+cidadeId);
  const numeroInput = document.getElementById('rua-numero-'+cidadeId);
  const bairroInput = document.getElementById('rua-bairro-'+cidadeId);
  const nome = nomeInput.value.trim();
  if(!nome){ toast('Informe o nome da rua.'); return; }
  const numero = numeroInput.value.trim();
  const bairro = bairroInput.value.trim();
  try{
    await api('POST', '/api/ruas', { cidadeId, nome, numero, bairro });
    nomeInput.value=''; numeroInput.value=''; bairroInput.value='';
    await renderCidades();
    toast('Rua adicionada ✓');
  }catch(e){
    toast(e.message || 'Não consegui adicionar a rua.');
  }
}

function removerRua(cidadeId, ruaId, nome){
  confirmarAcao('Remover a rua "'+nome+'" da lista? Registros já salvos com essa rua não são apagados.', async ()=>{
    try{
      await api('DELETE', '/api/ruas/' + encodeURIComponent(ruaId));
      await renderCidades();
    }catch(e){
      toast(e.message || 'Não consegui remover a rua.');
    }
  });
}

function removerRuaSelecionada(cidadeId){
  const sel = document.getElementById('rua-select-'+cidadeId);
  const ruaId = sel.value;
  if(!ruaId) return;
  const nome = sel.options[sel.selectedIndex].dataset.nome || sel.options[sel.selectedIndex].text;
  removerRua(cidadeId, ruaId, nome);
}

let cidadeSelecionadaId = null; // cidade em foco na aba Cidades (escolhida no select)

function selecionarCidade(id){
  cidadeSelecionadaId = id;
  renderCidades();
}

function removerCidadeSelecionada(){
  const c = CIDADES.find(x=>x.id===cidadeSelecionadaId);
  if(!c) return;
  removerCidade(c.id, c.nome);
}

async function renderCidades(){
  await refreshCidades();
  let todasRuas = [];
  try{ todasRuas = await api('GET', '/api/ruas'); }catch(e){ todasRuas = []; }
  const container = document.getElementById('cidades-lista');
  if(CIDADES.length===0){
    cidadeSelecionadaId = null;
    container.innerHTML = '<div class="empty">Nenhuma cidade cadastrada ainda.<br>Adicione acima as cidades onde a empresa atua.</div>';
    return;
  }
  if(!cidadeSelecionadaId || !CIDADES.some(c=>c.id===cidadeSelecionadaId)){
    cidadeSelecionadaId = CIDADES[0].id;
  }
  const opcoesCidade = CIDADES.map(c=>`<option value="${c.id}" ${c.id===cidadeSelecionadaId?'selected':''}>${c.nome}</option>`).join('');
  const c = CIDADES.find(x=>x.id===cidadeSelecionadaId);
  const ruasDaCidade = todasRuas.filter(r=>r.cidadeId===c.id);

  container.innerHTML = `
    <div class="card">
      <label>Cidades cadastradas</label>
      <select id="cidade-select" onchange="selecionarCidade(this.value)">${opcoesCidade}</select>
      <button onclick="removerCidadeSelecionada()" style="width:100%;padding:11px;border-radius:9px;border:1px solid #F1D1CC;background:#fff;color:var(--danger);font-weight:700;margin-top:8px;cursor:pointer;">Remover cidade selecionada</button>
    </div>
    <div class="entry">
      <div class="entry-top">
        <div class="entry-title">${c.nome}</div>
      </div>
      <label style="margin-top:10px;">Contrato / Nº processo</label>
      <input type="text" value="${c.contrato||''}" placeholder="Ex: Contrato 012/2026" onchange="atualizarCidade('${c.id}','contrato',this.value)">
      <label>Responsável / encarregado fixo</label>
      <input type="text" value="${c.responsavel||''}" placeholder="Ex: Carlos" onchange="atualizarCidade('${c.id}','responsavel',this.value)">
      <label>Telefone de contato</label>
      <input type="text" value="${c.telefone||''}" placeholder="Ex: (11) 98888-7777" onchange="atualizarCidade('${c.id}','telefone',this.value)">
      ${renderDocumentosCidade(c)}
      ${renderRuasCidade(c, ruasDaCidade)}
    </div>
  `;
}

async function anexarDocumento(cidadeId){
  const tipoSel = document.getElementById('doc-tipo-'+cidadeId);
  const tituloInput = document.getElementById('doc-titulo-'+cidadeId);
  const fileInput = document.getElementById('doc-arquivo-'+cidadeId);
  const file = fileInput.files[0];
  if(!file){ toast('Escolha um arquivo (PDF ou imagem) para anexar.'); return; }
  const tipo = tipoSel.value;
  const titulo = tituloInput.value.trim();
  const reader = new FileReader();
  reader.onload = async (e)=>{
    try{
      CIDADES = await api('POST', '/api/cidades/'+encodeURIComponent(cidadeId)+'/documentos', {
        tipo, titulo, nomeArquivo: file.name, arquivo: e.target.result
      });
      toast('Documento anexado ✓');
      await renderCidades();
    }catch(err){
      toast(err.message || 'Não consegui anexar o documento.');
    }
  };
  reader.readAsDataURL(file);
}

function removerDocumento(cidadeId, docId){
  confirmarAcao('Remover este documento? Essa ação não pode ser desfeita.', async ()=>{
    try{
      CIDADES = await api('DELETE', '/api/cidades/'+encodeURIComponent(cidadeId)+'/documentos/'+encodeURIComponent(docId));
      await renderCidades();
    }catch(e){
      toast(e.message || 'Não consegui remover o documento.');
    }
  });
}

// ------------------------------ Serviços ------------------------------------
let servicoSelecionadoId = null; // serviço em foco na aba Serviços (escolhido no select)

function selecionarServico(id){
  servicoSelecionadoId = id;
  renderServicos();
}

function removerServicoSelecionado(){
  const s = SERVICOS.find(x=>x.id===servicoSelecionadoId);
  if(!s) return;
  removerServico(s.id, s.nome);
}

async function adicionarServico(){
  const nomeInput = document.getElementById('novo-servico-nome');
  const nome = nomeInput.value.trim();
  if(!nome) return;
  const unidade = document.getElementById('novo-servico-unidade').value;
  try{
    SERVICOS = await api('POST', '/api/servicos', { nome, unidade });
    nomeInput.value = '';
    servicoSelecionadoId = SERVICOS.length ? SERVICOS[SERVICOS.length-1].id : null; // mostra o serviço recém-criado
    await renderServicos();
    popularSelectServico();
    toast('Serviço adicionado ✓');
  }catch(e){
    toast(e.message || 'Não consegui adicionar o serviço.');
  }
}

async function atualizarServicoUnidade(id, unidade){
  try{
    SERVICOS = await api('PUT', '/api/servicos/' + encodeURIComponent(id), { unidade });
    toast('Salvo ✓');
    popularSelectServico();
  }catch(e){
    toast(e.message || 'Não consegui salvar.');
  }
}

function removerServico(id, nome){
  confirmarAcao('Remover "'+nome+'" da lista de serviços? Registros já salvos com esse serviço não são apagados, mas a meta definida para ele será removida.', async ()=>{
    try{
      SERVICOS = await api('DELETE', '/api/servicos/' + encodeURIComponent(id));
      await renderServicos();
      popularSelectServico();
    }catch(e){
      toast(e.message || 'Não consegui remover o serviço.');
    }
  });
}

async function renderServicos(){
  await refreshServicos();
  const container = document.getElementById('servicos-lista');
  if(SERVICOS.length===0){
    servicoSelecionadoId = null;
    container.innerHTML = '<div class="empty">Nenhum serviço cadastrado ainda.<br>Adicione acima os serviços executados pela equipe.</div>';
    return;
  }
  if(!servicoSelecionadoId || !SERVICOS.some(s=>s.id===servicoSelecionadoId)){
    servicoSelecionadoId = SERVICOS[0].id;
  }
  const opcoesServico = SERVICOS.map(s=>`<option value="${s.id}" ${s.id===servicoSelecionadoId?'selected':''}>${s.nome}</option>`).join('');
  const s = SERVICOS.find(x=>x.id===servicoSelecionadoId);

  container.innerHTML = `
    <div class="card">
      <label>Serviços cadastrados</label>
      <select id="servico-select" onchange="selecionarServico(this.value)">${opcoesServico}</select>
      <button onclick="removerServicoSelecionado()" style="width:100%;padding:11px;border-radius:9px;border:1px solid #F1D1CC;background:#fff;color:var(--danger);font-weight:700;margin-top:8px;cursor:pointer;">Remover serviço selecionado</button>
    </div>
    <div class="entry">
      <div class="entry-top">
        <div class="entry-title">${s.nome}</div>
        <span class="badge">${s.unidade}</span>
      </div>
      <label style="margin-top:10px;">Unidade de medida</label>
      <select onchange="atualizarServicoUnidade('${s.id}', this.value)">
        <option value="m²" ${s.unidade==='m²'?'selected':''}>m² — área (extensão × largura)</option>
        <option value="m" ${s.unidade==='m'?'selected':''}>m — comprimento linear (só extensão)</option>
        <option value="ha" ${s.unidade==='ha'?'selected':''}>ha — área em hectares (extensão × largura)</option>
        <option value="R$" ${s.unidade==='R$'?'selected':''}>R$ — valor fixo mensal</option>
      </select>
      <div class="note" style="margin-top:8px;">O nome do serviço não pode ser alterado depois de cadastrado, para não desalinhar dos registros e metas já lançados. Para corrigir o nome, cadastre um novo serviço e remova este.</div>
    </div>
  `;
}

// ------------------------------ Usuários (admin) ----------------------------
function toggleUsCidade(){
  const isAdmin = document.getElementById('us-role').value === 'admin';
  document.getElementById('grp-us-cidade').style.display = isAdmin ? 'none' : '';
}

function popularSelectUsCidade(){
  const sel = document.getElementById('us-cidade');
  const atual = sel.value;
  sel.innerHTML = '<option value="">Selecione a cidade...</option>' + CIDADES.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  if(CIDADES.some(c=>c.id===atual)) sel.value = atual;
}

async function adicionarUsuario(){
  const nome = document.getElementById('us-nome').value.trim();
  const usuario = document.getElementById('us-usuario').value.trim();
  const senha = document.getElementById('us-senha').value;
  const role = document.getElementById('us-role').value;
  const cidadeId = document.getElementById('us-cidade').value;
  if(!nome || !usuario || senha.length < 4){
    toast('Preencha nome, usuário e uma senha com pelo menos 4 caracteres.');
    return;
  }
  try{
    await api('POST', '/api/users', { nome, usuario, senha, role, cidadeId });
    document.getElementById('us-nome').value = '';
    document.getElementById('us-usuario').value = '';
    document.getElementById('us-senha').value = '';
    document.getElementById('us-role').value = 'encarregado';
    document.getElementById('us-cidade').value = '';
    toggleUsCidade();
    await renderUsuarios();
    toast('Usuário criado ✓');
  }catch(e){
    toast(e.message || 'Não consegui criar o usuário.');
  }
}

function removerUsuario(id, nome){
  confirmarAcao('Remover o acesso de "'+nome+'"? A pessoa não vai mais conseguir entrar no app.', async ()=>{
    try{
      await api('DELETE', '/api/users/' + encodeURIComponent(id));
      await renderUsuarios();
    }catch(e){
      toast(e.message || 'Não consegui remover o usuário.');
    }
  });
}

async function atualizarUsuarioCidade(id, cidadeId){
  try{
    await api('PUT', '/api/users/' + encodeURIComponent(id), { cidadeId: cidadeId || null });
    toast('Cidade atualizada ✓');
  }catch(e){
    toast(e.message || 'Não consegui atualizar.');
  }
}

async function renderUsuarios(){
  if(!souAdmin()) return;
  await refreshCidades();
  popularSelectUsCidade();
  const usuarios = await api('GET', '/api/users');
  const container = document.getElementById('usuarios-lista');
  container.innerHTML = usuarios.map(u=>`
    <div class="entry">
      <div class="entry-top">
        <div>
          <div class="entry-title">${u.nome}</div>
          <div class="entry-sub">usuário: ${u.usuario}</div>
          <span class="badge">${u.role === 'admin' ? 'Administrador' : 'Encarregado'}</span>
        </div>
      </div>
      ${u.role === 'admin' ? '' : `
        <label style="margin-top:10px;">Cidade atribuída</label>
        <select onchange="atualizarUsuarioCidade('${u.id}', this.value)">
          <option value="">Nenhuma cidade atribuída</option>
          ${CIDADES.map(c=>`<option value="${c.id}" ${c.id===u.cidadeId?'selected':''}>${c.nome}</option>`).join('')}
        </select>
      `}
      <div class="entry-actions">
        <button class="del" onclick="removerUsuario('${u.id}', '${u.nome.replace(/'/g,"\\'")}')">Remover acesso</button>
      </div>
    </div>
  `).join('');
}

// ------------------------------ Exportar ------------------------------------
async function salvarConfig(){
  try{
    CONFIG = await api('PUT', '/api/config', {
      empresa: document.getElementById('cfg-empresa').value.trim(),
      cnpj: document.getElementById('cfg-cnpj').value.trim(),
      contrato: document.getElementById('cfg-contrato').value.trim()
    });
  }catch(e){
    toast('Não consegui salvar a identificação. ' + e.message);
  }
}

async function renderFiltrosExport(){
  await Promise.all([refreshEntries(), refreshConfig()]);
  popularFiltros();
}

function csvEscape(v){
  v = String(v ?? '');
  if(v.includes(';') || v.includes('"') || v.includes('\n')){
    v = '"' + v.replace(/"/g,'""') + '"';
  }
  return v;
}

function exportarCSV(){
  const mes = document.getElementById('exp-mes').value;
  const cidade = document.getElementById('exp-cidade').value;
  const entries = ENTRIES.filter(e=>(!mes || mesKey(e.data)===mes) && (!cidade || e.cidade===cidade))
    .sort((a,b)=>(a.cidade||'').localeCompare(b.cidade||'') || (a.data||'').localeCompare(b.data||''));
  if(entries.length===0){ alert('Nenhum registro para esse filtro.'); return; }

  const cols = ['Cidade','Rua','Extensão (m)','Largura (m)','Lados','Quantidade Medida','Unidade','Valor (R$)','Serviço','Data','Equipe','Observações'];
  const linhas = [cols.join(';')];
  entries.forEach(e=>{
    const isValorFixo = entryIsValorFixo(e);
    const area = areaTotal(e);
    linhas.push([
      csvEscape(e.cidade), csvEscape(enderecoCompleto(e)),
      isValorFixo?'':csvEscape(e.extensao), isValorFixo?'':csvEscape(e.largura), isValorFixo?'':csvEscape(e.lados),
      isValorFixo?'':(area===null?'':String(area).replace('.',',')),
      isValorFixo?'':csvEscape(e.unidade||'m²'),
      isValorFixo?String(parseFloat(e.valor)||0).replace('.',','):'',
      csvEscape(e.servico), e.data.split('-').reverse().join('/'), csvEscape(e.equipe), csvEscape(e.obs)
    ].join(';'));
  });
  const blob = new Blob(['﻿'+linhas.join('\n')], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'medicao_' + (mes||'todos') + slugCidadeArquivo(cidade) + '.csv';
  a.click();
  toast('Planilha exportada ✓');
}

// Nome de arquivo amigável quando um filtro de cidade está ativo (ex:
// "medicao_2026-08_sao-jose-do-rio-preto.csv").
function slugCidadeArquivo(cidade){
  if(!cidade) return '';
  return '_' + cidade.normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase();
}

function exportarMedicao(){
 try {
  const mes = document.getElementById('exp-mes').value;
  const cidadeFiltro = document.getElementById('exp-cidade').value;
  const entries = ENTRIES.filter(e=>(!mes || mesKey(e.data)===mes) && (!cidadeFiltro || e.cidade===cidadeFiltro))
    .sort((a,b)=>(a.cidade||'').localeCompare(b.cidade||'') || (a.rua||'').localeCompare(b.rua||''));
  if(entries.length===0){ alert('Nenhum registro para esse filtro.'); return; }

  const cfg = CONFIG;
  const label = mes ? mesRef(mes+'-01') : 'Todos os períodos';
  const cidades = [...new Set(entries.map(e=>e.cidade))].join(', ');
  const datasOrdenadas = entries.map(e=>e.data).sort();
  const periodo = datasOrdenadas.length ? datasOrdenadas[0].split('-').reverse().join('/') + ' a ' + datasOrdenadas[datasOrdenadas.length-1].split('-').reverse().join('/') : '';

  const resumoMap = {};
  entries.forEach(e=>{
    if(!resumoMap[e.servico]) resumoMap[e.servico] = {area:0, valor:0, count:0, unidades:new Set()};
    resumoMap[e.servico].area += areaTotal(e) || 0;
    resumoMap[e.servico].valor += parseFloat(e.valor) || 0;
    resumoMap[e.servico].count += 1;
    if(!entryIsValorFixo(e)) resumoMap[e.servico].unidades.add(e.unidade || 'm²');
  });
  function unidadeLabelDoResumo(r){
    if(r.unidades.size === 0) return '';
    if(r.unidades.size === 1) return [...r.unidades][0];
    return 'unid. variadas';
  }
  const totalArea = entries.reduce((s,e)=>s+(entryIsValorFixo(e)?0:(areaTotal(e)||0)),0);
  const totalValor = entries.reduce((s,e)=>s+(parseFloat(e.valor)||0),0);
  // Só dá pra somar a "quantidade medida" de todos os registros num total só
  // quando todo mundo usa a mesma unidade (m², m ou ha) — misturar unidades
  // num total geral não faz sentido. Quando há mais de uma, o quadro "Resumo
  // por Serviço" abaixo já mostra o total certo de cada serviço.
  const unidadesGerais = new Set(entries.filter(e=>!entryIsValorFixo(e)).map(e=>e.unidade || 'm²'));
  const totalAreaUnica = unidadesGerais.size === 1 ? totalArea.toLocaleString('pt-BR') + ' ' + [...unidadesGerais][0] : null;
  // Tabela principal aponta pro resumo por serviço; o próprio resumo (que já
  // é a quebra por unidade) aponta pras linhas dele mesmo, não pra si próprio.
  const totalAreaTxtPrincipal = totalAreaUnica !== null ? totalAreaUnica : (unidadesGerais.size === 0 ? '' : 'ver resumo abaixo');
  const totalAreaTxtResumo = totalAreaUnica !== null ? totalAreaUnica : (unidadesGerais.size === 0 ? '' : 'ver linhas acima');

  const win = window.open('', '_blank');
  if(!win){ alert('O navegador bloqueou a abertura da medição.\n\nToque em "Gerar Medição" novamente ou, se aparecer um aviso de pop-up bloqueado, toque nele e escolha "Permitir".'); return; }
  let html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Medição Mensal — ${label}</title>
  <style>
    @page { size: A4 landscape; margin: 14mm 12mm; }
    *{box-sizing:border-box;}
    body{font-family:Arial,Helvetica,sans-serif;color:#1E2430;margin:0;padding:20px;background:#fff;}
    .letterhead{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #00632B;padding-bottom:12px;margin-bottom:14px;}
    .letterhead .brand{display:flex;align-items:center;gap:12px;}
    .letterhead .brand img{width:48px;height:48px;object-fit:contain;}
    .letterhead h1{font-size:13px;color:#00632B;margin:0 0 3px;letter-spacing:.3px;}
    .letterhead .empresa{font-size:18px;color:#00632B;font-weight:700;letter-spacing:.2px;}
    .letterhead .cnpj{font-size:10px;color:#9AA4B2;}
    .letterhead .pagerinfo{font-size:11px;color:#6B7280;text-align:right;}
    .identificacao{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px 20px;background:#F4F6F8;border:1px solid #E2E5EA;border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:11.5px;}
    .identificacao div{display:flex;justify-content:space-between;border-bottom:1px dotted #C7CDD6;padding:2px 0;}
    .identificacao b{color:#00632B;font-weight:700;}
    table{width:100%;border-collapse:collapse;margin-bottom:22px;}
    th{background:#00632B;color:#fff;font-size:10px;text-align:center;padding:6px 5px;border:1px solid #00632B;}
    td{font-size:10px;padding:5px;border:1px solid #E2E5EA;text-align:center;}
    td.left{text-align:left;}
    tfoot td{font-weight:700;background:#E6F0EA;border-top:2px solid #00632B;}
    h2.secao{font-size:13px;color:#00632B;margin:0 0 8px;}
    thead{display:table-header-group;}
    tr{page-break-inside:avoid;}
    @media print { body{padding:0;} }
  </style></head><body>

  <div class="letterhead">
    <div class="brand">
      <img src="/img/logo.jpg" alt="Logo">
      <div>
        <div class="empresa">${cfg.empresa || '[Nome da Construtora]'}</div>
        <h1>Medição Mensal de Serviços — Limpeza Urbana</h1>
        <div class="cnpj">${cfg.cnpj || ''}</div>
      </div>
    </div>
    <div class="pagerinfo">Documento de medição para faturamento</div>
  </div>

  <div class="identificacao">
    <div><b>Mês de Referência</b> <span>${label}</span></div>
    <div><b>Contrato / Nº Processo</b> <span>${cfg.contrato || '(não informado)'}</span></div>
    <div><b>Cidade(s)</b> <span>${cidades}</span></div>
    <div><b>Período de Execução</b> <span>${periodo}</span></div>
  </div>

  <table>
    <thead><tr>
      <th>Nº</th><th>Cidade</th><th>Rua / Logradouro</th><th>Extensão (m)</th><th>Largura (m)</th><th>Lados</th>
      <th>Quantidade</th><th>Valor (R$)</th><th>Serviço Executado</th><th>Data</th><th>Equipe</th><th>Observações</th>
    </tr></thead>
    <tbody>`;

  entries.forEach((e,i)=>{
    const area = areaTotal(e);
    const isValorFixo = entryIsValorFixo(e);
    html += `<tr>
      <td>${i+1}</td>
      <td class="left">${e.cidade}</td>
      <td class="left">${enderecoCompleto(e)}</td>
      <td>${isValorFixo?'':(e.extensao||'')}</td>
      <td>${isValorFixo?'':(e.largura||'')}</td>
      <td>${isValorFixo?'':(e.lados||'')}</td>
      <td>${isValorFixo?'':(area===null?'':area.toLocaleString('pt-BR') + ' ' + (e.unidade||'m²'))}</td>
      <td>${isValorFixo?formatMoeda(e.valor):''}</td>
      <td class="left">${e.servico}</td>
      <td>${e.data.split('-').reverse().join('/')}</td>
      <td>${e.equipe||''}</td>
      <td class="left">${e.obs||''}</td>
    </tr>`;
  });

  html += `</tbody>
    <tfoot><tr>
      <td colspan="6" class="left">TOTAL GERAL</td>
      <td>${totalAreaTxtPrincipal}</td>
      <td>${formatMoeda(totalValor)}</td>
      <td colspan="4"></td>
    </tr></tfoot>
  </table>

  <h2 class="secao">Resumo por Serviço</h2>
  <table>
    <thead><tr><th>Serviço</th><th>Quantidade Total</th><th>Valor Total (R$)</th><th>Nº de Ruas/Trechos</th></tr></thead>
    <tbody>`;
  Object.keys(resumoMap).sort().forEach(serv=>{
    const r = resumoMap[serv];
    const unidadeLabel = unidadeLabelDoResumo(r);
    html += `<tr>
      <td class="left">${serv}</td>
      <td>${r.area.toLocaleString('pt-BR')}${unidadeLabel?' '+unidadeLabel:''}</td>
      <td>${formatMoeda(r.valor)}</td>
      <td>${r.count}</td>
    </tr>`;
  });
  html += `</tbody>
    <tfoot><tr>
      <td class="left">TOTAL GERAL</td>
      <td>${totalAreaTxtResumo}</td>
      <td>${formatMoeda(totalValor)}</td>
      <td>${entries.length}</td>
    </tr></tfoot>
  </table>

  <script>window.onload=()=>{setTimeout(()=>window.print(),400);}<\/script></body></html>`;
  win.document.write(html);
  win.document.close();
 } catch(err){
  alert('Não consegui gerar a medição. Erro: ' + (err && err.message ? err.message : err));
 }
}

function exportarFotos(){
 try {
  const mes = document.getElementById('exp-mes').value;
  const cidadeFiltro = document.getElementById('exp-cidade').value;
  const entries = ENTRIES.filter(e=>(!mes || mesKey(e.data)===mes) && (!cidadeFiltro || e.cidade===cidadeFiltro))
    .sort((a,b)=>(a.cidade||'').localeCompare(b.cidade||'') || (a.rua||'').localeCompare(b.rua||''));
  if(entries.length===0){ alert('Nenhum registro para esse filtro.'); return; }

  const cfg = CONFIG;
  const label = mes ? mesRef(mes+'-01') : 'Todos os períodos';
  const cidades = [...new Set(entries.map(e=>e.cidade))].join(', ');
  const datasOrdenadas = entries.map(e=>e.data).sort();
  const periodo = datasOrdenadas.length ? datasOrdenadas[0].split('-').reverse().join('/') + ' a ' + datasOrdenadas[datasOrdenadas.length-1].split('-').reverse().join('/') : '';

  const win = window.open('', '_blank');
  if(!win){ alert('O navegador bloqueou a abertura do relatório.\n\nToque em "Gerar Relatório Fotográfico" novamente ou, se aparecer um aviso de pop-up bloqueado, toque nele e escolha "Permitir".'); return; }
  let html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório Fotográfico — ${label}</title>
  <style>
    @page { size: A4; margin: 18mm 16mm; }
    *{box-sizing:border-box;}
    body{font-family:Arial,Helvetica,sans-serif;color:#1E2430;margin:0;padding:24px;max-width:900px;margin:0 auto;background:#fff;}
    .letterhead{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #00632B;padding-bottom:14px;margin-bottom:18px;}
    .letterhead .brand{display:flex;align-items:center;gap:12px;}
    .letterhead .brand img{width:52px;height:52px;object-fit:contain;}
    .letterhead h1{font-size:14px;color:#00632B;margin:0 0 4px;letter-spacing:.3px;}
    .letterhead .empresa{font-size:19px;color:#00632B;font-weight:700;letter-spacing:.2px;}
    .letterhead .cnpj{font-size:10.5px;color:#9AA4B2;}
    .letterhead .pagerinfo{font-size:11px;color:#6B7280;text-align:right;}
    .identificacao{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;background:#F4F6F8;border:1px solid #E2E5EA;border-radius:8px;padding:14px 18px;margin-bottom:22px;font-size:12.5px;}
    .identificacao div{display:flex;justify-content:space-between;border-bottom:1px dotted #C7CDD6;padding:3px 0;}
    .identificacao b{color:#00632B;font-weight:700;}
    .item{page-break-inside:avoid;border:1px solid #E2E5EA;border-radius:10px;padding:16px 18px;margin-bottom:18px;}
    .item h2{margin:0 0 3px;font-size:15px;color:#1E2430;}
    .item .local{font-size:12px;color:#6B7280;margin-bottom:8px;}
    .item .meta{font-size:12px;color:#374151;background:#F9FAFB;border-radius:6px;padding:8px 10px;margin-bottom:12px;}
    .item .meta b{color:#00632B;}
    .imgs{display:flex;gap:12px;}
    .imgs figure{flex:1;margin:0;text-align:center;}
    .imgs img{width:100%;height:190px;object-fit:cover;border-radius:8px;border:1px solid #E2E5EA;display:block;}
    .imgs .semfoto{width:100%;height:190px;border-radius:8px;border:1px dashed #C7CDD6;display:flex;align-items:center;justify-content:center;color:#9AA4B2;font-size:12px;}
    .imgs figure:first-child figcaption{color:#00632B;}
    .imgs figure:last-child figcaption{color:#ED6D22;}
    .imgs figcaption{font-size:11px;font-weight:700;letter-spacing:.5px;margin-top:5px;}
    .obs{font-size:11.5px;color:#6B7280;margin-top:10px;font-style:italic;}
    .assinaturas{display:flex;gap:40px;margin-top:40px;page-break-inside:avoid;}
    .assinatura{flex:1;text-align:center;}
    .linha{border-top:1px solid #1E2430;margin-bottom:6px;padding-top:6px;}
    .assinatura .cargo{font-size:11px;color:#6B7280;}
    @media print { body{padding:0;} .item{page-break-inside:avoid;} }
  </style></head><body>

  <div class="letterhead">
    <div class="brand">
      <img src="/img/logo.jpg" alt="Logo">
      <div>
        <div class="empresa">${cfg.empresa || '[Nome da Construtora]'}</div>
        <h1>Relatório Fotográfico Mensal — Limpeza Urbana</h1>
        <div class="cnpj">${cfg.cnpj || ''}</div>
      </div>
    </div>
    <div class="pagerinfo">Documento anexo à Medição Mensal</div>
  </div>

  <div class="identificacao">
    <div><b>Mês de Referência</b> <span>${label}</span></div>
    <div><b>Contrato / Nº Processo</b> <span>${cfg.contrato || '(não informado)'}</span></div>
    <div><b>Cidade(s)</b> <span>${cidades}</span></div>
    <div><b>Período de Execução</b> <span>${periodo}</span></div>
  </div>
  `;

  entries.forEach(e=>{
    html += `<div class="item">
      <h2>${enderecoCompleto(e)}</h2>
      <div class="local">${e.cidade}</div>
      <div class="meta">
        <b>Serviço:</b> ${e.servico} &nbsp;·&nbsp; <b>Data:</b> ${e.data.split('-').reverse().join('/')} &nbsp;·&nbsp; <b>Equipe:</b> ${e.equipe||'-'}<br>
        <b>Medição:</b> ${formatMedida(e) || '-'}
      </div>
      <div class="imgs">
        <figure>
          ${e.fotoAntes?`<img src="${e.fotoAntes}">`:'<div class="semfoto">Sem foto</div>'}
          <figcaption>ANTES</figcaption>
        </figure>
        <figure>
          ${e.fotoDepois?`<img src="${e.fotoDepois}">`:'<div class="semfoto">Sem foto</div>'}
          <figcaption>DEPOIS</figcaption>
        </figure>
      </div>
      ${e.obs?`<div class="obs">Observações: ${e.obs}</div>`:''}
    </div>`;
  });

  html += `
  <div class="assinaturas">
    <div class="assinatura">
      <div class="linha">&nbsp;</div>
      <div class="cargo">Responsável Técnico — ${cfg.empresa || '[Nome da Construtora]'}</div>
    </div>
    <div class="assinatura">
      <div class="linha">&nbsp;</div>
      <div class="cargo">Fiscalização — Prefeitura Municipal</div>
    </div>
  </div>
  <script>window.onload=()=>{setTimeout(()=>window.print(),400);}<\/script></body></html>`;
  win.document.write(html);
  win.document.close();
 } catch(err){
  alert('Não consegui gerar o relatório fotográfico. Erro: ' + (err && err.message ? err.message : err));
 }
}
