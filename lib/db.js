// "Banco de dados" simples em arquivo JSON — sem dependências externas.
// Para o tamanho de uma empresa pequena/média isso é rápido e confiável,
// e evita depender de módulos nativos (como better-sqlite3) que às vezes
// falham para compilar em algumas hospedagens.
"use strict";
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DEFAULT_DB = {
  users: [],
  entries: [],
  cidades: [],
  ruas: [],
  // Serviços cadastrados (nome + unidade de medida). Pré-populado com os
  // serviços que já existiam fixos no código, pra quem já usa o sistema
  // não perder nada na atualização.
  servicos: [
    { id: "svc-capina", nome: "Capina Manual", unidade: "m²", criadoEm: null },
    { id: "svc-rocada", nome: "Roçada Mecanizada", unidade: "m²", criadoEm: null },
    { id: "svc-varricao", nome: "Varrição", unidade: "m²", criadoEm: null },
    { id: "svc-equipe", nome: "Equipe Padrão", unidade: "R$", criadoEm: null },
    { id: "svc-sarjeta", nome: "Limpeza de Sarjeta", unidade: "m²", criadoEm: null },
    { id: "svc-caiacao", nome: "Caiação de Meio-fio", unidade: "m²", criadoEm: null },
  ],
  metas: {},
  config: { empresa: "", cnpj: "", contrato: "" },
  sessions: [],
};

let state;
try {
  if (fs.existsSync(DB_FILE)) {
    state = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } else {
    state = JSON.parse(JSON.stringify(DEFAULT_DB));
  }
} catch (e) {
  console.error("Falha ao ler o banco de dados, iniciando vazio:", e.message);
  state = JSON.parse(JSON.stringify(DEFAULT_DB));
}
// Garante que todas as chaves existam (upgrade de versões antigas do arquivo)
for (const k of Object.keys(DEFAULT_DB)) {
  if (!(k in state)) state[k] = JSON.parse(JSON.stringify(DEFAULT_DB[k]));
}

function persist() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

module.exports = { state, persist, DATA_DIR, UPLOADS_DIR };
