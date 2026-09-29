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

// A gravação do banco é feita em SEGUNDO PLANO (assíncrona), não mais
// travando o processo inteiro enquanto salva. Antes, `persist()` usava
// escrita síncrona (fs.writeFileSync) — com poucos registros isso é
// instantâneo, mas o banco é um arquivo JSON só, e conforme ele cresce
// (principalmente com fotos, que viram texto bem grande), gravar o arquivo
// inteiro do zero a cada ação (login, salvar registro, editar preço, etc.)
// passa a demorar de verdade — e como o servidor é de uma "thread" só,
// enquanto ele grava, TODO MUNDO fica travado (é por isso que o app "trava
// todo" às vezes: alguém salvou algo com o banco grande, e todo o resto
// ficou esperando aquela gravação terminar). Gravando em segundo plano,
// os pedidos de outras pessoas continuam sendo atendidos normalmente
// enquanto o arquivo é salvo.
//
// Não basta só tornar a ESCRITA EM DISCO assíncrona: montar o texto JSON
// inteiro de uma vez (JSON.stringify do banco todo) também é um trabalho
// síncrono, e com um banco bem grande (muitas fotos) isso sozinho já pode
// travar o processo por mais de um segundo. Por isso `montarJSONemPedacos`
// monta o texto aos poucos — registro por registro dentro de cada lista — e
// vai "dando uma pausa" (via setImmediate) entre os pedaços, pra deixar o
// servidor responder outros pedidos no meio do caminho, em vez de fazer
// tudo de uma vez só.
//
// Se `persist()` for chamado de novo enquanto uma gravação anterior ainda
// está em andamento, não empilha uma gravação pra cada chamada — só marca
// que precisa gravar de novo assim que a atual terminar, e aí grava a
// versão mais recente do estado (evita gravações desnecessárias em série).
let gravando = false;
let gravacaoPendente = false;

function cederEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Escreve um pedaço de texto direto no arquivo (stream), em vez de ir
// acumulando tudo numa string gigante na memória pra só no final escrever de
// uma vez — isso evita ter que converter um texto de centenas de MB pra
// Buffer numa tacada só (essa conversão sozinha também é síncrona e pode
// travar o processo por um tempo perceptível). Respeita o "contrapressão"
// do stream (drain) quando o disco não consegue acompanhar.
function escreverPedaco(ws, texto) {
  return new Promise((resolve, reject) => {
    const coube = ws.write(texto, (err) => {
      if (err) reject(err);
    });
    if (coube) {
      setImmediate(resolve);
    } else {
      ws.once("drain", resolve);
    }
  });
}

async function escreverJSONEmStream(ws, obj) {
  await escreverPedaco(ws, "{");
  const chaves = Object.keys(obj);
  for (let ci = 0; ci < chaves.length; ci++) {
    const chave = chaves[ci];
    const valor = obj[chave];
    await escreverPedaco(ws, JSON.stringify(chave) + ":");
    if (Array.isArray(valor) && valor.length > 0) {
      // Importante: o que trava o processo não é a QUANTIDADE de itens, é o
      // TAMANHO de cada um (um único registro com foto pode ter vários MB).
      // Por isso cede o event loop depois de CADA item da lista, não a cada
      // vários — assim nenhum item grande sozinho consegue travar tudo.
      await escreverPedaco(ws, "[");
      for (let i = 0; i < valor.length; i++) {
        if (i > 0) await escreverPedaco(ws, ",");
        await escreverPedaco(ws, JSON.stringify(valor[i]));
      }
      await escreverPedaco(ws, "]");
    } else {
      await escreverPedaco(ws, JSON.stringify(valor));
    }
    if (ci < chaves.length - 1) await escreverPedaco(ws, ",");
  }
  await escreverPedaco(ws, "}");
}

async function persist() {
  if (gravando) {
    gravacaoPendente = true;
    return;
  }
  gravando = true;
  try {
    const tmp = DB_FILE + ".tmp";
    const ws = fs.createWriteStream(tmp);
    await new Promise((resolve, reject) => {
      ws.on("error", reject);
      escreverJSONEmStream(ws, state)
        .then(() => ws.end())
        .catch(reject);
      ws.on("finish", resolve);
    });
    await fs.promises.rename(tmp, DB_FILE);
  } catch (e) {
    console.error("Falha ao salvar o banco de dados:", e.message);
  } finally {
    gravando = false;
    if (gravacaoPendente) {
      gravacaoPendente = false;
      persist();
    }
  }
}

// Grava de forma síncrona (bloqueante) — só usada no desligamento do
// processo (ver server.js), pra garantir que a última alteração não se
// perca se o processo for encerrado logo após uma gravação assíncrona
// ainda estar em andamento.
function persistSync() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

module.exports = { state, persist, persistSync, DATA_DIR, UPLOADS_DIR };
