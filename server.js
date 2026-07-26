// ============================================================
// RJ Saúde — CHAMADA ONLINE (P-37)
// Painel de chamada de senhas que roda pela INTERNET.
// Node.js puro, SEM dependências. Roda em qualquer host (nuvem/VPS/plataforma).
// Totem, TV (painel) e Recepção conectam pela internet — NÃO dependem da rede local.
// Atualização em tempo real via SSE (Server-Sent Events).
//
// Rodar:  node server.js        (porta 8080, ou variável de ambiente PORT)
// ============================================================

const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

const CONFIG = {
  clinica: { nome: 'RJ Saúde', subtitulo: 'MEDICINA OCUPACIONAL' },
  servicos: [
    { id: 'comum',        nome: 'Comum',                    sub: 'Senha normal',  prefixo: 'C', pref: false },
    { id: 'prioritaria',  nome: 'Prioritária',              sub: 'Idosos, gestantes, PcD, crianças de colo', prefixo: 'P', pref: true },
    { id: 'laboratorio',  nome: 'Laboratório / Toxicológico', sub: 'Senha normal', prefixo: 'L', pref: false }
  ],
  guiches: ['Guichê 1', 'Guichê 2']
};

// ---- estado em memória ----
const state = {
  data: null,       // dia de referência da numeração (zera quando vira o dia)
  contadores: {},   // prefixo -> último número emitido
  aguardando: [],   // {senha, nome, ts}
  atual: null,      // {senha, guiche, nome, ts}
  historico: []     // [{senha, guiche, nome, ts}]
};

function hoje() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

// Zera a numeração automaticamente quando o dia vira (mesmo com o servidor rodando 24h).
function verificarDia() {
  const h = hoje();
  if (state.data !== h) {
    state.contadores = {};
    state.aguardando = [];
    state.atual = null;
    state.historico = [];
    state.data = h;
  }
}

function snapshot() {
  verificarDia();
  return { atual: state.atual, historico: state.historico.slice(0, 8), aguardando: state.aguardando };
}

// ---- SSE ----
const clients = new Set();
function broadcast(tipo, dados) {
  const msg = 'data: ' + JSON.stringify({ tipo: tipo, dados: dados, estado: snapshot() }) + '\n\n';
  for (const res of clients) { try { res.write(msg); } catch (e) {} }
}

