// SPDX-License-Identifier: Apache-2.0
//
// prism-router-node-auth.uc —— 节点 / 站点认证的**参考实现**（共享库）
//
// ✅ 打包说明（必读）：
//   打包方已把本文件安装到 /usr/share/prism-router/prism-router-node-auth.uc
//   （prism-router/Makefile 与 tools/build-ipk.sh）。不过 ingest.uc / push.uc /
//   ingest-stations.uc / stations.uc / feishu.uc 仍各自内嵌一份等价实现：
//     * 这些脚本由 CGI/cron 直接执行，不依赖额外文件也能工作；
//     * 也避免升级时出现「脚本新、库旧」的半套状态。
//   以后若要改成 import，请一次性替换全部内嵌副本。**改动任何一处都要同步全部副本。**
//   安全目录（auth_secure_dir / auth_safe_tmp_parent）与 openssl 摘要回退解析
//   （auth_digest_hex）也按同一规则内嵌同步；测试里有一条静态同步断言防漂移。
//
// 本文件只依赖 ucode 内建 fs，不需要 ucode-mod-crypto：
//   * SHA-256 借 busybox 的 sha256sum（OpenWrt 必带；缺失时退回 openssl dgst）；
//   * HMAC-SHA256 按 RFC 2104 在 ucode 内存里拼 ipad/opad，再把**数据**从 stdin
//     喂给 sha256sum。密钥只存在于本进程内存，**绝不进 argv / 环境变量 / 磁盘**。
//   * Base64 在 ucode 内实现（OpenWrt 基础镜像没有独立的 base64 命令）。
//
// 为什么不用 `openssl dgst -hmac`：
//   目标容器 OpenSSL 3.0.22 实测 `-hmac <key>` 与 `-macopt key:<key>` 都只接受
//   argv 里的字面量（`key:/path` 也被当作字面量），没有“从文件/fd 读 HMAC key”
//   的选项；把 key 放进环境变量又会出现在 /proc/<pid>/environ。故改为纯 ucode
//   HMAC + sha256sum stdin。
//
// 协议（与 ingest.uc / push.uc 完全一致）：
//   v2 签名原文： "v2\n" + node_id + "\n" + ts + "\n" + nonce + "\n" + sha256_hex(body)
//   v1 旧签名  ： node_id + "\n" + ts + "\n" + sha256_hex(body)          （仅 legacy）
//   X-Sign / Authorization: base64(HMAC-SHA256(secret, 签名原文))
//
// UCI 注册（注意：UCI 的 section 名只允许 [A-Za-z0-9_]，所以 node_id 带 '-' 时
// **不能**写成 `config node 'node-a'`，必须用匿名 section + option node_id）：
//
//   config node
//       option node_id 'node-a'
//       option secret  '...'
//
//   兼容写法（node_id 只含字母数字下划线时）：
//   config node 'node_a'
//       option secret '...'
//
//   config station
//       option node_id 'ap-1'
//       option token   '...'
//
// 查找时一律用 UCI 的类型化遍历（cursor.foreach(config, 'node', cb)），并校验
//   s['.type'] == 'node' / 'station'，绝不用匿名 section 的下标去猜。

import { readfile, open, popen, access, unlink, chmod, chown, lstat, mkdir } from 'fs';

// ───────────────────────────── 小工具 ─────────────────────────────

export const auth_text = function(value, fallback) {
	return (value == null) ? fallback : `${value}`;
};

export const auth_shq = function(s) {
	return `'${replace(`${s}`, "'", "'\\''")}'`;
};

export const auth_pid = function() {
	const m = match(trim(auth_text(readfile('/proc/self/stat'), '')), /^([0-9]+)/);

	return m ? int(m[1]) : int(time());
};

// 常量时间比较：长度不同直接失败。签名/token 比较一律走这里。
export const auth_same = function(a, b) {
	if (length(a) != length(b))
		return false;

	let diff = 0;

	for (let i = 0; i < length(a); i++)
		diff |= ord(substr(a, i, 1)) ^ ord(substr(b, i, 1));

	return diff == 0;
};

// ───────────────────────────── 随机 nonce ─────────────────────────────

/* 16 字节随机数的 hex（非机密，只要不可预测/不重复）。 */
export const auth_nonce = function() {
	let raw = '';

	try {
		const fd = open('/dev/urandom', 'r');

		if (fd != null) {
			raw = fd.read(16) ?? '';
			fd.close();
		}
	}
	catch (e) {
		raw = '';
	}

	if (length(raw) < 16) {
		try {
			raw = replace(trim(auth_text(readfile('/proc/sys/kernel/random/uuid'), '')), '-', '');
		}
		catch (e) {
			raw = '';
		}
	}

	if (length(raw) < 16)
		raw = sprintf('%08x%08x%08x%08x', time(), auth_pid(), int(time() * 1000), 0);

	let hex = '';

	for (let i = 0; i < length(raw) && length(hex) < 32; i++)
		hex += sprintf('%02x', ord(substr(raw, i, 1)));

	return hex;
};

