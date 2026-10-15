// 给 patchright-core 打一个空值保护补丁（postinstall 自动跑，npm i 之后不会被冲掉）。
//
// 崩溃现场（2026-10-13 20:33 北京，那一轮以 code 1 结束，bplhkx@outlook.com 跑到一半被记成 error）：
//   UNCAUGHT-EXCEPTION Cannot read properties of undefined (reading 'CN')
//     at captureSecurityDetails (node_modules/patchright-core/lib/coreBundle.js:27104)
//     at ClientRequest.<anonymous> (:27115)
// 原因：它挂在 request 的 "socket" 事件上，TLS 握手还没完成时 getPeerCertificate() 返回空对象，
// 代码直接读 peerCertificate.subject.CN 就抛。这是 EventEmitter 的同步回调，业务侧 try/catch
// 拦不到，只能被进程级 uncaughtException 接走，于是整轮跑废。
//
// 修法：拿不到证书就整个跳过。securityDetails 本来就是可选字段——非 TLS 连接时它一直是
// undefined，下游（HAR / Response.securityDetails）都按可选处理，所以跳过是安全的。
//
// 锚点选的是文件里唯一的单行，不整块匹配，版本小改动不容易失配。找不到锚点时：
//   - 危险写法还在 → 退出码 1，让 npm i 直接失败（宁可装不上也不要静默没打上）
//   - 危险写法已经没了（上游修了）→ 提示后正常退出

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "/* patched: skip security details when the peer certificate is missing */";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(HERE, "..", "node_modules", "patchright-core", "lib", "coreBundle.js");
const ANCHOR = "const peerCertificate = socket.getPeerCertificate();";
const VULNERABLE = "subjectName: peerCertificate.subject.CN,";

const fail = (msg) => {
  console.error(`[patch-deps] ${msg}`);
  process.exit(1);
};

if (!fs.existsSync(BUNDLE)) {
  console.log("[patch-deps] 没有 patchright-core，跳过");
  process.exit(0);
}

const src = fs.readFileSync(BUNDLE, "utf8");
if (src.includes(MARKER)) {
  console.log("[patch-deps] patchright-core 已经打过补丁");
  process.exit(0);
}

if (!src.includes(VULNERABLE)) {
  console.log("[patch-deps] 这版 patchright-core 里没有那处危险写法，可能上游已修，跳过");
  process.exit(0);
}

const hits = src.split(ANCHOR).length - 1;
if (hits !== 1) fail(`锚点出现 ${hits} 次（要求恰好 1 次），不敢自动改，请人工核对 ${BUNDLE}`);

const guard = `${ANCHOR}\n            ${MARKER}\n            if (!peerCertificate || !peerCertificate.subject || !peerCertificate.issuer)\n              return;`;
const out = src.replace(ANCHOR, guard);
if (out === src) fail("替换没有生效");

fs.writeFileSync(BUNDLE, out);

const back = fs.readFileSync(BUNDLE, "utf8");
if (!back.includes(MARKER)) fail("写入后校验失败：文件里没有补丁标记");
if (back.split(VULNERABLE).length - 1 !== 1) fail("写入后校验失败：危险行数不对");

const ver = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(path.dirname(BUNDLE), "..", "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
})();
console.log(`[patch-deps] patchright-core@${ver} 已加上证书缺失保护`);
