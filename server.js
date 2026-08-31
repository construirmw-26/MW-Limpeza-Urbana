// Coleta de Campo — servidor (sem dependências externas, só Node puro).
// Guarda os dados em /data (arquivo JSON + fotos), autentica usuários por
// usuário/senha com cookie de sessão, e serve o app (public/) + a API.
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { state, persist, UPLOADS_DIR } = require("./lib/db");
const {
  sendJSON,
  readJSON,
  parseCookies,
  setCookie,
  clearCookie,
  serveStatic,
} = require("./lib/http-helpers");
const {
  hashSenha,
  verificarSenha,
  criarSessao,
  destruirSessao,
  usuarioDaSessao,
  usuarioPublico,
  cidadeDoUsuario,
} = require("./lib/auth");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const COOKIE_NAME = "cc_session";

// ---- Cria o primeiro usuário administrador se ainda não existir nenhum ----
function bootstrapAdmin() {
  if (state.users.length > 0) return;
  const usuario = process.env.ADMIN_USER || "admin";
  const senha = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString("hex");
  const nome = process.env.ADMIN_NOME || "Administrador";
  state.users.push({
    id: crypto.randomUUID(),
    nome,
    usuario,
    senha: hashSenha(senha),
    role: "admin",
    criadoEm: new Date().toISOString(),
  });
  persist();
  console.log("========================================================");
  console.log("Nenhum usuário existia — criei o administrador inicial:");
  console.log("  usuário:", usuario);
  if (!process.env.ADMIN_PASSWORD) {
    console.log("  senha  :", senha, "(gerada automaticamente — troque depois de logar)");
  } else {
    console.log("  senha  : (definida pela variável de ambiente ADMIN_PASSWORD)");
  }
  console.log("========================================================");
}
bootstrapAdmin();

// ---- Converte cidades salvas no formato antigo (texto simples) para o
// formato novo (objeto com contrato/responsável/telefone/documentos), e
// garante que cidades já no formato novo tenham a lista de documentos ----
function bootstrapCidades() {
  let mudou = false;
  state.cidades = state.cidades.map((c) => {
    if (typeof c === "string") {
      mudou = true;
      return { id: crypto.randomUUID(), nome: c, contrato: "", responsavel: "", telefone: "", documentos: [] };
    }
    if (!Array.isArray(c.documentos)) {
      mudou = true;
      c.documentos = [];
    }
    return c;
  });
  if (mudou) persist();
}
bootstrapCidades();

// ---- Migra metas antigas (um valor global por serviço) para o novo
// formato (um conjunto de metas por cidade — já que cada cidade agora
// pode ter uma meta diferente para o mesmo serviço). Só roda uma vez: se
// o formato já é o novo (valores são objetos, não números), não mexe. ----
function bootstrapMetas() {
  const chaves = Object.keys(state.metas || {});
  const formatoAntigo = chaves.some((k) => typeof state.metas[k] === "number");
  if (!formatoAntigo) return;
  const antigas = state.metas;
  state.metas = {};
  for (const c of state.cidades) {
    state.metas[c.nome] = { ...antigas };
  }
  persist();
}
bootstrapMetas();

// ---------------------------- Helpers de rota ------------------------------
function getAuthUser(req) {
  const cookies = parseCookies(req);
  return usuarioDaSessao(cookies[COOKIE_NAME]);
}

function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    sendJSON(res, 401, { erro: "Não autenticado" });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJSON(res, 403, { erro: "Somente administradores" });
    return null;
  }
  return user;
}

// Salva uma foto em base64 (data URL) em /data/uploads e devolve a URL pública.
function salvarFotoBase64(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const buf = Buffer.from(match[2], "base64");
  const nome = crypto.randomBytes(16).toString("hex") + "." + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, nome), buf);
  return "/uploads/" + nome;
}

// Igual à de cima, mas também aceita PDF (para contratos/aditivos anexados).
function salvarArquivoBase64(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const match = dataUrl.match(/^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const extPorMime = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/webp": "webp",
    "image/jpeg": "jpg",
  };
  const ext = extPorMime[mime];
  if (!ext) return null; // tipo de arquivo não suportado
  const buf = Buffer.from(match[2], "base64");
  const nome = crypto.randomBytes(16).toString("hex") + "." + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, nome), buf);
  return "/uploads/" + nome;
}

function removerFotoSeForUpload(url) {
  if (!url || typeof url !== "string" || !url.startsWith("/uploads/")) return;
  const full = path.join(UPLOADS_DIR, path.basename(url));
  fs.unlink(full, () => {});
}