// nonce 只允许 hex / 字母数字下划线连字符，长度 16..64，防止当成路径穿越。
export const auth_valid_nonce = function(nonce) {
	return match(nonce, /^[A-Za-z0-9_-]{16,64}$/) != null;
};

// ───────────────────────────── SHA-256 / HMAC ─────────────────────────────

const AUTH_ROOT = '/tmp/prism-router';
const AUTH_TMP = `${AUTH_ROOT}/.auth`;

let _auth_seq = 0;

/* 安全目录（与各脚本内嵌副本保持同一实现）：
   * lstat 不跟随符号链接，只接受真实目录且 root:root；
   * 已存在但不是安全目录时**直接失败**，绝不先 chmod/chown 再信任；
   * 新建后重新 lstat 校验，父目录由调用方先行校验。 */
export const auth_lstat_dir = function(path) {
	let st = null;

	try { st = lstat(path); } catch (e) { return null; }

	if (st == null || st.type != 'directory' || st.uid != 0 || st.gid != 0)
		return null;

	return st;
};

export const auth_secure_dir = function(path, mode) {
	let st = auth_lstat_dir(path);

	if (st == null) {
		let raw = null;

		try { raw = lstat(path); } catch (e) { raw = null; }

		/* 已存在但不是真实 root 目录（符号链接/普通文件/他人所有）→ 失败关闭。 */
		if (raw != null)
			return false;

		try { mkdir(path, mode); } catch (e) { }

		st = auth_lstat_dir(path);
		if (st == null)
			return false;
	}

	try { chmod(path, mode); } catch (e) { return false; }
	try { chown(path, 0, 0); } catch (e) { return false; }

	return auth_lstat_dir(path) != null;
};

/* /tmp 必须是 root 的 sticky 真实目录；否则不创建任何认证临时目录。 */
export const auth_safe_tmp_parent = function() {
	let st = null;

	try { st = lstat('/tmp'); } catch (e) { return false; }

	return st != null && st.type == 'directory' && st.uid == 0
		&& st.perm != null && st.perm.sticky == true;
};

/* /tmp/prism-router 先安全创建/校验，再建 0700 的 .auth。 */
export const auth_ensure_tmp = function() {
	if (!auth_safe_tmp_parent())
		return false;

	if (!auth_secure_dir(AUTH_ROOT, 493))		/* 0755 */
		return false;

	return auth_secure_dir(AUTH_TMP, 448);		/* 0700 */
};

/* sha256sum 的原始输出必须是行首 64 hex（主路径保持不变）；
   openssl dgst -sha256 的回退输出是 `SHA2-256(stdin)= <64hex>`，只额外接受
   这种以 64 hex 结尾的格式。 */
export const auth_digest_hex = function(raw) {
	const text = trim(auth_text(raw, ''));
	let m = match(text, /^([0-9a-fA-F]{64})/);

	if (m != null)
		return lc(m[1]);

	m = match(text, /(SHA2-256|SHA256)\(stdin\)= *([0-9a-fA-F]{64}) *$/);
	if (m != null)
		return lc(m[2]);

	m = match(text, /\(stdin\)= *([0-9a-fA-F]{64}) *$/);

	return (m != null) ? lc(m[1]) : '';
};

const auth_hash_cmd = function() {
	for (let path in [ '/usr/bin/sha256sum', '/bin/sha256sum' ])
		if (access(path))
			return path;

	for (let path in [ '/usr/bin/openssl', '/usr/sbin/openssl', '/bin/openssl' ])
		if (access(path))
			return sprintf('%s dgst -sha256', path);

	return 'sha256sum';
};

/* sha256_hex(data)：stdin 喂数据，stdout 重定向到 0600 私有文件。
   数据里可能含 HMAC 的 ipad/opad（由 key 派生），所以既不进 argv 也不留在磁盘上：
   临时文件只保存最终 hash 的十六进制文本。 */
