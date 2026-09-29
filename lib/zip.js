// Gerador de arquivo ZIP mínimo — sem dependências externas (só Node puro),
// seguindo a mesma ideia do resto do projeto.
//
// Os arquivos entram no ZIP "armazenados" (sem compressão): fotos JPEG/PNG
// já são comprimidas, então tentar comprimir de novo só gastaria processador
// sem diminuir quase nada o tamanho.
//
// Uso:
//   await escreverZip(res, [{ nome: "Pasta/arquivo.jpg", caminho: "/data/uploads/x.jpg" }, ...])
// Os arquivos são lidos do disco um de cada vez e enviados aos poucos pro
// navegador, então o servidor não precisa carregar todas as fotos na memória
// ao mesmo tempo e continua atendendo outras pessoas enquanto monta o ZIP.
"use strict";
const fs = require("fs");

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Data/hora no formato do MS-DOS, que é o que o ZIP usa.
function dataDos(d) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const data = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, data };
}

function escrever(res, buf) {
  return new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error("conexao_fechada"));
    const coube = res.write(buf);
    if (coube) return resolve();
    const aoDrenar = () => { res.off("close", aoFechar); resolve(); };
    const aoFechar = () => { res.off("drain", aoDrenar); reject(new Error("conexao_fechada")); };
    res.once("drain", aoDrenar);
    res.once("close", aoFechar);
  });
}

async function escreverZip(res, arquivos) {
  const central = [];
  let offset = 0;
  const agora = dataDos(new Date());

  for (const arq of arquivos) {
    let dados;
    try {
      dados = await fs.promises.readFile(arq.caminho);
    } catch (e) {
      continue; // arquivo sumiu do disco — pula, não quebra o ZIP inteiro
    }
    const nome = Buffer.from(arq.nome, "utf8");
    const crc = crc32(dados);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versão necessária
    local.writeUInt16LE(0x0800, 6); // nomes em UTF-8 (acentos funcionam)
    local.writeUInt16LE(0, 8); // sem compressão
    local.writeUInt16LE(agora.hora, 10);
    local.writeUInt16LE(agora.data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dados.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);

    await escrever(res, local);
    await escrever(res, nome);
    await escrever(res, dados);

    central.push({ nome, crc, tamanho: dados.length, offset });
    offset += local.length + nome.length + dados.length;
  }

  const inicioCentral = offset;
  let tamanhoCentral = 0;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4); // versão que criou
    h.writeUInt16LE(20, 6); // versão necessária
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(agora.hora, 12);
    h.writeUInt16LE(agora.data, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.tamanho, 20);
    h.writeUInt32LE(c.tamanho, 24);
    h.writeUInt16LE(c.nome.length, 28);
    h.writeUInt16LE(0, 30); // extra
    h.writeUInt16LE(0, 32); // comentário
    h.writeUInt16LE(0, 34); // disco
    h.writeUInt16LE(0, 36); // atributos internos
    h.writeUInt32LE(0, 38); // atributos externos
    h.writeUInt32LE(c.offset, 42);
    await escrever(res, h);
    await escrever(res, c.nome);
    tamanhoCentral += h.length + c.nome.length;
  }

  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(0, 4);
  fim.writeUInt16LE(0, 6);
  fim.writeUInt16LE(central.length, 8);
  fim.writeUInt16LE(central.length, 10);
  fim.writeUInt32LE(tamanhoCentral, 12);
  fim.writeUInt32LE(inicioCentral, 16);
  fim.writeUInt16LE(0, 20);
  await escrever(res, fim);
  res.end();
  return central.length;
}

module.exports = { escreverZip };
