// Utilitários mínimos de HTTP — sem dependências externas (só módulos
// nativos do Node). Assim o deploy não depende de "npm install" baixar
// nada da internet: funciona com o Node puro em qualquer hospedagem.
"use strict";
const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".webp": "image/webp",
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let total = 0;
    const max = limitBytes || 20 * 1024 * 1024; // 20MB (fotos em base64)
    req.on("data", (c) => {
      total += c.length;
      if (total > max) {
        reject(Object.assign(new Error("payload_too_large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJSON(req) {
  const buf = await readBody(req);
  if (!buf || buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    const err = new Error("json_invalido");
    err.status = 400;
    throw err;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setCookie(res, name, value, opts) {
  opts = opts || {};
  let str = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (opts.maxAgeSeconds) str += `; Max-Age=${opts.maxAgeSeconds}`;
  if (opts.secure) str += "; Secure";
  const prev = res.getHeader("Set-Cookie");
  const arr = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  arr.push(str);
  res.setHeader("Set-Cookie", arr);
}

function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
}

// Serve um arquivo estático de dentro de `rootDir`, prevenindo path traversal.
// `opts.cacheLongo` marca a resposta pra ficar guardada no navegador por
// bastante tempo — só deve ser usado pra arquivos cujo NOME nunca se repete
// pro mesmo conteúdo (como as fotos em /uploads/, que ganham um nome novo e
// aleatório a cada envio — ver salvarFotoBase64 em server.js). Assim, quando
// a mesma foto aparece de novo (na lista de registros, num relatório, ao
// reabrir um registro), o navegador não baixa ela de novo — usa a cópia que
// já tem guardada, o que ajuda bastante numa internet mais lenta (celular).
// Nunca usar isso pros arquivos do app (app.js, index.html), que mudam a
// cada atualização mas mantêm o mesmo nome.
function serveStatic(req, res, rootDir, urlPath, opts) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const full = path.normalize(path.join(rootDir, rel));
  if (!full.startsWith(path.normalize(rootDir))) {
    res.writeHead(403);
    res.end("Proibido");
    return true;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
  const ext = path.extname(full).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const headers = { "Content-Type": type };
  if (opts && opts.cacheLongo) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
  return true;
}

module.exports = { sendJSON, readBody, readJSON, parseCookies, setCookie, clearCookie, serveStatic, MIME };