export const auth_sha256_hex = function(data) {
	if (!auth_ensure_tmp())
		return '';

	const out = sprintf('%s/h-%d-%d-%s', AUTH_TMP, auth_pid(), _auth_seq++, auth_nonce());
	let fd = null;

	try {
		/* 'wx'：目标已存在（含被预先放置的符号链接/文件）就失败，绝不跟随写入。 */
		fd = open(out, 'wx', 384);         /* 384 = 0o600 */
		if (fd == null)
			return '';

		fd.close();
	}
	catch (e) {
		try { if (fd != null) fd.close(); } catch (e2) { }
		try { unlink(out); } catch (e2) { }
		return '';
	}

	let p = null;

	try {
		p = popen(sprintf('%s > %s', auth_hash_cmd(), auth_shq(out)), 'w');
	}
	catch (e) {
		p = null;
	}

	if (p == null) {
		try { unlink(out); } catch (e) { }
		return '';
	}

	let off = 0;

	try {
		while (off < length(data)) {
			const n = p.write(substr(`${data}`, off));

			if (n == null || n <= 0)
				break;

			off += n;
		}
	}
	catch (e) {
		/* 关闭管道后按实际输出判定 */
	}

	const rc = p.close();
	let raw = '';

	try { raw = auth_text(readfile(out), ''); } catch (e) { raw = ''; }
	try { unlink(out); } catch (e) { }

	if (rc != 0)
		return '';

	return auth_digest_hex(raw);
};

const auth_hex_bin = function(hex) {
	let out = '';

	for (let i = 0; i + 1 < length(hex); i += 2)
		out += chr(int(substr(hex, i, 2), 16));

	return out;
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const auth_b64 = function(bin) {
	let out = '';

	for (let i = 0; i < length(bin); i += 3) {
		const b0 = ord(substr(bin, i, 1));
		const has1 = (i + 1 < length(bin));
		const has2 = (i + 2 < length(bin));
		const b1 = has1 ? ord(substr(bin, i + 1, 1)) : 0;
		const b2 = has2 ? ord(substr(bin, i + 2, 1)) : 0;

		out += substr(B64, (b0 >> 2) & 63, 1);
		out += substr(B64, ((b0 & 3) << 4) | ((b1 >> 4) & 15), 1);
		out += has1 ? substr(B64, ((b1 & 15) << 2) | ((b2 >> 6) & 3), 1) : '=';
		out += has2 ? substr(B64, b2 & 63, 1) : '=';
	}

	return out;
};

/* HMAC-SHA256(secret, message) -> base64；失败返回 ''。key 永不进 argv。 */
export const auth_hmac_b64 = function(secret, message) {
	const msg = `${message}`;
	let key = `${secret}`;

	if (length(key) > 64) {
		const kh = auth_sha256_hex(key);

		if (length(kh) == 0)
			return '';

		key = auth_hex_bin(kh);
	}

	let ipad = '', opad = '';

	for (let i = 0; i < 64; i++) {
		const b = (i < length(key)) ? ord(substr(key, i, 1)) : 0;

		ipad += chr(b ^ 0x36);
		opad += chr(b ^ 0x5c);
	}

	const inner_hex = auth_sha256_hex(ipad + msg);

	if (length(inner_hex) == 0)
		return '';

	const outer_hex = auth_sha256_hex(opad + auth_hex_bin(inner_hex));

	if (length(outer_hex) == 0)
		return '';

	return auth_b64(auth_hex_bin(outer_hex));
};

// ───────────────────────────── 签名原文 ─────────────────────────────

export const auth_message_v2 = function(node_id, ts, nonce, body_digest) {
	return sprintf('v2\n%s\n%s\n%s\n%s', node_id, ts, nonce, body_digest);
};

export const auth_message_v1 = function(node_id, ts, body_digest) {
	return sprintf('%s\n%s\n%s', node_id, ts, body_digest);
};

// ───────────────────────────── UCI 注册表查找 ─────────────────────────────

const auth_section_id = function(s) {
	let id = trim(auth_text(s.node_id, ''));

	if (length(id) == 0 && s['.anonymous'] != true)
		id = trim(auth_text(s['.name'], ''));

	return id;
};

/* 按 node_id 找 secret；找不到返回 ''。只认 .type == 'node' 的 section。 */
export const auth_node_secret = function(cursor_handle, node_id) {
	let found = '';

	if (cursor_handle == null)
		return '';

	cursor_handle.foreach('prism-router', 'node', function(s) {
		if (length(found) || type(s) != 'object' || s['.type'] != 'node')
			return;

		if (auth_section_id(s) != node_id)
			return;

		const secret = trim(auth_text(s.secret, ''));

		if (length(secret))
			found = secret;
	});

	return found;
};

/* 按 node_id 找 station token；找不到返回 ''。只认 .type == 'station'。 */
export const auth_station_token = function(cursor_handle, node_id) {
	let found = '';

	if (cursor_handle == null)
		return '';

	cursor_handle.foreach('prism-router', 'station', function(s) {
		if (length(found) || type(s) != 'object' || s['.type'] != 'station')
			return;

		if (auth_section_id(s) != node_id)
			return;

		const token = trim(auth_text(s.token, ''));

		if (length(token))
			found = token;
	});

	return found;
};
