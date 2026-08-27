// Autenticação por usuário/senha, sem nenhuma biblioteca externa:
// - senha: crypto.scrypt (nativo do Node) com salt aleatório por usuário
// - sessão: token aleatório opaco guardado em cookie httpOnly, conferido
//   contra a lista de sessões salva no banco (sobrevive a reinícios)
"use strict";
const crypto = require("crypto");
const { state, persist } = require("./db");

const SESSAO_DIAS = 30;

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(senha, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verificarSenha(senha, armazenada) {
  const [salt, hash] = String(armazenada || "").split(":");
  if (!salt || !hash) return false;
  const tentativa = crypto.scryptSync(senha, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(tentativa, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function criarSessao(userId) {
  limparSessoesExpiradas();
  const token = crypto.randomBytes(32).toString("hex");
  const expiraEm = Date.now() + SESSAO_DIAS * 24 * 60 * 60 * 1000;
  state.sessions.push({ token, userId, expiraEm });
  persist();
  return { token, expiraEm };
}

function destruirSessao(token) {
  state.sessions = state.sessions.filter((s) => s.token !== token);
  persist();
}

function limparSessoesExpiradas() {
  const agora = Date.now();
  const antes = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.expiraEm > agora);
  if (state.sessions.length !== antes) persist();
}

function usuarioDaSessao(token) {
  if (!token) return null;
  const sess = state.sessions.find((s) => s.token === token && s.expiraEm > Date.now());
  if (!sess) return null;
  const user = state.users.find((u) => u.id === sess.userId);
  return user || null;
}

// Só o administrador tem acesso total (todas as cidades, aba Cidades,
// editar metas/identificação). Um encarregado é vinculado a uma única
// cidade (cidadeId) e só enxerga os dados daquela cidade.
function cidadeDoUsuario(u) {
  if (!u || !u.cidadeId) return null;
  const c = state.cidades.find((x) => x.id === u.cidadeId);
  return c ? c.nome : null;
}

// Nome do responsável/encarregado fixo cadastrado para a cidade do usuário
// (aba Cidades — campo preenchido pelo administrador). Serve só para sugerir
// automaticamente o campo "Equipe / Encarregado" em "+ Registro"; por isso
// vai no /api/me mesmo para quem não tem acesso à aba Cidades.
function responsavelDoUsuario(u) {
  if (!u || !u.cidadeId) return null;
  const c = state.cidades.find((x) => x.id === u.cidadeId);
  return c && c.responsavel ? c.responsavel : null;
}

function usuarioPublico(u) {
  if (!u) return null;
  return {
    id: u.id,
    nome: u.nome,
    usuario: u.usuario,
    role: u.role,
    cidadeId: u.role === "admin" ? null : u.cidadeId || null,
    cidadeNome: u.role === "admin" ? null : cidadeDoUsuario(u),
    cidadeResponsavel: u.role === "admin" ? null : responsavelDoUsuario(u),
  };
}

module.exports = {
  hashSenha,
  verificarSenha,
  criarSessao,
  destruirSessao,
  usuarioDaSessao,
  usuarioPublico,
  cidadeDoUsuario,
  responsavelDoUsuario,
};