// ---- helpers ----
function body(req) {
  return new Promise(function (resolve) {
    let b = '';
    req.on('data', function (c) { b += c; });
    req.on('end', function () { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}
function json(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function html(res, str) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(str);
}

const server = http.createServer(async function (req, res) {
  const u = url.parse(req.url, true);
  const path = u.pathname;

  // ===== API =====
  if (path === '/api/senha' && req.method === 'POST') {
    const b = await body(req);
    verificarDia();
    const serv = CONFIG.servicos.find(function (s) { return s.id === b.servico; }) || CONFIG.servicos[0];
    state.contadores[serv.prefixo] = (state.contadores[serv.prefixo] || 0) + 1;
    const num = String(state.contadores[serv.prefixo]).padStart(3, '0');
    const senha = serv.prefixo + '-' + num;
    const ticket = { senha: senha, nome: (b.nome || '').trim(), ts: Date.now() };
    state.aguardando.push(ticket);
    broadcast('nova-senha', ticket);
    return json(res, { ok: true, senha: senha });
  }

  if (path === '/api/chamar' && req.method === 'POST') {
    const b = await body(req);
    verificarDia();
    let ticket;
    if (b.senha) {
      const i = state.aguardando.findIndex(function (t) { return t.senha === b.senha; });
      ticket = (i >= 0) ? state.aguardando.splice(i, 1)[0] : { senha: b.senha, nome: b.nome || '', ts: Date.now() };
    } else {
      if (state.aguardando.length === 0) return json(res, { ok: false, erro: 'fila vazia' });
      let i = state.aguardando.findIndex(function (t) { return t.senha.charAt(0) === 'P'; }); // preferencial primeiro
      if (i < 0) i = 0;
      ticket = state.aguardando.splice(i, 1)[0];
    }
    const guiche = b.guiche || CONFIG.guiches[0];
    if (state.atual) state.historico.unshift(state.atual);
    state.historico = state.historico.slice(0, 20);
    state.atual = { senha: ticket.senha, guiche: guiche, nome: ticket.nome || '', ts: Date.now() };
    broadcast('chamada', state.atual);
    return json(res, { ok: true, atual: state.atual });
  }

  if (path === '/api/state') return json(res, snapshot());

  if (path === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: ' + JSON.stringify({ tipo: 'init', estado: snapshot() }) + '\n\n');
    clients.add(res);
    const ping = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', function () { clearInterval(ping); clients.delete(res); });
    return;
  }

  // ===== PÁGINAS =====
  if (path === '/')         { res.writeHead(302, { Location: '/painel' }); return res.end(); }
  if (path === '/totem')    return html(res, PAGE_TOTEM);
  if (path === '/painel')   return html(res, PAGE_PAINEL);
  if (path === '/recepcao') return html(res, PAGE_RECEPCAO);

  res.writeHead(404); res.end('404');
});

server.listen(PORT, function () { console.log('RJ Saude - Chamada Online rodando na porta ' + PORT); });

// ============================================================
//  PÁGINAS (HTML+JS embutidos, sem arquivos externos)
// ============================================================

const CSS_BASE =
'*{box-sizing:border-box;margin:0;padding:0;font-family:Segoe UI,Arial,sans-serif}' +
':root{--v1:#0E5C3F;--v2:#1F8A5B;--ouro:#C9A24B}';

const PAGE_PAINEL =
'<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Painel de Chamada — RJ Saúde</title><style>' + CSS_BASE +
'body{background:linear-gradient(160deg,#0b3b2a,#0E5C3F 60%,#0b3b2a);color:#fff;height:100vh;overflow:hidden}' +
'.top{display:flex;justify-content:space-between;align-items:center;padding:22px 40px;border-bottom:2px solid rgba(201,162,75,.4)}' +
'.logo b{font-size:34px}.logo span{display:block;color:var(--ouro);letter-spacing:3px;font-size:13px}' +
'.clock{font-size:40px;font-weight:700;color:var(--ouro)}' +
'.wrap{display:flex;height:calc(100vh - 90px)}' +
'.main{flex:2;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}' +
'.lbl{color:var(--ouro);letter-spacing:8px;font-size:26px;margin-bottom:4px}' +
'.senha{font-size:20vh;font-weight:800;line-height:.9}' +
'.guiche{font-size:6vh;font-weight:700;margin-top:8px}.nome{font-size:3.6vh;opacity:.92;margin-top:6px}' +
'.side{flex:1;border-left:2px solid rgba(201,162,75,.3);padding:22px;overflow:hidden}' +
'.side h2{color:var(--ouro);font-size:19px;letter-spacing:2px;margin-bottom:14px}' +
'.item{display:flex;justify-content:space-between;background:rgba(255,255,255,.06);border-radius:12px;padding:11px 16px;margin-bottom:9px;font-size:25px}' +
'.item b{color:var(--ouro)}' +
'#ov{position:fixed;inset:0;background:rgba(4,30,20,.97);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9;text-align:center;padding:20px}' +
'#ov button{font-size:30px;padding:20px 44px;border:0;border-radius:16px;background:var(--v2);color:#fff;font-weight:700;cursor:pointer;margin-top:24px}' +
'.flash{animation:fl .8s ease}@keyframes fl{0%{transform:scale(.85);opacity:.4}100%{transform:scale(1);opacity:1}}' +
'</style></head><body>' +
'<div class="top"><div class="logo"><b>RJ Saúde</b><span>MEDICINA OCUPACIONAL</span></div><div class="clock" id="clock">--:--</div></div>' +
'<div class="wrap"><div class="main"><div class="lbl">SENHA</div><div class="senha" id="senha">—</div><div class="guiche" id="guiche"></div><div class="nome" id="nome"></div></div>' +
'<div class="side"><h2>ÚLTIMAS CHAMADAS</h2><div id="hist"></div></div></div>' +
'<div id="ov"><div style="font-size:26px">Painel de Chamada · Sala de Espera</div>' +
'<button id="btn">🔊 Ativar som das chamadas</button>' +
'<div style="margin-top:16px;opacity:.7;font-size:15px">Toque uma vez para a TV falar os nomes em voz alta</div></div>' +
'<script>' +
'var somOn=false;' +
'document.getElementById("btn").onclick=function(){somOn=true;document.getElementById("ov").style.display="none";try{var u=new SpeechSynthesisUtterance("Som ativado");u.lang="pt-BR";speechSynthesis.speak(u);}catch(e){}};' +
'function tick(){var d=new Date();document.getElementById("clock").textContent=("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2);}setInterval(tick,1000);tick();' +
'function falar(a){if(!somOn)return;try{speechSynthesis.cancel();var alvo=a.nome?a.nome:("senha "+a.senha.replace("-"," "));var txt=alvo+", favor dirigir-se ao "+a.guiche;var u=new SpeechSynthesisUtterance(txt);u.lang="pt-BR";u.rate=.95;speechSynthesis.speak(u);}catch(e){}}' +
'function render(st){if(st.atual){var s=document.getElementById("senha");s.textContent=st.atual.senha;s.classList.remove("flash");void s.offsetWidth;s.classList.add("flash");document.getElementById("guiche").textContent=st.atual.guiche;document.getElementById("nome").textContent=st.atual.nome||"";}' +
'var h="";(st.historico||[]).forEach(function(x){h+="<div class=\\"item\\"><b>"+x.senha+"</b><span>"+x.guiche+"</span></div>";});document.getElementById("hist").innerHTML=h;}' +
'var es=new EventSource("/api/stream");es.onmessage=function(e){var m=JSON.parse(e.data);if(m.estado)render(m.estado);if(m.tipo==="chamada"&&m.dados)falar(m.dados);};' +
'fetch("/api/state").then(function(r){return r.json();}).then(render);' +
'</script></body></html>';

const PAGE_TOTEM =
'<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Totem — RJ Saúde</title><style>' + CSS_BASE +
'body{background:linear-gradient(160deg,#0b3b2a,#0E5C3F 60%,#0b3b2a);color:#fff;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}' +
'.logo{text-align:center;margin-bottom:8px}.logo b{font-size:40px}.logo span{display:block;color:var(--ouro);letter-spacing:4px;font-size:15px}' +
'h1{font-weight:400;opacity:.9;margin:22px 0 30px;font-size:26px}' +
'.btns{display:flex;flex-direction:column;gap:22px;width:min(560px,92vw)}' +
'.b{border:0;border-radius:22px;padding:34px;font-size:30px;font-weight:800;color:#fff;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.3)}' +
'.b small{display:block;font-weight:400;font-size:17px;opacity:.85;margin-top:6px}' +
'.c{background:var(--v2)}.p{background:var(--ouro);color:#3a2e08}' +
'#tela{position:fixed;inset:0;background:rgba(4,30,20,.98);display:none;flex-direction:column;align-items:center;justify-content:center;z-index:9}' +
'#tela .l{color:var(--ouro);letter-spacing:6px;font-size:26px}#res{font-size:26vh;font-weight:800;line-height:1}' +
'#tela .m{font-size:24px;opacity:.85;margin-top:14px}' +
'#ticket{display:none}' +
'@media print{body *{visibility:hidden}#ticket,#ticket *{visibility:visible}#ticket{display:block;position:fixed;left:0;top:0;width:100%;color:#000;text-align:center}#ticket .c{font-size:20px;font-weight:700;margin-top:6px}#ticket .s{font-size:16px}#ticket .n{font-size:64px;font-weight:800;margin:8px 0}#ticket .h{font-size:13px}}' +
'</style></head><body>' +
'<div class="logo"><b>RJ Saúde</b><span>MEDICINA OCUPACIONAL</span></div>' +
'<h1>Toque para retirar sua senha</h1>' +
'<div class="btns">' +
'<button class="b c" onclick="nova(\'comum\')">Comum<small>Senha normal</small></button>' +
'<button class="b p" onclick="nova(\'prioritaria\')">Prioritária<small>Idosos, gestantes, PcD, crianças de colo</small></button>' +
'<button class="b c" onclick="nova(\'laboratorio\')">Laboratório / Toxicológico<small>Senha normal</small></button>' +
'</div>' +
'<div id="tela"><div class="l">SUA SENHA</div><div id="res">—</div><div class="m">Aguarde ser chamado no painel</div></div>' +
'<div id="ticket"><div class="c">RJ SAÚDE · Medicina Ocupacional</div><div class="s" id="tkServ"></div><div class="n" id="tkSenha"></div><div class="h" id="tkData"></div><div class="h">Aguarde ser chamado no painel</div></div>' +
'<script>' +
'var SERV={comum:"Comum",prioritaria:"Prioritária",laboratorio:"Laboratório / Toxicológico"};' +
'function nova(s){fetch("/api/senha",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({servico:s})}).then(function(r){return r.json();}).then(function(d){if(d.ok)mostrar(d.senha,s);});}' +
'function mostrar(s,serv){document.getElementById("res").textContent=s;var t=document.getElementById("tela");t.style.display="flex";' +
'var d=new Date();document.getElementById("tkServ").textContent=SERV[serv]||"";document.getElementById("tkSenha").textContent=s;document.getElementById("tkData").textContent=d.toLocaleDateString("pt-BR")+" "+("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2);' +
'try{window.print();}catch(e){}' +
'setTimeout(function(){t.style.display="none";},7000);}' +
'</script></body></html>';

const PAGE_RECEPCAO =
'<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Recepção — Chamar Senhas</title><style>' + CSS_BASE +
'body{background:#0d1f18;color:#eaf3ee;min-height:100vh;padding:20px}' +
'.hd{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid rgba(201,162,75,.4);padding-bottom:14px;margin-bottom:18px}' +
'.hd b{font-size:24px}.hd span{color:var(--ouro);letter-spacing:2px;font-size:12px;display:block}' +
'.atual{background:linear-gradient(120deg,#0E5C3F,#1F8A5B);border-radius:16px;padding:18px 22px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center}' +
'.atual .s{font-size:44px;font-weight:800}.atual .g{font-size:22px;color:#fff}' +
'.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:16px}' +
'.gsel{display:flex;gap:8px}.gbtn{padding:12px 20px;border-radius:12px;border:2px solid var(--v2);background:transparent;color:#eaf3ee;cursor:pointer;font-size:16px;font-weight:600}' +
'.gbtn.on{background:var(--v2);color:#fff}' +
'.prox{margin-left:auto;padding:14px 26px;border:0;border-radius:12px;background:var(--ouro);color:#3a2e08;font-weight:800;font-size:17px;cursor:pointer}' +
'h2{color:var(--ouro);font-size:16px;letter-spacing:1px;margin:10px 0}' +
'.list{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}' +
'.card{background:#12281f;border:1px solid #1f4433;border-radius:12px;padding:14px;display:flex;justify-content:space-between;align-items:center}' +
'.card .s{font-size:26px;font-weight:800}.card.pref{border-color:var(--ouro)}' +
'.card button{border:0;border-radius:10px;background:var(--v2);color:#fff;padding:9px 14px;font-weight:700;cursor:pointer}' +
'.vazio{opacity:.6;padding:20px}' +
'</style></head><body>' +
'<div class="hd"><div><b>Recepção — Chamar Senhas</b><span>RJ SAÚDE · MEDICINA OCUPACIONAL</span></div><div id="clock" style="color:var(--ouro);font-size:22px;font-weight:700"></div></div>' +
'<div class="atual"><div><div style="font-size:12px;letter-spacing:2px;color:#d8ecdf">CHAMANDO AGORA</div><div class="s" id="aSenha">—</div></div><div class="g" id="aGuiche"></div></div>' +
'<div class="row"><span>Guichê:</span><div class="gsel" id="gsel"></div><button class="prox" onclick="proxima()">▶ Chamar próxima</button></div>' +
'<h2>SENHAS AGUARDANDO</h2><div class="list" id="list"></div>' +
'<script>' +
'var guiche="Guichê 1";var GUICHES=' + JSON.stringify(CONFIG.guiches) + ';' +
'function tick(){var d=new Date();document.getElementById("clock").textContent=("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2);}setInterval(tick,1000);tick();' +
'function montaG(){var h="";GUICHES.forEach(function(g,i){h+="<button class=\\"gbtn"+(i===0?" on":"")+"\\" data-g=\\""+g+"\\" onclick=\\"selG(this)\\">"+g+"</button>";});document.getElementById("gsel").innerHTML=h;}' +
'function selG(el){guiche=el.getAttribute("data-g");document.querySelectorAll(".gbtn").forEach(function(b){b.classList.remove("on");});el.classList.add("on");}' +
'function chamar(s){fetch("/api/chamar",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({senha:s,guiche:guiche})});}' +
'function proxima(){fetch("/api/chamar",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({guiche:guiche})});}' +
'function render(st){if(st.atual){document.getElementById("aSenha").textContent=st.atual.senha;document.getElementById("aGuiche").textContent=st.atual.guiche;}' +
'var ag=st.aguardando||[];var h="";if(!ag.length){h="<div class=\\"vazio\\">Nenhuma senha aguardando.</div>";}' +
'ag.forEach(function(x){var pref=x.senha.charAt(0)==="P";h+="<div class=\\"card"+(pref?" pref":"")+"\\"><div class=\\"s\\">"+x.senha+"</div><button onclick=\\"chamar(\'"+x.senha+"\')\\">Chamar</button></div>";});' +
'document.getElementById("list").innerHTML=h;}' +
'montaG();' +
'var es=new EventSource("/api/stream");es.onmessage=function(e){var m=JSON.parse(e.data);if(m.estado)render(m.estado);};' +
'fetch("/api/state").then(function(r){return r.json();}).then(render);' +
'</script></body></html>';