// ------------------------------- Servidor -----------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const urlPath = req.url.split("?")[0];
    const method = req.method;

    // ---- Arquivos enviados (fotos) ----
    if (method === "GET" && urlPath.startsWith("/uploads/")) {
      if (serveStatic(req, res, UPLOADS_DIR, urlPath.replace("/uploads", ""))) return;
      res.writeHead(404);
      res.end("Não encontrado");
      return;
    }

    // ---------------------------- API ----------------------------
    if (urlPath.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");

      // ---- Login / Logout / Quem sou eu ----
      if (method === "POST" && urlPath === "/api/login") {
        const body = await readJSON(req);
        const usuario = String(body.usuario || "").trim();
        const senha = String(body.senha || "");
        const user = state.users.find((u) => u.usuario.toLowerCase() === usuario.toLowerCase());
        if (!user || !verificarSenha(senha, user.senha)) {
          return sendJSON(res, 401, { erro: "Usuário ou senha inválidos" });
        }
        const { token, expiraEm } = criarSessao(user.id);
        setCookie(res, COOKIE_NAME, token, {
          maxAgeSeconds: Math.round((expiraEm - Date.now()) / 1000),
          secure: process.env.NODE_ENV === "production",
        });
        return sendJSON(res, 200, usuarioPublico(user));
      }

      if (method === "POST" && urlPath === "/api/logout") {
        const cookies = parseCookies(req);
        if (cookies[COOKIE_NAME]) destruirSessao(cookies[COOKIE_NAME]);
        clearCookie(res, COOKIE_NAME);
        return sendJSON(res, 200, { ok: true });
      }

      if (method === "GET" && urlPath === "/api/me") {
        const user = getAuthUser(req);
        if (!user) return sendJSON(res, 401, { erro: "Não autenticado" });
        return sendJSON(res, 200, usuarioPublico(user));
      }

      // A partir daqui, todas as rotas exigem login.
      const user = requireAuth(req, res);
      if (!user) return;

      // ---- Usuários (só admin) ----
      if (urlPath === "/api/users") {
        if (method === "GET") {
          if (!requireAdmin(req, res)) return;
          return sendJSON(res, 200, state.users.map(usuarioPublico));
        }
        if (method === "POST") {
          if (!requireAdmin(req, res)) return;
          const body = await readJSON(req);
          const nome = String(body.nome || "").trim();
          const usuario = String(body.usuario || "").trim();
          const senha = String(body.senha || "");
          const role = body.role === "admin" ? "admin" : "encarregado";
          const cidadeId = role === "encarregado" && body.cidadeId ? String(body.cidadeId) : null;
          if (!nome || !usuario || senha.length < 4) {
            return sendJSON(res, 400, { erro: "Preencha nome, usuário e uma senha com pelo menos 4 caracteres." });
          }
          if (state.users.some((u) => u.usuario.toLowerCase() === usuario.toLowerCase())) {
            return sendJSON(res, 409, { erro: "Já existe um usuário com esse nome de login." });
          }
          if (cidadeId && !state.cidades.some((c) => c.id === cidadeId)) {
            return sendJSON(res, 400, { erro: "Cidade selecionada não existe." });
          }
          const novo = {
            id: crypto.randomUUID(),
            nome,
            usuario,
            senha: hashSenha(senha),
            role,
            cidadeId,
            criadoEm: new Date().toISOString(),
          };
          state.users.push(novo);
          persist();
          return sendJSON(res, 201, usuarioPublico(novo));
        }
      }

      const userIdMatch = urlPath.match(/^\/api\/users\/([^/]+)$/);
      if (userIdMatch && method === "PUT") {
        if (!requireAdmin(req, res)) return;
        const id = decodeURIComponent(userIdMatch[1]);
        const alvo = state.users.find((u) => u.id === id);
        if (!alvo) return sendJSON(res, 404, { erro: "Usuário não encontrado." });
        const body = await readJSON(req);
        if (body.cidadeId !== undefined) {
          const cidadeId = body.cidadeId ? String(body.cidadeId) : null;
          if (cidadeId && !state.cidades.some((c) => c.id === cidadeId)) {
            return sendJSON(res, 400, { erro: "Cidade selecionada não existe." });
          }
          alvo.cidadeId = cidadeId;
        }
        persist();
        return sendJSON(res, 200, usuarioPublico(alvo));
      }
      if (userIdMatch && method === "DELETE") {
        if (!requireAdmin(req, res)) return;
        const id = decodeURIComponent(userIdMatch[1]);
        if (id === user.id) return sendJSON(res, 400, { erro: "Você não pode remover seu próprio usuário." });
        const alvo = state.users.find((u) => u.id === id);
        if (!alvo) return sendJSON(res, 404, { erro: "Usuário não encontrado." });
        const outrosAdmins = state.users.some((u) => u.role === "admin" && u.id !== id);
        if (alvo.role === "admin" && !outrosAdmins) {
          return sendJSON(res, 400, { erro: "Precisa existir pelo menos um administrador." });
        }
        state.users = state.users.filter((u) => u.id !== id);
        state.sessions = state.sessions.filter((s) => s.userId !== id);
        persist();
        return sendJSON(res, 200, { ok: true });
      }

      // ---- Config (identificação da empresa) ----
      if (urlPath === "/api/config") {
        if (method === "GET") return sendJSON(res, 200, state.config);
        if (method === "PUT") {
          if (!requireAdmin(req, res)) return;
          const body = await readJSON(req);
          state.config = {
            empresa: String(body.empresa || "").trim(),
            cnpj: String(body.cnpj || "").trim(),
            contrato: String(body.contrato || "").trim(),
          };
          persist();
          return sendJSON(res, 200, state.config);
        }
      }

      // ---- Cidades (só admin: lista completa, contratos e documentos) ----
      // Um encarregado não enxerga a lista de cidades nem os contratos —
      // ele só sabe o nome da própria cidade, devolvido em /api/me.
      if (urlPath === "/api/cidades" || urlPath.startsWith("/api/cidades/")) {
        if (!requireAdmin(req, res)) return;
      }

      // Cada cidade é um objeto {id, nome, contrato, responsavel, telefone}.
      // O nome não muda depois de criado, para não desalinhar com os
      // registros já lançados (que guardam a cidade como texto).
      if (urlPath === "/api/cidades") {
        if (method === "GET") return sendJSON(res, 200, state.cidades);
        if (method === "POST") {
          const body = await readJSON(req);
          const nome = String(body.nome || "").trim();
          if (!nome) return sendJSON(res, 400, { erro: "Informe o nome da cidade." });
          if (state.cidades.some((c) => c.nome.toLowerCase() === nome.toLowerCase())) {
            return sendJSON(res, 409, { erro: "Essa cidade já está cadastrada." });
          }
          const nova = {
            id: crypto.randomUUID(),
            nome,
            contrato: String(body.contrato || "").trim(),
            responsavel: String(body.responsavel || "").trim(),
            telefone: String(body.telefone || "").trim(),
            documentos: [],
          };
          state.cidades.push(nova);
          state.cidades.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
          persist();
          return sendJSON(res, 201, state.cidades);
        }
      }

      // ---- Documentos da cidade (Contrato / Aditivo de contrato) ----
      const cidadeDocsMatch = urlPath.match(/^\/api\/cidades\/([^/]+)\/documentos$/);
      if (cidadeDocsMatch && method === "POST") {
        const cidadeId = decodeURIComponent(cidadeDocsMatch[1]);
        const alvo = state.cidades.find((c) => c.id === cidadeId);
        if (!alvo) return sendJSON(res, 404, { erro: "Cidade não encontrada." });
        const body = await readJSON(req);
        const tipo = body.tipo === "aditivo" ? "aditivo" : "contrato";
        const titulo = String(body.titulo || "").trim();
        const url = salvarArquivoBase64(body.arquivo);
        if (!url) return sendJSON(res, 400, { erro: "Anexe um arquivo em PDF, JPG, PNG ou WEBP." });
        const doc = {
          id: crypto.randomUUID(),
          tipo,
          titulo,
          nomeArquivo: String(body.nomeArquivo || "").trim(),
          url,
          criadoPor: user.nome,
          criadoEm: new Date().toISOString(),
        };
        if (!Array.isArray(alvo.documentos)) alvo.documentos = [];
        alvo.documentos.push(doc);
        persist();
        return sendJSON(res, 201, state.cidades);
      }
      const cidadeDocMatch = urlPath.match(/^\/api\/cidades\/([^/]+)\/documentos\/([^/]+)$/);
      if (cidadeDocMatch && method === "DELETE") {
        const cidadeId = decodeURIComponent(cidadeDocMatch[1]);
        const docId = decodeURIComponent(cidadeDocMatch[2]);
        const alvo = state.cidades.find((c) => c.id === cidadeId);
        if (!alvo) return sendJSON(res, 404, { erro: "Cidade não encontrada." });
        const doc = (alvo.documentos || []).find((d) => d.id === docId);
        if (doc) removerFotoSeForUpload(doc.url);
        alvo.documentos = (alvo.documentos || []).filter((d) => d.id !== docId);
        persist();
        return sendJSON(res, 200, state.cidades);
      }

      const cidadeMatch = urlPath.match(/^\/api\/cidades\/([^/]+)$/);
      if (cidadeMatch && method === "PUT") {
        const id = decodeURIComponent(cidadeMatch[1]);
        const alvo = state.cidades.find((c) => c.id === id);
        if (!alvo) return sendJSON(res, 404, { erro: "Cidade não encontrada." });
        const body = await readJSON(req);
        if (body.contrato !== undefined) alvo.contrato = String(body.contrato || "").trim();
        if (body.responsavel !== undefined) alvo.responsavel = String(body.responsavel || "").trim();
        if (body.telefone !== undefined) alvo.telefone = String(body.telefone || "").trim();
        persist();
        return sendJSON(res, 200, state.cidades);
      }
      if (cidadeMatch && method === "DELETE") {
        const id = decodeURIComponent(cidadeMatch[1]);
        const alvo = state.cidades.find((c) => c.id === id);
        if (alvo) (alvo.documentos || []).forEach((d) => removerFotoSeForUpload(d.url));
        state.cidades = state.cidades.filter((c) => c.id !== id);
        state.ruas = state.ruas.filter((r) => r.cidadeId !== id); // remove também as ruas dessa cidade
        if (alvo) delete state.metas[alvo.nome]; // remove também as metas dessa cidade
        persist();
        return sendJSON(res, 200, state.cidades);
      }

      // ---- Ruas ----
      // Só o administrador cadastra ruas (nome, número, bairro, vinculadas
      // a uma cidade). O encarregado só ENXERGA e ESCOLHE, na cidade dele —
      // não digita rua livremente, para manter a lista padronizada.
      if (urlPath === "/api/ruas") {
        if (method === "GET") {
          if (user.role === "admin") {
            const url = new URL(req.url, "http://x");
            const filtroCidadeId = url.searchParams.get("cidadeId");
            const lista = filtroCidadeId ? state.ruas.filter((r) => r.cidadeId === filtroCidadeId) : state.ruas;
            return sendJSON(res, 200, lista);
          }
          const minhaCidadeId = user.cidadeId || null;
          return sendJSON(res, 200, minhaCidadeId ? state.ruas.filter((r) => r.cidadeId === minhaCidadeId) : []);
        }
        if (method === "POST") {
          if (!requireAdmin(req, res)) return;
          const body = await readJSON(req);
          const cidadeId = String(body.cidadeId || "");
          const nome = String(body.nome || "").trim();
          if (!cidadeId || !state.cidades.some((c) => c.id === cidadeId)) {
            return sendJSON(res, 400, { erro: "Selecione uma cidade válida." });
          }
          if (!nome) return sendJSON(res, 400, { erro: "Informe o nome da rua." });
          const nova = {
            id: crypto.randomUUID(),
            cidadeId,
            nome,
            numero: String(body.numero || "").trim(),
            bairro: String(body.bairro || "").trim(),
            criadoEm: new Date().toISOString(),
          };
          state.ruas.push(nova);
          persist();
          return sendJSON(res, 201, state.ruas.filter((r) => r.cidadeId === cidadeId));
        }
      }
      const ruaMatch = urlPath.match(/^\/api\/ruas\/([^/]+)$/);
      if (ruaMatch && method === "PUT") {
        if (!requireAdmin(req, res)) return;
        const id = decodeURIComponent(ruaMatch[1]);
        const alvo = state.ruas.find((r) => r.id === id);
        if (!alvo) return sendJSON(res, 404, { erro: "Rua não encontrada." });
        const body = await readJSON(req);
        if (body.nome !== undefined) alvo.nome = String(body.nome || "").trim();
        if (body.numero !== undefined) alvo.numero = String(body.numero || "").trim();
        if (body.bairro !== undefined) alvo.bairro = String(body.bairro || "").trim();
        persist();
        return sendJSON(res, 200, state.ruas.filter((r) => r.cidadeId === alvo.cidadeId));
      }
      if (ruaMatch && method === "DELETE") {
        if (!requireAdmin(req, res)) return;
        const id = decodeURIComponent(ruaMatch[1]);
        const alvo = state.ruas.find((r) => r.id === id);
        const cidadeId = alvo ? alvo.cidadeId : null;
        state.ruas = state.ruas.filter((r) => r.id !== id);
        persist();
        return sendJSON(res, 200, cidadeId ? state.ruas.filter((r) => r.cidadeId === cidadeId) : []);
      }

      // ---- Serviços ----
      // Qualquer um logado pode VER a lista (precisa pra escolher o serviço
      // em "+ Registro" e ver as metas); só o administrador cadastra, edita
      // a unidade ou remove. O nome não muda depois de criado, pra não
      // desalinhar dos registros e metas já lançados (que guardam o serviço
      // pelo nome, não por id).
      if (urlPath === "/api/servicos") {
        if (method === "GET") return sendJSON(res, 200, state.servicos);
        if (method === "POST") {
          if (!requireAdmin(req, res)) return;
          const body = await readJSON(req);
          const nome = String(body.nome || "").trim();
          const unidade = String(body.unidade || "").trim();
          if (!nome) return sendJSON(res, 400, { erro: "Informe o nome do serviço." });
          if (!unidade) return sendJSON(res, 400, { erro: "Informe a unidade de medida." });
          if (state.servicos.some((s) => s.nome.toLowerCase() === nome.toLowerCase())) {
            return sendJSON(res, 409, { erro: "Esse serviço já está cadastrado." });
          }
          const novo = { id: crypto.randomUUID(), nome, unidade, criadoEm: new Date().toISOString() };
          state.servicos.push(novo);
          persist();
          return sendJSON(res, 201, state.servicos);
        }
      }
      const servicoMatch = urlPath.match(/^\/api\/servicos\/([^/]+)$/);
      if (servicoMatch && method === "PUT") {
        if (!requireAdmin(req, res)) return;
        const id = decodeURIComponent(servicoMatch[1]);
        const alvo = state.servicos.find((s) => s.id === id);
        if (!alvo) return sendJSON(res, 404, { erro: "Serviço não encontrado." });
        const body = await readJSON(req);
        if (body.unidade !== undefined) {
          const unidade = String(body.unidade || "").trim();
          if (!unidade) return sendJSON(res, 400, { erro: "Informe a unidade de medida." });
          alvo.unidade = unidade;
        }
        persist();
        return sendJSON(res, 200, state.servicos);
      }
      if (servicoMatch && method === "DELETE") {
        if (!requireAdmin(req, res)) return;
        const id = decodeURIComponent(servicoMatch[1]);
        const alvo = state.servicos.find((s) => s.id === id);
        state.servicos = state.servicos.filter((s) => s.id !== id);
        if (alvo) {
          // remove a meta desse serviço em todas as cidades
          for (const cidadeNome of Object.keys(state.metas)) {
            if (state.metas[cidadeNome]) delete state.metas[cidadeNome][alvo.nome];
          }
        }
        persist();
        return sendJSON(res, 200, state.servicos);
      }

      // ---- Metas ----
      // Cada cidade tem seu próprio conjunto de metas por serviço (uma
      // cidade pode ter uma meta bem diferente da outra). Qualquer um
      // logado pode VER o progresso da cidade dele; só o administrador
      // define o valor da meta, e pode escolher qualquer cidade. Um
      // encarregado só enxerga a própria cidade, mesmo que tente pedir
      // outra pela API.
      if (urlPath === "/api/metas") {
        if (method === "GET") {
          const url = new URL(req.url, "http://x");
          let cidade = url.searchParams.get("cidade") || "";
          if (user.role !== "admin") {
            cidade = cidadeDoUsuario(user) || "";
          }
          if (!cidade) return sendJSON(res, 200, {});
          return sendJSON(res, 200, state.metas[cidade] || {});
        }
        if (method === "PUT") {
          if (!requireAdmin(req, res)) return;
          const body = await readJSON(req);
          const cidade = String(body.cidade || "").trim();
          const servico = String(body.servico || "");
          const valor = parseFloat(body.valor);
          if (!cidade) return sendJSON(res, 400, { erro: "Selecione uma cidade." });
          if (!servico) return sendJSON(res, 400, { erro: "Serviço não informado." });
          if (!state.metas[cidade]) state.metas[cidade] = {};
          if (valor > 0) state.metas[cidade][servico] = valor;
          else delete state.metas[cidade][servico];
          persist();
          return sendJSON(res, 200, state.metas[cidade]);
        }
      }

      // ---- Registros (entries) ----
      // O administrador vê e mexe em tudo. Um encarregado só vê, cria e
      // apaga registros da cidade que foi atribuída a ele — mesmo que
      // tente forçar outra cidade pela API, o servidor ignora e usa a
      // cidade cadastrada no perfil dele.
      const minhaCidade = user.role === "admin" ? null : cidadeDoUsuario(user);
      if (urlPath === "/api/entries") {
        if (method === "GET") {
          const lista = user.role === "admin" ? state.entries : state.entries.filter((e) => e.cidade === minhaCidade);
          return sendJSON(res, 200, lista);
        }
        if (method === "POST") {
          const body = await readJSON(req);
          let cidade = String(body.cidade || "").trim();
          let cidadeId = null;
          if (user.role !== "admin") {
            if (!minhaCidade) {
              return sendJSON(res, 403, { erro: "Você ainda não tem uma cidade atribuída. Fale com o administrador." });
            }
            cidade = minhaCidade;
            cidadeId = user.cidadeId || null;
          } else {
            const cidadeObj = state.cidades.find((c) => c.nome === cidade);
            cidadeId = cidadeObj ? cidadeObj.id : null;
          }
          // A rua tem que ser uma das já cadastradas (pelo administrador) para
          // essa cidade — o campo é sempre um ruaId, nunca texto livre, para
          // manter a lista padronizada e evitar nomes divergentes.
          const ruaId = String(body.ruaId || "").trim();
          const ruaObj = ruaId ? state.ruas.find((r) => r.id === ruaId && r.cidadeId === cidadeId) : null;
          // O serviço também tem que ser um dos já cadastrados (aba Serviços)
          // — guardamos a unidade de medida junto no registro (denormalizada),
          // pra manter o histórico correto mesmo se o serviço mudar depois.
          const servico = String(body.servico || "").trim();
          const servicoObj = servico ? state.servicos.find((s) => s.nome === servico) : null;
          const data = String(body.data || "").trim();
          if (!cidade || !ruaObj || !servicoObj || !data) {
            return sendJSON(res, 400, { erro: "Preencha ao menos Cidade, Rua, Serviço e Data. Verifique se a rua e o serviço estão cadastrados." });
          }
          const entry = {
            id: crypto.randomUUID(),
            cidade,
            ruaId: ruaObj.id,
            rua: ruaObj.nome,
            numero: ruaObj.numero || "",
            bairro: ruaObj.bairro || "",
            extensao: body.extensao || "",
            largura: body.largura || "",
            lados: body.lados || "",
            valor: body.valor || "",
            servico,
            unidade: servicoObj.unidade,
            equipe: String(body.equipe || "").trim(),
            data,
            obs: String(body.obs || "").trim(),
            fotoAntes: salvarFotoBase64(body.fotoAntes),
            fotoDepois: salvarFotoBase64(body.fotoDepois),
            criadoPor: user.nome,
            criadoEm: new Date().toISOString(),
          };
          state.entries.push(entry);
          persist();
          return sendJSON(res, 201, entry);
        }
      }
      const entryMatch = urlPath.match(/^\/api\/entries\/([^/]+)$/);
      if (entryMatch && method === "DELETE") {
        const id = decodeURIComponent(entryMatch[1]);
        const alvo = state.entries.find((e) => e.id === id);
        if (alvo && user.role !== "admin" && alvo.cidade !== minhaCidade) {
          return sendJSON(res, 403, { erro: "Você só pode excluir registros da sua cidade." });
        }
        if (alvo) {
          removerFotoSeForUpload(alvo.fotoAntes);
          removerFotoSeForUpload(alvo.fotoDepois);
        }
        state.entries = state.entries.filter((e) => e.id !== id);
        persist();
        return sendJSON(res, 200, { ok: true });
      }

      return sendJSON(res, 404, { erro: "Rota não encontrada." });
    }

    // ------------------------ Arquivos estáticos (app) ------------------------
    if (method === "GET" || method === "HEAD") {
      if (serveStatic(req, res, PUBLIC_DIR, urlPath)) return;
      // qualquer outra rota cai no index.html (app de página única)
      if (serveStatic(req, res, PUBLIC_DIR, "/index.html")) return;
    }

    res.writeHead(404);
    res.end("Não encontrado");
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    console.error(err);
    sendJSON(res, status, { erro: err.message || "Erro interno" });
  }
});

server.listen(PORT, () => {
  console.log(`Coleta de Campo rodando em http://localhost:${PORT}`);
});
